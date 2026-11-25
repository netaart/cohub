import { createHash } from "node:crypto";
import {
  COHUB_BILLING_CREDIT_UNITS,
  COHUB_BILLING_TOKEN_TYPES,
  type CreditsBenefit,
  type Product,
  type PurchasedCreditsBenefitConfig,
} from "@cohub/billing";

export const COHUB_BALANCE_POLICY_VERSION = "balance-bundle-v1";
export const COHUB_BALANCE_MIN_USD = 1;
export const COHUB_BALANCE_META_KEY = "cohub_balance";
const COHUB_BALANCE_META_VERSION = 1;

const BENEFIT_KEY_MAX_LENGTH = 64;
const USD_MINOR_PER_USD = 100;
const BALANCE_UNITS_PER_USD = COHUB_BILLING_CREDIT_UNITS.usdMicroCent.unitsPerUsd;

export class CohubBalanceValidationError extends Error {
  override name = "CohubBalanceValidationError";
}

export type CohubBalanceSpec = {
  amountUsd: number;
  amountMinor: number;
  benefitAmount: number;
  policyVersion: typeof COHUB_BALANCE_POLICY_VERSION;
};

/**
 * Parsed Cohub Balance descriptor stored on the Billing Product meta.
 * Billing remains the single source of truth; this module never touches a
 * Cohub database.
 */
export type CohubBalanceDescriptor = {
  benefitKey: string;
  amountMinor: number;
  policyVersion: string;
};

export type CohubBalanceProductMeta = {
  version: typeof COHUB_BALANCE_META_VERSION;
  benefit_key: string;
  amount_minor: number;
  policy_version: string;
};

export type ProductStatus = "draft" | "active";
export type ProductVisibility = "public" | "private";

/**
 * Status and visibility a product must be created with.
 *
 * Billing refuses to bind a Benefit to a `draft` product, so a Balance product
 * cannot be staged as a draft. It is created `active` but `private` instead:
 * binding succeeds, while the public resolve and checkout paths both require
 * `visibility === "public"` and therefore cannot see it until provisioning
 * finishes and the caller's requested state is applied.
 */
export function resolveBalanceProductCreateState(input: {
  hasBalance: boolean;
  requestedStatus: ProductStatus;
  requestedVisibility: ProductVisibility;
}): { status: ProductStatus; visibility: ProductVisibility } {
  if (!input.hasBalance) {
    return { status: input.requestedStatus, visibility: input.requestedVisibility };
  }
  return { status: "active", visibility: "private" };
}

export function resolveCohubBalanceSpec(input: {
  value: unknown;
  productAmountMinor: number;
}): CohubBalanceSpec | null {
  if (input.value === undefined || input.value === null || input.value === false) return null;
  if (typeof input.value !== "number" || !Number.isSafeInteger(input.value) || input.value < COHUB_BALANCE_MIN_USD) {
    throw new CohubBalanceValidationError(
      `cohubBalanceUsd must be an integer of at least ${COHUB_BALANCE_MIN_USD}`,
    );
  }
  const amountUsd = input.value;
  const amountMinor = amountUsd * USD_MINOR_PER_USD;
  const benefitAmount = amountUsd * BALANCE_UNITS_PER_USD;
  if (!Number.isSafeInteger(amountMinor) || !Number.isSafeInteger(benefitAmount)) {
    throw new CohubBalanceValidationError("cohubBalanceUsd is too large");
  }
  if (!Number.isSafeInteger(input.productAmountMinor) || input.productAmountMinor < amountMinor) {
    throw new CohubBalanceValidationError("Product price must cover Cohub Balance");
  }
  return {
    amountUsd,
    amountMinor,
    benefitAmount,
    policyVersion: COHUB_BALANCE_POLICY_VERSION,
  };
}

