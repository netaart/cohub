import {
  COHUB_BILLING_CREDIT_UNITS,
  COHUB_BILLING_TOKEN_TYPES,
  type Benefit,
  type CreditsBenefit,
  type CreditsBenefitConfig,
  type Product,
  type PurchasedCreditsBenefitConfig,
} from "@cohub/billing";
import type { CohubBalanceDescriptor } from "./space-commerce-balance.js";
import { serializeCohubBalance } from "./space-commerce-balance.js";

export type SerializedCommerceBenefitConfig =
  | {
      type: "feature";
      metadata: Record<string, string | number | boolean>;
    }
  | {
      type: "credits";
      amount: number;
      expiresInDays: number | null;
    };

export type SerializedCommerceBenefit = {
  key: string;
  name: string;
  description: string | null;
  status: string;
  type: "feature" | "credits";
  config: SerializedCommerceBenefitConfig;
};

export type SerializedCommerceProductCreditBenefit = {
  key: string;
  name: string;
  amount: number;
  expiresInDays: number | null;
};

export type SerializedCommerceProduct = {
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
  kind: "addon";
  interval: "one_time";
  pricing: {
    amountMinor: number;
    amountUsd: number;
    compareAtAmountMinor: number | null;
    compareAtAmountUsd: number | null;
    discountLabel: string | null;
    discountRate: number | null;
  };
  display: {
    description: string | null;
    benefits: string[];
    creditsAmount: number | null;
    validity: string | null;
    creditBenefits: SerializedCommerceProductCreditBenefit[];
  };
  cohubBalance: {
    amountUsd: number;
    amountMinor: number;
    policyVersion: string;
  } | null;
  isDefaultPlan: boolean;
};

export type SerializedCommerceProductBenefitBinding = {
  id: string | null;
  productKey: string;
  benefitKey: string;
  createdAt: string | null;
};

export type SerializedCommerceBuyerProfile = {
  displayName: string;
  avatarUrl: string | null;
};

export type SerializedCommerceOrder = {
  id: string;
  productKeySnapshot: string;
  productNameSnapshot: string;
  status: string;
  amountSnapshot: number;
  paidAmountSnapshot: number;
  createdAt: string;
  paidAt: string | null;
  buyerProfile: SerializedCommerceBuyerProfile | null;
};

export function serializeOrder(order: {
  id: string;
  product_key_snapshot: string;
  product_name_snapshot: string;
  status: string;
  amount_snapshot: number;
  paid_amount_snapshot: number;
  created_at: string;
  paid_at: string | null;
}, input?: {
  buyerProfile?: SerializedCommerceBuyerProfile | null;
}): SerializedCommerceOrder {
  return {
    id: order.id,
    productKeySnapshot: order.product_key_snapshot,
    productNameSnapshot: order.product_name_snapshot,
    status: order.status,
    amountSnapshot: order.amount_snapshot,
    paidAmountSnapshot: order.paid_amount_snapshot,
    createdAt: order.created_at,
    paidAt: order.paid_at,
    buyerProfile: input?.buyerProfile ?? null,
  };
}

export function serializeProductBenefit(binding: {
  id: string;
  product_key: string;
  benefit_key: string;
  created_at: string;
}): SerializedCommerceProductBenefitBinding {
  return {
    id: binding.id,
    productKey: binding.product_key,
    benefitKey: binding.benefit_key,
    createdAt: binding.created_at,
  };
}

const COHUB_CREDIT_TOKEN = COHUB_BILLING_TOKEN_TYPES.cohubCredit;

function isCreditsBenefit(benefit: Benefit): benefit is CreditsBenefit {
  return benefit.type === "credits";
}

function resolveExpiresInDays(config: CreditsBenefitConfig): number | null {
  if (!("expires_in_days" in config)) return null;
  const value = config.expires_in_days;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function serializeBenefit(benefit: Benefit): SerializedCommerceBenefit {
  if (isCreditsBenefit(benefit)) {
    const config = benefit.config;
    return {
      key: benefit.key,
      name: benefit.name,
      description: benefit.description,
      status: benefit.status,
      type: "credits",
      config: {
        type: "credits",
        amount: config.amount,
        expiresInDays: resolveExpiresInDays(config),
      },
    };
  }
  return {
    key: benefit.key,
    name: benefit.name,
    description: benefit.description,
    status: benefit.status,
    type: "feature",
    config: {
      type: "feature",
      metadata: benefit.config?.metadata ?? {},
    },
  };
}

export function serializeProduct(
  product: Product,
  boundCreditBenefits: CreditsBenefit[] = [],
  cohubBalance?: CohubBalanceDescriptor | null,
): SerializedCommerceProduct {
  const amountMinor = Number(product.amount ?? 0);
  const amountUsd = amountMinor / 100;
  const creditBenefits = boundCreditBenefits
    .filter((benefit) => benefit.config.token_type === COHUB_CREDIT_TOKEN)
    .map((benefit) => ({
      key: benefit.key,
      name: benefit.name,
      amount: benefit.config.amount,
      expiresInDays: resolveExpiresInDays(benefit.config),
    }));
  const creditsAmount =
    creditBenefits.length > 0
      ? creditBenefits.reduce((sum, b) => sum + b.amount, 0)
      : null;
  return {
    id: product.id,
    key: product.key,
    name: product.name,
    description: product.description,
    status: product.status,
    visibility: product.visibility,
    billingType: product.billing_type ?? "one_time",
    billingPeriod: product.billing_period ?? "one_time",
    billingIntervalCount: Number(product.billing_interval_count ?? 1),
    currency: product.currency ?? "USD",
    kind: "addon",
    interval: "one_time",
    pricing: {
      amountMinor,
      amountUsd,
      compareAtAmountMinor: null,
      compareAtAmountUsd: null,
      discountLabel: null,
      discountRate: null,
    },
    display: {
      description: product.description,
      benefits: [],
      creditsAmount,
      validity: null,
      creditBenefits,
    },
    cohubBalance: serializeCohubBalance(cohubBalance),
    isDefaultPlan: false,
  };
}

/**
 * Credit benefit config for a space commerce `credits` benefit. Cohub space
 * commerce always uses the virtual `cohub_credit` token at business scope with
 * a one-time purchase grant kind; these are fixed so creators never need to
 * reason about token types or scopes.
 */
export function buildSpaceCreditsBenefitConfig(input: {
  amount: number;
  expiresInDays?: number | null;
}): PurchasedCreditsBenefitConfig {
  const config: PurchasedCreditsBenefitConfig = {
    token_type: COHUB_CREDIT_TOKEN,
    amount: input.amount,
    scope: "business",
    grant_kind: "purchased",
  };
  if (input.expiresInDays != null) {
    config.expires_in_days = input.expiresInDays;
  }
  return config;
}

export const COMMERCE_CREDIT_UNIT = COHUB_BILLING_CREDIT_UNITS.cohubCredit;
