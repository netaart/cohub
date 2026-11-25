import { and, eq } from "drizzle-orm";
import { spaceCommerceBusinesses, spaces, apps } from "@cohub/db";
import { db } from "../db/index.js";
import {
  BillingConfigurationError,
  billingOperations,
  COHUB_BILLING_FEATURES,
  createBusinessBillingOperations,
  createTalesofaiCommerceSdk,
  type CommerceSdk,
  type CreditsBenefit,
} from "@cohub/billing";
import { createLogger } from "@cohub/infra/logging";
import { config } from "../config.js";
import { isBillingApiError } from "./billing-api-error.js";

const BILLING_NAMESPACE = "cohub_space";

const logger = createLogger({ serviceName: "cohub-api" });

/**
 * Resolves the space commerce entitlement. Returns `true` when entitled,
 * `false` when explicitly not entitled, or `null` when the billing service
 * could not be reached — letting callers distinguish a missing subscription
 * (402) from a transient verification failure (503) instead of masking a
 * billing outage as an upgrade prompt.
 */
export async function resolveSpaceCommerceEntitlement(
  userId: string,
): Promise<boolean | null> {
  try {
    const entitlement = await billingOperations.getFeatureEntitlement({
      userId,
      featureKey: COHUB_BILLING_FEATURES.spaceCommerce,
    });
    return Boolean(entitlement?.enabled);
  } catch (error) {
    logger.warn("[space-commerce] failed to check commerce entitlement", {
      userId,
      error,
    });
    return null;
  }
}

export class SpaceCommerceNotInitializedError extends Error {
  override name = "SpaceCommerceNotInitializedError";

  constructor(readonly spaceId: string) {
    super("Space commerce is not initialized");
  }
}

export type SpaceCommerceSdk = CommerceSdk;

function requireBillingClientConfig() {
  const baseUrl = config.talesofaiBillingBaseUrl?.trim();
  const adminApiKey = config.talesofaiBillingAdminApiKey?.trim();
  if (!baseUrl || !adminApiKey) throw new BillingConfigurationError();
  return { baseUrl, adminApiKey };
}

export async function createSpaceCommerceSdk(): Promise<SpaceCommerceSdk> {
  return createTalesofaiCommerceSdk(requireBillingClientConfig());
}

export async function createSpaceBusinessBillingOperations(businessKey: string) {
  return createBusinessBillingOperations({
    clientConfig: { ...requireBillingClientConfig(), businessKey },
    businessKey,
  });
}

export async function loadBusinessCreditBenefits(input: {
  sdk: SpaceCommerceSdk;
  businessKey: string;
}): Promise<Map<string, CreditsBenefit>> {
  const creditBenefits = new Map<string, CreditsBenefit>();
  let page = 1;
  while (true) {
    const result = await input.sdk.admin.benefits.list({
      business_key: input.businessKey,
      include_count: false,
      limit: 100,
      page,
    });
    for (const benefit of result.items) {
      if (benefit.type !== "credits") continue;
      creditBenefits.set(benefit.key, benefit);
    }
    if (!result.pagination.has_more) break;
    page += 1;
  }
  return creditBenefits;
}

export async function loadBoundBenefitKeys(input: {
  sdk: SpaceCommerceSdk;
  businessKey: string;
  productKey: string;
}): Promise<string[]> {
  const bindings = await input.sdk.admin.products.listBenefits({
    business_key: input.businessKey,
    product_key: input.productKey,
  });
  return bindings.map((binding) => binding.benefit_key);
}

