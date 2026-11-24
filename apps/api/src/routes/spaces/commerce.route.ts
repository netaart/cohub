import { Hono } from "hono";
import { isBillingApiError } from "../../lib/billing-api-error.js";
import { authzDenied, requireValidId, useAuth } from "../../lib/middleware.js";
import {
  handleSpaceCommerceRouteError,
  requireSpaceCommerceEntitlement,
} from "../../lib/commerce-http.js";
import { hasPermission } from "../../permissions.js";
import { createCommerceKey } from "../../lib/commerce-key.js";
import {
  createSpaceCommerceSdk,
  ensureSpaceCommerceBusiness,
  loadBusinessCreditBenefits,
  requireSpaceCommerceBusiness,
} from "../../lib/space-commerce.js";
import {
  buildSpaceCreditsBenefitConfig,
  serializeBenefit,
  serializeOrder,
  serializeProduct,
  serializeProductBenefit,
  type SerializedCommerceBuyerProfile,
  type SerializedCommerceProductBenefitBinding,
} from "../../lib/commerce-serialize.js";
import type { Benefit, CreditsBenefit, Product, ProductBenefit } from "../../lib/commerce-types.js";
import { createLogger } from "@cohub/infra/logging";
import type { SpaceCommerceSdk } from "../../lib/space-commerce.js";
import { fallbackPublicUserProfile, getProfilesByUuids } from "../../user-profiles.js";
import {
  buildCohubBalanceBenefitConfig,
  buildCohubBalanceBenefitKey,
  buildCohubBalanceProductMeta,
  COHUB_BALANCE_META_KEY,
  CohubBalanceValidationError,
  collectManagedBalanceBenefitKeys,
  isCohubBalanceBenefitValid,
  readCohubBalanceDescriptor,
  resolveBalanceProductCreateState,
  resolveCohubBalanceSpec,
  type CohubBalanceDescriptor,
} from "../../lib/space-commerce-balance.js";

const router = new Hono();
const logger = createLogger({ serviceName: "cohub-api" });

const COHUB_BOUND_BENEFIT_KEYS_META_KEY = "cohub_bound_benefit_keys";
const MIN_PRODUCT_AMOUNT_USD = 0.5;

function serializeProductBenefitFallback(input: { productKey: string; benefitKey: string }): SerializedCommerceProductBenefitBinding {
  return {
    id: null,
    productKey: input.productKey,
    benefitKey: input.benefitKey,
    createdAt: null,
  };
}

