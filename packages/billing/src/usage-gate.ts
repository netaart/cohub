import { COHUB_BILLING_POLICY } from "./constants.js";
import { createBillingConversionIntent, type BillingConversionIntent } from "./conversion.js";
import { BillingUsageGateUnavailableError } from "./errors.js";
import { COHUB_BILLING_TOKEN_TYPES, type BillingOperations } from "./interfaces.js";

export type BillingUsageKind =
  | "llm.turn"
  | "llm.raw_completion"
  | "llm.decision"
  | "generation"
  | "generation.image"
  | "generation.video"
  | "generation.music"
  | "generation.3d"
  | "sandbox.compute"
  | (string & {});

export type BillingUsageSource =
  | "session_prompt"
  | "scheduled_prompt"
  | "generation_task"
  | "agent_llm_call"
  | "raw_completion"
  | "decision"
  | (string & {});

export type BillingUsageGateInput = {
  userId: string;
  usageKind: BillingUsageKind;
  source: BillingUsageSource;
  model?: string | null;
  provider?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
};

export type BillingBalanceState = "positive" | "zero" | "negative";

export type BillingAccessDecision =
  | {
      status: "allowed";
      balanceState: "positive" | "zero";
      netUsd: number;
    }
  | {
      status: "allowed_with_debt";
      balanceState: "negative";
      netUsd: number;
      hardNegativeLimitUsd: number;
      conversion: BillingConversionIntent;
    }
  | {
      status: "blocked";
      code: "billing_credit_limit_exceeded";
      balanceState: BillingBalanceState;
      netUsd: number;
      minimumBalanceUsd: number;
      conversion: BillingConversionIntent;
    }
  | {
      status: "blocked";
      code: "billing_credit_limit_exceeded";
      balanceState: "zero" | "negative";
      netUsd: number;
      hardNegativeLimitUsd: number;
      conversion: BillingConversionIntent;
    };

export type BillingUsageGate = {
  evaluate(input: BillingUsageGateInput): Promise<BillingAccessDecision>;
};

export function createBillingUsageGate(input: {
  operations: Pick<BillingOperations, "getCreditStatus"> & Partial<Pick<BillingOperations, "status">>;
  hardNegativeLimitUsd?: number;
  minimumBalanceUsdByUsageKind?: Readonly<Record<string, number>>;
  failClosedUsageKinds?: readonly BillingUsageKind[];
  tokenType?: string;
  onEvaluationError?: (error: unknown, gateInput: BillingUsageGateInput) => void;
}): BillingUsageGate {
  const hardNegativeLimitUsd = input.hardNegativeLimitUsd ?? COHUB_BILLING_POLICY.hardNegativeLimitUsd;
  if (hardNegativeLimitUsd > 0) {
    throw new Error("hardNegativeLimitUsd must be zero or negative");
  }
  const minimumBalanceUsdByUsageKind: Readonly<Record<string, number>> =
    input.minimumBalanceUsdByUsageKind ?? COHUB_BILLING_POLICY.minimumBalanceUsdByUsageKind;
  for (const minimumBalanceUsd of Object.values(minimumBalanceUsdByUsageKind)) {
    if (!Number.isFinite(minimumBalanceUsd) || minimumBalanceUsd < 0) {
      throw new Error("Minimum balances must be finite and non-negative");
    }
  }
  const failClosedUsageKinds = new Set<string>(
    input.failClosedUsageKinds ?? COHUB_BILLING_POLICY.failClosedUsageKinds,
  );
  const tokenType = input.tokenType ?? COHUB_BILLING_TOKEN_TYPES.usdMicroCent;

  return {
    async evaluate(gateInput) {
      if (input.operations.status && !input.operations.status.configured) {
        return { status: "allowed", balanceState: "zero", netUsd: 0 };
      }

      let netUsd = 0;
      try {
        const credit = await input.operations.getCreditStatus({
          userId: gateInput.userId,
          tokenType,
        });
        if (!Number.isFinite(credit.netUsd)) {
          throw new Error("Billing returned a non-finite net balance");
        }
        netUsd = credit.netUsd;
      } catch (error) {
        input.onEvaluationError?.(error, gateInput);
        if (failClosedUsageKinds.has(gateInput.usageKind)) {
          throw new BillingUsageGateUnavailableError(gateInput.usageKind, { cause: error });
        }
        return { status: "allowed", balanceState: "zero", netUsd };
      }

      const minimumBalanceUsd = minimumBalanceUsdByUsageKind[gateInput.usageKind];
      if (minimumBalanceUsd !== undefined && netUsd < minimumBalanceUsd) {
        const isVideoGeneration = gateInput.usageKind === "generation.video";
        const minimumBalanceLabel = minimumBalanceUsd.toLocaleString("en-US", {
          style: "currency",
          currency: "USD",
        });
        return {
          status: "blocked",
          code: "billing_credit_limit_exceeded",
          balanceState: netUsd > 0 ? "positive" : netUsd < 0 ? "negative" : "zero",
          netUsd,
          minimumBalanceUsd,
          conversion: createBillingConversionIntent({
            level: "hard",
            reason: "minimum_balance_not_met",
            source: gateInput.source,
            title: "Insufficient balance",
            message: isVideoGeneration
              ? `Video generation requires a balance of at least ${minimumBalanceLabel}.`
              : `A balance of at least ${minimumBalanceLabel} is required to continue.`,
          }),
        };
      }
      if (netUsd > 0) {
        return { status: "allowed", balanceState: "positive", netUsd };
      }
      if (netUsd === 0) {
        return {
          status: "blocked",
          code: "billing_credit_limit_exceeded",
          balanceState: "zero",
          netUsd,
          hardNegativeLimitUsd,
          conversion: createBillingConversionIntent({
            level: "hard",
            reason: "balance_not_positive",
            source: gateInput.source,
            message: "A positive balance is required to continue.",
          }),
        };
      }
      if (netUsd >= hardNegativeLimitUsd) {
        return {
          status: "allowed_with_debt",
          balanceState: "negative",
          netUsd,
          hardNegativeLimitUsd,
          conversion: createBillingConversionIntent({
            level: "soft",
            reason: "negative_balance",
            source: gateInput.source,
          }),
        };
      }
      return {
        status: "blocked",
        code: "billing_credit_limit_exceeded",
        balanceState: "negative",
        netUsd,
        hardNegativeLimitUsd,
        conversion: createBillingConversionIntent({
          level: "hard",
          reason: "balance_not_positive",
          source: gateInput.source,
          message: "A positive balance is required to continue.",
        }),
      };
    },
  };
}
