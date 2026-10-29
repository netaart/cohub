// Optional hosted-billing provider. Requires @talesofai-billing/sdk at runtime.

import {
  benefitsFeature,
  type Benefit,
  type CreditsBenefit,
} from "@talesofai-billing/sdk/admin/benefits";
import {
  discountsFeature,
  type Discount,
  type DiscountPreviewResponse,
} from "@talesofai-billing/sdk/admin/discounts";
import { businessesFeature } from "@talesofai-billing/sdk/admin/businesses";
import {
  creditsFeature,
  type CreditGrant,
  type CreditTransaction,
  type UsageOverage,
} from "@talesofai-billing/sdk/admin/credits";
import { customersFeature } from "@talesofai-billing/sdk/admin/customers";
import {
  type CreateOrderResponse,
  type GetOrderResponse,
  ordersFeature,
} from "@talesofai-billing/sdk/admin/orders";
import {
  type Product,
  productsFeature,
} from "@talesofai-billing/sdk/admin/products";
import { redemptionCodesFeature } from "@talesofai-billing/sdk/admin/redemption-codes";
import { providersFeature } from "@talesofai-billing/sdk/admin/providers";
import {
  type CreateSubscriptionResponse,
  type GetSubscriptionResponse,
  type Subscription,
  type SubscriptionCheckout,
  subscriptionsFeature,
} from "@talesofai-billing/sdk/admin/subscriptions";
import { ApiError, createSdk } from "@talesofai-billing/sdk/base";
import { createHash, randomUUID } from "node:crypto";
import {
  COHUB_BILLING_BENEFITS,
  COHUB_BILLING_CREDIT_UNITS,
  COHUB_BILLING_TOKEN_TYPES,
  COHUB_BILLING_USAGE_TYPES,
  type BillingAccountState,
  type BillingBalanceActivity,
  type BillingBalanceActivityList,
  type BillingBalanceActivityListInput,
  type BillingCatalog,
  type BillingCatalogProduct,
  type BillingCheckoutInput,
  type BillingCheckoutConfirmation,
  type BillingCheckoutResult,
  type BillingDiscountOffer,
  type BillingDiscountPricing,
  type BillingProductPromotion,
  type BillingProductCreditBenefit,
  type BillingCreditBalance,
  type BillingCreditExpiryGroup,
  type BillingCreditGrantStatus,
  type BillingCreditStatus,
  type BillingCreditUnit,
  type BusinessBillingOperations,
  type BusinessCreditConsumeResult,
  type BillingFeatureEntitlement,
  type BillingFeatureLimitCheck,
  type BillingFeatureLimitInput,
  type BillingHistoryListInput,
  type BillingOperations,
  type BillingPaymentStatus,
  type BillingPluginStatus,
  type BillingPromotionCodePreview,
  type BillingPromotionCodePreviewInput,
  type BillingRedemptionInput,
  type BillingRedemptionResult,
  type BillingSubscriptionHistoryList,
  type BillingSubscriptionHistoryStatus,
  type BillingUsagePreflight,
  type BillingUsagePreflightInput,
  type BillingUsageRecordInput,
  type BillingUsageRecordResult,
  type BillingUserRef,
} from "./interfaces.js";
import { resolveGenerationModelDiscount } from "./generation-usage.js";
import type { BillingClientConfig } from "./types.js";
import { checkoutLockRedisRef } from "./runtime.js";

class BillingConfigurationError extends Error {
  constructor(message = "Talesofai Billing is not configured") {
    super(message);
    this.name = "BillingConfigurationError";
  }
}

function createConfiguredSdk(input: BillingClientConfig) {
  return createSdk({
    baseURL: input.baseUrl,
    adminApiKey: input.adminApiKey,
  })
    .useAdmin(benefitsFeature())
    .useAdmin(businessesFeature())
    .useAdmin(customersFeature())
    .useAdmin(creditsFeature())
    .useAdmin(discountsFeature())
    .useAdmin(productsFeature())
    .useAdmin(ordersFeature())
    .useAdmin(redemptionCodesFeature())
    .useAdmin(subscriptionsFeature())
    .useAdmin(providersFeature());
}

type ConfiguredBillingSdk = ReturnType<typeof createConfiguredSdk>;

type FirstPurchaseCampaign = {
  key: string;
  revision: string;
  discount: Discount;
};

type FirstPurchaseCampaigns = {
  subscription: FirstPurchaseCampaign | null;
  addons: Map<string, FirstPurchaseCampaign>;
};

type ResolvedCheckoutDiscount = {
  discountId: string;
  createSelector: { discount_id: string } | { discount_code: string };
  selectionKey: string;
};

const FIRST_PURCHASE_MARKER = "cohub_first_purchase_default_v1";
const FIRST_PURCHASE_PRODUCT_KEY = "cohub_first_purchase_product_key";
const FIRST_SUBSCRIPTION_OFFER_KEY = "cohub-first-subscription-v1";
const CHECKOUT_RETURN_PARAM = "cohub_billing";
const CHECKOUT_PRODUCT_PARAM = "cohub_billing_product";
const MAX_PROMOTION_CODE_LENGTH = 256;

const ENSURE_CUSTOMER_CACHE_TTL_MS = 5 * 60 * 1000;
const BILLING_STATIC_CATALOG_CACHE_TTL_SECONDS = 6 * 60 * 60;
const FIRST_PURCHASE_CAMPAIGN_CACHE_TTL_SECONDS = 60;
const BILLING_OFFER_PREVIEW_CACHE_TTL_SECONDS = 60;
const BILLING_PURCHASE_FACTS_CACHE_TTL_SECONDS = 15;
const BILLING_CATALOG_APP_NAME = "cohub";
const CHECKOUT_LOCK_TTL_MS = 30_000;
const CHECKOUT_LOCK_RETRY_DELAY_MS = 250;
const CHECKOUT_LOCK_RETRY_COUNT = 24;
const CREDIT_LIST_PAGE_LIMIT = 100;
const CREDIT_LIST_MAX_PAGES = 20;
const CREDIT_GRANT_DISPLAY_STATUSES = [
  "active",
  "depleted",
  "expired",
] as const;
const BILLING_CURRENT_SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due"] as const;
const BILLING_BLOCKING_SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "payment_conflicted",
] as const;
const BILLING_AUTO_RENEW_CANCELABLE_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
] as const;
const CREDIT_BENEFIT_DISPLAY_NAMES: Record<string, string> = {
  free_monthly_credits: "Free Plan Credits",
};
type BillingListPage<T> = {
  items: T[];
  pagination: {
    has_more: boolean;
  };
};
type CreditGrantDisplayStatus = (typeof CREDIT_GRANT_DISPLAY_STATUSES)[number];

function isCohubCatalogProduct(product: Product): boolean {
  return product.meta?.appName === BILLING_CATALOG_APP_NAME;
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function normalizeAmount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Number(value.toFixed(8));
}

function normalizeRedemptionCode(value: string): string {
  return value.trim();
}

function redemptionIdempotencyKey(input: {
  userId: string;
  code: string;
}): string {
  const codeHash = createHash("sha256")
    .update(normalizeRedemptionCode(input.code))
    .digest("hex");
  return `cohub:billing:redemption:${input.userId}:${codeHash}`;
}

function roundUsd(
  value: number,
  decimalPlaces: number = COHUB_BILLING_CREDIT_UNITS.usdMicroCent.usdDecimalPlaces,
): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(decimalPlaces));
}

function getCreditUnit(tokenType: string): BillingCreditUnit {
  if (tokenType === COHUB_BILLING_TOKEN_TYPES.usdMicroCent)
    return COHUB_BILLING_CREDIT_UNITS.usdMicroCent;
  if (tokenType === COHUB_BILLING_TOKEN_TYPES.cohubCredit)
    return COHUB_BILLING_CREDIT_UNITS.cohubCredit;
  return {
    tokenType,
    displayCurrency: "USD",
    displayUnit: COHUB_BILLING_CREDIT_UNITS.usdMicroCent.displayUnit,
    unitToUsd: COHUB_BILLING_CREDIT_UNITS.usdMicroCent.unitToUsd,
    unitsPerUsd: COHUB_BILLING_CREDIT_UNITS.usdMicroCent.unitsPerUsd,
    usdDecimalPlaces: COHUB_BILLING_CREDIT_UNITS.usdMicroCent.usdDecimalPlaces,
  };
}

function amountToUsd(amount: number, tokenType: string): number {
  const unit = getCreditUnit(tokenType);
  return roundUsd(amount * unit.unitToUsd, unit.usdDecimalPlaces);
}

function usdToAmount(amountUsd: number, tokenType: string): number {
  const unit = getCreditUnit(tokenType);
  const roundedUsd = roundUsd(amountUsd, unit.usdDecimalPlaces);
  if (roundedUsd <= 0) return 0;
  return Math.round(roundedUsd * unit.unitsPerUsd);
}

function mapCreditBalance(
  summary: BillingCreditBalance["raw"],
): BillingCreditBalance {
  return {
    tokenType: summary.token_type,
    availableBalance: summary.available_balance,
    openOverageBalance: summary.open_overage_balance,
    netBalance: summary.net_balance,
    raw: summary,
  };
}