function metaBenefitKeys(product: Product): string[] {
  const value = product.meta?.[COHUB_BOUND_BENEFIT_KEYS_META_KEY];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function resolveOrderBuyerUserUuid(order: { external_user_id?: string | null; external_user_id_snapshot?: string | null }) {
  const userUuid = order.external_user_id ?? order.external_user_id_snapshot ?? null;
  return typeof userUuid === "string" && userUuid.trim() ? userUuid.trim() : null;
}

async function buildOrderBuyerProfiles(orders: Array<{ external_user_id?: string | null; external_user_id_snapshot?: string | null }>) {
  const userUuids = orders.map(resolveOrderBuyerUserUuid).filter((value): value is string => Boolean(value));
  const profiles = await getProfilesByUuids(userUuids);
  const buyerProfiles = new Map<string, SerializedCommerceBuyerProfile>();

  for (const userUuid of userUuids) {
    const profile = profiles.get(userUuid) ?? fallbackPublicUserProfile(userUuid);
    buyerProfiles.set(userUuid, {
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
    });
  }

  return buyerProfiles;
}

async function syncProductBenefitMeta(input: {
  sdk: SpaceCommerceSdk;
  businessKey: string;
  productKey: string;
  benefitKey: string;
  mode: "bind" | "unbind";
}) {
  try {
    const product = await input.sdk.admin.products.get({
      business_key: input.businessKey,
      product_key: input.productKey,
    });
    const keys = new Set(metaBenefitKeys(product));
    if (input.mode === "bind") keys.add(input.benefitKey);
    else keys.delete(input.benefitKey);
    await input.sdk.admin.products.update({
      product_key: input.productKey,
      patch: {
        business_key: input.businessKey,
        meta: {
          ...product.meta,
          [COHUB_BOUND_BENEFIT_KEYS_META_KEY]: [...keys].sort(),
        },
      },
    });
  } catch (error) {
    logger.warn("[space-commerce] failed to sync product benefit meta", {
      businessKey: input.businessKey,
      productKey: input.productKey,
      benefitKey: input.benefitKey,
      mode: input.mode,
      error,
    });
    throw error;
  }
}

async function compensateFailedBalanceProvision(input: {
  sdk: SpaceCommerceSdk;
  businessKey: string;
  productKey: string;
  benefitKey: string;
  benefitCreated: boolean;
}) {
  const compensations: Array<{ resource: string; run: () => Promise<unknown> }> = [];
  if (input.benefitCreated) {
    compensations.push({
      resource: "benefit",
      run: () => input.sdk.admin.benefits.update({
        benefit_key: input.benefitKey,
        patch: { business_key: input.businessKey, status: "archived" },
      }),
    });
  }
  compensations.push({
    resource: "product",
    run: () => input.sdk.admin.products.update({
      product_key: input.productKey,
      patch: { business_key: input.businessKey, status: "archived" },
    }),
  });

  for (const compensation of compensations) {
    try {
      await compensation.run();
    } catch (error) {
      logger.error("[space-commerce] failed to compensate Balance provisioning", {
        resource: compensation.resource,
        businessKey: input.businessKey,
        productKey: input.productKey,
        benefitKey: input.benefitKey,
        error,
      });
    }
  }
}

/** True when a Benefit is the platform-managed Balance of a product in this business. */
async function isManagedBalanceBenefit(input: {
  sdk: SpaceCommerceSdk;
  businessKey: string;
  benefitKey: string;
}): Promise<boolean> {
  const bindings = await input.sdk.admin.products.listProductsByBenefit({
    business_key: input.businessKey,
    benefit_key: input.benefitKey,
  });
  return bindings.some((binding: { product: Pick<Product, "meta"> }) => {
    const descriptor = readCohubBalanceDescriptor(binding.product);
    return descriptor?.benefitKey === input.benefitKey;
  });
}

type SerializedProductBenefitBinding = {
  id: string | null;
  productKey: string;
  benefitKey: string;
  createdAt: string | null;
};

function productBenefitItemsFromResponse(response: unknown, productKey: string): SerializedProductBenefitBinding[] {
  if (!response || typeof response !== "object") return [];
  const record = response as {
    items?: unknown;
    product_benefits?: unknown;
    benefits?: unknown;
  };
  const source = Array.isArray(record.items)
    ? record.items
    : Array.isArray(record.product_benefits)
      ? record.product_benefits
      : Array.isArray(record.benefits)
        ? record.benefits
        : [];
  return source.flatMap((item): SerializedProductBenefitBinding[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<ProductBenefit> & { key?: unknown };
    const benefitKey = typeof candidate.benefit_key === "string" ? candidate.benefit_key : typeof candidate.key === "string" ? candidate.key : "";
    if (!benefitKey) return [];
    return [{
      id: typeof candidate.id === "string" ? candidate.id : null,
      productKey: typeof candidate.product_key === "string" ? candidate.product_key : productKey,
      benefitKey,
      createdAt: typeof candidate.created_at === "string" ? candidate.created_at : null,
    }];
  });
}

async function listSpaceCommerceProducts(input: { sdk: SpaceCommerceSdk; businessKey: string }): Promise<Product[]> {
  const products: Product[] = [];
  let page = 1;
  while (true) {
    const result = await input.sdk.admin.products.list({
      business_key: input.businessKey,
      include_count: false,
      limit: 100,
      page,
    });
    products.push(...result.items);
    if (!result.pagination.has_more) break;
    page += 1;
  }
  return products;
}

async function listProductBenefitBindings(input: {
  sdk: SpaceCommerceSdk;
  businessKey: string;
  /** Reuses an already-loaded catalog; omit to load it here. */
  products?: readonly Product[];
}): Promise<SerializedProductBenefitBinding[]> {
  const products = input.products ?? await listSpaceCommerceProducts(input);
  const bindings = new Map<string, SerializedProductBenefitBinding>();
  let billingListSupported = true;

  for (const product of products) {
    if (billingListSupported) {
      try {
        const response = await input.sdk.admin.products.http.request({
          method: "GET",
          path: "/products/:product_key/benefits",
          pathParams: { product_key: product.key },
          query: { business_key: input.businessKey },
        });
        for (const binding of productBenefitItemsFromResponse(response, product.key)) {
          bindings.set(`${binding.productKey}\u0000${binding.benefitKey}`, binding);
        }
        continue;
      } catch (error) {
        if (isBillingApiError(error) && (error.status === 400 || error.status === 404 || error.status === 405)) {
          billingListSupported = false;
        } else {
          throw error;
        }
      }
    }

    for (const benefitKey of metaBenefitKeys(product)) {
      const binding = serializeProductBenefitFallback({ productKey: product.key, benefitKey });
      bindings.set(`${binding.productKey}\u0000${binding.benefitKey}`, binding);
    }
  }
  return [...bindings.values()].sort((left, right) => left.productKey.localeCompare(right.productKey) || left.benefitKey.localeCompare(right.benefitKey));
}

async function collectCommerceKeys<T extends { key: string }>(
  loadPage: (page: number) => Promise<{ items: T[]; pagination: { has_more: boolean } }>,
): Promise<Set<string>> {
  const keys = new Set<string>();
  let page = 1;
  while (true) {
    const result = await loadPage(page);
    for (const item of result.items) keys.add(item.key);
    if (!result.pagination.has_more) break;
    page += 1;
  }
  return keys;
}

function isCommerceConflict(error: unknown): boolean {
  return isBillingApiError(error) && error.status === 409;
}

function mergeKeys(target: Set<string>, source: Iterable<string>): Set<string> {
  for (const key of source) target.add(key);
  return target;
}

async function listProductKeys(sdk: SpaceCommerceSdk, businessKey: string): Promise<Set<string>> {
  return collectCommerceKeys((page) => sdk.admin.products.list({
    business_key: businessKey,
    include_count: false,
    limit: 100,
    page,
  }));
}

async function listBenefitKeys(sdk: SpaceCommerceSdk, businessKey: string): Promise<Set<string>> {
  return collectCommerceKeys((page) => sdk.admin.benefits.list({
    business_key: businessKey,
    include_count: false,
    limit: 100,
    page,
  }));
}

/**
 * Builds a map of product key to its bound credit benefits.
 */
async function loadProductCreditBenefits(input: {
  sdk: SpaceCommerceSdk;
  businessKey: string;
  products?: readonly Product[];
}): Promise<Map<string, CreditsBenefit[]>> {
  const [creditBenefitsMap, bindings] = await Promise.all([
    loadBusinessCreditBenefits({ sdk: input.sdk, businessKey: input.businessKey }),
    listProductBenefitBindings(input),
  ]);
  const byProduct = new Map<string, CreditsBenefit[]>();
  for (const binding of bindings) {
    const creditBenefit = creditBenefitsMap.get(binding.benefitKey);
    if (!creditBenefit) continue;
    const list = byProduct.get(binding.productKey) ?? [];
    list.push(creditBenefit);
    byProduct.set(binding.productKey, list);
  }
  return byProduct;
}

router.post("/:id/commerce/setup", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.commerce.manage", { spaceId }))) return authzDenied(c);
  const entitlementDenied = await requireSpaceCommerceEntitlement(c, user.uuid);
  if (entitlementDenied) return entitlementDenied;
  try {
    const mapping = await ensureSpaceCommerceBusiness(spaceId);
    return c.json({ businessKey: mapping.billingBusinessKey });
  } catch (error) {
    const response = handleSpaceCommerceRouteError(c, error);
    if (response) return response;
    throw error;
  }
});

