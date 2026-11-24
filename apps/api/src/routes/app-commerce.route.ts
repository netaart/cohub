import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { isBillingApiError } from "../lib/billing-api-error.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { authzDenied, getExecutionPrincipal, getOptionalAuth, requireValidId, useAuth } from "../lib/middleware.js";
import { handleAppCommerceRouteError } from "../lib/commerce-http.js";
import { hasPermission } from "../permissions.js";
import {
  buildAppCheckoutReturnUrls,
  createSpaceCommerceSdk,
  createSpaceBusinessBillingOperations,
  getAppCommerceContextById,
  loadBoundBenefitKeys,
  loadBusinessCreditBenefits,
  requireSpaceCommerceBusinessKey,
} from "../lib/space-commerce.js";
import { serializeProduct, serializeOrder } from "../lib/commerce-serialize.js";
import { db } from "../db/index.js";
import { spaces, userProfiles } from "@cohub/db";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import {
  isCohubBalanceProductValid,
  readCohubBalanceDescriptor,
} from "../lib/space-commerce-balance.js";
import {
  createAppPurchaseIdempotencyKey,
  normalizePurchaseAttemptId,
  toPromotionMoney,
} from "../lib/app-commerce-purchase.js";
import {
  recordResolvedAppPromotionEvent,
  resolvePublishedAppPromotion,
} from "../app-promotion-events.js";
import {
  canTargetCommerceViewer,
  resolveCommerceViewerUserId,
} from "../lib/app-commerce-viewer.js";

/**
 * Commerce endpoints live under `/{resource}/:id/commerce/*`; the router is a
 * factory so the same handlers serve both the canonical `/api/apps` mount and
 * the legacy `/api/works` mount with identical payloads.
 */
export function createAppCommerceRouter(resource: "works" | "apps"): Hono {
  const router = new Hono();

/** Public resolve fan-out caps: bound upstream Billing load per request. */
const RESOLVE_MAX_PRODUCT_KEYS = 20;
const RESOLVE_MAX_PRODUCT_KEY_LENGTH = 128;
const RESOLVE_BILLING_CONCURRENCY = 4;

type PromotionAttributionInput = {
  promotionId: string;
  sourceUrl?: string;
  fbp?: string;
  fbc?: string;
};

function parsePromotionAttribution(value: unknown): PromotionAttributionInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const promotionId = typeof record.promotionId === "string" ? record.promotionId : "";
  if (!requireValidId(promotionId)) return null;
  const sourceUrl = typeof record.sourceUrl === "string" && record.sourceUrl.length <= 2_048
    ? record.sourceUrl
    : undefined;
  const fbp = typeof record.fbp === "string" && record.fbp.length <= 255 ? record.fbp : undefined;
  const fbc = typeof record.fbc === "string" && record.fbc.length <= 255 ? record.fbc : undefined;
  return { promotionId, sourceUrl, fbp, fbc };
}

async function getPublishedAppOrDeny(appId: string, userUuid?: string | null) {
  const app = await getAppCommerceContextById(appId);
  if (app?.appStatus !== "published") return { error: "app not found" as const };
  if ((app.appVisibility ?? "public") === "space") {
    if (!userUuid) return { auth: "required" as const, app };
  }
  return { app };
}

async function resolvePublicAppUrl(input: { spaceId: string; appSlug: string }) {
  const [row] = await db
    .select({ username: userProfiles.username, spaceSlug: spaces.slug })
    .from(spaces)
    .innerJoin(userProfiles, eq(userProfiles.userUuid, spaces.userUuid))
    .where(eq(spaces.id, input.spaceId))
    .limit(1);
  if (!row?.username || !row.spaceSlug) return null;
  const origin = config.webOrigin?.replace(/\/+$/, "")
    ?? (config.env === "prod" ? "https://cohub.live" : "https://dev.cohub.live");
  return `${origin}/${encodeURIComponent(row.username)}/${encodeURIComponent(row.spaceSlug)}/w/${encodeURIComponent(input.appSlug)}`;
}

