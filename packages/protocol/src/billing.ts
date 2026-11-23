/**
 * Standard billing payload attached under the `billing` key of any response
 * or realtime event that involves a billing gate. Present on 402 error bodies
 * (blocked / not entitled), on success responses carrying a soft debt warning,
 * and on realtime error events. `conversion` always drives the shared upgrade
 * UI; balance fields appear only for balance-based gates.
 *
 * `conversion` is intentionally `unknown` here to keep the protocol layer free
 * of a billing dependency — clients validate it against `BillingConversionIntent`.
 */
export type BillingPayload = {
  conversion: unknown;
  status?: "blocked" | "allowed_with_debt";
  netUsd?: number;
  hardNegativeLimitUsd?: number;
  minimumBalanceUsd?: number;
};

/** The caller's best personal price for a model, attached to model listings for badges and countdowns. */
export type ModelOffer = {
  multiplier: number;
  ruleKey: string | null;
  endsAt: string | null;
  /** The rule asks clients to surface it outside the model picker. */
  announce: boolean;
};

/** A quota that covers this model's requests, one unit per unit of the request `parameter`. */
export type ModelQuotaOffer = { tokenType: string; parameter: string };

/** A quota token balance in raw units, net of open overage. */
export type BillingQuota = {
  tokenType: string;
  /** The request parameter one unit covers (e.g. `duration` seconds), from the pricing rules. */
  parameter: string | null;
  balance: number;
  grants: Array<{ benefitName: string | null; remaining: number; original: number | null; expiresAt: string | null }>;
};

export type ListBillingQuotasResponse = { quotas: BillingQuota[] };