router.get("/:id/commerce/products", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.commerce.view", { spaceId }))) return authzDenied(c);
  try {
    const mapping = await requireSpaceCommerceBusiness(spaceId);
    const sdk = await createSpaceCommerceSdk();
    const [result, creditBenefitsByProduct] = await Promise.all([
      sdk.admin.products.list({
        business_key: mapping.billingBusinessKey,
        include_count: false,
        limit: 100,
        page: 1,
      }),
      loadProductCreditBenefits({ sdk, businessKey: mapping.billingBusinessKey }),
    ]);
    return c.json({
      products: result.items.map((product: Product) => serializeProduct(
        product,
        creditBenefitsByProduct.get(product.key) ?? [],
        readCohubBalanceDescriptor(product),
      )),
      businessKey: mapping.billingBusinessKey,
    });
  } catch (error) {
    const response = handleSpaceCommerceRouteError(c, error);
    if (response) return response;
    throw error;
  }
});

router.post("/:id/commerce/products", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.commerce.manage", { spaceId }))) return authzDenied(c);
  const entitlementDenied = await requireSpaceCommerceEntitlement(c, user.uuid);
  if (entitlementDenied) return entitlementDenied;
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const explicitKey = typeof body?.key === "string" ? body.key.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const description = typeof body?.description === "string" ? body.description.trim() : undefined;
  const visibility = body?.visibility === "private" ? "private" : "public";
  const status = body?.status === "draft" ? "draft" : "active";
  const amount = typeof body?.amountUsd === "number" ? body.amountUsd : Number.NaN;
  if (!name) return c.json({ message: "name is required" }, 400);
  if (!Number.isFinite(amount) || amount < MIN_PRODUCT_AMOUNT_USD) return c.json({ message: "amountUsd must be at least 0.5" }, 400);
  const amountMinor = Math.round(amount * 100);
  let balanceSpec: ReturnType<typeof resolveCohubBalanceSpec>;
  try {
    balanceSpec = resolveCohubBalanceSpec({
      value: body?.cohubBalanceUsd,
      productAmountMinor: amountMinor,
    });
  } catch (error) {
    if (error instanceof CohubBalanceValidationError) {
      return c.json({ message: error.message }, 400);
    }
    throw error;
  }
  try {
    const mapping = await requireSpaceCommerceBusiness(spaceId);
    const sdk = await createSpaceCommerceSdk();
    // Balance products are provisioned private-then-published: Billing rejects
    // binding a Benefit to a draft product, so the product must already be
    // active while we bind. Private visibility keeps it out of the public
    // resolve and checkout paths until provisioning completes.
    const createState = resolveBalanceProductCreateState({
      hasBalance: Boolean(balanceSpec),
      requestedStatus: status,
      requestedVisibility: visibility,
    });
    const createProduct = (key: string) => sdk.admin.products.create({
      business_key: mapping.billingBusinessKey,
      key,
      name,
      description,
      status: createState.status,
      visibility: createState.visibility,
      amount: amountMinor,
      currency: "USD",
      billing_type: "one_time",
      billing_period: "one_time",
      billing_interval_count: 1,
      ...(balanceSpec
        ? {
          meta: {
            [COHUB_BALANCE_META_KEY]: buildCohubBalanceProductMeta(
              balanceSpec,
              buildCohubBalanceBenefitKey(key, balanceSpec.amountUsd),
            ),
          },
        }
        : {}),
    });
    let product: Awaited<ReturnType<typeof createProduct>>;
    if (explicitKey) {
      product = await createProduct(explicitKey);
    } else {
      const occupiedKeys = await listProductKeys(sdk, mapping.billingBusinessKey);
      let generatedKey = createCommerceKey({ name, fallback: "product", occupiedKeys });
      try {
        product = await createProduct(generatedKey);
      } catch (error) {
        if (!isCommerceConflict(error)) throw error;
        occupiedKeys.add(generatedKey);
        mergeKeys(occupiedKeys, await listProductKeys(sdk, mapping.billingBusinessKey));
        generatedKey = createCommerceKey({ name, fallback: "product", occupiedKeys });
        product = await createProduct(generatedKey);
      }
    }

    let balanceDescriptor: CohubBalanceDescriptor | null = null;
    if (balanceSpec) {
      const benefitKey = buildCohubBalanceBenefitKey(product.key, balanceSpec.amountUsd);
      let benefitCreated = false;
      try {
        let balanceBenefit: Benefit;
        try {
          balanceBenefit = await sdk.admin.benefits.create({
            business_key: mapping.billingBusinessKey,
            key: benefitKey,
            type: "credits",
            name: `Cohub Balance ${balanceSpec.amountUsd}`,
            description: "Platform-managed Cohub Balance included with this product.",
            config: buildCohubBalanceBenefitConfig(balanceSpec),
            status: "active",
          });
          benefitCreated = true;
        } catch (error) {
          if (!isCommerceConflict(error)) throw error;
          balanceBenefit = await sdk.admin.benefits.get({
            business_key: mapping.billingBusinessKey,
            benefit_key: benefitKey,
          });
        }
        if (
          balanceBenefit.type !== "credits" ||
          !isCohubBalanceBenefitValid(balanceBenefit, balanceSpec)
        ) {
          throw new Error("Existing Cohub Balance benefit has incompatible configuration");
        }
        await sdk.admin.products.bindBenefit({
          business_key: mapping.billingBusinessKey,
          product_key: product.key,
          benefit_key: benefitKey,
        });
        const boundKeys = [...metaBenefitKeys(product), benefitKey].sort();
        product = await sdk.admin.products.update({
          product_key: product.key,
          patch: {
            business_key: mapping.billingBusinessKey,
            meta: {
              ...product.meta,
              [COHUB_BOUND_BENEFIT_KEYS_META_KEY]: boundKeys,
              [COHUB_BALANCE_META_KEY]: buildCohubBalanceProductMeta(balanceSpec, benefitKey),
            },
            status,
            visibility,
          },
        });
        balanceDescriptor = readCohubBalanceDescriptor(product);
      } catch (error) {
        logger.error("[space-commerce] Cohub Balance provisioning failed", {
          businessKey: mapping.billingBusinessKey,
          productKey: product.key,
          benefitKey,
          benefitCreated,
          billingStatus: isBillingApiError(error) ? error.status : undefined,
          billingMessage: isBillingApiError(error) ? error.message : undefined,
          error,
        });
        await compensateFailedBalanceProvision({
          sdk,
          businessKey: mapping.billingBusinessKey,
          productKey: product.key,
          benefitKey,
          benefitCreated,
        });
        throw error;
      }
    }
    return c.json({
      product: serializeProduct(product, [], balanceDescriptor),
      businessKey: mapping.billingBusinessKey,
    });
  } catch (error) {
    const response = handleSpaceCommerceRouteError(c, error);
    if (response) return response;
    throw error;
  }
});