function normalizeBusinessKeyValue(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

function buildBillingBusinessKey(spaceId: string) {
  return `${BILLING_NAMESPACE}_${normalizeBusinessKeyValue(spaceId)}`;
}

function appendCheckoutQuery(urlString: string, input: { status: "success" | "failed" | "cancel"; orderId?: string | null }) {
  const url = new URL(urlString);
  url.searchParams.set("cohub_checkout", input.status);
  if (input.orderId) url.searchParams.set("cohub_order", input.orderId);
  return url.toString();
}

function buildBillingBusinessName(input: { spaceName: string; spaceId: string }) {
  const name = input.spaceName.trim() || input.spaceId;
  const suffix = input.spaceId.slice(0, 8);
  return `Cohub Space · ${name} · ${suffix}`.slice(0, 256);
}

export async function getSpaceCommerceBusiness(spaceId: string) {
  const [mapping] = await db
    .select()
    .from(spaceCommerceBusinesses)
    .where(eq(spaceCommerceBusinesses.spaceId, spaceId))
    .limit(1);
  return mapping ?? null;
}

export async function ensureSpaceCommerceBusiness(spaceId: string) {
  const existing = await getSpaceCommerceBusiness(spaceId);
  if (existing) return existing;

  const [space] = await db
    .select({ id: spaces.id, name: spaces.name })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1);
  if (!space) throw new Error("Space not found");

  const businessKey = buildBillingBusinessKey(space.id);
  const sdk = await createSpaceCommerceSdk();
  try {
    await sdk.admin.businesses.create({
      key: businessKey,
      name: buildBillingBusinessName({ spaceName: space.name, spaceId: space.id }),
      status: "active",
    });
  } catch (error) {
    if (!isBillingApiError(error) || error.status !== 409) throw error;
  }

  const [mapping] = await db
    .insert(spaceCommerceBusinesses)
    .values({
      spaceId: space.id,
      billingBusinessKey: businessKey,
    })
    .onConflictDoUpdate({
      target: spaceCommerceBusinesses.spaceId,
      set: {
        billingBusinessKey: businessKey,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!mapping) throw new Error("Failed to persist space commerce business mapping");
  return mapping;
}

export async function requireSpaceCommerceBusiness(spaceId: string) {
  const mapping = await getSpaceCommerceBusiness(spaceId);
  if (!mapping) throw new SpaceCommerceNotInitializedError(spaceId);
  return mapping;
}

export async function getSpaceCommerceBusinessKey(spaceId: string) {
  return (await getSpaceCommerceBusiness(spaceId))?.billingBusinessKey ?? null;
}

export async function requireSpaceCommerceBusinessKey(spaceId: string) {
  return (await requireSpaceCommerceBusiness(spaceId)).billingBusinessKey;
}

export async function ensureSpaceCommerceBusinessKey(spaceId: string) {
  return (await ensureSpaceCommerceBusiness(spaceId)).billingBusinessKey;
}

export async function getAppCommerceContextById(appId: string) {
  const [row] = await db
    .select({
      appId: apps.id,
      appSlug: apps.slug,
      appStatus: apps.status,
      appVisibility: apps.visibility,
      currentVersionId: apps.currentVersionId,
      spaceId: apps.spaceId,
    })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1);
  if (!row) return null;
  return row;
}

export async function getAppCommerceContextBySpaceAndSlug(input: {
  spaceId: string;
  appSlug: string;
}) {
  const [row] = await db
    .select({
      appId: apps.id,
      appSlug: apps.slug,
      appStatus: apps.status,
      appVisibility: apps.visibility,
      currentVersionId: apps.currentVersionId,
      spaceId: apps.spaceId,
    })
    .from(apps)
    .where(and(eq(apps.spaceId, input.spaceId), eq(apps.slug, input.appSlug)))
    .limit(1);
  return row ?? null;
}

export function buildAppCheckoutReturnUrls(input: { appUrl: string; orderId?: string | null }) {
  return {
    successRedirectUrl: appendCheckoutQuery(input.appUrl, { status: "success", orderId: input.orderId }),
    failedRedirectUrl: appendCheckoutQuery(input.appUrl, { status: "failed", orderId: input.orderId }),
    cancelRedirectUrl: appendCheckoutQuery(input.appUrl, { status: "cancel", orderId: input.orderId }),
  };
}