router.post(`/${resource}/:id/commerce/products/resolve`, async (c) => {
  const principal = getOptionalAuth(c);
  const appId = c.req.param("id");
  if (!requireValidId(appId)) return c.json({ message: "app not found" }, 404);
  const resolved = await getPublishedAppOrDeny(appId, principal?.uuid ?? null);
  if ("error" in resolved) return c.json({ message: resolved.error }, 404);
  if ("auth" in resolved) return authzDenied(c);
  if ((resolved.app.appVisibility ?? "public") === "space" && !(await hasPermission(principal, "space.view", { spaceId: resolved.app.spaceId }))) return authzDenied(c);
  const body = await c.req.json().catch(() => null) as { productKeys?: unknown } | null;
  const requested = Array.isArray(body?.productKeys)
    ? [...new Set(body.productKeys.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
    : [];
  if (requested.length === 0) return c.json({ message: "productKeys is required" }, 400);
  if (requested.length > RESOLVE_MAX_PRODUCT_KEYS) {
    return c.json({ message: `productKeys must contain at most ${RESOLVE_MAX_PRODUCT_KEYS} items` }, 400);
  }
  if (requested.some((key) => key.length > RESOLVE_MAX_PRODUCT_KEY_LENGTH)) {
    return c.json({ message: `productKeys entries must be at most ${RESOLVE_MAX_PRODUCT_KEY_LENGTH} characters` }, 400);
  }
  try {
    const businessKey = await requireSpaceCommerceBusinessKey(resolved.app.spaceId);
    const sdk = await createSpaceCommerceSdk();
    const [products, creditBenefitsMap] = await Promise.all([
      mapWithConcurrency(requested, RESOLVE_BILLING_CONCURRENCY, async (productKey) => {
        try {
          const product = await sdk.admin.products.get({ business_key: businessKey, product_key: productKey });
          if (product.status !== "active" || product.visibility !== "public" || product.billing_type !== "one_time") return null;
          return product;
        } catch (error) {
          if (isBillingApiError(error) && error.status === 404) return null;
          throw error;
        }
      }),
      loadBusinessCreditBenefits({ sdk, businessKey }),
    ]);
    const visibleProducts = products.filter(
      (item): item is NonNullable<typeof item> => Boolean(item),
    );
    const boundKeysByProduct = await mapWithConcurrency(
      visibleProducts,
      RESOLVE_BILLING_CONCURRENCY,
      (item) => loadBoundBenefitKeys({ sdk, businessKey, productKey: item.key }),
    );
    const serializedProducts = [];
    for (const [index, item] of visibleProducts.entries()) {
      const boundKeys = boundKeysByProduct[index] ?? [];
      const boundCredits = boundKeys
        .map((key) => creditBenefitsMap.get(key))
        .filter((b): b is NonNullable<typeof b> => Boolean(b));
      const balance = readCohubBalanceDescriptor(item);
      if (balance && !isCohubBalanceProductValid({
        productKey: item.key,
        productAmountMinor: Number(item.amount ?? 0),
        productCurrency: item.currency,
        balance,
        benefit: creditBenefitsMap.get(balance.benefitKey),
        boundBenefitKeys: boundKeys,
      })) {
        continue;
      }
      serializedProducts.push(serializeProduct(item, boundCredits, balance));
    }
    return c.json({
      products: serializedProducts,
    });
  } catch (error) {
    const response = handleAppCommerceRouteError(c, error);
    if (response) return response;
    throw error;
  }
});

router.get(`/${resource}/:id/commerce/entitlements`, async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const appId = c.req.param("id");
  if (!requireValidId(appId)) return c.json({ message: "app not found" }, 404);
  const resolved = await getPublishedAppOrDeny(appId, user.uuid);
  if ("error" in resolved) return c.json({ message: resolved.error }, 404);
  if ((resolved.app.appVisibility ?? "public") === "space" && !(await hasPermission(user, "space.view", { spaceId: resolved.app.spaceId }))) return authzDenied(c);
  try {
    const businessKey = await requireSpaceCommerceBusinessKey(resolved.app.spaceId);
    const ops = await createSpaceBusinessBillingOperations(businessKey);
    const viewerUserId = resolveCommerceViewerUserId(getExecutionPrincipal(c), appId, user.uuid);
    if (!viewerUserId) return authzDenied(c);
    const state = await ops.getEntitlements({ userId: viewerUserId });
    const creditBalance = state.credits.find((c: { tokenType: string }) => c.tokenType === "cohub_credit");
    return c.json({
      entitlements: state.entitlements.map((entitlement: { key: string; enabled: boolean; metadata: Record<string, string | number | boolean> }) => ({
        benefitKey: entitlement.key,
        enabled: entitlement.enabled,
        metadata: entitlement.metadata,
      })),
      credits: {
        available: creditBalance?.availableBalance ?? 0,
        net: creditBalance?.netBalance ?? 0,
      },
      businessKey,
    });
  } catch (error) {
    const response = handleAppCommerceRouteError(c, error);
    if (response) return response;
    throw error;
  }
});

router.post(`/${resource}/:id/commerce/credits/consume`, async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const appId = c.req.param("id");
  if (!requireValidId(appId)) return c.json({ message: "app not found" }, 404);
  const resolved = await getPublishedAppOrDeny(appId, user.uuid);
  if ("error" in resolved) return c.json({ message: resolved.error }, 404);
  if ((resolved.app.appVisibility ?? "public") === "space" && !(await hasPermission(user, "space.view", { spaceId: resolved.app.spaceId }))) return authzDenied(c);
  const body = await c.req.json().catch(() => null) as {
    amount?: unknown;
    operationId?: unknown;
    consumerUserId?: unknown;
    reason?: unknown;
  } | null;
  const rawAmount = typeof body?.amount === "number" ? body.amount : null;
  if (rawAmount === null || !Number.isSafeInteger(rawAmount) || rawAmount <= 0) {
    return c.json({ message: "amount must be a positive safe integer" }, 400);
  }
  const operationId = typeof body?.operationId === "string" ? body.operationId.trim() : "";
  if (!operationId || operationId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(operationId)) {
    return c.json({ message: "operationId must be 1-128 chars of [a-zA-Z0-9_-]" }, 400);
  }
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 512) : undefined;

  const execution = getExecutionPrincipal(c);
  const executionViewerUserId = resolveCommerceViewerUserId(execution, appId, user.uuid);
  if (!executionViewerUserId) return authzDenied(c);
  const consumerUserId = typeof body?.consumerUserId === "string" ? body.consumerUserId.trim() : null;
  const targetUserId = consumerUserId ?? executionViewerUserId;
  if (!canTargetCommerceViewer(execution, executionViewerUserId, consumerUserId)) return authzDenied(c);
  if (consumerUserId && consumerUserId !== executionViewerUserId) {
    if (!(await hasPermission(user, "space.commerce.manage", { spaceId: resolved.app.spaceId }))) return authzDenied(c);
  }
  try {
    const businessKey = await requireSpaceCommerceBusinessKey(resolved.app.spaceId);
    const ops = await createSpaceBusinessBillingOperations(businessKey);
    const result = await ops.consume({
      userId: targetUserId,
      amount: rawAmount,
      operationId,
      sourceId: resolved.app.appId,
      reason,
    });
    return c.json({
      status: result.status,
      amount: result.amount,
      remaining: result.remaining,
      shortfall: result.shortfall,
      businessKey,
    });
  } catch (error) {
    const response = handleAppCommerceRouteError(c, error);
    if (response) return response;
    throw error;
  }
});

