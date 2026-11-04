import type { BillingAccessDecision, BillingUsageKind } from "./usage-gate.js";

export class BillingAccessBlockedError extends Error {
  readonly code = "billing_credit_limit_exceeded";

  constructor(
    public readonly decision: Extract<BillingAccessDecision, { status: "blocked" }>,
    message?: string,
  ) {
    super(
      message ??
        (decision.conversion.reason === "minimum_balance_not_met"
          ? "Insufficient balance for video generation."
          : "Add credits to continue."),
    );
    this.name = "BillingAccessBlockedError";
  }
}

export class BillingUsageGateUnavailableError extends Error {
  constructor(public readonly usageKind: BillingUsageKind, options?: ErrorOptions) {
    super("Balance is temporarily unavailable. Please try again.", options);
    this.name = "BillingUsageGateUnavailableError";
  }
}

export function isBillingAccessBlockedError(error: unknown): error is BillingAccessBlockedError {
  return error instanceof BillingAccessBlockedError;
}

export function isBillingUsageGateUnavailableError(
  error: unknown,
): error is BillingUsageGateUnavailableError {
  return error instanceof BillingUsageGateUnavailableError;
}
