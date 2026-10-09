import type { BillingConversionIntent } from "./conversion.js";
import type { BillingAccessBlockedError } from "./errors.js";
import type { BillingAccessDecision } from "./usage-gate.js";

/**
 * Standard billing payload attached under the `billing` key of any response
 * that involves a billing gate. Present on 402 error bodies (blocked / not
 * entitled) and on success bodies carrying a soft debt warning. `conversion`
 * always drives the shared upgrade UI; balance fields appear only for
 * balance-based gates.
 */
export type BillingResponsePayload = {
  conversion: BillingConversionIntent;
  status?: "blocked" | "allowed_with_debt";
  netUsd?: number;
  hardNegativeLimitUsd?: number;
  minimumBalanceUsd?: number;
};

/** Standard shape of a billing-gated error body (`code` + `message` + `billing`). */
export type BillingErrorBody = {
  code: string;
  message: string;
  billing: BillingResponsePayload;
};

/** Serializes a blocked usage-gate error into the standard 402 body. */
export function serializeBillingBlocked(
  error: BillingAccessBlockedError,
  options?: { actionUrl?: string | null },
): BillingErrorBody {
  const actionUrl = options?.actionUrl?.trim();
  const conversion = actionUrl
    ? {
        ...error.decision.conversion,
        primaryAction: { ...error.decision.conversion.primaryAction, href: actionUrl },
      }
    : error.decision.conversion;
  return {
    code: error.code,
    message: error.message,
    billing: {
      status: error.decision.status,
      netUsd: error.decision.netUsd,
      ...("minimumBalanceUsd" in error.decision
        ? { minimumBalanceUsd: error.decision.minimumBalanceUsd }
        : { hardNegativeLimitUsd: error.decision.hardNegativeLimitUsd }),
      conversion,
    },
  };
}

/**
 * Serializes a soft debt warning into the standard `billing` payload for
 * success responses. Returns `null` for any non-warning decision.
 */
export function serializeBillingWarning(
  decision: BillingAccessDecision | null | undefined,
): BillingResponsePayload | null {
  if (decision?.status !== "allowed_with_debt") return null;
  return {
    status: decision.status,
    netUsd: decision.netUsd,
    hardNegativeLimitUsd: decision.hardNegativeLimitUsd,
    conversion: decision.conversion,
  };
}
