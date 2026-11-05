import type { Redis } from "ioredis";
import {
  COHUB_BILLING_CREDIT_UNITS,
  COHUB_BILLING_TOKEN_TYPES,
  type BillingAccountState,
  type BillingBalanceActivityList,
  type BillingBalanceActivityListInput,
  type BillingCatalog,
  type BillingCheckoutInput,
  type BillingCheckoutConfirmation,
  type BillingCheckoutResult,
  type BillingCreditStatus,
  type BillingCreditUnit,
  type BillingFeatureEntitlement,
  type BillingFeatureLimitCheck,
  type BillingFeatureLimitInput,
  type BillingHistoryListInput,
  type BillingOperations,
  type BillingPluginStatus,
  type BillingRedemptionInput,
  type BillingRedemptionResult,
  type BillingReferralRewardResult,
  type BillingSubscriptionHistoryList,
  type BillingSubscriptionHistoryStatus,
  type BillingUsagePreflight,
  type BillingUsagePreflightInput,
  type BillingUsageRecordInput,
  type BillingUsageRecordResult,
  type BillingUserRef,
  type BusinessBillingOperations,
  type BusinessCreditConsumeResult,
} from "./interfaces.js";
import { resolveGenerationModelDiscount } from "./generation-usage.js";
import { checkoutLockRedisRef } from "./runtime.js";

export type { BillingClientConfig, BillingRuntimeConfig } from "./types.js";
import type { BillingClientConfig, BillingRuntimeConfig } from "./types.js";

export type BillingRedisClient = Pick<Redis, "get" | "set" | "eval">;

let runtimeConfig: BillingRuntimeConfig = {};

export function configureBillingRuntime(input: {
  config?: BillingRuntimeConfig;
  redis?: BillingRedisClient | null;
}) {
  runtimeConfig = input.config ?? {};
  checkoutLockRedisRef.current = input.redis ?? null;
  defaultBillingOperations = null;
  defaultSpaceWalletBillingOperations = null;
}

export class BillingConfigurationError extends Error {
  constructor(message = "Talesofai Billing is not configured") {
    super(message);
    this.name = "BillingConfigurationError";
  }
}

export function resolveBillingClientConfig(
  config: BillingRuntimeConfig = runtimeConfig,
): BillingClientConfig | null {
  const baseUrl = config.talesofaiBillingBaseUrl?.trim();
  const businessKey = config.talesofaiBillingBusinessKey?.trim();
  const adminApiKey = config.talesofaiBillingAdminApiKey?.trim();
  if (!baseUrl || !businessKey || !adminApiKey) return null;
  return { baseUrl, businessKey, adminApiKey };
}

export function resolveSpaceWalletBillingClientConfig(
  config: BillingRuntimeConfig = runtimeConfig,
): BillingClientConfig | null {
  const personal = resolveBillingClientConfig(config);
  const businessKey = config.talesofaiBillingSpaceWalletBusinessKey?.trim();
  if (!personal || !businessKey || businessKey === personal.businessKey) return null;
  return { ...personal, businessKey };
}

export function isBillingConfigured(): boolean {
  return resolveBillingClientConfig() !== null;
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

class DisabledBillingError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly responseBody: unknown;
  constructor(input: { status: number; message: string; code?: string }) {
    super(input.message);
    this.name = "DisabledBillingError";
    this.status = input.status;
    this.code = input.code;
    this.responseBody = { message: input.message, code: input.code };
  }
}

function billingApiError(statusCode: number, message: string, code?: string): DisabledBillingError {
  return new DisabledBillingError({ status: statusCode, message, code });
}

function emptyCreditStatus(): BillingCreditStatus {
  return {
    netUsd: 0,
    groups: [],
  };
}

function emptyBalanceActivityList(input: {
  userId: string;
  tokenType: string;
  status: BillingPluginStatus;
  page: number;
  limit: number;
}): BillingBalanceActivityList {
  return {
    userId: input.userId,
    billing: input.status,
    tokenType: input.tokenType,
    unit: getCreditUnit(input.tokenType),
    page: input.page,
    limit: input.limit,
    items: [],
    pagination: {
      hasMore: false,
      nextPage: null,
    },
  };
}

