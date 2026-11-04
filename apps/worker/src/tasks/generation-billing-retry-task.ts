import {
  billingOperations,
  COHUB_BILLING_TOKEN_TYPES,
  type CohubBillingUsageType,
} from "@cohub/billing";
import type { Job } from "bullmq";
import { GENERATION_BILLING_RETRY_TASK_TYPE, type GenerationUsageBilling } from "@cohub/protocol/generation";
import type { TaskPayload } from "@cohub/protocol/task";
import { parseGenerationBillingRetryData } from "./generation-billing-retry-data.js";
import { registerTask } from "./registry.js";
import { updateGenerationTurnBilling } from "./generation-session.js";
import { spaceWalletBilling } from "../space-wallet-billing.js";
import { generationBilling } from "../generation-billing.js";
import { db } from "../db.js";
import { taskRuns } from "@cohub/db";
import { eq, sql } from "drizzle-orm";

/**
 * Personal billing retries retain the original idempotency key. With Space
 * wallets enabled, the shared router skips retries rather than choosing a new payer.
 */
registerTask(GENERATION_BILLING_RETRY_TASK_TYPE, async (job: Job) => {
  const payload = job.data as TaskPayload;
  const data = parseGenerationBillingRetryData(payload.data);
  const amountUsd = data.amountUsd;
  if (amountUsd <= 0) {
    return { status: "skipped", reason: "zero_amount", taskRunId: data.taskRunId };
  }
  if (!billingOperations.status.configured) {
    return { status: "skipped", reason: "billing_not_configured", taskRunId: data.taskRunId };
  }
  const reservation = await generationBilling.getReservation(data.taskRunId);
  if (reservation) {
    const settlement = await generationBilling.settle({
      taskRunId: data.taskRunId,
      actualUsd: data.amountUsd,
      reason: `Generation settlement ${data.model}`,
    });
    if (settlement.status === "pending") throw settlement.error;
    const reservedUsd = Number(reservation.reserveUsd);
    const billing = {
      status: settlement.status === "settled"
        ? settlement.overage ? "overage" : "recorded"
        : "skipped",
      officialCostUsd: data.officialCostUsd,
      amountUsd: data.amountUsd,
      discountMultiplier: data.modelDiscount.multiplier,
      usageType: data.usageType,
      reservedAmountUsd: reservedUsd,
      ...(settlement.status === "settled"
        ? {
            refundedAmountUsd: Math.max(0, Number((reservedUsd - data.amountUsd).toFixed(8))),
            additionalAmountUsd: Math.max(0, Number((data.amountUsd - reservedUsd).toFixed(8))),
          }
        : {}),
      ...(settlement.status === "released" || settlement.status === "missing"
        ? {
            reason: settlement.status === "released" ? "reservation_released" : "missing_reservation",
            ...(settlement.status === "released" ? { refundedAmountUsd: reservedUsd } : {}),
          }
        : {}),
    } satisfies GenerationUsageBilling;
    await updateGenerationTurnBilling(data.taskRunId, billing);
    await db.update(taskRuns).set({
      result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) || jsonb_build_object('billing', ${JSON.stringify(billing)}::jsonb)`,
      updatedAt: new Date(),
    }).where(eq(taskRuns.id, data.taskRunId)).catch(() => undefined);
    return { ...billing, taskRunId: data.taskRunId };
  }

  const result = await spaceWalletBilling.recordUsage({
    spaceId: payload.spaceId,
    retryOnly: true,
    userId: data.userId,
    amountUsd,
    tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
    usageType: data.usageType as CohubBillingUsageType,
    sourceId: data.taskRunId,
    operationId: `generation:${data.taskRunId}`,
    reason: `Generation ${data.model}`,
  });

  if (result.status === "overage") {
    console.warn("[Billing] generation usage retry recorded as overage", {
      userId: data.userId,
      taskRunId: data.taskRunId,
      officialCostUsd: data.officialCostUsd,
      amountUsd,
      discountMultiplier: data.modelDiscount.multiplier,
      model: data.model,
      usageType: data.usageType,
      adapterType: data.adapterType ?? null,
    });
  }

  const billing = {
    status: result.status === "overage"
      ? "overage"
      : result.status === "disabled" || result.status === "skipped"
        ? "skipped"
        : "recorded",
    officialCostUsd: data.officialCostUsd,
    amountUsd,
    discountMultiplier: data.modelDiscount.multiplier,
    usageType: data.usageType,
    ...(result.status === "disabled"
      ? { reason: "billing_disabled" }
      : result.status === "skipped"
        ? { reason: "record_failed" }
        : {}),
  } satisfies GenerationUsageBilling;
  await updateGenerationTurnBilling(data.taskRunId, billing);
  return { ...billing, taskRunId: data.taskRunId };
});
