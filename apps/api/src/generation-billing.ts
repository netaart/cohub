import {
  applyGenerationModelDiscount,
  BillingAccessBlockedError,
  billingOperations,
  generationUsageKind,
  isBillingUsageGateUnavailableError,
  isGenerationModelDiscountFree,
  spaceWalletBillingOperations,
  type BillingAccessDecision,
  type GenerationModelDiscount,
} from "@cohub/billing";
import {
  createGenerationReserveHolds,
  GenerationBillingUnavailableError,
  parseGenerationReserveHold,
  type GenerationReserveHold,
} from "@cohub/core/generation-billing";
import { taskRuns } from "@cohub/db";
import { loadGenerationBillingConfig, resolveGenerationBillingReserve } from "@cohub/infra/config-runtime/generation-billing";
import { createLogger } from "@cohub/infra/logging";
import { eq } from "drizzle-orm";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { redisBestEffortCommandClient } from "./redis.js";
import { spaceWalletBilling } from "./space-wallet-billing.js";

const logger = createLogger({ serviceName: "cohub-api" });
const ALLOWED: BillingAccessDecision = { status: "allowed", balanceState: "zero", netUsd: 0 };

export { GenerationBillingUnavailableError };

export const generationReserveHolds = createGenerationReserveHolds({
  redis: redisBestEffortCommandClient,
  billing: billingOperations,
  walletBilling: spaceWalletBillingOperations,
  warn: (message, context) => logger.warn(message, context),
});

/**
 * Whitelisted models must fit their reserve on top of the payer's live holds; others take the usage
 * gate. Throws BillingAccessBlockedError (402) or GenerationBillingUnavailableError (503).
 */
export async function admitGeneration(input: {
  taskRunId: string;
  userId: string;
  spaceId: string;
  sessionId?: string | null;
  turnId?: string | null;
  model: string;
  usageType: string;
  discount: GenerationModelDiscount;
}): Promise<{ decision: BillingAccessDecision; hold: GenerationReserveHold | null }> {
  if (isGenerationModelDiscountFree(input.discount)) return { decision: ALLOWED, hold: null };

  const reserveConfig = await loadGenerationBillingConfig(config.platformConfigRoot, (error) => {
    logger.error("[Billing] invalid generation billing config", { error });
  });
  const reserveCap = resolveGenerationBillingReserve(reserveConfig, input.model);
  const amountUsd = reserveCap === null ? 0 : applyGenerationModelDiscount(reserveCap, input.discount);
  if (amountUsd > 0 && billingOperations.status.configured) {
    try {
      const result = await generationReserveHolds.hold({
        taskRunId: input.taskRunId,
        userId: input.userId,
        spaceId: input.spaceId,
        usageType: input.usageType,
        amountUsd,
      });
      if (result.status === "blocked") throw result.error;
      return { decision: ALLOWED, hold: result.hold };
    } catch (error) {
      if (error instanceof BillingAccessBlockedError || error instanceof GenerationBillingUnavailableError) throw error;
      // Redis is down: the hold is only a defense, so admit through the regular gate instead.
      logger.warn("[Billing] generation reserve hold unavailable; using the usage gate", { model: input.model, error });
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

/** Releases the hold recorded on a queued generation task, if any. */
export async function releaseGenerationTaskHold(taskRunId: string): Promise<void> {
  const [task] = await db.select({ payload: taskRuns.payload }).from(taskRuns).where(eq(taskRuns.id, taskRunId)).limit(1);
  const data = (task?.payload as { data?: { reserveHold?: unknown } } | null | undefined)?.data;
  const hold = parseGenerationReserveHold(data?.reserveHold);
  if (hold) await generationReserveHolds.release(taskRunId, hold.payer);
}