function emptyCatalog(input: {
  userId: string;
  status: BillingPluginStatus;
  paymentReason: string | null;
}): BillingCatalog {
  return {
    userId: input.userId,
    billing: input.status,
    payment: {
      available: false,
      reason: input.paymentReason,
    },
    products: [],
    plans: [],
    addons: [],
    currentSubscriptions: [],
    hasActiveSubscription: false,
    defaultPlanProductKey: null,
  };
}

function emptySubscriptionHistoryList(input: {
  userId: string;
  status: BillingPluginStatus;
  page: number;
  limit: number;
}): BillingSubscriptionHistoryList {
  return {
    userId: input.userId,
    billing: input.status,
    page: input.page,
    limit: input.limit,
    items: [],
    pagination: {
      hasMore: false,
      nextPage: null,
    },
  };
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

function disabledRedemptionResult(input: {
  userId: string;
  status: BillingPluginStatus;
  reason: string | null;
}): BillingRedemptionResult {
  return {
    userId: input.userId,
    billing: input.status,
    redeemed: false,
    message: input.reason,
    redemptionRecordId: null,
    itemCount: 0,
  };
}

export function createDisabledBillingOperations(
  reason = "billing configuration is missing",
): BillingOperations {
  const status: BillingPluginStatus = {
    provider: "disabled",
    configured: false,
    reason,
  };
  return {
    status,

    async ensureCustomer(input: BillingUserRef): Promise<BillingUserRef> {
      return input;
    },

    async getState(input: BillingUserRef): Promise<BillingAccountState> {
      return { userId: input.userId, credits: [], entitlements: [] };
    },

    async getGenerationModelDiscount(input) {
      return resolveGenerationModelDiscount({
        model: input.model,
        entitlements: [],
      });
    },

    async getCreditStatus(): Promise<BillingCreditStatus> {
      return emptyCreditStatus();
    },

    async confirmSpaceWalletOrder() {
      throw new BillingConfigurationError("Space wallet billing is not configured");
    },

    async getCatalog(input?: BillingUserRef): Promise<BillingCatalog> {
      return emptyCatalog({
        userId: input?.userId ?? "anonymous",
        status,
        paymentReason: status.reason ?? "Billing integration is not configured",
      });
    },

    async previewPromotionCode(input): Promise<import("./interfaces.js").BillingPromotionCodePreview> {
      return {
        userId: input.userId,
        productKey: input.productKey,
        promotionCode: input.promotionCode,
        eligible: false,
        reasonCode: "billing_unavailable",
        message: status.reason ?? "Billing integration is not configured",
        name: null,
        duration: null,
        endsAt: null,
        pricing: null,
      };
    },

    async listSubscriptions(
      input: BillingHistoryListInput,
    ): Promise<BillingSubscriptionHistoryList> {
      return emptySubscriptionHistoryList({
        userId: input.userId,
        status,
        page: input.page ?? 1,
        limit: input.limit ?? 10,
      });
    },

    async purchaseAddon(
      input: BillingCheckoutInput,
    ): Promise<BillingCheckoutResult> {
      return disabledCheckoutResult({
        userId: input.userId,
        productKey: input.productKey,
        status,
        reason: status.reason ?? "Billing integration is not configured",
      });
    },

    async createSubscription(
      input: BillingCheckoutInput,
    ): Promise<BillingCheckoutResult> {
      return disabledCheckoutResult({
        userId: input.userId,
        productKey: input.productKey,
        status,
        reason: status.reason ?? "Billing integration is not configured",
      });
    },

    async resolveCheckoutConfirmation(input: BillingUserRef & { productKey: string; checkoutId: string }): Promise<BillingCheckoutConfirmation> {
      return {
        productKey: input.productKey,
        settled: false,
        status: null,
        pending: false,
        productName: null,
      };
    },

    async cancelSubscriptionCheckout(): Promise<BillingSubscriptionHistoryStatus> {
      throw billingApiError(
        503,
        status.reason ?? "Billing integration is not configured",
        "billing_unavailable",
      );
    },

    async getSubscription(): Promise<BillingSubscriptionHistoryStatus> {
      throw billingApiError(503, "Billing integration is not configured", "billing_unavailable");
    },
    async getSubscriptionPaymentAction(): Promise<{ checkoutUrl: string | null; reason: string | null }> {
      throw billingApiError(503, "Billing integration is not configured", "billing_unavailable");
    },

    async cancelSubscriptionAutoRenew(): Promise<BillingSubscriptionHistoryStatus> {
      throw billingApiError(
        503,
        status.reason ?? "Billing integration is not configured",
        "billing_unavailable",
      );
    },

    async redeemCode(
      input: BillingRedemptionInput,
    ): Promise<BillingRedemptionResult> {
      return disabledRedemptionResult({
        userId: input.userId,
        status,
        reason: status.reason ?? "Billing integration is not configured",
      });
    },

    async grantReferralReward(): Promise<BillingReferralRewardResult> {
      throw new BillingConfigurationError(status.reason);
    },

    async preflightUsage(
      input: BillingUsagePreflightInput,
    ): Promise<BillingUsagePreflight> {
      const tokenType =
        input.tokenType ?? COHUB_BILLING_TOKEN_TYPES.usdMicroCent;
      return {
        allowed: true,
        tokenType,
        estimatedAmountUsd: roundUsd(
          input.estimatedAmountUsd,
          getCreditUnit(tokenType).usdDecimalPlaces,
        ),
        availableBalance: 0,
        netBalance: 0,
        shortfall: 0,
      };
    },

    async recordUsage(
      input: BillingUsageRecordInput,
    ): Promise<BillingUsageRecordResult> {
      const tokenType =
        input.tokenType ?? COHUB_BILLING_TOKEN_TYPES.usdMicroCent;
      return {
        tokenType,
        amountUsd: roundUsd(
          input.amountUsd,
          getCreditUnit(tokenType).usdDecimalPlaces,
        ),
        status: "disabled",
        response: null,
      };
    },

    async listBalanceActivities(
      input: BillingBalanceActivityListInput,
    ): Promise<BillingBalanceActivityList> {
      const tokenType =
        input.tokenType ?? COHUB_BILLING_TOKEN_TYPES.usdMicroCent;
      return emptyBalanceActivityList({
        userId: input.userId,
        tokenType,
        status,
        page: input.page ?? 1,
        limit: input.limit ?? 10,
      });
    },

    async getFeatureEntitlement(): Promise<BillingFeatureEntitlement | null> {
      return null;
    },

    async checkFeatureLimit(
      input: BillingFeatureLimitInput,
    ): Promise<BillingFeatureLimitCheck> {
      const limit = input.fallbackLimit ?? null;
      const allowed =
        limit === null
          ? input.missingEntitlementPolicy !== "deny"
          : input.quantity <= limit;
      return {
        allowed,
        quantity: input.quantity,
        limit,
        unlimited: limit === null,
        entitlement: null,
      };
    },
  };
}


export function createDisabledBusinessBillingOperations(
  reason = "billing configuration is missing",
): BusinessBillingOperations {
  const status: BillingPluginStatus = {
    provider: "disabled",
    configured: false,
    reason,
  };
  return {
    status,
    businessKey: "",
    async getEntitlements(input: BillingUserRef): Promise<BillingAccountState> {
      return { userId: input.userId, credits: [], entitlements: [] };
    },
    async getCreditStatus(): Promise<BillingCreditStatus> {
      return emptyCreditStatus();
    },
    async consume(input): Promise<BusinessCreditConsumeResult> {
      return {
        userId: input.userId,
        status: "disabled",
        amount: 0,
        remaining: 0,
        shortfall: null,
      };
    },
  };
}


type TalesofaiProviderModule = {
  createTalesofaiBillingOperations: (clientConfig: BillingClientConfig) => BillingOperations;
  createBusinessBillingOperations: (input: {
    clientConfig: BillingClientConfig;
    businessKey: string;
  }) => BusinessBillingOperations;
};

function loadTalesofaiProviderModule(): Promise<TalesofaiProviderModule> {
  return import("./provider-talesofai.js").catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BillingConfigurationError(
      `Talesofai Billing provider is unavailable. Install @talesofai-billing/sdk for hosted billing, or leave billing unconfigured. (${detail})`,
    );
  });
}