router.post(`/${resource}/:id/commerce/purchase`, async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const appId = c.req.param("id");
  if (!requireValidId(appId)) return c.json({ message: "app not found" }, 404);
  const resolved = await getPublishedAppOrDeny(appId, user.uuid);
  if ("error" in resolved) return c.json({ message: resolved.error }, 404);
  if ((resolved.app.appVisibility ?? "public") === "space" && !(await hasPermission(user, "space.view", { spaceId: resolved.app.spaceId }))) return authzDenied(c);
  const body = await c.req.json().catch(() => null) as {
    productKey?: unknown;
    purchaseAttemptId?: unknown;
    promotionAttribution?: unknown;
  } | null;
  const productKey = typeof body?.productKey === "string" ? body.productKey.trim() : "";
  if (!productKey) return c.json({ message: "productKey is required" }, 400);
  const rawPurchaseAttemptId = body?.purchaseAttemptId ?? c.req.header("Idempotency-Key");
  const purchaseAttemptId = rawPurchaseAttemptId === undefined
    ? randomUUID()
    : normalizePurchaseAttemptId(rawPurchaseAttemptId);
  if (!purchaseAttemptId) {
    return c.json({
      message: "purchaseAttemptId must be 1-128 chars of [a-zA-Z0-9_-]",
    }, 400);
  }
  const promotionAttribution = parsePromotionAttribution(body?.promotionAttribution);
  const promotion = promotionAttribution
    ? await resolvePublishedAppPromotion(resolved.app.appId, promotionAttribution.promotionId)
    : null;
  try {
    const businessKey = await requireSpaceCommerceBusinessKey(resolved.app.spaceId);
    const sdk = await createSpaceCommerceSdk();
    const product = await sdk.admin.products.get({ business_key: businessKey, product_key: productKey });
    if (product.status !== "active" || product.visibility !== "public" || product.billing_type !== "one_time") {
      return c.json({ message: "product is not available" }, 400);
    }
    const amountMinor = Number(product.amount ?? 0);
    const balance = readCohubBalanceDescriptor(product);
    if (balance) {
      let balanceBenefit = null;
      try {
        const benefit = await sdk.admin.benefits.get({
          business_key: businessKey,
          benefit_key: balance.benefitKey,
        });
        if (benefit.type === "credits") balanceBenefit = benefit;
      } catch (error) {
        if (!isBillingApiError(error) || error.status !== 404) throw error;
      }
      const boundBenefitKeys = await loadBoundBenefitKeys({
        sdk,
        businessKey,
        productKey: product.key,
      });
      if (!isCohubBalanceProductValid({
        productKey: product.key,
        productAmountMinor: amountMinor,
        productCurrency: product.currency,
        balance,
        benefit: balanceBenefit,
        boundBenefitKeys,
      })) {
        return c.json({ message: "Cohub Balance configuration is invalid" }, 409);
      }
    }
    const appUrl = await resolvePublicAppUrl({
      spaceId: resolved.app.spaceId,
      appSlug: resolved.app.appSlug,
    });
    if (!appUrl) return c.json({ message: "app public url is unavailable" }, 409);
    const provisionalRedirects = buildAppCheckoutReturnUrls({ appUrl });
    const result = await sdk.admin.orders.create(
      {
        business_key: businessKey,
        external_user_id: user.uuid,
        product_key: product.key,
        billing_reason: "purchase",
        success_redirect_url: provisionalRedirects.successRedirectUrl,
        failed_redirect_url: provisionalRedirects.failedRedirectUrl,
        cancel_redirect_url: provisionalRedirects.cancelRedirectUrl,
        meta: {
          source: "cohub",
          source_type: "app",
          cohub_space_id: resolved.app.spaceId,
          cohub_app_id: resolved.app.appId,
          cohub_app_version_id: resolved.app.currentVersionId,
          cohub_purchase_attempt_id: purchaseAttemptId,
          cohub_purchase_idempotency_version: "app-purchase-v1",
          ...(promotion && promotionAttribution ? {
            cohub_promotion_id: promotion.promotion.id,
            ...(promotionAttribution.fbp ? { cohub_promotion_fbp: promotionAttribution.fbp } : {}),
            ...(promotionAttribution.fbc ? { cohub_promotion_fbc: promotionAttribution.fbc } : {}),
          } : {}),
          ...(balance ? {
            cohub_balance_amount_minor: balance.amountMinor,
            cohub_balance_benefit_key: balance.benefitKey,
            cohub_balance_policy_version: balance.policyVersion,
            cohub_balance_owner_gross_amount_minor: amountMinor - balance.amountMinor,
          } : {}),
        },
      },
      {
        idempotencyKey: createAppPurchaseIdempotencyKey({
          appId: resolved.app.appId,
          buyerUserUuid: user.uuid,
          productKey: product.key,
          purchaseAttemptId,
        }),
      },
    );
    const checkoutMoney = toPromotionMoney(amountMinor, product.currency);
    if (
      promotion
      && promotionAttribution
      && result.checkout?.checkout_usable === true
      && typeof result.checkout.checkout_url === "string"
    ) {
      recordResolvedAppPromotionEvent(c, {
        promotion: promotion.promotion,
        appVersionId: promotion.app.currentVersionId,
        eventKey: "checkout_started",
        eventId: purchaseAttemptId,
        sourceUrl: promotionAttribution.sourceUrl,
        fbp: promotionAttribution.fbp,
        fbc: promotionAttribution.fbc,
        productKey: product.key,
        value: checkoutMoney?.value,
        currency: checkoutMoney?.currency,
      });
    }
    return c.json({ checkout: {
      providerKey: result.checkout?.provider_key ?? null,
      checkoutUrl: result.checkout?.checkout_url ?? null,
      checkoutUsable: result.checkout?.checkout_usable === true,
      status: result.checkout?.status ?? null,
      message: result.checkout?.message ?? null,
      orderId: result.order.id,
      productKey: result.order.product_key_snapshot,
      value: checkoutMoney?.value ?? null,
      currency: checkoutMoney?.currency ?? null,
    } });
  } catch (error) {
    const response = handleAppCommerceRouteError(c, error);
    if (response) return response;
    throw error;
  }
});

