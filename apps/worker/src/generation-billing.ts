import { billingOperations, spaceWalletBillingOperations } from "@cohub/billing";
import { createGenerationBillingReservations, type GenerationBillingReservation } from "@cohub/core/generation-billing";
import { taskRuns } from "@cohub/db";
import { createLogger } from "@cohub/infra/logging";
import { eq, sql } from "drizzle-orm";
import { db } from "./db.js";

const logger = createLogger({ serviceName: "cohub-worker" });

async function notifySettled(reservation: GenerationBillingReservation, overage: boolean) {
  const { updateGenerationTurnBilling } = await import("./tasks/generation-session.js");
  const reservedUsd = Number(reservation.reserveUsd);
  const actualUsd = Number(reservation.actualUsd ?? 0);
  const billing = {
    status: overage ? "overage" as const : "recorded" as const,
    amountUsd: actualUsd,
    reservedAmountUsd: reservedUsd,
    refundedAmountUsd: Math.max(0, Number((reservedUsd - actualUsd).toFixed(8))),
    additionalAmountUsd: Math.max(0, Number((actualUsd - reservedUsd).toFixed(8))),
    usageType: reservation.usageType,
  };
  await updateGenerationTurnBilling(reservation.taskRunId, billing);
  await db.update(taskRuns).set({
    result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) || jsonb_build_object('billing', ${JSON.stringify(billing)}::jsonb)`,
    updatedAt: new Date(),
  }).where(eq(taskRuns.id, reservation.taskRunId)).catch(() => undefined);
}

export const generationBilling = createGenerationBillingReservations({
  db,
  billing: billingOperations,
  walletBilling: spaceWalletBillingOperations,
  warn: (message, context) => logger.warn(message, context),
  onSettled: notifySettled,
});