function lazyBillingOperations(
  load: () => Promise<BillingOperations>,
  status: BillingPluginStatus,
): BillingOperations {
  let implPromise: Promise<BillingOperations> | null = null;
  const getImpl = () => {
    implPromise ??= load();
    return implPromise;
  };
  return new Proxy(
    { status } as BillingOperations,
    {
      get(target, property, receiver) {
        if (property === "status") return status;
        if (property === "then") return undefined;
        const value = Reflect.get(target, property, receiver);
        if (value !== undefined) return value;
        return async (...args: unknown[]) => {
          const impl = await getImpl();
          const method = Reflect.get(impl, property) as unknown;
          if (typeof method !== "function") return method;
          return (method as (...a: unknown[]) => unknown).apply(impl, args);
        };
      },
    },
  );
}

function lazyBusinessBillingOperations(
  load: () => Promise<BusinessBillingOperations>,
  status: BillingPluginStatus,
  businessKey: string,
): BusinessBillingOperations {
  let implPromise: Promise<BusinessBillingOperations> | null = null;
  const getImpl = () => {
    implPromise ??= load();
    return implPromise;
  };
  return new Proxy(
    { status, businessKey } as BusinessBillingOperations,
    {
      get(target, property, receiver) {
        if (property === "status") return status;
        if (property === "businessKey") return businessKey;
        if (property === "then") return undefined;
        const value = Reflect.get(target, property, receiver);
        if (value !== undefined) return value;
        return async (...args: unknown[]) => {
          const impl = await getImpl();
          const method = Reflect.get(impl, property) as unknown;
          if (typeof method !== "function") return method;
          return (method as (...a: unknown[]) => unknown).apply(impl, args);
        };
      },
    },
  );
}

