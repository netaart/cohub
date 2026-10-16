/**
 * Provider credit-summary payload kept for hosted billing compatibility.
 * The provider may return additional fields; they are preserved on the raw
 * payload but not part of the public contract.
 */
export type BillingCreditSummaryRaw = {
  token_type: string;
  available_balance: number;
  open_overage_balance: number;
  net_balance: number;
};

/**
 * Provider benefit grant kept for hosted billing compatibility. The provider
 * may return additional fields; they are preserved on the raw payload but not
 * part of the public contract.
 */
export type BillingActiveBenefitRaw = {
  grant_id: string;
  benefit_id: string;
  benefit_key: string;
  benefit_name: string;
  benefit_type: "feature";
  config: {
    metadata: Record<string, string | number | boolean>;
  };
  source_type: string;
  source_id: string;
  granted_at: string;
  effective_at: string;
  expires_at: string | null;
};

/** Provider consume response kept for hosted billing compatibility. */
export type BillingConsumeCreditsResponseRaw = {
  overage?: unknown;
};

export const COHUB_BILLING_TOKEN_TYPES = {
  usdMicroCent: "usd_micro_cent",
  cohubCredit: "cohub_credit",
} as const;

export const COHUB_BILLING_CREDIT_UNITS = {
  usdMicroCent: {
    tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
    displayCurrency: "USD",
    displayUnit: "micro-cent",
    unitToUsd: 0.00000001,
    unitsPerUsd: 100_000_000,
    usdDecimalPlaces: 8,
  },
  cohubCredit: {
    tokenType: COHUB_BILLING_TOKEN_TYPES.cohubCredit,
    displayCurrency: null,
    displayUnit: "credit",
    unitToUsd: 0,
    unitsPerUsd: 0,
    usdDecimalPlaces: 0,
  },
} as const;

export const COHUB_BILLING_USAGE_TYPES = {
  generation: "generation",
  generationLlm: "generation.llm",
  generationLlmRaw: "generation.llm.raw",
  generationDecision: "generation.decision",
  generationImage: "generation.image",
  generationVideo: "generation.video",
  generationMusic: "generation.music",
  generation3d: "generation.3d",
  sandboxCompute: "sandbox.compute",
  spaceStorage: "space.storage",
  workConsumption: "work.consumption",
} as const;

export const COHUB_BILLING_BENEFITS = {
  referralInviterCredit: "referral_inviter_credit",
  referralInviteeCredit: "referral_invitee_credit",
  proModelDiscount: "pro_model_discount_v1",
  maxModelDiscount: "max_model_discount_v1",
} as const;

export const COHUB_BILLING_FEATURES = {
  generationAccess: "generation.access",
  sandboxAccess: "sandbox.access",
  sandboxSpecBoost: "sandbox.spec.boost",
  sandboxSpecUltra: "sandbox.spec.ultra",
  spaceStorageMaxBytes: "space.storage.max_bytes",
  spaceModsMax: "space.mods.max",
  spaceCommerce: "space.commerce",
  // Billing-provider feature keys are stored identifiers on purchased
  // entitlements; the work-era key stays frozen so existing grants keep resolving.
  workPublishHideCohubBar: "work.publish.hide_cohub_bar",
} as const;

export type CohubBillingTokenType =
  typeof COHUB_BILLING_TOKEN_TYPES[keyof typeof COHUB_BILLING_TOKEN_TYPES]
  | (string & {});

export type CohubBillingUsageType =
  typeof COHUB_BILLING_USAGE_TYPES[keyof typeof COHUB_BILLING_USAGE_TYPES]
  | (string & {});

export type CohubBillingFeatureKey =
  typeof COHUB_BILLING_FEATURES[keyof typeof COHUB_BILLING_FEATURES]
  | (string & {});

export type BillingUserRef = {
  userId: string;
};

export type GenerationModelDiscount = {
  multiplier: number;
  benefitKey: string | null;
  grantId: string | null;
  resolvedAt: string;
};

export type GenerationModelDiscountInput = BillingUserRef & {
  model: string;
};

export type BillingReferralRewardInput = BillingUserRef & {
  referralId: string;
  side: "inviter" | "invitee";
  operationId: string;
  expectedAmountUsd: number;
};

export type BillingReferralRewardResult = {
  amountUsd: number;
  benefitKey: string;
  grantId: string;
  transactionId: string;
};

export type BillingProviderKind = "disabled" | "talesofai";

export type BillingPluginStatus = {
  provider: BillingProviderKind;
  configured: boolean;
  reason?: string;
};

export type BillingCreditBalance = {
  tokenType: string;
  availableBalance: number;
  openOverageBalance: number;
  netBalance: number;
  raw: BillingCreditSummaryRaw;
};