router.patch("/:id/commerce/products/:productKey", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const productKey = c.req.param("productKey").trim();
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!productKey) return c.json({ message: "product not found" }, 404);
  if (!(await hasPermission(user, "space.commerce.manage", { spaceId }))) return authzDenied(c);
  const entitlementDenied = await requireSpaceCommerceEntitlement(c, user.uuid);
  if (entitlementDenied) return entitlementDenied;
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const patch: Record<string, unknown> = {};
  if (typeof body?.name === "string") patch.name = body.name.trim();
  if (typeof body?.description === "string") patch.description = body.description.trim();
  if (body?.description === null) patch.description = null;
  if (body?.status === "draft" || body?.status === "active" || body?.status === "archived") patch.status = body.status;
  if (body?.visibility === "public" || body?.visibility === "private") patch.visibility = body.visibility;
  if (Object.keys(patch).length === 0) return c.json({ message: "nothing to update" }, 400);
  try {
    const mapping = await requireSpaceCommerceBusiness(spaceId);
    const sdk = await createSpaceCommerceSdk();
    const product = await sdk.admin.products.update({
      product_key: productKey,
      patch: {
        business_key: mapping.billingBusinessKey,
        ...(patch as {
          name?: string;
          description?: string | null;
          status?: "draft" | "active" | "archived";
          visibility?: "public" | "private";
        }),
      },
    });
    return c.json({
      product: serializeProduct(product, [], readCohubBalanceDescriptor(product)),
      businessKey: mapping.billingBusinessKey,
    });
  } catch (error) {
    const response = handleSpaceCommerceRouteError(c, error);
    if (response) return response;
    throw error;
  }
});