let defaultBillingOperations: BillingOperations | null = null;
let defaultSpaceWalletBillingOperations: SpaceWalletBillingOperations | null = null;

export type SpaceWalletBillingOperations = BillingOperations & { readonly businessKey: string | null };

export function createSpaceWalletBillingOperations(config: BillingRuntimeConfig = runtimeConfig): SpaceWalletBillingOperations {
  const clientConfig = resolveSpaceWalletBillingClientConfig(config);
  const operations = clientConfig
    ? createTalesofaiBillingOperations(clientConfig)
    : createDisabledBillingOperations("A separate wallet billing business is required");
  return Object.assign(operations, { businessKey: clientConfig?.businessKey ?? null });
}

export const spaceWalletBillingOperations = new Proxy({} as SpaceWalletBillingOperations, {
  get(_target, property, receiver) {
    defaultSpaceWalletBillingOperations ??= createSpaceWalletBillingOperations();
    return Reflect.get(defaultSpaceWalletBillingOperations, property, receiver);
  },
});

export function createTalesofaiBillingOperations(
  clientConfig: BillingClientConfig,
): BillingOperations {
  const status: BillingPluginStatus = {
    provider: "talesofai",
    configured: true,
  };
  return lazyBillingOperations(
    async () => {
      const provider = await loadTalesofaiProviderModule();
      return provider.createTalesofaiBillingOperations(clientConfig);
    },
    status,
  );
}

export function createBillingOperations(): BillingOperations {
  const clientConfig = resolveBillingClientConfig();
  if (!clientConfig) return createDisabledBillingOperations();
  return createTalesofaiBillingOperations(clientConfig);
}

export function createBusinessBillingOperations(input: {
  clientConfig: BillingClientConfig;
  businessKey: string;
}): BusinessBillingOperations {
  const status: BillingPluginStatus = {
    provider: "talesofai",
    configured: true,
  };
  return lazyBusinessBillingOperations(
    async () => {
      const provider = await loadTalesofaiProviderModule();
      return provider.createBusinessBillingOperations(input);
    },
    status,
    input.businessKey,
  );
}

export function getBillingOperations(): BillingOperations {
  defaultBillingOperations ??= createBillingOperations();
  return defaultBillingOperations;
}

export const billingOperations = new Proxy({} as BillingOperations, {
  get(_target, property, receiver) {
    return Reflect.get(getBillingOperations(), property, receiver);
  },
});
