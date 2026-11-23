import { billingOperations, parsePricingSnapshot, spaceWalletBillingOperations } from "@cohub/billing";
import { createGenerationReserveHolds, refundGenerationQuota } from "@cohub/core/generation-billing";
import { createLogger } from "@cohub/infra/logging";
import { redisBestEffortCommandClient } from "./redis.js";

const logger = createLogger({ serviceName: "cohub-worker" });

export const generationReserveHolds = createGenerationReserveHolds({
  redis: redisBestEffortCommandClient,
  billing: billingOperations,
  walletBilling: spaceWalletBillingOperations,
  info: (message, context) => logger.info(message, context),
  warn: (message, context) => logger.warn(message, context),
});

/** Tasks whose provider call succeeded in this process; their quota stays spent even if a later step fails. */
const deliveredGenerations = new Set<string>();

export function markGenerationDelivered(taskRunId: string) {
  deliveredGenerations.add(taskRunId);
}

/** Returns a failed generation's quota unless its output was already produced. */
export async function refundFailedGenerationQuota(input: { taskRunId: string; userId: string | undefined; pricing: unknown }) {
  const delivered = deliveredGenerations.delete(input.taskRunId);
  if (delivered || !input.userId || input.pricing === undefined) return;
  try {
    const { quota } = parsePricingSnapshot(input.pricing);
    await refundGenerationQuota({ billing: billingOperations, taskRunId: input.taskRunId, userId: input.userId, quota, reason: "task_failed" });
  } catch (error) {
    logger.error("[GenerationQuota] refund failed; manual billing verification required", { taskRunId: input.taskRunId, userId: input.userId, error });
  }
}

export function forgetGenerationDelivery(taskRunId: string) {
  deliveredGenerations.delete(taskRunId);
}