router.get(`/${resource}/:id/commerce/orders/:orderId`, async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const appId = c.req.param("id");
  const orderId = c.req.param("orderId");
  if (!requireValidId(appId)) return c.json({ message: "app not found" }, 404);
  if (!requireValidId(orderId)) return c.json({ message: "order not found" }, 404);
  const resolved = await getPublishedAppOrDeny(appId, user.uuid);
  if ("error" in resolved) return c.json({ message: resolved.error }, 404);
  if ((resolved.app.appVisibility ?? "public") === "space" && !(await hasPermission(user, "space.view", { spaceId: resolved.app.spaceId }))) return authzDenied(c);
  const viewerUserId = resolveCommerceViewerUserId(getExecutionPrincipal(c), appId, user.uuid);
  if (!viewerUserId) return authzDenied(c);
  try {
    const businessKey = await requireSpaceCommerceBusinessKey(resolved.app.spaceId);
    const sdk = await createSpaceCommerceSdk();
    const order = await sdk.admin.orders.get({
      business_key: businessKey,
      order_id: orderId,
    });
    if (order.external_user_id !== viewerUserId) return authzDenied(c);
    return c.json({ order: serializeOrder(order) });
  } catch (error) {
    const response = handleAppCommerceRouteError(c, error);
    if (response) return response;
    throw error;
  }
  });

  return router;
}