export function buildCohubBalanceBenefitKey(productKey: string, amountUsd: number): string {
  const hash = createHash("sha256").update(productKey).digest("hex").slice(0, 8);
  const suffix = `_cb_${amountUsd}_${hash}`;
  const prefixLength = Math.max(1, BENEFIT_KEY_MAX_LENGTH - suffix.length);
  const prefix = productKey.slice(0, prefixLength).replace(/_+$/g, "") || "product";
  return `${prefix}${suffix}`;
}

export function buildCohubBalanceBenefitConfig(spec: CohubBalanceSpec): PurchasedCreditsBenefitConfig {
  return {
    token_type: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
    amount: spec.benefitAmount,
    scope: "global",
    grant_kind: "purchased",
  };
}

export function buildCohubBalanceProductMeta(
  spec: CohubBalanceSpec,
  benefitKey: string,
): CohubBalanceProductMeta {
  return {
    version: COHUB_BALANCE_META_VERSION,
    benefit_key: benefitKey,
    amount_minor: spec.amountMinor,
    policy_version: spec.policyVersion,
  };
}

export function parseCohubBalanceProductMeta(value: unknown): CohubBalanceDescriptor | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.version !== COHUB_BALANCE_META_VERSION) return null;
  const benefitKey = record.benefit_key;
  const amountMinor = record.amount_minor;
  const policyVersion = record.policy_version;
  if (typeof benefitKey !== "string" || benefitKey.length === 0) return null;
  if (
    typeof amountMinor !== "number" ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < COHUB_BALANCE_MIN_USD * USD_MINOR_PER_USD ||
    amountMinor % USD_MINOR_PER_USD !== 0
  ) {
    return null;
  }
  if (typeof policyVersion !== "string" || policyVersion.length === 0) return null;
  return { benefitKey, amountMinor, policyVersion };
}

export function readCohubBalanceDescriptor(
  product: Pick<Product, "meta">,
): CohubBalanceDescriptor | null {
  return parseCohubBalanceProductMeta(product.meta?.[COHUB_BALANCE_META_KEY]);
}

export function isCohubBalanceBenefitValid(
  benefit: CreditsBenefit,
  balance: Pick<CohubBalanceDescriptor, "amountMinor" | "policyVersion">,
): boolean {
  const amountUsd = balance.amountMinor / USD_MINOR_PER_USD;
  const expectedAmount = amountUsd * BALANCE_UNITS_PER_USD;
  return balance.policyVersion === COHUB_BALANCE_POLICY_VERSION &&
    benefit.status === "active" &&
    benefit.config.token_type === COHUB_BILLING_TOKEN_TYPES.usdMicroCent &&
    benefit.config.scope === "global" &&
    benefit.config.grant_kind === "purchased" &&
    benefit.config.amount === expectedAmount;
}

export function isCohubBalanceProductValid(input: {
  productKey: string;
  productAmountMinor: number;
  productCurrency: string | undefined;
  balance: CohubBalanceDescriptor;
  benefit: CreditsBenefit | null | undefined;
  boundBenefitKeys: readonly string[];
}): boolean {
  return input.productCurrency?.toUpperCase() === "USD" &&
    Number.isSafeInteger(input.productAmountMinor) &&
    input.productAmountMinor >= input.balance.amountMinor &&
    input.benefit?.key === input.balance.benefitKey &&
    input.boundBenefitKeys.includes(input.balance.benefitKey) &&
    isCohubBalanceBenefitValid(input.benefit, input.balance);
}

export function serializeCohubBalance(
  balance: CohubBalanceDescriptor | null | undefined,
) {
  if (!balance) return null;
  return {
    amountUsd: balance.amountMinor / USD_MINOR_PER_USD,
    amountMinor: balance.amountMinor,
    policyVersion: balance.policyVersion,
  };
}

/** Benefit keys that are platform-managed Cohub Balance across the given products. */
export function collectManagedBalanceBenefitKeys(
  products: readonly Pick<Product, "meta">[],
): Set<string> {
  const keys = new Set<string>();
  for (const product of products) {
    const descriptor = readCohubBalanceDescriptor(product);
    if (descriptor) keys.add(descriptor.benefitKey);
  }
  return keys;
}