function mergeFeatureMetadata(
  current: BillingFeatureEntitlement["metadata"],
  next: BillingFeatureEntitlement["metadata"],
): BillingFeatureEntitlement["metadata"] {
  const merged = { ...current };
  for (const [key, value] of Object.entries(next)) {
    const existing = merged[key];
    if (typeof value === "boolean") {
      merged[key] = existing === true || value;
      continue;
    }
    if (typeof value === "number") {
      merged[key] =
        typeof existing === "number" ? Math.max(existing, value) : value;
      continue;
    }
    if (existing === undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

function mapFeatureEntitlements(
  activeBenefits: BillingFeatureEntitlement["grants"],
): BillingFeatureEntitlement[] {
  const byKey = new Map<string, BillingFeatureEntitlement>();
  for (const benefit of activeBenefits) {
    const metadata = benefit.config.metadata ?? {};
    const enabled = metadata.enabled !== false;
    const existing = byKey.get(benefit.benefit_key);
    if (existing) {
      existing.enabled = existing.enabled || enabled;
      existing.metadata = mergeFeatureMetadata(existing.metadata, metadata);
      existing.grants.push(benefit);
      continue;
    }
    byKey.set(benefit.benefit_key, {
      key: benefit.benefit_key,
      enabled,
      metadata: { ...metadata },
      grants: [benefit],
    });
  }
  return [...byKey.values()];
}

async function getCustomerStateOrEmpty(input: {
  sdk: ConfiguredBillingSdk;
  businessKey: string;
  userId: string;
}): Promise<BillingAccountState | null> {
  try {
    const state = await input.sdk.admin.customers.getState({
      external_user_id: input.userId,
      business_key: input.businessKey,
    });
    return {
      userId: input.userId,
      credits: state.credits.map(mapCreditBalance),
      entitlements: mapFeatureEntitlements(state.active_benefits),
    };
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return null;
  }
}

async function getCustomerCreditsOrEmpty(input: {
  sdk: ConfiguredBillingSdk;
  businessKey: string;
  userId: string;
}): Promise<(BillingUserRef & { credits: BillingCreditBalance[] }) | null> {
  try {
    const credits = await input.sdk.admin.customers.getCredits({
      external_user_id: input.userId,
      business_key: input.businessKey,
    });
    return {
      userId: input.userId,
      credits: credits.credits.map(mapCreditBalance),
    };
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return null;
  }
}

async function getCustomerEntitlementsOrEmpty(input: {
  sdk: ConfiguredBillingSdk;
  businessKey: string;
  userId: string;
}): Promise<
  (BillingUserRef & { entitlements: BillingFeatureEntitlement[] }) | null
> {
  try {
    const entitlements = await input.sdk.admin.customers.getEntitlements({
      external_user_id: input.userId,
      business_key: input.businessKey,
    });
    return {
      userId: input.userId,
      entitlements: mapFeatureEntitlements(entitlements.active_benefits),
    };
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return null;
  }
}

function findBalance(
  credits: BillingCreditBalance[],
  tokenType: string,
): BillingCreditBalance | null {
  return credits.find((credit) => credit.tokenType === tokenType) ?? null;
}

function daysUntil(
  expiresAt: string | null | undefined,
  now = new Date(),
): number | null {
  if (!expiresAt) return null;
  const expires = new Date(expiresAt);
  if (Number.isNaN(expires.getTime())) return null;
  return Math.ceil((expires.getTime() - now.getTime()) / 86_400_000);
}

function getExpiryGroupKey(
  daysRemaining: number | null,
): BillingCreditExpiryGroup["key"] {
  if (daysRemaining === null) return "never";
  if (daysRemaining <= 0) return "expired";
  if (daysRemaining <= 7) return "lt_7d";
  if (daysRemaining <= 30) return "lt_30d";
  return "gte_30d";
}

function humanizeIdentifier(value: string): string {
  return value
    .split(/[_\s.-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveCreditGrantBenefitName(grant: CreditGrant): string | null {
  const benefitName = grant.benefit_name?.trim();
  if (benefitName) return benefitName;
  const benefitKey = grant.benefit_key?.trim();
  if (!benefitKey) return null;
  return (
    CREDIT_BENEFIT_DISPLAY_NAMES[benefitKey] ?? humanizeIdentifier(benefitKey)
  );
}

function optionalAmount(value: number | undefined, tokenType: string) {
  if (typeof value !== "number") return { amount: null, amountUsd: null };
  return {
    amount: normalizeAmount(value),
    amountUsd: amountToUsd(value, tokenType),
  };
}

function getCreditGrantUnavailableReasons(
  grant: CreditGrant,
): string[] {
  return Array.isArray(grant.unavailable_reasons)
    ? grant.unavailable_reasons
    : [];
}

function isCreditGrantDisplayable(grant: CreditGrant): boolean {
  if (grant.available_now !== false) return true;
  const reasons = getCreditGrantUnavailableReasons(grant);
  return reasons.length > 0 && reasons.every((reason) => reason === "depleted");
}

function mapCreditGrant(
  grant: CreditGrant,
  now = new Date(),
): BillingCreditGrantStatus {
  const daysRemaining = daysUntil(grant.expires_at ?? null, now);
  const consumed = optionalAmount(grant.consumed_amount, grant.token_type);
  const usageConsumed = optionalAmount(
    grant.usage_consumed_amount,
    grant.token_type,
  );
  const settledOverage = optionalAmount(
    grant.settled_overage_amount,
    grant.token_type,
  );
  const originalAmount =
    typeof grant.original_amount === "number"
      ? normalizeAmount(grant.original_amount)
      : null;
  const originalAmountUsd =
    typeof grant.original_amount === "number"
      ? amountToUsd(grant.original_amount, grant.token_type)
      : null;
  const consumedPercent =
    originalAmount && consumed.amount !== null
      ? Math.min(
          100,
          Math.max(
            0,
            Number(((consumed.amount / originalAmount) * 100).toFixed(1)),
          ),
        )
      : null;
  return {
    id: grant.id,
    tokenType: grant.token_type,
    benefitKey: grant.benefit_key ?? null,
    benefitName: resolveCreditGrantBenefitName(grant),
    grantKind: grant.grant_kind ?? null,
    sourceType: grant.source_type ?? null,
    sourceId: grant.source_id ?? null,
    status: grant.status,
    availableNow: grant.available_now ?? null,
    unavailableReasons: getCreditGrantUnavailableReasons(grant),
    remainingAmount: normalizeAmount(grant.remaining_amount),
    remainingAmountUsd: amountToUsd(grant.remaining_amount, grant.token_type),
    originalAmount,
    originalAmountUsd,
    consumedAmount: consumed.amount,
    consumedAmountUsd: consumed.amountUsd,
    usageConsumedAmount: usageConsumed.amount,
    usageConsumedAmountUsd: usageConsumed.amountUsd,
    settledOverageAmount: settledOverage.amount,
    settledOverageAmountUsd: settledOverage.amountUsd,
    consumedPercent,
    effectiveAt: grant.effective_at ?? null,
    expiresAt: grant.expires_at ?? null,
    daysRemaining,
    createdAt: grant.created_at,
  };
}

function createdAtDesc(
  left: BillingCreditGrantStatus,
  right: BillingCreditGrantStatus,
): number {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  const leftValue = Number.isNaN(leftTime) ? 0 : leftTime;
  const rightValue = Number.isNaN(rightTime) ? 0 : rightTime;
  return rightValue - leftValue;
}

function groupCreditGrants(
  grants: BillingCreditGrantStatus[],
): BillingCreditExpiryGroup[] {
  const orderedKeys: BillingCreditExpiryGroup["key"][] = [
    "lt_7d",
    "lt_30d",
    "gte_30d",
    "never",
    "expired",
  ];
  const byKey = new Map<
    BillingCreditExpiryGroup["key"],
    BillingCreditExpiryGroup
  >();
  for (const key of orderedKeys) {
    byKey.set(key, {
      key,
      remainingAmountUsd: 0,
      grants: [],
    });
  }
  for (const grant of grants) {
    const key = getExpiryGroupKey(grant.daysRemaining);
    const group = byKey.get(key);
    if (!group) continue;
    group.remainingAmountUsd = normalizeAmount(
      group.remainingAmountUsd + grant.remainingAmountUsd,
    );
    group.grants.push(grant);
  }
  for (const group of byKey.values()) {
    group.grants.sort(createdAtDesc);
  }
  return orderedKeys
    .map((key) => byKey.get(key))
    .filter(
      (group): group is BillingCreditExpiryGroup =>
        !!group && group.grants.length > 0,
    );
}

type UsageActivityDraft = {
  id: string;
  tokenType: string;
  usageType: string | null;
  sourceType: string | null;
  sourceId: string | null;
  operationId: string | null;
  reason: string | null;
  createdAt: string;
  coveredAmountUsd: number;
  overageAmountUsd: number;
};

function balanceActivityCreatedAtDesc(a: { createdAt: string }, b: { createdAt: string }): number {
  const leftTime = Date.parse(a.createdAt);
  const rightTime = Date.parse(b.createdAt);
  const leftValue = Number.isNaN(leftTime) ? 0 : leftTime;
  const rightValue = Number.isNaN(rightTime) ? 0 : rightTime;
  return rightValue - leftValue;
}

function formatBillingLabel(value: string | null): string {
  if (!value) return "Usage";
  return value
    .split(/[._-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function transactionActivityTitle(type: CreditTransaction["type"]): string {
  switch (type) {
    case "grant":
      return "Credits added";
    case "refund":
      return "Refund";
    case "expire":
      return "Credits expired";
    case "revoke":
      return "Credits revoked";
    case "adjust":
      return "Balance adjusted";
    default:
      return "Balance activity";
  }
}

function transactionActivityAmountUsd(transaction: CreditTransaction): number {
  const amountUsd = amountToUsd(transaction.amount, transaction.token_type);
  switch (transaction.type) {
    case "consume":
    case "expire":
    case "revoke":
      return -amountUsd;
    case "grant":
    case "refund":
    case "adjust":
      return amountUsd;
    case "settlement":
      return 0;
    default:
      return amountUsd;
  }
}

function mapTransactionActivity(
  transaction: CreditTransaction,
): BillingBalanceActivity | null {
  if (transaction.type === "consume" || transaction.type === "settlement") {
    return null;
  }
  const amountUsd = transactionActivityAmountUsd(transaction);
  if (amountUsd === 0) return null;
  return {
    id: `transaction:${transaction.id}`,
    kind: transaction.type,
    tokenType: transaction.token_type,
    title: transactionActivityTitle(transaction.type),
    description: transaction.reason ?? transaction.source_type ?? null,
    sourceType: transaction.source_type ?? null,
    sourceId: transaction.source_id ?? null,
    operationId: transaction.operation_id ?? null,
    amountUsd,
    status: null,
    createdAt: transaction.created_at,
  };
}

function getUsageActivityDraft(
  drafts: Map<string, UsageActivityDraft>,
  input: {
    id: string;
    tokenType: string;
    usageType: string | null;
    sourceType: string | null;
    sourceId: string | null;
    operationId: string | null;
    reason: string | null;
    createdAt: string;
  },
): UsageActivityDraft {
  const key = input.operationId ? `operation:${input.operationId}` : input.id;
  const existing = drafts.get(key);
  if (existing) {
    if (new Date(input.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
      existing.createdAt = input.createdAt;
    }
    existing.usageType ??= input.usageType;
    existing.sourceType ??= input.sourceType;
    existing.sourceId ??= input.sourceId;
    existing.reason ??= input.reason;
    return existing;
  }
  const draft: UsageActivityDraft = {
    id: key,
    tokenType: input.tokenType,
    usageType: input.usageType,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    operationId: input.operationId,
    reason: input.reason,
    createdAt: input.createdAt,
    coveredAmountUsd: 0,
    overageAmountUsd: 0,
  };
  drafts.set(key, draft);
  return draft;
}

function mapUsageActivity(draft: UsageActivityDraft): BillingBalanceActivity | null {
  const totalAmountUsd = roundUsd(draft.coveredAmountUsd + draft.overageAmountUsd);
  if (totalAmountUsd <= 0) return null;
  const hasCovered = draft.coveredAmountUsd > 0;
  const hasOverage = draft.overageAmountUsd > 0;
  return {
    id: `usage:${draft.id}`,
    kind: "usage",
    tokenType: draft.tokenType,
    title: formatBillingLabel(draft.usageType),
    description: draft.reason ?? draft.sourceType,
    sourceType: draft.sourceType,
    sourceId: draft.sourceId,
    operationId: draft.operationId,
    amountUsd: -totalAmountUsd,
    status: hasCovered && hasOverage ? "partial" : hasOverage ? "overage" : "covered",
    createdAt: draft.createdAt,
  };
}

function addUsageTransactionDraft(
  drafts: Map<string, UsageActivityDraft>,
  transaction: CreditTransaction,
): void {
  const draft = getUsageActivityDraft(drafts, {
    id: `transaction:${transaction.id}`,
    tokenType: transaction.token_type,
    usageType: transaction.usage_type ?? null,
    sourceType: transaction.source_type ?? null,
    sourceId: transaction.source_id ?? null,
    operationId: transaction.operation_id ?? null,
    reason: transaction.reason ?? null,
    createdAt: transaction.created_at,
  });
  draft.coveredAmountUsd = roundUsd(
    draft.coveredAmountUsd + amountToUsd(transaction.amount, transaction.token_type),
  );
}

function addUsageOverageDraft(
  drafts: Map<string, UsageActivityDraft>,
  overage: UsageOverage,
): void {
  const draft = getUsageActivityDraft(drafts, {
    id: `overage:${overage.id}`,
    tokenType: overage.token_type,
    usageType: overage.usage_type ?? null,
    sourceType: overage.source_type,
    sourceId: overage.source_id,
    operationId: overage.operation_id,
    reason: overage.reason ?? null,
    createdAt: overage.created_at,
  });
  draft.overageAmountUsd = roundUsd(
    draft.overageAmountUsd + amountToUsd(overage.original_amount, overage.token_type),
  );
}

function buildBalanceActivities(input: {
  transactions: CreditTransaction[];
  overages: UsageOverage[];
}): BillingBalanceActivity[] {
  const usageDrafts = new Map<string, UsageActivityDraft>();
  const activities: BillingBalanceActivity[] = [];
  for (const transaction of input.transactions) {
    if (transaction.type === "consume") {
      addUsageTransactionDraft(usageDrafts, transaction);
      continue;
    }
    const activity = mapTransactionActivity(transaction);
    if (activity) activities.push(activity);
  }
  for (const overage of input.overages) {
    addUsageOverageDraft(usageDrafts, overage);
  }
  for (const draft of usageDrafts.values()) {
    const activity = mapUsageActivity(draft);
    if (activity) activities.push(activity);
  }
  return activities.sort(balanceActivityCreatedAtDesc);
}

function minorAmountToUsd(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  return Number((amount / 100).toFixed(2));
}

function normalizePromotionCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (!code || code.length > MAX_PROMOTION_CODE_LENGTH) {
    throw billingApiError(
      400,
      "Promotion code is invalid",
      "promotion_code_invalid",
    );
  }
  return code;
}

function discountPricing(
  pricing: Extract<DiscountPreviewResponse, { eligible: true }>["pricing"],
): BillingDiscountPricing {
  return {
    amountMinor: pricing.amount,
    amountUsd: minorAmountToUsd(pricing.amount),
    discountAmountMinor: pricing.discount_amount,
    discountAmountUsd: minorAmountToUsd(pricing.discount_amount),
    paidAmountMinor: pricing.paid_amount,
    paidAmountUsd: minorAmountToUsd(pricing.paid_amount),
    currency: pricing.currency,
  };
}

function firstPurchaseRevision(
  key: string,
  discount: Discount,
): string {
  return createHash("sha256")
    .update(JSON.stringify([key, discount.id, discount.version]))
    .digest("hex");
}

function checkoutSelectionKey(input: BillingCheckoutInput): string {
  const selection = input.promotionCode
    ? `code:${input.promotionCode.trim().toUpperCase()}`
    : input.offer
      ? `preset:${input.offer.key}:${input.offer.revision}`
      : "base";
  return createHash("sha256").update(selection).digest("hex");
}

/**
 * A first-purchase Discount must be automatic (no code), a one-off percentage
 * and limited to one redemption per customer. The percentage itself is read
 * from the Discount so operators can retune the campaign without a deploy.
 */
function isValidFirstPurchaseDiscount(discount: Discount): boolean {
  return (
    discount.code_preview === null &&
    discount.effect.type === "percentage" &&
    typeof discount.effect.percentage_bps === "number" &&
    discount.effect.percentage_bps >= 100 &&
    discount.effect.percentage_bps <= 10_000 &&
    discount.duration.type === "once" &&
    discount.max_redemptions_per_customer === 1
  );
}

function firstPurchasePromotion(
  campaign: FirstPurchaseCampaign | null,
): BillingProductPromotion | null {
  if (!campaign) return null;
  const bps = campaign.discount.effect.percentage_bps ?? 0;
  return {
    kind: "first_purchase",
    percentOff: Math.round(bps / 100),
    endsAt: campaign.discount.ends_at ?? null,
  };
}

function newestDiscount(
  current: Discount | undefined,
  candidate: Discount,
): Discount {
  if (!current) return candidate;
  if (candidate.created_at !== current.created_at) {
    return candidate.created_at > current.created_at ? candidate : current;
  }
  return candidate.id > current.id ? candidate : current;
}

function normalizeBillingPage(value: number | undefined): number {
  return Math.max(1, Math.floor(value ?? 1));
}

function normalizeBillingLimit(value: number | undefined): number {
  return Math.min(10, Math.max(1, Math.floor(value ?? 10)));
}

function billingApiError(
  statusCode: number,
  message: string,
  code?: string,
): ApiError {
  return new ApiError({
    status: statusCode,
    message,
    code,
    responseBody: { message, code },
  });
}

function getCheckoutUnavailableReason(
  checkout: SubscriptionCheckout | undefined,
): string | null {
  if (checkout?.checkout_usable === true && checkout.checkout_url) return null;
  return checkout?.message ?? null;
}

function isProviderBackedSubscriptionCheckout(
  checkout: SubscriptionCheckout | undefined,
): boolean {
  return optionalString(checkout?.provider_key) !== null;
}

function mapSubscriptionHistoryStatus(
  subscription: Subscription,
  checkout?: SubscriptionCheckout,
): BillingSubscriptionHistoryStatus {
  const providerStatus =
    checkout?.subscription_status ?? checkout?.provider_request_status ?? null;
  const canPay =
    subscription.status === "pending_checkout" &&
    checkout?.checkout_usable === true &&
    !!checkout.checkout_url;
  const canCancelAutoRenew =
    BILLING_AUTO_RENEW_CANCELABLE_SUBSCRIPTION_STATUSES.includes(
      subscription.status as (typeof BILLING_AUTO_RENEW_CANCELABLE_SUBSCRIPTION_STATUSES)[number],
    ) &&
    subscription.cancel_at_period_end === false &&
    subscription.current_period_end !== null &&
    isProviderBackedSubscriptionCheckout(checkout);
  return {
    id: subscription.id,
    externalUserId: subscription.external_user_id,
    productKey: subscription.product_key_snapshot,
    productName: subscription.product_name_snapshot,
    status: subscription.status,
    amountMinor: subscription.amount_snapshot,
    amountUsd: minorAmountToUsd(subscription.amount_snapshot),
    paidAmountMinor: subscription.paid_amount_snapshot,
    paidAmountUsd: minorAmountToUsd(subscription.paid_amount_snapshot),
    currency: subscription.currency_snapshot,
    billingPeriod: subscription.billing_period_snapshot,
    billingIntervalCount: subscription.billing_interval_count_snapshot,
    currentPeriodStart: subscription.current_period_start,
    currentPeriodEnd: subscription.current_period_end,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    renewalRecovery: mapRenewalRecovery(subscription),
    canceledAt: subscription.canceled_at,
    checkoutExpiresAt: subscription.checkout_expires_at,
    checkoutCanceledAt: subscription.checkout_canceled_at,
    checkoutExpiredAt: subscription.checkout_expired_at,
    paymentConflictedAt: subscription.payment_conflicted_at,
    endedAt: subscription.ended_at,
    createdAt: subscription.created_at,
    updatedAt: subscription.updated_at,
    providerStatus,
    providerTerminal: false,
    checkoutStatus: checkout?.status ?? null,
    actions: {
      canPay,
      checkoutUrl: canPay ? (checkout?.checkout_url ?? null) : null,
      checkoutUsable: canPay,
      canCancelCheckout: subscription.status === "pending_checkout",
      canCancelAutoRenew,
      unavailableReason: canPay ? null : getCheckoutUnavailableReason(checkout),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function checkoutDiscountId(value: {
  discount?: { discount_id?: string };
}): string | null {
  return optionalString(value.discount?.discount_id);
}

function optionalNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string =>
      typeof item === "string" && item.trim().length > 0,
  );
}

function uniqueStringArray(value: unknown): string[] {
  return [
    ...new Set(
      stringArray(value)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function recordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
}

function firstOptionalNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const number = optionalNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function firstOptionalString(...values: unknown[]): string | null {
  for (const value of values) {
    const string = optionalString(value);
    if (string !== null) return string;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getProductInterval(
  product: Product,
): BillingCatalogProduct["interval"] {
  if (product.billing_type === "one_time") return "one_time";
  if (
    product.billing_type !== "recurring" ||
    product.billing_period !== "month"
  )
    return "other";
  switch (product.billing_interval_count) {
    case 1:
      return "monthly";
    case 3:
      return "quarterly";
    case 12:
      return "yearly";
    default:
      return "other";
  }
}

function isCreditsBenefit(benefit: Benefit): benefit is CreditsBenefit {
  return benefit.type === "credits";
}

function isProductCreditsBenefit(
  product: Product,
  benefit: CreditsBenefit,
): boolean {
  const grantKind =
    product.billing_type === "recurring" ? "plan_period" : "purchased";
  if (benefit.config.grant_kind !== grantKind) return false;
  const meta = asRecord(product.meta) ?? {};
  const display = asRecord(meta.display) ?? {};
  const configuredKeys = uniqueStringArray(
    display.credit_benefit_keys ??
      display.creditBenefitKeys ??
      meta.credit_benefit_keys,
  );
  if (configuredKeys.length > 0) return configuredKeys.includes(benefit.key);
  const productKey = product.key.toLowerCase();
  const benefitKey = benefit.key.toLowerCase();
  const exactKeys = new Set([
    `${productKey}_credits`,
    `${productKey}_benefit`,
    `${productKey}_credits_benefit`,
  ]);
  if (exactKeys.has(benefitKey)) return true;
  return (
    benefitKey.startsWith(`${productKey}_`) && benefitKey.includes("credit")
  );
}

function mapProductCreditBenefit(
  product: Product,
  benefit: CreditsBenefit,
): BillingProductCreditBenefit {
  const cycleAmount = benefit.config.amount;
  const multiplier =
    benefit.config.grant_kind === "plan_period"
      ? Math.max(1, product.billing_interval_count)
      : 1;
  const periodAmount = cycleAmount * multiplier;
  return {
    key: benefit.key,
    name: benefit.name,
    tokenType: benefit.config.token_type,
    grantKind: benefit.config.grant_kind,
    scope: benefit.config.scope,
    cycleAmount,
    cycleAmountUsd: amountToUsd(cycleAmount, benefit.config.token_type),
    periodAmount,
    periodAmountUsd: amountToUsd(periodAmount, benefit.config.token_type),
    expiresInDays:
      "expires_in_days" in benefit.config
        ? (benefit.config.expires_in_days ?? null)
        : null,
  };
}

function mapMetaCreditBenefit(
  product: Product,
  record: Record<string, unknown>,
  index: number,
): BillingProductCreditBenefit | null {
  const config = asRecord(record.config) ?? {};
  const tokenType =
    firstOptionalString(
      record.tokenType,
      record.token_type,
      config.token_type,
    ) ?? "cohub_credit";
  const grantKind =
    firstOptionalString(
      record.grantKind,
      record.grant_kind,
      config.grant_kind,
    ) ?? (product.billing_type === "recurring" ? "plan_period" : "purchased");
  const scope =
    firstOptionalString(record.scope, config.scope) ??
    (product.billing_type === "recurring" ? "business" : "global");
  const cycleAmount = firstOptionalNumber(
    record.cycleAmount,
    record.cycle_amount,
    record.amount,
    config.amount,
  );
  const cycleAmountUsd = firstOptionalNumber(
    record.cycleAmountUsd,
    record.cycle_amount_usd,
    record.amountUsd,
    record.amount_usd,
    record.usageBalanceUsd,
    record.usage_balance_usd,
  );
  if (cycleAmount === null && cycleAmountUsd === null) return null;
  const multiplier =
    grantKind === "plan_period" ? Math.max(1, product.billing_interval_count) : 1;
  const resolvedCycleAmount = cycleAmount ?? 0;
  const resolvedCycleAmountUsd =
    cycleAmountUsd ?? amountToUsd(resolvedCycleAmount, tokenType);
  const periodAmount =
    firstOptionalNumber(record.periodAmount, record.period_amount) ??
    resolvedCycleAmount * multiplier;
  const periodAmountUsd =
    firstOptionalNumber(record.periodAmountUsd, record.period_amount_usd) ??
    resolvedCycleAmountUsd * multiplier;
  return {
    key:
      firstOptionalString(record.key, record.benefitKey, record.benefit_key) ??
      `${product.key}_credit_${index + 1}`,
    name: firstOptionalString(record.name) ?? "Usage balance",
    tokenType,
    grantKind,
    scope,
    cycleAmount: resolvedCycleAmount,
    cycleAmountUsd: resolvedCycleAmountUsd,
    periodAmount,
    periodAmountUsd,
    expiresInDays: firstOptionalNumber(
      record.expiresInDays,
      record.expires_in_days,
      config.expires_in_days,
    ),
  };
}

function mapProductMetaCreditBenefits(
  product: Product,
): BillingProductCreditBenefit[] {
  const meta = asRecord(product.meta) ?? {};
  const display = asRecord(meta.display) ?? {};
  return recordArray(
    meta.creditBenefits ??
      meta.credit_benefits ??
      display.creditBenefits ??
      display.credit_benefits,
  ).flatMap((record, index) => {
    const benefit = mapMetaCreditBenefit(product, record, index);
    return benefit ? [benefit] : [];
  });
}

function mapCatalogProduct(
  product: Product,
  defaultPlanProductKey: string | null,
  creditBenefits: CreditsBenefit[],
): BillingCatalogProduct {
  const meta = asRecord(product.meta) ?? {};
  const pricing = asRecord(meta.pricing) ?? {};
  const display = asRecord(meta.display) ?? {};
  const compareAtAmountMinor =
    optionalNumber(pricing.compare_at_amount_minor) ??
    optionalNumber(pricing.compare_at_amount) ??
    null;
  const configuredCreditBenefits = mapProductMetaCreditBenefits(product);
  const productCreditBenefits =
    configuredCreditBenefits.length > 0
      ? configuredCreditBenefits
      : creditBenefits
          .filter((benefit) => isProductCreditsBenefit(product, benefit))
          .map((benefit) => mapProductCreditBenefit(product, benefit));
  const creditsAmount =
    productCreditBenefits.length > 0
      ? productCreditBenefits.reduce(
          (sum, benefit) => sum + benefit.periodAmount,
          0,
        )
      : null;
  return {
    id: product.id,
    key: product.key,
    name: product.name,
    description: product.description,
    status: product.status,
    visibility: product.visibility,
    billingType: product.billing_type,
    billingPeriod: product.billing_period,
    billingIntervalCount: product.billing_interval_count,
    currency: product.currency,
    kind: product.billing_type === "recurring" ? "plan" : "addon",
    interval: getProductInterval(product),
    pricing: {
      amountMinor: product.amount,
      amountUsd: minorAmountToUsd(product.amount),
      compareAtAmountMinor,
      compareAtAmountUsd:
        compareAtAmountMinor === null
          ? null
          : minorAmountToUsd(compareAtAmountMinor),
      discountLabel: optionalString(pricing.discount_label),
      discountRate: optionalNumber(pricing.discount_rate),
    },
    promotion: null,
    offer: null,
    display: {
      description: optionalString(display.description) ?? product.description,
      benefits: stringArray(display.benefits),
      creditsAmount,
      validity:
        optionalString(display.validity) ?? optionalString(meta.validity),
      creditBenefits: productCreditBenefits,
    },
    isDefaultPlan: product.key === defaultPlanProductKey,
  };
}

function mapRenewalRecovery(subscription: Subscription) {
  const recovery = subscription.renewal_recovery;
  if (!recovery) return undefined;
  return {
    state: recovery.state,
    effectiveEndsAt: recovery.effective_ends_at,
    payInvoice: recovery.pay_invoice,
    endRecovery: recovery.end_recovery,
    subscribe: recovery.subscribe,
  };
}

function mapSubscriptionSummary(subscription: Subscription) {
  return {
    id: subscription.id,
    productKey: subscription.product_key_snapshot ?? null,
    productName: subscription.product_name_snapshot ?? null,
    status: subscription.status,
    currentPeriodStart: subscription.current_period_start,
    currentPeriodEnd: subscription.current_period_end,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    renewalRecovery: mapRenewalRecovery(subscription),
  };
}

function isSubscriptionExpiredAfterCancel(
  subscription: Subscription,
  now = new Date(),
): boolean {
  if (!subscription.cancel_at_period_end || !subscription.current_period_end)
    return false;
  const currentPeriodEnd = Date.parse(subscription.current_period_end);
  return !Number.isNaN(currentPeriodEnd) && currentPeriodEnd <= now.getTime();
}

async function resolvePaymentStatus(sdk: ConfiguredBillingSdk): Promise<BillingPaymentStatus> {
  try {
    const response = await sdk.admin.providers.status();
    if (response.status !== "available" || !response.checkout_available) {
      return {
        available: false,
        reason:
          response.active_provider_key === "not_configured"
            ? "No active payment provider"
            : "Checkout is currently unavailable",
      };
    }
    return { available: true, reason: null };
  } catch (error) {
    return {
      available: false,
      reason:
        error instanceof Error
          ? error.message
          : "Provider status query failed",
    };
  }
}

type BillingStaticCatalogCache = {
  publicProducts: Product[];
  creditBenefits: CreditsBenefit[];
  defaultPlanProduct: Product | null;
  payment: BillingPaymentStatus;
};

async function readBillingCache<T>(key: string): Promise<T | null> {
  const redis = checkoutLockRedisRef.current;
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

async function writeBillingCache<T>(key: string, value: T, ttlSeconds: number) {
  const redis = checkoutLockRedisRef.current;
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    // Billing must keep working when Redis is unavailable.
  }
}

async function getBillingCache<T>(
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  const cached = await readBillingCache<T>(key);
  if (cached !== null) return cached;
  const value = await load();
  await writeBillingCache(key, value, ttlSeconds);
  return value;
}

function checkoutResultFromOrder(input: {
  userId: string;
  productKey: string;
  response: GetOrderResponse | CreateOrderResponse;
  status: BillingPluginStatus;
  reused?: boolean;
}): BillingCheckoutResult {
  const checkout = input.response.checkout;
  const checkoutUsable =
    checkout?.checkout_usable === true && !!checkout.checkout_url;
  return {
    userId: input.userId,
    billing: input.status,
    payment: {
      available: checkoutUsable,
      reason: checkoutUsable
        ? null
        : (checkout?.message ?? "Checkout is not currently usable"),
    },
    productKey: input.productKey,
    checkoutUrl: checkout?.checkout_url ?? null,
    checkoutUsable,
    message: checkout?.message ?? null,
    orderId: input.response.order.id,
    subscriptionId: input.response.order.subscription_id,
    reused: input.reused === true,
  };
}

function checkoutResultFromSubscription(input: {
  userId: string;
  productKey: string;
  response: (GetSubscriptionResponse | CreateSubscriptionResponse) & {
    reused?: boolean;
  };
  status: BillingPluginStatus;
}): BillingCheckoutResult {
  const checkout = input.response.checkout;
  const checkoutUsable =
    checkout?.checkout_usable === true && !!checkout.checkout_url;
  return {
    userId: input.userId,
    billing: input.status,
    payment: {
      available: checkoutUsable,
      reason: checkoutUsable
        ? null
        : (checkout?.message ?? "Checkout is not currently usable"),
    },
    productKey: input.productKey,
    checkoutUrl: checkout?.checkout_url ?? null,
    checkoutUsable,
    message: checkout?.message ?? null,
    orderId: null,
    subscriptionId: input.response.subscription.id,
    reused: input.response.reused === true,
  };
}

/**
 * The client hands over one return URL; each redirect gets the outcome
 * appended as `cohub_billing` so the app can confirm, retry or restore state
 * without polling the order first.
 */
function checkoutRedirects(returnUrl: string | undefined, productKey: string, purchaseId?: string) {
  if (!returnUrl || !/^https?:\/\//i.test(returnUrl)) {
    return {
      success_redirect_url: undefined,
      failed_redirect_url: undefined,
      cancel_redirect_url: undefined,
    };
  }
  const withOutcome = (outcome: "success" | "failed" | "cancel") => {
    const url = new URL(returnUrl);
    url.searchParams.set(CHECKOUT_RETURN_PARAM, outcome);
    // The product is server-authoritative (it is the key the checkout was
    // created for), so the landing page never trusts a client-supplied name.
    url.searchParams.set(CHECKOUT_PRODUCT_PARAM, productKey);
    if (purchaseId) url.searchParams.set("cohub_billing_purchase", purchaseId);
    return url.toString();
  };
  return {
    success_redirect_url: withOutcome("success"),
    failed_redirect_url: withOutcome("failed"),
    cancel_redirect_url: withOutcome("cancel"),
  };
}

async function withRedisCheckoutLock<T>(
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const lockKey = `billing:checkout:lock:${key}`;
  const lockValue = randomUUID();
  const redis = checkoutLockRedisRef.current;
  if (!redis) return run();
  for (let attempt = 0; attempt < CHECKOUT_LOCK_RETRY_COUNT; attempt += 1) {
    const locked = await redis
      .set(lockKey, lockValue, "PX", CHECKOUT_LOCK_TTL_MS, "NX")
      .catch(() => null);
    if (locked === "OK") {
      try {
        return await run();
      } finally {
        await redis
          .eval(
            "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
            1,
            lockKey,
            lockValue,
          )
          .catch(() => undefined);
      }
    }
    await sleep(CHECKOUT_LOCK_RETRY_DELAY_MS);
  }
  return run();
}

function disabledCheckoutResult(input: {
  userId: string;
  productKey: string;
  status: BillingPluginStatus;
  reason: string | null;
}): BillingCheckoutResult {
  return {
    userId: input.userId,
    billing: input.status,
    payment: {
      available: false,
      reason: input.reason,
    },
    productKey: input.productKey,
    checkoutUrl: null,
    checkoutUsable: false,
    message: input.reason,
    orderId: null,
    subscriptionId: null,
    reused: false,
  };
}

function checkFeatureLimitFromEntitlement(input: {
  entitlement: BillingFeatureEntitlement | null;
  quantity: number;
  metadataKey: string;
  fallbackLimit?: number;
  missingEntitlementPolicy?: "allow" | "deny";
}): BillingFeatureLimitCheck {
  const unlimited = input.entitlement?.metadata.unlimited === true;
  const rawLimit = input.entitlement?.metadata[input.metadataKey];
  const entitlementLimit =
    typeof rawLimit === "number" && Number.isFinite(rawLimit) ? rawLimit : null;
  const limit = unlimited
    ? null
    : (entitlementLimit ?? input.fallbackLimit ?? null);
  const allowed =
    input.entitlement === null && limit === null
      ? input.missingEntitlementPolicy !== "deny"
      : unlimited || (limit !== null && input.quantity <= limit);
  return {
    allowed,
    quantity: input.quantity,
    limit,
    unlimited,
    entitlement: input.entitlement,
  };
}

export function createTalesofaiBillingOperations(
  clientConfig: BillingClientConfig,
): BillingOperations {
  const sdk = createConfiguredSdk(clientConfig);
  const businessKey = clientConfig.businessKey;
  const status: BillingPluginStatus = {
    provider: "talesofai",
    configured: true,
  };

  let campaignCache: {
    value: FirstPurchaseCampaigns;
    expiresAt: number;
  } | null = null;
  let campaignInflight: Promise<FirstPurchaseCampaigns> | null = null;
  const loadFirstPurchaseCampaigns =
    async (): Promise<FirstPurchaseCampaigns> => {
      const listDiscountsByKind = async (kind: "subscription" | "addon") => {
        const discounts: Discount[] = [];
        for (let page = 1; page <= 20; page += 1) {
          const response = await sdk.admin.discounts.list({
            business_key: businessKey,
            metadata_contains: { [FIRST_PURCHASE_MARKER]: kind },
            sorting: "-created_at",
            include_count: false,
            page,
            limit: 100,
          });
          discounts.push(...response.items);
          if (!response.pagination.has_more) break;
        }
        return discounts;
      };
      const [subscriptionDiscounts, addonDiscountsList] = await Promise.all([
        listDiscountsByKind("subscription"),
        listDiscountsByKind("addon"),
      ]);

      let subscriptionDiscount: Discount | undefined;
      const discounts = [...subscriptionDiscounts, ...addonDiscountsList];
      const addonDiscounts = new Map<string, Discount>();
      for (const discount of discounts) {
        if (
          discount.effective_status !== "available" ||
          !isValidFirstPurchaseDiscount(discount)
        ) {
          continue;
        }
        const kind = discount.metadata[FIRST_PURCHASE_MARKER];
        if (kind === "subscription") {
          subscriptionDiscount = newestDiscount(subscriptionDiscount, discount);
          continue;
        }
        if (kind !== "addon") continue;
        const productKey = optionalString(
          discount.metadata[FIRST_PURCHASE_PRODUCT_KEY],
        );
        if (!productKey) continue;
        addonDiscounts.set(
          productKey,
          newestDiscount(addonDiscounts.get(productKey), discount),
        );
      }

      const toCampaign = (
        key: string,
        discount: Discount | undefined,
      ): FirstPurchaseCampaign | null => {
        if (!discount) return null;
        return {
          key,
          revision: firstPurchaseRevision(key, discount),
          discount,
        };
      };

      const value = {
        subscription: toCampaign(
          FIRST_SUBSCRIPTION_OFFER_KEY,
          subscriptionDiscount,
        ),
        addons: new Map(
          [...addonDiscounts].flatMap(([productKey, discount]) => {
            const campaign = toCampaign(
              `cohub-first-addon-v1:${productKey}`,
              discount,
            );
            return campaign ? [[productKey, campaign]] : [];
          }),
        ),
      };
      return value;
    };

  const listFirstPurchaseCampaigns =
    async (): Promise<FirstPurchaseCampaigns> => {
      if (campaignCache && campaignCache.expiresAt > Date.now()) {
        return campaignCache.value;
      }
      if (campaignInflight) return campaignInflight;
      campaignInflight = (async () => {
        const cached = await getBillingCache<{
          subscription: FirstPurchaseCampaign | null;
          addons: [string, FirstPurchaseCampaign][];
        }>(
          `billing:first-purchase-campaigns:${businessKey}:v1`,
          FIRST_PURCHASE_CAMPAIGN_CACHE_TTL_SECONDS,
          async () => {
            const loaded = await loadFirstPurchaseCampaigns();
            return {
              subscription: loaded.subscription,
              addons: [...loaded.addons.entries()],
            };
          },
        );
        const value = {
          subscription: cached.subscription,
          addons: new Map(cached.addons),
        };
        campaignCache = {
          value,
          expiresAt:
            Date.now() + FIRST_PURCHASE_CAMPAIGN_CACHE_TTL_SECONDS * 1_000,
        };
        return value;
      })();
      try {
        return await campaignInflight;
      } finally {
        campaignInflight = null;
      }
    };

  const previewDiscount = async (input: {
    userId: string;
    productKey: string;
    selector: { discount_id: string } | { discount_code: string };
  }): Promise<DiscountPreviewResponse> =>
    sdk.admin.discounts.preview({
      business_key: businessKey,
      external_user_id: input.userId,
      product_key: input.productKey,
      ...input.selector,
    });

  const getPurchaseFacts = async (userId: string) =>
    sdk.admin.customers.getPurchaseFacts({
      external_user_id: userId,
      business_key: businessKey,
    });

  const ensuredCustomers = new Map<
    string,
    { value: BillingUserRef; expiresAt: number }
  >();
  const inflightEnsures = new Map<string, Promise<BillingUserRef>>();
  const inflightCheckouts = new Map<string, Promise<BillingCheckoutResult>>();

  const runCheckoutSingleflight = (
    input: {
      kind: "addon" | "plan";
      userId: string;
      productKey: string;
      selectionKey: string;
    },
    run: () => Promise<BillingCheckoutResult>,
  ): Promise<BillingCheckoutResult> => {
    const key = `${businessKey}:${input.kind}:${input.userId}:${input.productKey}:${input.selectionKey}`;
    const inflight = inflightCheckouts.get(key);
    if (inflight) return inflight;
    const promise = withRedisCheckoutLock(key, run).finally(() => {
      inflightCheckouts.delete(key);
    });
    inflightCheckouts.set(key, promise);
    return promise;
  };

  const cacheEnsuredCustomer = (input: BillingUserRef) => {
    ensuredCustomers.set(input.userId, {
      value: input,
      expiresAt: Date.now() + ENSURE_CUSTOMER_CACHE_TTL_MS,
    });
  };

  const forgetEnsuredCustomer = (userId: string) => {
    ensuredCustomers.delete(userId);
  };

  const ensureCustomer = async (
    input: BillingUserRef,
  ): Promise<BillingUserRef> => {
    const cached = ensuredCustomers.get(input.userId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const inflight = inflightEnsures.get(input.userId);
    if (inflight) return inflight;

    const promise = (async () => {
      try {
        // Ensuring an identity must not change its operator-managed status.
        const customer = await sdk.admin.customers.create({
          external_user_id: input.userId,
        });
        const value = { userId: customer.external_user_id };
        cacheEnsuredCustomer(value);
        return value;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409) throw error;
        const customer = await sdk.admin.customers.get({
          external_user_id: input.userId,
        });
        const value = { userId: customer.external_user_id };
        cacheEnsuredCustomer(value);
        return value;
      }
    })();

    inflightEnsures.set(input.userId, promise);
    try {
      return await promise;
    } finally {
      inflightEnsures.delete(input.userId);
    }
  };

  const getStateAfterEnsure = async (
    userId: string,
  ): Promise<BillingAccountState> => {
    await ensureCustomer({ userId });
    const state = await getCustomerStateOrEmpty({ sdk, businessKey, userId });
    if (state) return state;

    forgetEnsuredCustomer(userId);
    await ensureCustomer({ userId });
    return (
      (await getCustomerStateOrEmpty({ sdk, businessKey, userId })) ?? {
        userId,
        credits: [],
        entitlements: [],
      }
    );
  };

  const getCreditsAfterEnsure = async (
    userId: string,
  ): Promise<BillingUserRef & { credits: BillingCreditBalance[] }> => {
    await ensureCustomer({ userId });
    const state = await getCustomerCreditsOrEmpty({ sdk, businessKey, userId });
    if (state) return state;

    forgetEnsuredCustomer(userId);
    await ensureCustomer({ userId });
    return (
      (await getCustomerCreditsOrEmpty({ sdk, businessKey, userId })) ?? {
        userId,
        credits: [],
      }
    );
  };

  const getEntitlementsAfterEnsure = async (
    userId: string,
  ): Promise<
    BillingUserRef & { entitlements: BillingFeatureEntitlement[] }
  > => {
    await ensureCustomer({ userId });
    const state = await getCustomerEntitlementsOrEmpty({
      sdk,
      businessKey,
      userId,
    });
    if (state) return state;

    forgetEnsuredCustomer(userId);
    await ensureCustomer({ userId });
    return (
      (await getCustomerEntitlementsOrEmpty({ sdk, businessKey, userId })) ?? {
        userId,
        entitlements: [],
      }
    );
  };

  const getFeatureEntitlement = async (input: {
    userId: string;
    featureKey: string;
  }): Promise<BillingFeatureEntitlement | null> => {
    const state = await getEntitlementsAfterEnsure(input.userId);
    return (
      state.entitlements.find(
        (entitlement) =>
          entitlement.key === input.featureKey && entitlement.enabled,
      ) ?? null
    );
  };

  const listAllPages = async <T>(
    fetchPage: (page: number, limit: number) => Promise<BillingListPage<T>>,
  ): Promise<T[]> => {
    const items: T[] = [];
    for (let page = 1; page <= CREDIT_LIST_MAX_PAGES; page += 1) {
      const response = await fetchPage(page, CREDIT_LIST_PAGE_LIMIT);
      items.push(...response.items);
      if (!response.pagination.has_more) break;
    }
    return items;
  };

  const listAllCreditGrants = async (input: {
    userId: string;
    tokenType: string;
    status?: CreditGrantDisplayStatus | "revoked";
  }): Promise<CreditGrant[]> =>
    listAllPages((page, limit) =>
      sdk.admin.credits.listGrants({
        business_key: businessKey,
        external_user_id: input.userId,
        token_type: input.tokenType,
        status: input.status,
        include_count: false,
        page,
        limit,
      }),
    );

  const listBalanceActivities = async (
    input: BillingBalanceActivityListInput,
  ): Promise<BillingBalanceActivityList> => {
    const tokenType = input.tokenType ?? COHUB_BILLING_TOKEN_TYPES.usdMicroCent;
    const page = Math.max(1, Math.floor(input.page ?? 1));
    const limit = Math.min(10, Math.max(1, Math.floor(input.limit ?? 10)));
    if (input.createCustomer !== false) await ensureCustomer({ userId: input.userId });
    else if (!await getCustomerCreditsOrEmpty({ sdk, businessKey, userId: input.userId })) {
      return { userId: input.userId, billing: status, tokenType, unit: getCreditUnit(tokenType), page, limit, items: [], pagination: { hasMore: false, nextPage: null } };
    }
    if (input.transactionLedger) {
      const result = await sdk.admin.credits.listTransactions({
        business_key: businessKey,
        external_user_id: input.userId,
        token_type: tokenType,
        sorting: "-created_at",
        include_count: false,
        page, limit,
      });
      const items = result.items.flatMap((transaction): BillingBalanceActivity[] => {
        if (transaction.type === "consume" || transaction.type === "settlement") {
          return [{
            id: `transaction:${transaction.id}`, kind: "usage", tokenType,
            title: transaction.type === "settlement" ? "Overage settlement" : "Usage",
            description: transaction.reason ?? null,
            sourceType: transaction.source_type, sourceId: transaction.source_id,
            operationId: transaction.operation_id,
            amountUsd: -amountToUsd(transaction.amount, tokenType), status: "covered",
            createdAt: transaction.created_at,
          }];
        }
        const activity = mapTransactionActivity(transaction);
        return activity ? [activity] : [];
      });
      const hasMore = result.pagination.has_more;
      return {
        userId: input.userId, billing: status, tokenType, unit: getCreditUnit(tokenType), page, limit, items,
        pagination: { hasMore, nextPage: hasMore ? page + 1 : null },
      };
    }
    const [transactions, overages] = await Promise.all([
      listAllPages((nextPage, nextLimit) =>
        sdk.admin.credits.listTransactions({
          business_key: businessKey,
          external_user_id: input.userId,
          token_type: tokenType,
          sorting: "-created_at",
          include_count: false,
          page: nextPage,
          limit: nextLimit,
        }),
      ),
      listAllPages((nextPage, nextLimit) =>
        sdk.admin.credits.listUsageOverages({
          business_key: businessKey,
          external_user_id: input.userId,
          token_type: tokenType,
          sorting: "-created_at",
          include_count: false,
          page: nextPage,
          limit: nextLimit,
        }),
      ),
    ]);
    const activities = buildBalanceActivities({ transactions, overages });
    const start = (page - 1) * limit;
    const items = activities.slice(start, start + limit);
    const hasMore = activities.length > start + limit;
    return {
      userId: input.userId,
      billing: status,
      tokenType,
      unit: getCreditUnit(tokenType),
      page,
      limit,
      items,
      pagination: {
        hasMore,
        nextPage: hasMore ? page + 1 : null,
      },
    };
  };

  const listPublicProducts = async (): Promise<Product[]> => {
    const products = await listAllPages((page, limit) =>
      sdk.admin.products.list({
        business_key: businessKey,
        include_count: false,
        page,
        limit,
      }),
    );
    return products.filter(
      (product) =>
        product.status === "active" &&
        product.visibility === "public" &&
        isCohubCatalogProduct(product),
    );
  };

  const getProductOrNull = async (productKey: string): Promise<Product | null> => {
    try {
      return await sdk.admin.products.get({
        business_key: businessKey,
        product_key: productKey,
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return null;
    }
  };

  const appendReferencedSubscriptionProducts = async (input: {
    products: Product[];
    subscriptions: Subscription[];
  }): Promise<Product[]> => {
    const byKey = new Map(input.products.map((product) => [product.key, product]));
    const missingKeys = [...new Set(input.subscriptions
      .map((subscription) => subscription.product_key_snapshot)
      .filter((key): key is string => Boolean(key && !byKey.has(key))))];
    if (missingKeys.length === 0) return input.products;
    const referencedProducts = await Promise.all(missingKeys.map(getProductOrNull));
    for (const product of referencedProducts) {
      if (product?.status === "active" && isCohubCatalogProduct(product)) {
        byKey.set(product.key, product);
      }
    }
    return [...byKey.values()];
  };

  const listActiveCreditsBenefits = async (): Promise<CreditsBenefit[]> => {
    const benefits = await listAllPages((page, limit) =>
      sdk.admin.benefits.list({
        business_key: businessKey,
        include_count: false,
        page,
        limit,
      }),
    );
    return benefits.filter(
      (benefit): benefit is CreditsBenefit =>
        isCreditsBenefit(benefit) && benefit.status === "active",
    );
  };

  const getDefaultPlanProduct = async (): Promise<Product | null> => {
    try {
      const defaultPlan = await sdk.admin.businesses.getDefaultPlan({
        business_key: businessKey,
      });
      if (defaultPlan.status !== "enabled") return null;
      const products = await listAllPages((page, limit) =>
        sdk.admin.products.list({
          business_key: businessKey,
          include_count: false,
          page,
          limit,
        }),
      );
      return (
        products.find(
          (product) =>
            product.id === defaultPlan.product_id &&
            product.status === "active" &&
            product.billing_type === "recurring" &&
            isCohubCatalogProduct(product),
        ) ?? null
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return null;
    }
  };

  const listSubscriptionsByStatuses = async (
    userId: string,
    statuses: readonly string[],
  ): Promise<Subscription[]> => {
    const subscriptions = await listAllPages((page, limit) =>
      sdk.admin.subscriptions.list({
        business_key: businessKey,
        external_user_id: userId,
        sorting: "-created_at",
        include_count: false,
        page,
        limit,
      }),
    );
    return subscriptions.filter((subscription) =>
      statuses.includes(subscription.status),
    );
  };

  const listCurrentSubscriptions = async (
    userId: string,
  ): Promise<Subscription[]> =>
    (
      await listSubscriptionsByStatuses(
        userId,
        BILLING_CURRENT_SUBSCRIPTION_STATUSES,
      )
    ).filter((subscription) => !isSubscriptionExpiredAfterCancel(subscription));

  const listBlockingSubscriptions = async (
    userId: string,
  ): Promise<Subscription[]> => {
    return (
      await listSubscriptionsByStatuses(
        userId,
        BILLING_BLOCKING_SUBSCRIPTION_STATUSES,
      )
    ).filter((subscription) => !isSubscriptionExpiredAfterCancel(subscription));
  };

  const getStaticCatalog = async (): Promise<BillingStaticCatalogCache> =>
    getBillingCache(
      `billing:catalog:static:${businessKey}:v2`,
      BILLING_STATIC_CATALOG_CACHE_TTL_SECONDS,
      async () => {
        const [publicProducts, creditBenefits, defaultPlanProduct, payment] = await Promise.all([
          listPublicProducts(),
          listActiveCreditsBenefits(),
          getDefaultPlanProduct(),
          resolvePaymentStatus(sdk),
        ]);
        return { publicProducts, creditBenefits, defaultPlanProduct, payment };
      },
    );

  const campaignForProduct = (
    campaigns: FirstPurchaseCampaigns,
    product: BillingCatalogProduct,
  ): FirstPurchaseCampaign | null =>
    product.kind === "plan"
      ? campaigns.subscription
      : (campaigns.addons.get(product.key) ?? null);

  /**
   * Attaches viewer-independent campaign facts and, for a signed-in user,
   * the priced automatic offer they are actually eligible for. Campaign
   * discovery failures degrade to the base catalog instead of failing it.
   */
  const applyFirstPurchaseCampaigns = async (
    userId: string | null,
    products: BillingCatalogProduct[],
  ): Promise<BillingCatalogProduct[]> => {
    try {
      const campaigns = await listFirstPurchaseCampaigns();
      const promoted = products.map((product) => {
        const promotion = firstPurchasePromotion(
          campaignForProduct(campaigns, product),
        );
        return promotion ? { ...product, promotion } : product;
      });
      if (!userId) return promoted;
      const hasPlanCampaign = promoted.some(
        (product) => product.kind === "plan" && campaigns.subscription,
      );
      const purchaseFacts = hasPlanCampaign
        ? await getBillingCache(
            `billing:purchase-facts:${businessKey}:${createHash("sha256").update(userId).digest("hex")}`,
            BILLING_PURCHASE_FACTS_CACHE_TTL_SECONDS,
            () => getPurchaseFacts(userId),
          )
        : null;
      const previews: BillingCatalogProduct[] = [];
      const previewQueue = [...promoted];
      const previewWorker = async () => {
        while (previewQueue.length > 0) {
          const product = previewQueue.shift();
          if (!product) return;
          const previewed = await (async () => {
          const campaign =
            product.kind === "plan"
              ? purchaseFacts?.facts.subscription_purchase.exists === false
                ? campaigns.subscription
                : null
              : (campaigns.addons.get(product.key) ?? null);
          if (!campaign) return product;
          try {
            const preview = await getBillingCache(
              `billing:offer-preview:${businessKey}:${createHash("sha256")
                .update(
                  JSON.stringify([userId, product.key, campaign.revision]),
                )
                .digest("hex")}`,
              BILLING_OFFER_PREVIEW_CACHE_TTL_SECONDS,
              () =>
                previewDiscount({
                  userId,
                  productKey: product.key,
                  selector: { discount_id: campaign.discount.id },
                }),
            );
            if (
              !preview.eligible ||
              preview.discount.discount_id !== campaign.discount.id ||
              preview.pricing.amount !== product.pricing.amountMinor ||
              preview.pricing.discount_amount <= 0
            ) {
              return product;
            }
            const offer: BillingDiscountOffer = {
              ref: { key: campaign.key, revision: campaign.revision },
              name: preview.discount.name,
              duration: preview.duration.type,
              endsAt: preview.discount.ends_at,
              pricing: discountPricing(preview.pricing),
            };
            return { ...product, offer };
          } catch (error) {
            console.warn(
              `[billing] Offer preview failed for ${product.key}`,
              error,
            );
            return product;
          }
          })();
          previews.push(previewed);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(4, promoted.length) }, previewWorker),
      );
      previews.sort(
        (left, right) =>
          promoted.findIndex((product) => product.key === left.key) -
          promoted.findIndex((product) => product.key === right.key),
      );
      return previews;
    } catch (error) {
      console.warn("[billing] Automatic offer discovery failed", error);
      return products;
    }
  };

  const getCatalog = async (input?: BillingUserRef): Promise<BillingCatalog> => {
    const userId = input?.userId ?? "anonymous";
    if (input?.userId) await ensureCustomer({ userId: input.userId });
    const [
      staticCatalog,
      currentSubscriptions,
      blockingSubscriptions,
    ] = await Promise.all([
      getStaticCatalog(),
      input?.userId ? listCurrentSubscriptions(input.userId) : Promise.resolve([]),
      input?.userId ? listBlockingSubscriptions(input.userId) : Promise.resolve([]),
    ]);
    const { publicProducts, creditBenefits, defaultPlanProduct, payment } = staticCatalog;
    const hasActiveSubscription = blockingSubscriptions.some((subscription) =>
      BILLING_BLOCKING_SUBSCRIPTION_STATUSES.includes(
        subscription.status as (typeof BILLING_BLOCKING_SUBSCRIPTION_STATUSES)[number],
      ),
    );
    const defaultPlanProductKey = input?.userId ? (defaultPlanProduct?.key ?? null) : null;
    const catalogProducts =
      input?.userId && defaultPlanProduct && !hasActiveSubscription
        ? [
            ...publicProducts.filter(
              (product) => product.key !== defaultPlanProduct.key,
            ),
            defaultPlanProduct,
          ]
        : publicProducts;
    const products = input?.userId
      ? await appendReferencedSubscriptionProducts({
          products: catalogProducts,
          subscriptions: [...currentSubscriptions, ...blockingSubscriptions],
        })
      : catalogProducts;
    const baseProducts = products
      .filter(isCohubCatalogProduct)
      .map((product) =>
        mapCatalogProduct(product, defaultPlanProductKey, creditBenefits),
      )
      .sort(
        (left, right) => left.pricing.amountMinor - right.pricing.amountMinor,
      );
    const mappedProducts = await applyFirstPurchaseCampaigns(
      input?.userId ?? null,
      baseProducts,
    );
    const plans = mappedProducts.filter((product) => product.kind === "plan");
    const addons = mappedProducts.filter((product) => product.kind === "addon");
    return {
      userId,
      billing: status,
      payment,
      products: mappedProducts,
      plans,
      addons,
      currentSubscriptions: currentSubscriptions.map(mapSubscriptionSummary),
      hasActiveSubscription,
      defaultPlanProductKey,
    };
  };

  const findCheckoutProduct = async (input: {
    productKey: string;
    kind: "addon" | "plan";
  }): Promise<Product | null> => {
    try {
      const product = await sdk.admin.products.get({
        business_key: businessKey,
        product_key: input.productKey,
      });
      const expectedBillingType =
        input.kind === "addon" ? "one_time" : "recurring";
      if (
        product.status !== "active" ||
        product.visibility !== "public" ||
        product.billing_type !== expectedBillingType ||
        !isCohubCatalogProduct(product)
      ) {
        return null;
      }
      return product;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return null;
    }
  };

  const previewPromotionCode = async (
    input: BillingPromotionCodePreviewInput,
  ): Promise<BillingPromotionCodePreview> => {
    const promotionCode = normalizePromotionCode(input.promotionCode);
    const product = await getProductOrNull(input.productKey);
    if (
      product?.status !== "active" ||
      product.visibility !== "public" ||
      !isCohubCatalogProduct(product)
    ) {
      throw billingApiError(404, "Product not found", "product_not_found");
    }
    await ensureCustomer({ userId: input.userId });
    const preview = await previewDiscount({
      userId: input.userId,
      productKey: product.key,
      selector: { discount_code: promotionCode },
    });
    if (!preview.eligible) {
      return {
        userId: input.userId,
        productKey: product.key,
        promotionCode,
        eligible: false,
        reasonCode: preview.reason_code,
        message: preview.message,
        name: null,
        duration: null,
        endsAt: null,
        pricing: null,
      };
    }
    return {
      userId: input.userId,
      productKey: product.key,
      promotionCode,
      eligible: true,
      reasonCode: null,
      message: null,
      name: preview.discount.name,
      duration: preview.duration.type,
      endsAt: preview.discount.ends_at,
      pricing: discountPricing(preview.pricing),
    };
  };

  const resolveCheckoutDiscount = async (
    input: BillingCheckoutInput,
    product: Product,
  ): Promise<ResolvedCheckoutDiscount | null> => {
    if (input.promotionCode && input.offer) {
      throw billingApiError(
        400,
        "Promotion code and automatic offer are mutually exclusive",
        "discount_selection_ambiguous",
      );
    }
    if (input.promotionCode) {
      const promotionCode = normalizePromotionCode(input.promotionCode);
      const preview = await previewDiscount({
        userId: input.userId,
        productKey: product.key,
        selector: { discount_code: promotionCode },
      });
      if (!preview.eligible) {
        throw billingApiError(409, preview.message, preview.reason_code);
      }
      return {
        discountId: preview.discount.discount_id,
        createSelector: { discount_code: promotionCode },
        selectionKey: `code:${createHash("sha256").update(promotionCode).digest("hex")}`,
      };
    }
    if (!input.offer) return null;

    const campaigns = await listFirstPurchaseCampaigns();
    const campaign =
      product.billing_type === "recurring"
        ? campaigns.subscription
        : (campaigns.addons.get(product.key) ?? null);
    if (
      !campaign ||
      campaign.key !== input.offer.key ||
      campaign.revision !== input.offer.revision
    ) {
      throw billingApiError(
        409,
        "This offer has changed. Refresh pricing and try again",
        "first_purchase_offer_changed",
      );
    }
    if (product.billing_type === "recurring") {
      const facts = await getPurchaseFacts(input.userId);
      if (facts.facts.subscription_purchase.exists) {
        throw billingApiError(
          409,
          "The first subscription offer is no longer available",
          "first_subscription_required",
        );
      }
    }
    const preview = await previewDiscount({
      userId: input.userId,
      productKey: product.key,
      selector: { discount_id: campaign.discount.id },
    });
    if (!preview.eligible) {
      throw billingApiError(409, preview.message, preview.reason_code);
    }
    return {
      discountId: campaign.discount.id,
      createSelector: { discount_id: campaign.discount.id },
      selectionKey: `preset:${campaign.revision}`,
    };
  };

  const createUnavailableCheckout = (input: {
    userId: string;
    productKey: string;
    reason: string;
  }) =>
    disabledCheckoutResult({
      userId: input.userId,
      productKey: input.productKey,
      status,
      reason: input.reason,
    });

  const findReusableAddonCheckout = async (input: {
    userId: string;
    productKey: string;
    discountId: string | null;
  }): Promise<BillingCheckoutResult | null> => {
    const response = await sdk.admin.orders.list({
      business_key: businessKey,
      external_user_id: input.userId,
      product_key: input.productKey,
      status: "pending_checkout",
      billing_reason: "purchase",
      sorting: "-created_at",
      include_count: false,
      page: 1,
      limit: 10,
    });
    for (const order of response.items) {
      try {
        const inspected = await sdk.admin.orders.inspect({
          order_id: order.id,
          business_key: businessKey,
        });
        if (
          inspected.checkout?.checkout_usable === true &&
          inspected.checkout.checkout_url &&
          checkoutDiscountId(inspected) === input.discountId
        ) {
          return checkoutResultFromOrder({
            userId: input.userId,
            productKey: input.productKey,
            response: inspected,
            status,
            reused: true,
          });
        }
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    return null;
  };

  const findReusableSubscriptionCheckout = async (input: {
    userId: string;
    productKey: string;
    discountId: string | null;
  }): Promise<BillingCheckoutResult | null> => {
    const response = await sdk.admin.subscriptions.list({
      business_key: businessKey,
      external_user_id: input.userId,
      product_key: input.productKey,
      status: "pending_checkout",
      sorting: "-created_at",
      include_count: false,
      page: 1,
      limit: 10,
    });
    for (const subscription of response.items) {
      try {
        const inspected = await sdk.admin.subscriptions.inspect({
          subscription_id: subscription.id,
          business_key: businessKey,
        });
        if (
          inspected.checkout?.checkout_usable === true &&
          inspected.checkout.checkout_url &&
          checkoutDiscountId(inspected) === input.discountId
        ) {
          return checkoutResultFromSubscription({
            userId: input.userId,
            productKey: input.productKey,
            response: { ...inspected, reused: true },
            status,
          });
        }
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    return null;
  };

  const purchaseAddon = async (
    input: BillingCheckoutInput,
  ): Promise<BillingCheckoutResult> => {
    if (input.walletCheckout) return purchaseAddonUnprotected(input);
    return runCheckoutSingleflight(
      {
        kind: "addon",
        userId: input.userId,
        productKey: input.productKey,
        selectionKey: `${checkoutSelectionKey(input)}:${input.purchaseId ?? "legacy"}`,
      },
      () => purchaseAddonUnprotected(input),
    );
  };

  const purchaseAddonUnprotected = async (
    input: BillingCheckoutInput,
  ): Promise<BillingCheckoutResult> => {
    const product = await findCheckoutProduct({
      productKey: input.productKey,
      kind: "addon",
    });
    if (!product) {
      return createUnavailableCheckout({
        userId: input.userId,
        productKey: input.productKey,
        reason: "Product is not available for purchase",
      });
    }

    await ensureCustomer({ userId: input.userId });
    const discount = await resolveCheckoutDiscount(input, product);
    const reusableCheckout = input.walletCheckout || input.purchaseId ? null : await findReusableAddonCheckout({
      userId: input.userId,
      productKey: product.key,
      discountId: discount?.discountId ?? null,
    });
    if (reusableCheckout) return reusableCheckout;

    const payment = await resolvePaymentStatus(sdk);
    if (!payment.available) {
      return createUnavailableCheckout({
        userId: input.userId,
        productKey: product.key,
        reason: payment.reason ?? "No available payment provider",
      });
    }

    const response = await sdk.admin.orders.create({
      business_key: businessKey,
      external_user_id: input.userId,
      product_key: product.key,
      billing_reason: "purchase",
      ...checkoutRedirects(input.returnUrl, input.productKey, input.purchaseId),
      ...(input.walletCheckout ? {
        meta: { space_id: input.walletCheckout.spaceId, actor_user_id: input.walletCheckout.actorUserId, wallet_checkout_id: input.walletCheckout.id },
      } : {}),
      ...(discount?.createSelector ?? {}),
    }, input.walletCheckout ? { idempotencyKey: `space-wallet:${input.walletCheckout.id}` } : input.purchaseId ? { idempotencyKey: `cohub:order:${input.userId}:${input.purchaseId}` } : undefined);
    return checkoutResultFromOrder({
      userId: input.userId,
      productKey: product.key,
      response,
      status,
    });
  };

  const createSubscription = async (
    input: BillingCheckoutInput,
  ): Promise<BillingCheckoutResult> => {
    return runCheckoutSingleflight(
      {
        kind: "plan",
        userId: input.userId,
        productKey: input.productKey,
        selectionKey: `${checkoutSelectionKey(input)}:${input.purchaseId ?? "legacy"}`,
      },
      () => createSubscriptionUnprotected(input),
    );
  };

  const createSubscriptionUnprotected = async (
    input: BillingCheckoutInput,
  ): Promise<BillingCheckoutResult> => {
    const product = await findCheckoutProduct({
      productKey: input.productKey,
      kind: "plan",
    });
    if (!product) {
      return createUnavailableCheckout({
        userId: input.userId,
        productKey: input.productKey,
        reason: "Plan is not available for subscription",
      });
    }

    await ensureCustomer({ userId: input.userId });
    const currentSubscriptions = await listBlockingSubscriptions(input.userId);
    if (currentSubscriptions.length > 0) {
      return createUnavailableCheckout({
        userId: input.userId,
        productKey: product.key,
        reason: "A subscription is already active",
      });
    }

    const discount = await resolveCheckoutDiscount(input, product);
    const reusableCheckout = input.purchaseId ? null : await findReusableSubscriptionCheckout({
      userId: input.userId,
      productKey: product.key,
      discountId: discount?.discountId ?? null,
    });
    if (reusableCheckout) return reusableCheckout;

    const payment = await resolvePaymentStatus(sdk);
    if (!payment.available) {
      return createUnavailableCheckout({
        userId: input.userId,
        productKey: product.key,
        reason: payment.reason ?? "No available payment provider",
      });
    }

    const response = await sdk.admin.subscriptions.create({
      business_key: businessKey,
      external_user_id: input.userId,
      product_key: product.key,
      ...checkoutRedirects(input.returnUrl, input.productKey, input.purchaseId),
      ...(discount?.createSelector ?? {}),
    }, input.purchaseId ? { idempotencyKey: `cohub:subscription:${input.userId}:${input.purchaseId}` } : undefined);
    return checkoutResultFromSubscription({
      userId: input.userId,
      productKey: product.key,
      response,
      status,
    });
  };

  const shouldInspectSubscriptionForHistory = (
    subscription: Subscription,
  ): boolean => {
    if (subscription.status === "pending_checkout") return true;
    return (
      BILLING_AUTO_RENEW_CANCELABLE_SUBSCRIPTION_STATUSES.includes(
        subscription.status as (typeof BILLING_AUTO_RENEW_CANCELABLE_SUBSCRIPTION_STATUSES)[number],
      ) &&
      subscription.cancel_at_period_end === false &&
      subscription.current_period_end !== null
    );
  };

  const resolveCheckoutConfirmation = async (input: {
    userId: string;
    productKey: string;
    checkoutId: string;
  }): Promise<BillingCheckoutConfirmation> => {
    await ensureCustomer({ userId: input.userId });
    try {
      const product = await sdk.admin.products.get({
        business_key: businessKey,
        product_key: input.productKey,
      });
      const isPlan = product.billing_type === "recurring";
      if (isPlan) {
        const inspected = await sdk.admin.subscriptions.inspect({
          business_key: businessKey,
          subscription_id: input.checkoutId,
        });
        const subscription = inspected.subscription;
        if (
          subscription.external_user_id !== input.userId ||
          subscription.product_key_snapshot !== input.productKey
        ) {
          throw billingApiError(404, "Checkout not found", "checkout_not_found");
        }
        return {
          productKey: input.productKey,
          settled: ["active", "trialing"].includes(subscription.status),
          checkoutUrl: subscription.status === "pending_checkout" && inspected.checkout?.checkout_usable ? inspected.checkout.checkout_url ?? null : null,
          canRestart: ["checkout_expired", "checkout_canceled"].includes(subscription.status)
            && !subscription.payment_conflicted_at
            && inspected.checkout?.checkout_usable === false
            && ["checkout_expired", "checkout_canceled"].includes(inspected.checkout.status),
          status: subscription.status ?? null,
          pending: subscription.status === "pending_checkout",
          productName: product.name ?? null,
        };
      }
      const inspected = await sdk.admin.orders.inspect({
        business_key: businessKey,
        order_id: input.checkoutId,
      });
      const order = inspected.order;
      if (
        order.external_user_id !== input.userId ||
        order.product_key_snapshot !== input.productKey
      ) {
        throw billingApiError(404, "Checkout not found", "checkout_not_found");
      }
      return {
        productKey: input.productKey,
        settled: order.status === "paid",
        checkoutUrl: order.status === "pending_checkout" && inspected.checkout?.checkout_usable ? inspected.checkout.checkout_url ?? null : null,
        canRestart: ["checkout_expired", "checkout_canceled"].includes(order.status)
          && !order.paid_at && !order.payment_conflicted_at
          && inspected.checkout?.checkout_usable === false
          && ["checkout_expired", "checkout_canceled"].includes(inspected.checkout.status),
        status: order.status ?? null,
        pending: order.status === "pending_checkout",
        productName: product.name ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return {
          productKey: input.productKey,
          settled: false,
          status: null,
          pending: true,
          canRestart: false,
          productName: null,
        };
      }
      throw error;
    }
  };

  const listSubscriptions = async (
    input: BillingHistoryListInput,
  ): Promise<BillingSubscriptionHistoryList> => {
    const page = normalizeBillingPage(input.page);
    const limit = normalizeBillingLimit(input.limit);
    await ensureCustomer({ userId: input.userId });
    const response = await sdk.admin.subscriptions.list({
      business_key: businessKey,
      external_user_id: input.userId,
      sorting: "-created_at",
      include_count: false,
      page,
      limit,
    });
    const items = await Promise.all(
      response.items.map(async (subscription) => {
        if (!shouldInspectSubscriptionForHistory(subscription)) {
          return mapSubscriptionHistoryStatus(subscription);
        }
        try {
          const inspected = await sdk.admin.subscriptions.inspect({
            subscription_id: subscription.id,
            business_key: businessKey,
          });
          return mapSubscriptionHistoryStatus(
            inspected.subscription,
            inspected.checkout,
          );
        } catch (error) {
          if (!isNotFound(error)) throw error;
          return mapSubscriptionHistoryStatus(subscription);
        }
      }),
    );
    const hasMore = response.pagination.has_more;
    return {
      userId: input.userId,
      billing: status,
      page,
      limit,
      items,
      pagination: {
        hasMore,
        nextPage: hasMore ? page + 1 : null,
      },
    };
  };

  const getOwnedSubscription = async (input: {
    userId: string;
    subscriptionId: string;
  }): Promise<Subscription> => {
    try {
      const subscription = await sdk.admin.subscriptions.get({
        subscription_id: input.subscriptionId,
        business_key: businessKey,
      });
      if (subscription.external_user_id !== input.userId) {
        throw billingApiError(
          404,
          "Subscription not found",
          "subscription_not_found",
        );
      }
      return subscription;
    } catch (error) {
      if (isNotFound(error))
        throw billingApiError(
          404,
          "Subscription not found",
          "subscription_not_found",
        );
      throw error;
    }
  };

  const getSubscription = async (
    input: BillingUserRef & { subscriptionId: string },
  ): Promise<BillingSubscriptionHistoryStatus> => {
    await getOwnedSubscription(input);
    const inspected = await sdk.admin.subscriptions.inspect({
      subscription_id: input.subscriptionId,
      business_key: businessKey,
    });
    return {
      ...mapSubscriptionHistoryStatus(inspected.subscription, inspected.checkout),
      ...(inspected.payment_conflict ? {
        paymentConflict: {
          reason: inspected.payment_conflict.reason,
          amountMinor: inspected.payment_conflict.actual_amount,
          currency: inspected.payment_conflict.actual_currency,
        },
      } : {}),
    };
  };

  const getSubscriptionPaymentAction = async (
    input: BillingUserRef & { subscriptionId: string },
  ) => {
    await getOwnedSubscription(input);
    const result = await sdk.admin.subscriptions.paymentAction(
      { subscription_id: input.subscriptionId },
      { business_key: businessKey, external_user_id: input.userId },
    );
    return { checkoutUrl: result.payment_action?.checkout_url ?? null, reason: result.reason };
  };

  const cancelSubscriptionCheckout = async (
    input: BillingUserRef & { subscriptionId: string },
  ): Promise<BillingSubscriptionHistoryStatus> => {
    const subscription = await getOwnedSubscription(input);
    if (subscription.status !== "pending_checkout") {
      throw billingApiError(
        409,
        "Only pending checkout subscriptions can be canceled",
        "subscription_checkout_not_cancelable",
      );
    }
    const canceled = await sdk.admin.subscriptions.cancelCheckout(
      { subscription_id: input.subscriptionId },
      { business_key: businessKey },
      {
        idempotencyKey: `cohub:billing:subscription-cancel-checkout:${input.userId}:${input.subscriptionId}`,
      },
    );
    return mapSubscriptionHistoryStatus(canceled);
  };

  const cancelSubscriptionAutoRenew = async (
    input: BillingUserRef & { subscriptionId: string },
  ): Promise<BillingSubscriptionHistoryStatus> => {
    const subscription = await getOwnedSubscription(input);
    if (subscription.renewal_recovery?.state === "closing") return getSubscription(input);
    const endingRecovery = subscription.renewal_recovery?.end_recovery.allowed === true;
    if (!endingRecovery && (
      !BILLING_AUTO_RENEW_CANCELABLE_SUBSCRIPTION_STATUSES.includes(
        subscription.status as (typeof BILLING_AUTO_RENEW_CANCELABLE_SUBSCRIPTION_STATUSES)[number],
      ) ||
      subscription.cancel_at_period_end ||
      subscription.current_period_end === null
    )) {
      throw billingApiError(
        409,
        "Subscription auto-renew cannot be canceled",
        "subscription_auto_renew_not_cancelable",
      );
    }

    const inspected = await sdk.admin.subscriptions.inspect({
      subscription_id: input.subscriptionId,
      business_key: businessKey,
    });
    if (!endingRecovery && !isProviderBackedSubscriptionCheckout(inspected.checkout)) {
      throw billingApiError(
        409,
        "Subscription auto-renew cannot be canceled",
        "subscription_auto_renew_not_cancelable",
      );
    }
    const response = await sdk.admin.subscriptions.cancel(
      { subscription_id: input.subscriptionId },
      { business_key: businessKey },
      {
        idempotencyKey: endingRecovery
          ? `cohub:billing:subscription-end-recovery:${input.userId}:${input.subscriptionId}:${subscription.current_period_end}`
          : `cohub:billing:subscription-cancel-auto-renew:${input.userId}:${input.subscriptionId}`,
      },
    );
    const cancellationCheckout = response.cancellation
      ? ({
          provider_key: response.cancellation.provider_key,
          provider_config_id: response.cancellation.provider_config_id,
          status: response.cancellation.status,
          message: response.cancellation.message,
          acquiring_subscription_id:
            response.cancellation.acquiring_subscription_id,
          subscription_status: response.cancellation.subscription_status,
        } satisfies SubscriptionCheckout)
      : inspected.checkout;
    return mapSubscriptionHistoryStatus(
      response.subscription,
      cancellationCheckout,
    );
  };

  const redeemCode = async (
    input: BillingRedemptionInput,
  ): Promise<BillingRedemptionResult> => {
    const code = normalizeRedemptionCode(input.code);
    if (!code) {
      return {
        userId: input.userId,
        billing: status,
        redeemed: false,
        message: "Redemption code is required",
        redemptionRecordId: null,
        itemCount: 0,
      };
    }
    await ensureCustomer({ userId: input.userId });
    const response = await sdk.admin.redemptionCodes.redeem(
      {
        code,
        external_user_id: input.userId,
      },
      {
        idempotencyKey: redemptionIdempotencyKey({
          userId: input.userId,
          code,
        }),
      },
    );
    return {
      userId: input.userId,
      billing: status,
      redeemed: true,
      message: null,
      redemptionRecordId: response.redemption_record.id,
      itemCount: response.redemption_record.items_snapshot.length,
    };
  };

  return {
    status,
    ensureCustomer,

    async getState(input: BillingUserRef): Promise<BillingAccountState> {
      return getStateAfterEnsure(input.userId);
    },

    async getGenerationModelDiscount(input) {
      await ensureCustomer({ userId: input.userId });
      const response = await sdk.admin.customers.getEntitlements({
        external_user_id: input.userId,
        business_key: businessKey,
      });
      return resolveGenerationModelDiscount({
        model: input.model,
        entitlements: response.active_benefits.map((benefit) => ({
          benefitKey: benefit.benefit_key,
          enabled: benefit.config.metadata.enabled !== false,
          metadata: benefit.config.metadata,
          grantId: benefit.grant_id,
        })),
      });
    },

    async getCreditStatus(
      input: BillingUserRef & { tokenType?: string; createCustomer?: boolean },
    ): Promise<BillingCreditStatus> {
      const tokenType =
        input.tokenType ?? COHUB_BILLING_TOKEN_TYPES.usdMicroCent;
      const state = input.createCustomer === false
        ? await getCustomerCreditsOrEmpty({ sdk, businessKey, userId: input.userId })
        : await getCreditsAfterEnsure(input.userId);
      if (!state) return { netUsd: 0, globalAvailableUsd: 0, groups: [] };
      const balance = findBalance(state.credits, tokenType);
      const grants = (
        await listAllCreditGrants({ userId: input.userId, tokenType })
      ).filter(
        (grant) =>
          CREDIT_GRANT_DISPLAY_STATUSES.includes(
            grant.status as CreditGrantDisplayStatus,
          ) && isCreditGrantDisplayable(grant),
      );
      const grantStatuses = grants.map((grant) => mapCreditGrant(grant));
      const openOverageUsd = amountToUsd(
        balance?.openOverageBalance ?? 0,
        tokenType,
      );
      const netUsd = balance
        ? amountToUsd(balance.netBalance, tokenType)
        : -openOverageUsd;

      return {
        netUsd,
        globalAvailableUsd: !balance ? 0 : typeof balance.raw.global_available_balance === "number"
          ? amountToUsd(balance.raw.global_available_balance, tokenType)
          : null,
        groups: groupCreditGrants(grantStatuses),
      };
    },

    async confirmSpaceWalletOrder(input) {
      const result = await sdk.admin.orders.list({
        business_key: businessKey,
        external_user_id: input.userId,
        meta_contains: { wallet_checkout_id: input.requestId, actor_user_id: input.actorUserId, space_id: input.spaceId },
        page: 1, limit: 1, include_count: false,
      });
      const order = result.items[0];
      if (!order || order.external_user_id !== input.userId || order.meta?.actor_user_id !== input.actorUserId || order.meta?.space_id !== input.spaceId || order.meta?.wallet_checkout_id !== input.requestId) {
        throw billingApiError(404, "Wallet order not found", "wallet_order_not_found");
      }
      return { settled: order.status === "paid", pending: order.status === "pending_checkout" };
    },

    getCatalog,

    previewPromotionCode,

    listSubscriptions,

    purchaseAddon,

    createSubscription,

    resolveCheckoutConfirmation,

    cancelSubscriptionCheckout,

    cancelSubscriptionAutoRenew,
    getSubscription,
    getSubscriptionPaymentAction,

    redeemCode,

    async grantReferralReward(input) {
      const benefitKey =
        input.side === "inviter"
          ? COHUB_BILLING_BENEFITS.referralInviterCredit
          : COHUB_BILLING_BENEFITS.referralInviteeCredit;
      const expectedAmount = usdToAmount(
        input.expectedAmountUsd,
        COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
      );
      const benefit = await sdk.admin.benefits.get({
        business_key: businessKey,
        benefit_key: benefitKey,
      });
      if (
        benefit.type !== "credits" ||
        benefit.status !== "active" ||
        benefit.config.token_type !== COHUB_BILLING_TOKEN_TYPES.usdMicroCent ||
        benefit.config.amount !== expectedAmount
      ) {
        throw new BillingConfigurationError(
          `Billing benefit ${benefitKey} must grant USD ${input.expectedAmountUsd.toFixed(2)} in active credits`,
        );
      }

      await ensureCustomer({ userId: input.userId });
      const result = await sdk.admin.credits.grant(
        {
          business_key: businessKey,
          external_user_id: input.userId,
          benefit_key: benefitKey,
          source_id: input.referralId,
          operation_id: input.operationId,
          reason: "Cohub referral reward",
        },
        { idempotencyKey: input.operationId },
      );
      const amountUsd = amountToUsd(
        result.grant.original_amount,
        result.grant.token_type,
      );
      return {
        amountUsd,
        benefitKey,
        grantId: result.grant.id,
        transactionId: result.transaction.id,
      };
    },

    async preflightUsage(
      input: BillingUsagePreflightInput,
    ): Promise<BillingUsagePreflight> {
      const tokenType =
        input.tokenType ?? COHUB_BILLING_TOKEN_TYPES.usdMicroCent;
      const estimatedAmountUsd = roundUsd(
        input.estimatedAmountUsd,
        getCreditUnit(tokenType).usdDecimalPlaces,
      );
      const estimatedAmount = usdToAmount(estimatedAmountUsd, tokenType);
      if (estimatedAmountUsd === 0) {
        return {
          allowed: true,
          tokenType,
          estimatedAmountUsd,
          availableBalance: 0,
          netBalance: 0,
          shortfall: 0,
        };
      }

      await ensureCustomer({ userId: input.userId });
      const preview = await sdk.admin.credits.previewConsume({
        business_key: businessKey,
        external_user_id: input.userId,
        token_type: tokenType,
        amount: estimatedAmount,
        source_type: "usage",
        source_id: `preflight:${input.usageType}`,
        usage_type: input.usageType,
      });
      const availableBalance = amountToUsd(preview.available_before, tokenType);
      const netBalance = amountToUsd(
        Math.max(
          0,
          preview.available_before -
            preview.historical_overage_settlement_amount,
        ),
        tokenType,
      );
      const shortfall = amountToUsd(
        preview.uncovered_current_usage_amount,
        tokenType,
      );
      return {
        allowed:
          !preview.would_create_overage &&
          preview.uncovered_current_usage_amount === 0,
        tokenType,
        estimatedAmountUsd,
        availableBalance,
        netBalance,
        shortfall,
      };
    },

    async recordUsage(
      input: BillingUsageRecordInput,
    ): Promise<BillingUsageRecordResult> {
      const tokenType =
        input.tokenType ?? COHUB_BILLING_TOKEN_TYPES.usdMicroCent;
      const amountUsd = roundUsd(
        input.amountUsd,
        getCreditUnit(tokenType).usdDecimalPlaces,
      );
      const amount = usdToAmount(amountUsd, tokenType);
      if (amount === 0) {
        return { tokenType, amountUsd, status: "skipped", response: null };
      }

      await ensureCustomer({ userId: input.userId });
      const response = await sdk.admin.credits.consume(
        {
          business_key: businessKey,
          external_user_id: input.userId,
          token_type: tokenType,
          amount,
          source_type: "usage",
          source_id: input.sourceId,
          usage_type: input.usageType,
          operation_id: input.operationId,
          reason: input.reason,
        },
        { idempotencyKey: input.operationId },
      );

      return {
        tokenType,
        amountUsd,
        status: response.overage ? "overage" : "recorded",
        response,
      };
    },

    listBalanceActivities,

    getFeatureEntitlement,

    async checkFeatureLimit(
      input: BillingFeatureLimitInput,
    ): Promise<BillingFeatureLimitCheck> {
      const entitlement = await getFeatureEntitlement(input);
      return checkFeatureLimitFromEntitlement({
        entitlement,
        quantity: input.quantity,
        metadataKey: input.metadataKey ?? "limit",
        fallbackLimit: input.fallbackLimit,
        missingEntitlementPolicy: input.missingEntitlementPolicy,
      });
    },
  };
}

function createBusinessSdk(clientConfig: BillingClientConfig) {
  return createSdk({
    baseURL: clientConfig.baseUrl,
    adminApiKey: clientConfig.adminApiKey,
  })
    .useAdmin(customersFeature())
    .useAdmin(creditsFeature());
}

type BusinessSdk = ReturnType<typeof createBusinessSdk>;

async function ensureBusinessCustomer(
  sdk: BusinessSdk,
  _businessKey: string,
  userId: string,
): Promise<void> {
  try {
    // Ensuring an identity must not change its operator-managed status.
    await sdk.admin.customers.create({
      external_user_id: userId,
    });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error;
  }
}

async function listBusinessCreditGrants(
  sdk: BusinessSdk,
  businessKey: string,
  userId: string,
): Promise<CreditGrant[]> {
  const grants: CreditGrant[] = [];
  for (let page = 1; page <= CREDIT_LIST_MAX_PAGES; page += 1) {
    const result = await sdk.admin.credits.listGrants({
      business_key: businessKey,
      external_user_id: userId,
      token_type: COHUB_BILLING_TOKEN_TYPES.cohubCredit,
      include_count: false,
      page,
      limit: CREDIT_LIST_PAGE_LIMIT,
    });
    grants.push(...result.items);
    if (!result.pagination.has_more) break;
  }
  return grants;
}

async function resolveRemaining(
  sdk: BusinessSdk,
  businessKey: string,
  userId: string,
): Promise<number> {
  try {
    const credits = await sdk.admin.customers.getCredits({
      external_user_id: userId,
      business_key: businessKey,
    });
    const balance =
      credits.credits.find((c) => c.token_type === COHUB_BILLING_TOKEN_TYPES.cohubCredit) ?? null;
    return balance?.available_balance ?? 0;
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return 0;
  }
}

/**
 * Creates business-scoped billing operations bound to a single billing
 * business (e.g. a Cohub Space). Shares the platform credit mapping helpers
 * and declarations so space commerce and platform billing never drift apart.
 * Credits use the virtual `cohub_credit` token at business scope.
 */
export function createBusinessBillingOperations(input: {
  clientConfig: BillingClientConfig;
  businessKey: string;
}): BusinessBillingOperations {
  const sdk = createBusinessSdk(input.clientConfig);
  const businessKey = input.businessKey;
  const status: BillingPluginStatus = {
    provider: "talesofai",
    configured: true,
  };

  const getEntitlements = async (
    ref: BillingUserRef,
  ): Promise<BillingAccountState> => {
    await ensureBusinessCustomer(sdk, businessKey, ref.userId);
    try {
      const state = await sdk.admin.customers.getState({
        external_user_id: ref.userId,
        business_key: businessKey,
      });
      return {
        userId: ref.userId,
        credits: state.credits.map(mapCreditBalance),
        entitlements: mapFeatureEntitlements(state.active_benefits),
      };
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return { userId: ref.userId, credits: [], entitlements: [] };
    }
  };

  const getCreditStatus = async (
    ref: BillingUserRef,
  ): Promise<BillingCreditStatus> => {
    const tokenType = COHUB_BILLING_TOKEN_TYPES.cohubCredit;
    await ensureBusinessCustomer(sdk, businessKey, ref.userId);
    let netBalance = 0;
    try {
      const credits = await sdk.admin.customers.getCredits({
        external_user_id: ref.userId,
        business_key: businessKey,
      });
      const balance =
        credits.credits.find((c) => c.token_type === tokenType) ?? null;
      netBalance = balance?.net_balance ?? 0;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const grants = (await listBusinessCreditGrants(sdk, businessKey, ref.userId)).filter(
      (grant) =>
        CREDIT_GRANT_DISPLAY_STATUSES.includes(
          grant.status as CreditGrantDisplayStatus,
        ) && isCreditGrantDisplayable(grant),
    );
    const grantStatuses = grants.map((grant) => mapCreditGrant(grant));
    return {
      netUsd: amountToUsd(netBalance, tokenType),
      groups: groupCreditGrants(grantStatuses),
    };
  };

  const consume = async (
    ref: BillingUserRef & {
      amount: number;
      operationId: string;
      sourceId: string;
      reason?: string;
    },
  ): Promise<BusinessCreditConsumeResult> => {
    const tokenType = COHUB_BILLING_TOKEN_TYPES.cohubCredit;
    const amount = Math.max(0, Math.floor(ref.amount));
    if (amount <= 0) {
      return { userId: ref.userId, status: "consumed", amount: 0, remaining: 0, shortfall: null };
    }
    await ensureBusinessCustomer(sdk, businessKey, ref.userId);

    // Consume is authoritative and idempotent via operationId: a retry returns
    // the original result without double-charging.
    const response = await sdk.admin.credits.consume(
      {
        business_key: businessKey,
        external_user_id: ref.userId,
        token_type: tokenType,
        amount,
        source_type: "usage",
        source_id: ref.sourceId,
        usage_type: COHUB_BILLING_USAGE_TYPES.workConsumption,
        operation_id: ref.operationId,
        reason: ref.reason,
      },
      { idempotencyKey: ref.operationId },
    );

    const remaining = await resolveRemaining(sdk, businessKey, ref.userId);

    if (response.overage) {
      return {
        userId: ref.userId,
        status: "insufficient",
        amount: 0,
        remaining,
        shortfall: amount,
      };
    }

    return {
      userId: ref.userId,
      status: "consumed",
      amount,
      remaining,
      shortfall: null,
    };
  };

  return {
    status,
    businessKey,
    getEntitlements,
    getCreditStatus,
    consume,
  };
}