router.get("/:id/commerce/benefits", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.commerce.view", { spaceId }))) return authzDenied(c);
  try {
    const mapping = await requireSpaceCommerceBusiness(spaceId);
    const sdk = await createSpaceCommerceSdk();
    const [result, products] = await Promise.all([
      sdk.admin.benefits.list({
        business_key: mapping.billingBusinessKey,
        include_count: false,
        limit: 100,
        page: 1,
      }),
      listSpaceCommerceProducts({ sdk, businessKey: mapping.billingBusinessKey }),
    ]);
    const managedBenefitKeys = collectManagedBalanceBenefitKeys(products);
    return c.json({
      benefits: result.items
        .filter((item: Benefit) => !managedBenefitKeys.has(item.key))
        .map((item: Benefit) => serializeBenefit(item)),
      businessKey: mapping.billingBusinessKey,
    });
  } catch (error) {
    const response = handleSpaceCommerceRouteError(c, error);
    if (response) return response;
    throw error;
  }
});

router.post("/:id/commerce/benefits", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.commerce.manage", { spaceId }))) return authzDenied(c);
  const entitlementDenied = await requireSpaceCommerceEntitlement(c, user.uuid);
  if (entitlementDenied) return entitlementDenied;
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const explicitKey = typeof body?.key === "string" ? body.key.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const description = typeof body?.description === "string" ? body.description.trim() : undefined;
  const benefitType = body?.type === "credits" ? "credits" : "feature";
  const metadata = typeof body?.metadata === "object" && body.metadata && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, string | number | boolean>
    : {};
  const creditAmount = typeof body?.amount === "number" ? Math.floor(body.amount) : null;
  if (!name) return c.json({ message: "name is required" }, 400);
  if (benefitType === "credits") {
    if (creditAmount === null || creditAmount <= 0) return c.json({ message: "amount must be a positive integer" }, 400);
  }
  const expiresInDays = typeof body?.expiresInDays === "number" && Number.isFinite(body.expiresInDays) && body.expiresInDays > 0
    ? Math.floor(body.expiresInDays)
    : undefined;
  try {
    const mapping = await requireSpaceCommerceBusiness(spaceId);
    const sdk = await createSpaceCommerceSdk();
    const createBenefit = (key: string): Promise<Benefit> => {
      if (benefitType === "credits") {
        return sdk.admin.benefits.create({
          business_key: mapping.billingBusinessKey,
          key,
          type: "credits" as const,
          name,
          description,
          config: buildSpaceCreditsBenefitConfig({ amount: creditAmount ?? 0, expiresInDays }),
          status: "active" as const,
        });
      }
      return sdk.admin.benefits.create({
        business_key: mapping.billingBusinessKey,
        key,
        type: "feature" as const,
        name,
        description,
        config: { metadata },
        status: "active" as const,
      });
    };
    let benefit: Benefit;
    if (explicitKey) {
      benefit = await createBenefit(explicitKey);
    } else {
      const occupiedKeys = await listBenefitKeys(sdk, mapping.billingBusinessKey);
      let generatedKey = createCommerceKey({ name, fallback: "benefit", occupiedKeys });
      try {
        benefit = await createBenefit(generatedKey);
      } catch (error) {
        if (!isCommerceConflict(error)) throw error;
        occupiedKeys.add(generatedKey);
        mergeKeys(occupiedKeys, await listBenefitKeys(sdk, mapping.billingBusinessKey));
        generatedKey = createCommerceKey({ name, fallback: "benefit", occupiedKeys });
        benefit = await createBenefit(generatedKey);
      }
    }
    return c.json({ benefit: serializeBenefit(benefit), businessKey: mapping.billingBusinessKey });
  } catch (error) {
    const response = handleSpaceCommerceRouteError(c, error);
    if (response) return response;
    throw error;
  }
});

