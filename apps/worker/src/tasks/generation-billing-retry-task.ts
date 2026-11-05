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
import { recordGenerationTaskBilling, updateGenerationTurnBilling } from "./generation-session.js";
import { spaceWalletBilling } from "../space-wallet-billing.js";
import { spaceWalletCustomerId } from "@cohub/core/space-wallet";
import { taskRuns } from "@cohub/db";
import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { generationReserveHolds } from "../generation-billing.js";

/**
 * Personal billing retries retain the original idempotency key. With Space
 * wallets enabled, the shared router skips retries rather than choosing a new payer,
 * unless a reserve hold pinned the payer.
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
  if (data.payer) {
    // A held generation that failed after its first charge attempt must not be charged; its hold is already released.
    const [task] = await db.select({ status: taskRuns.status }).from(taskRuns).where(eq(taskRuns.id, data.taskRunId)).limit(1);
    if (task?.status === "failed") {
      console.info("[GenerationReserve] skipped the billing retry of a failed task", { taskRunId: data.taskRunId, payerType: data.payer });
      return { status: "skipped", reason: "task_failed", taskRunId: data.taskRunId };
    }
  }

  const result = await spaceWalletBilling.recordUsage({
    spaceId: payload.spaceId,
    retryOnly: true,
    payer: data.payer,
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
  await (data.payer ? recordGenerationTaskBilling : updateGenerationTurnBilling)(data.taskRunId, billing);
  const holdPayerId = data.payer === "space_wallet" ? payload.spaceId && spaceWalletCustomerId(payload.spaceId) : data.userId;
  if (data.payer && holdPayerId && billing.status !== "skipped") {
    await generationReserveHolds.release(data.taskRunId, { type: data.payer, id: holdPayerId }, "retry_charged");
  }
  return { ...billing, taskRunId: data.taskRunId };
});
