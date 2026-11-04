import { billingOperations, spaceWalletBillingOperations } from "@cohub/billing";
import { createGenerationBillingReservations, settledReservationBilling, type GenerationBillingReservation } from "@cohub/core/generation-billing";
import { taskRuns } from "@cohub/db";
import { createLogger } from "@cohub/infra/logging";
import type { GenerationUsageBilling } from "@cohub/protocol/generation";
import { eq } from "drizzle-orm";
import { db } from "./db.js";

const logger = createLogger({ serviceName: "cohub-worker" });

async function notifyReconcileSettled(reservation: GenerationBillingReservation, overage: boolean) {
  const { recordGenerationTaskBilling } = await import("./tasks/generation-session.js");
  const [task] = await db.select({ result: taskRuns.result }).from(taskRuns).where(eq(taskRuns.id, reservation.taskRunId)).limit(1);
  const result = task?.result as { billing?: Partial<GenerationUsageBilling> } | null | undefined;
  const previous = result?.billing ?? {};
  await recordGenerationTaskBilling(reservation.taskRunId, {
    ...(previous.officialCostUsd !== undefined ? { officialCostUsd: previous.officialCostUsd } : {}),
    ...(previous.discountMultiplier !== undefined ? { discountMultiplier: previous.discountMultiplier } : {}),
    ...settledReservationBilling(reservation),
    usageType: reservation.usageType,
    status: overage ? "overage" : "recorded",
  });
}

export const generationBilling = createGenerationBillingReservations({
  db,
  billing: billingOperations,
  walletBilling: spaceWalletBillingOperations,
  warn: (message, context) => logger.warn(message, context),
  onReconcileSettled: notifyReconcileSettled,
});