router.patch("/:id/commerce/benefits/:benefitKey", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const benefitKey = c.req.param("benefitKey").trim();
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!benefitKey) return c.json({ message: "benefit not found" }, 404);
  if (!(await hasPermission(user, "space.commerce.manage", { spaceId }))) return authzDenied(c);
  const entitlementDenied = await requireSpaceCommerceEntitlement(c, user.uuid);
  if (entitlementDenied) return entitlementDenied;
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const patch: Record<string, unknown> = {};
  if (typeof body?.name === "string") patch.name = body.name.trim();
  if (typeof body?.description === "string") patch.description = body.description.trim();
  if (body?.description === null) patch.description = null;
  if (body?.status === "active" || body?.status === "archived") patch.status = body.status;
  if (typeof body?.metadata === "object" && body.metadata && !Array.isArray(body.metadata)) {
    patch.config = { metadata: body.metadata as Record<string, string | number | boolean> };
  }
  if (Object.keys(patch).length === 0) return c.json({ message: "nothing to update" }, 400);
  try {
    const mapping = await requireSpaceCommerceBusiness(spaceId);
    const sdk = await createSpaceCommerceSdk();
    if (await isManagedBalanceBenefit({
      sdk,
      businessKey: mapping.billingBusinessKey,
      benefitKey,
    })) {
      return c.json({ message: "Cohub Balance benefits are platform-managed" }, 403);
    }
    // Credits benefits have an immutable config (amount, token, scope).
    // Only feature benefits accept metadata updates.
    if (patch.config) {
      const existing = await sdk.admin.benefits.get({
        benefit_key: benefitKey,
        business_key: mapping.billingBusinessKey,
      });
      if (existing.type !== "feature") {
        return c.json({ message: "metadata can only be updated for feature benefits" }, 400);
      }
    }
    const benefit = await sdk.admin.benefits.update({
      benefit_key: benefitKey,
      patch: {
        business_key: mapping.billingBusinessKey,
        ...patch,
      },
    });
    return c.json({ benefit: serializeBenefit(benefit), businessKey: mapping.billingBusinessKey });
  } catch (error) {
    const response = handleSpaceCommerceRouteError(c, error);
    if (response) return response;
    throw error;
  }
});