export type BillingCreditUnit = {
  tokenType: string;
  /** `null` marks a non-monetary virtual unit (e.g. `cohub_credit`). */
  displayCurrency: string | null;
  displayUnit: string;
  unitToUsd: number;
  unitsPerUsd: number;
  usdDecimalPlaces: number;
};

export type BillingCreditGrantStatus = {
  id: string;
  tokenType: string;
  benefitKey: string | null;
  benefitName: string | null;
  grantKind: string | null;
  sourceType: string | null;
  sourceId: string | null;
  status: string;
  availableNow: boolean | null;
  unavailableReasons: string[];
  remainingAmount: number;
  remainingAmountUsd: number;
  originalAmount: number | null;
  originalAmountUsd: number | null;
  consumedAmount: number | null;
  consumedAmountUsd: number | null;
  usageConsumedAmount: number | null;
  usageConsumedAmountUsd: number | null;
  settledOverageAmount: number | null;
  settledOverageAmountUsd: number | null;
  consumedPercent: number | null;
  effectiveAt: string | null;
  expiresAt: string | null;
  daysRemaining: number | null;
  createdAt: string;
};

export type BillingCreditExpiryGroup = {
  key: "expired" | "lt_7d" | "lt_30d" | "gte_30d" | "never";
  remainingAmountUsd: number;
  grants: BillingCreditGrantStatus[];
};

export type BillingCreditStatus = {
  netUsd: number;
  groups: BillingCreditExpiryGroup[];
};

export type BillingProductKind = "plan" | "addon";

export type BillingProductBillingInterval = "monthly" | "quarterly" | "yearly" | "one_time" | "other";

export type BillingProductPricing = {
  amountMinor: number;
  amountUsd: number;
  compareAtAmountMinor: number | null;
  compareAtAmountUsd: number | null;
  discountLabel: string | null;
  discountRate: number | null;
};

export type BillingDiscountPricing = {
  amountMinor: number;
  amountUsd: number;
  discountAmountMinor: number;
  discountAmountUsd: number;
  paidAmountMinor: number;
  paidAmountUsd: number;
  currency: string;
};

export type BillingDiscountOfferRef = {
  key: string;
  revision: string;
};

export type BillingDiscountOffer = {
  ref: BillingDiscountOfferRef;
  name: string;
  duration: "once" | "forever";
  endsAt: string | null;
  pricing: BillingDiscountPricing;
};

/**
 * Campaign a product participates in, independent of the viewer. Lets
 * anonymous and ineligible visitors see the incentive that exists, while
 * {@link BillingCatalogProduct.offer} stays the only source of a real price.
 */
export type BillingProductPromotion = {
  kind: "first_purchase";
  percentOff: number;
  endsAt: string | null;
};

export type BillingProductDisplay = {
  description: string | null;
  benefits: string[];
  creditsAmount: number | null;
  validity: string | null;
  creditBenefits: BillingProductCreditBenefit[];
};

export type BillingProductCreditBenefit = {
  key: string;
  name: string;
  tokenType: string;
  grantKind: string;
  scope: string;
  cycleAmount: number;
  cycleAmountUsd: number;
  periodAmount: number;
  periodAmountUsd: number;
  expiresInDays: number | null;
};

export type BillingCatalogProduct = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  visibility: string;
  billingType: string;
  billingPeriod: string;
  billingIntervalCount: number;
  currency: string;
  kind: BillingProductKind;
  interval: BillingProductBillingInterval;
  pricing: BillingProductPricing;
  /** Viewer-independent campaign the product is part of, if any. */
  promotion: BillingProductPromotion | null;
  /** User-specific automatic offer. Base pricing remains unchanged. */
  offer: BillingDiscountOffer | null;
  display: BillingProductDisplay;
  isDefaultPlan: boolean;
};

