import {
  applyPricingMultiplier,
  BillingAccessBlockedError,
  billingOperations,
  generationUsageKind,
  isBillingUsageGateUnavailableError,
  isPricingSnapshotFree,
  parsePricingSnapshot,
  quotaUnitsRequested,
  snapshotMultiplier,
  spaceWalletBillingOperations,
  type BillingAccessDecision,
  type PricingQuote,
} from "@cohub/billing";
import {
  consumeGenerationQuota,
  createGenerationReserveHolds,
  GenerationBillingUnavailableError,
  parseGenerationReserveHold,
  refundGenerationQuota,
  type GenerationQuotaUse,
  type GenerationReserveHold,
  type GenerationReserveReleaseReason,
} from "@cohub/core/generation-billing";
import { taskRuns } from "@cohub/db";
import { loadGenerationBillingConfig, resolveGenerationBillingReserve } from "@cohub/infra/config-runtime/generation-billing";
import { createLogger } from "@cohub/infra/logging";
import type { GenerationPricingSnapshot } from "@cohub/protocol/generation";
import { eq } from "drizzle-orm";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { redisBestEffortCommandClient } from "./redis.js";
import { spaceWalletBilling } from "./space-wallet-billing.js";
import { usagePricing } from "./usage-pricing.js";

const logger = createLogger({ serviceName: "cohub-api" });
const ALLOWED: BillingAccessDecision = { status: "allowed", balanceState: "zero", netUsd: 0 };

export { GenerationBillingUnavailableError };

export class GenerationPricingUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("Generation pricing is temporarily unavailable. Please try again later.", options);
    this.name = "GenerationPricingUnavailableError";
  }
}

export const generationReserveHolds = createGenerationReserveHolds({
  redis: redisBestEffortCommandClient,
  billing: billingOperations,
  walletBilling: spaceWalletBillingOperations,
  info: (message, context) => logger.info(message, context),
  warn: (message, context) => logger.warn(message, context),
});

export type GenerationAdmission = {
  decision: BillingAccessDecision;
  hold: GenerationReserveHold | null;
  pricing: GenerationPricingSnapshot;
};

type AdmissionInput = {
  taskRunId: string;
  userId: string;
  spaceId: string;
  sessionId?: string | null;
  turnId?: string | null;
  model: string;
  /** The declaration's adapter type, matched by `providers` conditions. */
  provider: string | null;
  usageType: string;
  parameters?: Record<string, unknown>;
};

/**
 * Prices the request, draws any quota, then admits the uncovered remainder: whitelisted models must fit
 * their reserve on top of the payer's live holds, others take the usage gate. Throws
 * GenerationPricingUnavailableError or GenerationBillingUnavailableError (503) or
 * BillingAccessBlockedError (402); a failed admission returns any quota it drew.
 */
export async function admitGeneration(input: AdmissionInput): Promise<GenerationAdmission> {
  const context = { taskRunId: input.taskRunId, userId: input.userId, spaceId: input.spaceId, model: input.model };
  let quote: PricingQuote;
  try {
    quote = await usagePricing.quote({ userId: input.userId, usageType: input.usageType, model: input.model, provider: input.provider, modelDiscounts: true });
  } catch (error) {
    logger.error("[Billing] failed to price generation before enqueue", { ...context, error });
    throw new GenerationPricingUnavailableError({ cause: error });
  }

  let quota: GenerationQuotaUse | null = null;
  if (quote.quota && billingOperations.status.configured) {
    try {
      quota = await consumeGenerationQuota({
        billing: billingOperations,
        taskRunId: input.taskRunId,
        userId: input.userId,
        usageType: input.usageType,
        model: input.model,
        quota: quote.quota,
        requested: quotaUnitsRequested(input.parameters, quote.quota.parameter),
        warn: (message, details) => logger.error(message, details),
      });
    } catch (error) {
      logger.error("[Billing] failed to draw generation quota before enqueue", { ...context, tokenType: quote.quota.tokenType, error });
      throw new GenerationPricingUnavailableError({ cause: error });
    }
  }
  const pricing: GenerationPricingSnapshot = { resolvedAt: quote.resolvedAt, personal: quote.personal, spaceWallet: quote.spaceWallet, quota };
  if (pricing.personal.source || pricing.spaceWallet.source || quota) {
    logger.info("[Billing] generation priced", { ...context, personal: pricing.personal, spaceWallet: pricing.spaceWallet, quota });
  }

  try {
    return { ...await admitBalance(input, pricing), pricing };
  } catch (error) {
    await refundQuota(input.taskRunId, input.userId, quota);
    throw error;
  }
}