router.get("/:id/commerce/product-benefits", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.commerce.view", { spaceId }))) return authzDenied(c);
  try {
    const mapping = await requireSpaceCommerceBusiness(spaceId);
    const sdk = await createSpaceCommerceSdk();
    const products = await listSpaceCommerceProducts({ sdk, businessKey: mapping.billingBusinessKey });
    const productBenefits = await listProductBenefitBindings({
      sdk,
      businessKey: mapping.billingBusinessKey,
      products,
    });
    const managedBenefitKeys = collectManagedBalanceBenefitKeys(products);
    return c.json({
      productBenefits: productBenefits.filter((binding) => !managedBenefitKeys.has(binding.benefitKey)),
      businessKey: mapping.billingBusinessKey,
    });
  } catch (error) {
    const response = handleSpaceCommerceRouteError(c, error);
    if (response) return response;
    throw error;
  }
});

router.post("/:id/commerce/product-benefits", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.commerce.manage", { spaceId }))) return authzDenied(c);
  const entitlementDenied = await requireSpaceCommerceEntitlement(c, user.uuid);
  if (entitlementDenied) return entitlementDenied;
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const productKey = typeof body?.productKey === "string" ? body.productKey.trim() : "";
  const benefitKey = typeof body?.benefitKey === "string" ? body.benefitKey.trim() : "";
  if (!productKey) return c.json({ message: "productKey is required" }, 400);
  if (!benefitKey) return c.json({ message: "benefitKey is required" }, 400);
  try {
    const mapping = await requireSpaceCommerceBusiness(spaceId);
    const sdk = await createSpaceCommerceSdk();
    if (await isManagedBalanceBenefit({
      sdk,
      businessKey: mapping.billingBusinessKey,
      benefitKey,
    })) {
      return c.json({ message: "Cohub Balance benefits are platform-managed" }, 403);
    }
    const productBenefit = await sdk.admin.products.bindBenefit({
      business_key: mapping.billingBusinessKey,
      product_key: productKey,
      benefit_key: benefitKey,
    });
    await syncProductBenefitMeta({
      sdk,
      businessKey: mapping.billingBusinessKey,
      productKey,
      benefitKey,
      mode: "bind",
    });
    return c.json({ productBenefit: serializeProductBenefit(productBenefit), businessKey: mapping.billingBusinessKey });
  } catch (error) {
    const response = handleSpaceCommerceRouteError(c, error);
    if (response) return response;
    throw error;
  }
});