export type BillingSubscriptionSummary = {
  id: string;
  productKey: string | null;
  productName: string | null;
  status: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

export type BillingPaymentStatus = {
  available: boolean;
  reason: string | null;
};

export type BillingCatalog = BillingUserRef & {
  billing: BillingPluginStatus;
  payment: BillingPaymentStatus;
  products: BillingCatalogProduct[];
  plans: BillingCatalogProduct[];
  addons: BillingCatalogProduct[];
  currentSubscriptions: BillingSubscriptionSummary[];
  hasActiveSubscription: boolean;
  defaultPlanProductKey: string | null;
};

export type BillingHistoryPagination = {
  hasMore: boolean;
  nextPage: number | null;
};

export type BillingCheckoutActionState = {
  canPay: boolean;
  checkoutUrl: string | null;
  checkoutUsable: boolean;
  canCancelCheckout: boolean;
  canCancelAutoRenew: boolean;
  unavailableReason: string | null;
};

export type BillingHistoryListInput = BillingUserRef & {
  page?: number;
  limit?: number;
};

export type BillingSubscriptionHistoryStatus = {
  id: string;
  externalUserId: string;
  productKey: string;
  productName: string;
  status: string;
  amountMinor: number;
  amountUsd: number;
  paidAmountMinor: number;
  paidAmountUsd: number;
  currency: string;
  billingPeriod: string;
  billingIntervalCount: number;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  checkoutExpiresAt: string | null;
  checkoutCanceledAt: string | null;
  checkoutExpiredAt: string | null;
  paymentConflictedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  providerStatus: string | null;
  providerTerminal: boolean;
  checkoutStatus: string | null;
  actions: BillingCheckoutActionState;
};

export type BillingSubscriptionHistoryList = BillingUserRef & {
  billing: BillingPluginStatus;
  page: number;
  limit: number;
  items: BillingSubscriptionHistoryStatus[];
  pagination: BillingHistoryPagination;
};

export type BillingCheckoutInput = BillingUserRef & {
  productKey: string;
  returnUrl?: string;
  promotionCode?: string;
  offer?: BillingDiscountOfferRef;
};

export type BillingPromotionCodePreviewInput = BillingUserRef & {
  productKey: string;
  promotionCode: string;
};

export type BillingPromotionCodePreview = BillingUserRef & {
  productKey: string;
  promotionCode: string;
  eligible: boolean;
  reasonCode: string | null;
  message: string | null;
  name: string | null;
  duration: "once" | "forever" | null;
  endsAt: string | null;
  pricing: BillingDiscountPricing | null;
};

export type BillingCheckoutResult = BillingUserRef & {
  billing: BillingPluginStatus;
  payment: BillingPaymentStatus;
  productKey: string;
  checkoutUrl: string | null;
  checkoutUsable: boolean;
  message: string | null;
  orderId: string | null;
  subscriptionId: string | null;
  reused: boolean;
};

/**
 * Server-confirmed state of a checkout that just returned to the app. The
 * outcome is only trusted once the provider reports the order/subscription as
 * settled; the URL alone never carries that promise.
 */
export type BillingCheckoutConfirmation = {
  productKey: string;
  /** `true` when the order/subscription reached a paid (or live) terminal state. */
  settled: boolean;
  /** Provider status when settled, e.g. `paid` for an order or `active` for a subscription. */
  status: string | null;
  /** Whether the record is still awaiting payment (vs. failed/canceled, which also settle as `!settled`). */
  pending: boolean;
  productName: string | null;
};


export type BillingRedemptionInput = BillingUserRef & {
  code: string;
};

export type BillingRedemptionResult = BillingUserRef & {
  billing: BillingPluginStatus;
  redeemed: boolean;
  message: string | null;
  redemptionRecordId: string | null;
  itemCount: number;
};

export type BillingFeatureEntitlement = {
  key: string;
  enabled: boolean;
  metadata: Record<string, string | number | boolean>;
  grants: BillingActiveBenefitRaw[];
};

export type BillingAccountState = BillingUserRef & {
  credits: BillingCreditBalance[];
  entitlements: BillingFeatureEntitlement[];
};

export type BillingUsagePreflightInput = BillingUserRef & {
  estimatedAmountUsd: number;
  usageType: CohubBillingUsageType;
  tokenType?: CohubBillingTokenType;
};

/**
 * Advisory balance check only. This does not reserve credits; callers must still
 * handle recordUsage returning "overage".
 */
export type BillingUsagePreflight = {
  allowed: boolean;
  tokenType: string;
  estimatedAmountUsd: number;
  availableBalance: number;
  netBalance: number;
  shortfall: number;
};

export type BillingBalanceActivityKind =
  | "grant"
  | "usage"
  | "refund"
  | "expire"
  | "revoke"
  | "adjust";

export type BillingBalanceActivityStatus = "covered" | "overage" | "partial" | null;

export type BillingBalanceActivity = {
  id: string;
  kind: BillingBalanceActivityKind;
  tokenType: string;
  title: string;
  description: string | null;
  sourceType: string | null;
  sourceId: string | null;
  operationId: string | null;
  amountUsd: number;
  status: BillingBalanceActivityStatus;
  createdAt: string;
};

export type BillingBalanceActivityList = BillingUserRef & {
  billing: BillingPluginStatus;
  tokenType: string;
  unit: BillingCreditUnit;
  page: number;
  limit: number;
  items: BillingBalanceActivity[];
  pagination: BillingHistoryPagination;
};

export type BillingBalanceActivityListInput = BillingUserRef & {
  tokenType?: CohubBillingTokenType;
  page?: number;
  limit?: number;
};

export type BillingUsageRecordInput = BillingUserRef & {
  amountUsd: number;
  usageType: CohubBillingUsageType;
  sourceId: string;
  operationId: string;
  tokenType?: CohubBillingTokenType;
  reason?: string;
};

export type BillingUsageRecordResult = {
  tokenType: string;
  amountUsd: number;
  status: "disabled" | "skipped" | "recorded" | "overage";
  response: BillingConsumeCreditsResponseRaw | null;
};

export type BillingFeatureEntitlementInput = BillingUserRef & {
  featureKey: CohubBillingFeatureKey;
};

export type BillingFeatureLimitInput = BillingFeatureEntitlementInput & {
  quantity: number;
  metadataKey?: string;
  fallbackLimit?: number;
  missingEntitlementPolicy?: "allow" | "deny";
};

export type BillingFeatureLimitCheck = {
  allowed: boolean;
  quantity: number;
  limit: number | null;
  unlimited: boolean;
  entitlement: BillingFeatureEntitlement | null;
};

/**
 * A single purchase result for a business-scoped credit pack.
 */
export type BusinessCreditConsumeStatus =
  | "consumed"
  | "insufficient"
  | "disabled";

export type BusinessCreditConsumeInput = BillingUserRef & {
  /** Positive integer amount of virtual credits to consume. */
  amount: number;
  /** Client-generated idempotency key; reuse to safely retry the same consume. */
  operationId: string;
  /** Stable id of the consuming work, recorded as the billing usage `source_id`. */
  sourceId: string;
  reason?: string;
};

export type BusinessCreditConsumeResult = {
  userId: string;
  status: BusinessCreditConsumeStatus;
  amount: number;
  remaining: number;
  shortfall: number | null;
};

/**
 * Business-scoped billing operations for a single billing business (e.g. a
 * Cohub Space). Shares the same credit mapping helpers and declarations as
 * the platform {@link BillingOperations}, but is bound to one business key and
 * exposes only the subset needed for space commerce: entitlement lookups,
 * credit status, and credit consumption.
 */
export interface BusinessBillingOperations {
  readonly status: BillingPluginStatus;
  readonly businessKey: string;
  getEntitlements(input: BillingUserRef): Promise<BillingAccountState>;
  getCreditStatus(input: BillingUserRef): Promise<BillingCreditStatus>;
  consume(input: BusinessCreditConsumeInput): Promise<BusinessCreditConsumeResult>;
}

export interface BillingOperations {
  readonly status: BillingPluginStatus;
  ensureCustomer(input: BillingUserRef): Promise<BillingUserRef>;
  getState(input: BillingUserRef): Promise<BillingAccountState>;
  getGenerationModelDiscount(input: GenerationModelDiscountInput): Promise<GenerationModelDiscount>;
  getCreditStatus(input: BillingUserRef & { tokenType?: CohubBillingTokenType }): Promise<BillingCreditStatus>;
  getCatalog(input?: BillingUserRef): Promise<BillingCatalog>;
  previewPromotionCode(input: BillingPromotionCodePreviewInput): Promise<BillingPromotionCodePreview>;
  listSubscriptions(input: BillingHistoryListInput): Promise<BillingSubscriptionHistoryList>;
  purchaseAddon(input: BillingCheckoutInput): Promise<BillingCheckoutResult>;
  createSubscription(input: BillingCheckoutInput): Promise<BillingCheckoutResult>;
  resolveCheckoutConfirmation(input: BillingUserRef & { productKey: string; checkoutId: string }): Promise<BillingCheckoutConfirmation>;
  cancelSubscriptionCheckout(input: BillingUserRef & { subscriptionId: string }): Promise<BillingSubscriptionHistoryStatus>;
  cancelSubscriptionAutoRenew(input: BillingUserRef & { subscriptionId: string }): Promise<BillingSubscriptionHistoryStatus>;
  redeemCode(input: BillingRedemptionInput): Promise<BillingRedemptionResult>;
  grantReferralReward(input: BillingReferralRewardInput): Promise<BillingReferralRewardResult>;
  preflightUsage(input: BillingUsagePreflightInput): Promise<BillingUsagePreflight>;
  recordUsage(input: BillingUsageRecordInput): Promise<BillingUsageRecordResult>;
  listBalanceActivities(input: BillingBalanceActivityListInput): Promise<BillingBalanceActivityList>;
  getFeatureEntitlement(input: BillingFeatureEntitlementInput): Promise<BillingFeatureEntitlement | null>;
  checkFeatureLimit(input: BillingFeatureLimitInput): Promise<BillingFeatureLimitCheck>;
}