async function admitBalance(input: AdmissionInput, pricing: GenerationPricingSnapshot): Promise<Omit<GenerationAdmission, "pricing">> {
  if (isPricingSnapshotFree(pricing)) return { decision: ALLOWED, hold: null };

  const reserveConfig = await loadGenerationBillingConfig(config.platformConfigRoot, (error) => {
    logger.error("[Billing] invalid generation billing config", { error });
  });
  const reserveCap = resolveGenerationBillingReserve(reserveConfig, input.model);
  const amountUsd = reserveCap === null ? 0 : applyPricingMultiplier(reserveCap, snapshotMultiplier(pricing, "personal"));
  if (amountUsd > 0 && billingOperations.status.configured) {
    try {
      const result = await generationReserveHolds.hold({
        taskRunId: input.taskRunId,
        userId: input.userId,
        spaceId: input.spaceId,
        model: input.model,
        usageType: input.usageType,
        amountUsd,
        walletAmountUsd: applyPricingMultiplier(reserveCap, snapshotMultiplier(pricing, "space_wallet")),
      });
      if (result.status === "blocked") throw result.error;
      return { decision: ALLOWED, hold: result.hold };
    } catch (error) {
      if (error instanceof BillingAccessBlockedError || error instanceof GenerationBillingUnavailableError) throw error;
      // Redis is down: the hold is only a defense, so admit through the regular gate instead.
      logger.warn("[GenerationReserve] Redis unavailable; admitting through the usage gate", {
        taskRunId: input.taskRunId,
        userId: input.userId,
        model: input.model,
        amountUsd,
        error,
      });
    }
  }

  let decision: BillingAccessDecision;
  try {
    decision = await spaceWalletBilling.gate.evaluate({
      userId: input.userId,
      usageKind: generationUsageKind(input.usageType),
      source: "generation_task",
      model: input.model,
      spaceId: input.spaceId,
      sessionId: input.sessionId ?? null,
      turnId: input.turnId ?? null,
    });
  } catch (error) {
    if (isBillingUsageGateUnavailableError(error)) throw new GenerationBillingUnavailableError(error.message, { cause: error });
    throw error;
  }
  if (decision.status === "blocked") throw new BillingAccessBlockedError(decision);
  return { decision, hold: null };
}

const refundQuota = (taskRunId: string, userId: string, quota: GenerationQuotaUse | null | undefined) =>
  refundGenerationQuota({ billing: billingOperations, taskRunId, userId, quota, error: (message, context) => logger.error(message, context) });

/** Undoes an admission whose task never reached the queue. */
export async function releaseGenerationAdmission(
  input: { taskRunId: string; userId: string; admission: Pick<GenerationAdmission, "hold" | "pricing"> },
  reason: GenerationReserveReleaseReason,
): Promise<void> {
  const { taskRunId, userId, admission } = input;
  await Promise.all([
    admission.hold ? generationReserveHolds.release(taskRunId, admission.hold.payer, reason) : null,
    refundQuota(taskRunId, userId, admission.pricing.quota),
  ]);
}

/** Releases the hold and returns the quota of a queued generation whose turn was cancelled. */
export async function releaseCancelledGeneration(taskRunId: string): Promise<void> {
  const [task] = await db.select({ payload: taskRuns.payload, userUuid: taskRuns.userUuid }).from(taskRuns).where(eq(taskRuns.id, taskRunId)).limit(1);
  const data = (task?.payload as { data?: { reserveHold?: unknown; pricing?: unknown } } | null | undefined)?.data;
  const hold = parseGenerationReserveHold(data?.reserveHold);
  const quota = data?.pricing ? parsePricingSnapshot(data.pricing).quota : null;
  await Promise.all([
    hold ? generationReserveHolds.release(taskRunId, hold.payer, "turn_cancelled") : null,
    task?.userUuid ? refundQuota(taskRunId, task.userUuid, quota) : null,
  ]);
}