router.delete("/:id/commerce/product-benefits", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.commerce.manage", { spaceId }))) return authzDenied(c);
  const entitlementDenied = await requireSpaceCommerceEntitlement(c, user.uuid);
  if (entitlementDenied) return entitlementDenied;
  const productKey = c.req.query("productKey")?.trim() ?? "";
  const benefitKey = c.req.query("benefitKey")?.trim() ?? "";
  if (!productKey) return c.json({ message: "productKey is required" }, 400);
  if (!benefitKey) return c.json({ message: "benefitKey is required" }, 400);
  try {
    const mapping = await requireSpaceCommerceBusiness(spaceId);
    const sdk = await createSpaceCommerceSdk();
    if (await isManagedBalanceBenefit({
      sdk,
      businessKey: mapping.billingBusinessKey,
      benefitKey,
    })) {
      return c.json({ message: "Cohub Balance benefits are platform-managed" }, 403);
    }
    await sdk.admin.products.unbindBenefit({
      business_key: mapping.billingBusinessKey,
      product_key: productKey,
      benefit_key: benefitKey,
    });
    await syncProductBenefitMeta({
      sdk,
      businessKey: mapping.billingBusinessKey,
      productKey,
      benefitKey,
      mode: "unbind",
    });
    return c.json({ ok: true, businessKey: mapping.billingBusinessKey });
  } catch (error) {
    const response = handleSpaceCommerceRouteError(c, error);
    if (response) return response;
    throw error;
  }
});

router.get("/:id/commerce/orders", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.commerce.view", { spaceId }))) return authzDenied(c);
  const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(c.req.query("limit") ?? "20", 10) || 20));
  try {
    const mapping = await requireSpaceCommerceBusiness(spaceId);
    const sdk = await createSpaceCommerceSdk();
    const result = await sdk.admin.orders.list({
      business_key: mapping.billingBusinessKey,
      include_count: false,
      page,
      limit,
      sorting: "-created_at",
    });
    const buyerProfiles = await buildOrderBuyerProfiles(result.items);
    return c.json({
      orders: result.items.map((order) => {
        const userUuid = resolveOrderBuyerUserUuid(order);
        return serializeOrder(order, {
          buyerProfile: userUuid ? (buyerProfiles.get(userUuid) ?? null) : null,
        });
      }),
      pagination: { hasMore: result.pagination.has_more, nextPage: result.pagination.has_more ? page + 1 : null },
      businessKey: mapping.billingBusinessKey,
    });
  } catch (error) {
    const response = handleSpaceCommerceRouteError(c, error);
    if (response) return response;
    throw error;
  }
});

export default router;
