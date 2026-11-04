import {
  applyGenerationModelDiscount,
  BillingAccessBlockedError,
  COHUB_BILLING_TOKEN_TYPES,
  createBillingConversionIntent,
  type BillingAccessDecision,
  type BillingOperations,
  type BillingUsageReversalReceipt,
  type SpaceWalletBillingOperations,
} from "@cohub/billing";
import { generationBillingReservations, taskRuns } from "@cohub/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { spaceWalletCustomerId, walletCreditsUsable } from "../space-wallet/index.js";

const RESERVE_TTL_MS = 60 * 60 * 1000;
const RESERVE_RECONCILE_GRACE_MS = 10 * 60 * 1000;
const SETTLE_RECONCILE_GRACE_MS = 5 * 60 * 1000;
const RECONCILE_BATCH_SIZE = 50;

export const GENERATION_RESERVE_OPERATION_PREFIX = "generation:reserve:";
export const GENERATION_SETTLE_OPERATION_PREFIX = "generation:extra:";
export const GENERATION_SETTLE_REFUND_OPERATION_PREFIX = "generation:settle-refund:";
export const GENERATION_RELEASE_REFUND_OPERATION_PREFIX = "generation:release-refund:";

export const generationReserveOperationId = (taskRunId: string) =>
  `${GENERATION_RESERVE_OPERATION_PREFIX}${taskRunId}`;
export const generationSettleOperationId = (taskRunId: string) =>
  `${GENERATION_SETTLE_OPERATION_PREFIX}${taskRunId}`;
export const generationSettleRefundOperationId = (taskRunId: string) =>
  `${GENERATION_SETTLE_REFUND_OPERATION_PREFIX}${taskRunId}`;
export const generationReleaseRefundOperationId = (taskRunId: string) =>
  `${GENERATION_RELEASE_REFUND_OPERATION_PREFIX}${taskRunId}`;

export type GenerationBillingPayer = {
  type: "personal" | "space_wallet";
  id: string;
};

export type GenerationBillingReservation = typeof generationBillingReservations.$inferSelect;

export type GenerationBillingReserveResult =
  | { status: "held"; reservation: GenerationBillingReservation }
  | { status: "disabled" }
  | { status: "blocked"; error: BillingAccessBlockedError };

export type GenerationBillingSettleResult =
  | { status: "settled"; reservation: GenerationBillingReservation; overage: boolean }
  | { status: "missing" }
  | { status: "released"; reservation: GenerationBillingReservation }
  | { status: "pending"; reservation: GenerationBillingReservation; error: unknown };

export class GenerationBillingUnavailableError extends Error {
  constructor(message = "Generation billing is temporarily unavailable. Please try again.", options?: ErrorOptions) {
    super(message, options);
    this.name = "GenerationBillingUnavailableError";
  }
}

function roundUsd(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(8));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function recordNumber(record: unknown, key: string): number | null {
  if (!isRecord(record)) return null;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rowUsd(value: string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function walletReason(userId: string, reason: string | undefined): string {
  const prefix = `actor_user_id=${encodeURIComponent(userId)}; `;
  return prefix + (reason ?? "Generation usage").slice(0, Math.max(0, 1_024 - prefix.length));
}

function blockedDecision(input: {
  reserveUsd: number;
  availableUsd: number;
}): Extract<BillingAccessDecision, { status: "blocked" }> {
  const reserveUsd = roundUsd(input.reserveUsd);
  const availableUsd = roundUsd(Math.max(0, input.availableUsd));
  const shortfallUsd = roundUsd(Math.max(0, reserveUsd - availableUsd));
  const reserveLabel = reserveUsd.toFixed(2);
  const availableLabel = availableUsd.toFixed(2);
  const shortfallLabel = shortfallUsd.toFixed(2);
  return {
    status: "blocked",
    code: "billing_credit_limit_exceeded",
    balanceState: availableUsd > 0 ? "positive" : "zero",
    netUsd: availableUsd,
    minimumBalanceUsd: reserveUsd,
    conversion: createBillingConversionIntent({
      level: "hard",
      reason: "minimum_balance_not_met",
      source: "generation_task",
      title: "Insufficient balance for this generation",
      message: `This generation reserves $${reserveLabel}. Available balance is $${availableLabel}; add $${shortfallLabel} to continue.`,
    }),
  };
}

function blockedError(input: { reserveUsd: number; availableUsd: number }): BillingAccessBlockedError {
  const decision = blockedDecision(input);
  return new BillingAccessBlockedError(decision, decision.conversion.message);
}

export function planGenerationSettlement(reserveUsd: number, actualUsd: number): {
  refundUsd: number;
  extraUsd: number;
} {
  const reserve = roundUsd(Math.max(0, reserveUsd));
  const actual = roundUsd(Math.max(0, actualUsd));
  if (actual < reserve) return { refundUsd: roundUsd(reserve - actual), extraUsd: 0 };
  if (actual > reserve) return { refundUsd: 0, extraUsd: roundUsd(actual - reserve) };
  return { refundUsd: 0, extraUsd: 0 };
}

type Candidate = {
  payer: GenerationBillingPayer;
  allowed: boolean;
  availableUsd: number;
};

export function createGenerationBillingReservations(input: {
  db: PostgresJsDatabase<Record<string, unknown>>;
  billing: BillingOperations;
  walletBilling: SpaceWalletBillingOperations;
  warn?: (message: string, context: Record<string, unknown>) => void;
  onSettled?: (reservation: GenerationBillingReservation, overage: boolean) => Promise<void>;
}) {
  const { db, billing, walletBilling } = input;
  const warn = input.warn;

  const operationsFor = (payer: GenerationBillingPayer): BillingOperations =>
    payer.type === "space_wallet" ? walletBilling : billing;

  const reasonFor = (payer: GenerationBillingPayer, userId: string, reason: string | undefined) =>
    payer.type === "space_wallet" ? walletReason(userId, reason) : reason;

  async function previewPayer(input: {
    payer: GenerationBillingPayer;
    reserveUsd: number;
    usageType: string;
  }): Promise<Candidate> {
    const operations = operationsFor(input.payer);
    if (!operations.status.configured) {
      return { payer: input.payer, allowed: false, availableUsd: 0 };
    }
    const preview = await operations.preflightUsage({
      userId: input.payer.id,
      tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
      usageType: input.usageType,
      estimatedAmountUsd: input.reserveUsd,
    });
    return {
      payer: input.payer,
      allowed: preview.allowed && preview.shortfall === 0,
      availableUsd: preview.availableBalance,
    };
  }

  async function selectPayer(input: {
    userId: string;
    spaceId: string | null;
    reserveUsd: number;
    usageType: string;
  }): Promise<{ payer: GenerationBillingPayer | null; availableUsd: number }> {
    const candidates: Candidate[] = [];
    if (input.spaceId && walletBilling.status.configured && billing.status.configured) {
      const walletId = spaceWalletCustomerId(input.spaceId);
      try {
        const credit = await walletBilling.getCreditStatus({ userId: walletId, createCustomer: false });
        if (walletCreditsUsable(credit) && credit.netUsd >= input.reserveUsd) {
          candidates.push(await previewPayer({
            payer: { type: "space_wallet", id: walletId },
            reserveUsd: input.reserveUsd,
            usageType: input.usageType,
          }));
        }
      } catch (error) {
        warn?.("Space wallet generation reserve preview failed", { spaceId: input.spaceId, error });
      }
    }
    if (billing.status.configured) {
      try {
        candidates.push(await previewPayer({
          payer: { type: "personal", id: input.userId },
          reserveUsd: input.reserveUsd,
          usageType: input.usageType,
        }));
      } catch (error) {
        if (candidates.length === 0) {
          throw new GenerationBillingUnavailableError(undefined, { cause: error });
        }
        warn?.("Personal generation reserve preview failed after wallet candidate", { userId: input.userId, error });
      }
    }
    const allowed = candidates.find((candidate) => candidate.allowed);
    if (allowed) return { payer: allowed.payer, availableUsd: allowed.availableUsd };
    const best = candidates.reduce<Candidate | null>(
      (current, candidate) => !current || candidate.availableUsd > current.availableUsd ? candidate : current,
      null,
    );
    return { payer: null, availableUsd: best?.availableUsd ?? 0 };
  }

  async function insertReservation(input: {
    taskRunId: string;
    userId: string;
    spaceId: string | null;
    model: string;
    usageType: string;
    reserveUsd: number;
    discountMultiplier: number;
  }): Promise<GenerationBillingReservation> {
    const now = Date.now();
    const [inserted] = await db.insert(generationBillingReservations).values({
      taskRunId: input.taskRunId,
      userId: input.userId,
      spaceId: input.spaceId,
      model: input.model,
      usageType: input.usageType,
      payerType: "pending",
      payerId: "",
      reserveUsd: input.reserveUsd.toFixed(8),
      reserveOperationId: generationReserveOperationId(input.taskRunId),
      discountMultiplier: input.discountMultiplier.toFixed(5),
      status: "reserving",
      expiresAt: new Date(now + RESERVE_TTL_MS),
    }).onConflictDoNothing().returning();
    if (inserted) return inserted;
    const [existing] = await db.select().from(generationBillingReservations)
      .where(eq(generationBillingReservations.taskRunId, input.taskRunId)).limit(1);
    if (!existing) throw new Error(`Generation billing reservation not found after insert conflict: ${input.taskRunId}`);
    return existing;
  }

  async function reserve(input: {
    taskRunId: string;
    userId: string;
    spaceId: string | null;
    model: string;
    usageType: string;
    reserveUsd: number;
    discountMultiplier: number;
    reason?: string;
  }): Promise<GenerationBillingReserveResult> {
    const reserveUsd = roundUsd(input.reserveUsd);
    if (reserveUsd <= 0) return { status: "disabled" };
    if (!billing.status.configured) return { status: "disabled" };

    const initial = await insertReservation({ ...input, reserveUsd });
    if (initial.status !== "reserving") {
      if (initial.status === "held") return { status: "held", reservation: initial };
      throw new GenerationBillingUnavailableError(`Generation billing reservation is already ${initial.status}.`);
    }

    const lockKey = input.spaceId
      ? `generation-reserve:space:${input.spaceId}`
      : `generation-reserve:user:${input.userId}`;

    try {
      return await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
        const [row] = await tx.select().from(generationBillingReservations)
          .where(eq(generationBillingReservations.taskRunId, input.taskRunId)).for("update");
        if (!row) throw new GenerationBillingUnavailableError("Generation billing reservation disappeared.");
        if (row.status === "held") return { status: "held", reservation: row };
        if (row.status !== "reserving") {
          throw new GenerationBillingUnavailableError(`Generation billing reservation is already ${row.status}.`);
        }

        const selected = await selectPayer({
          userId: input.userId,
          spaceId: input.spaceId,
          reserveUsd,
          usageType: input.usageType,
        });
        if (!selected.payer) {
          const error = blockedError({ reserveUsd, availableUsd: selected.availableUsd });
          await tx.update(generationBillingReservations).set({
            status: "released",
            payerType: "personal",
            payerId: input.userId,
            releasedAt: new Date(),
            lastError: error.message,
            updatedAt: new Date(),
          }).where(and(
            eq(generationBillingReservations.id, row.id),
            eq(generationBillingReservations.status, "reserving"),
          ));
          return { status: "blocked", error };
        }

        const payer = selected.payer;
        const operationId = generationReserveOperationId(input.taskRunId);
        const result = await operationsFor(payer).recordUsage({
          userId: payer.id,
          amountUsd: reserveUsd,
          tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
          usageType: input.usageType,
          sourceId: input.taskRunId,
          operationId,
          reason: reasonFor(payer, input.userId, input.reason ?? `Generation reserve ${input.model}`),
        });
        if (result.status === "disabled" || result.status === "skipped") {
          throw new GenerationBillingUnavailableError("Generation reserve debit was not recorded.");
        }
        if (result.status === "overage") {
          const reversal = await operationsFor(payer).reverseUsage({
            userId: payer.id,
            amountUsd: reserveUsd,
            tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
            originalOperationId: operationId,
            operationId: generationReleaseRefundOperationId(input.taskRunId),
            reason: `Generation reserve rejected ${input.model}`,
          });
          if (reversal.status !== "reversed") {
            throw new GenerationBillingUnavailableError("Generation reserve rejection refund was not recorded.");
          }
          await tx.update(generationBillingReservations).set({
            status: "released",
            payerType: payer.type,
            payerId: payer.id,
            reversalOperationId: generationReleaseRefundOperationId(input.taskRunId),
            reversalReceipt: reversal.receipt ? { ...reversal.receipt } : null,
            releasedAt: new Date(),
            lastError: "reserve_overage",
            updatedAt: new Date(),
          }).where(and(
            eq(generationBillingReservations.id, row.id),
            eq(generationBillingReservations.status, "reserving"),
          ));
          return {
            status: "blocked",
            error: blockedError({ reserveUsd, availableUsd: 0 }),
          };
        }

        const [held] = await tx.update(generationBillingReservations).set({
          status: "held",
          payerType: payer.type,
          payerId: payer.id,
          updatedAt: new Date(),
          lastError: null,
        }).where(and(
          eq(generationBillingReservations.id, row.id),
          eq(generationBillingReservations.status, "reserving"),
        )).returning();
        if (!held) throw new GenerationBillingUnavailableError("Generation billing reservation could not be marked held.");
        return { status: "held", reservation: held };
      });
    } catch (error) {
      if (error instanceof BillingAccessBlockedError || error instanceof GenerationBillingUnavailableError) throw error;
      throw new GenerationBillingUnavailableError(undefined, { cause: error });
    }
  }

  async function loadReservation(taskRunId: string): Promise<GenerationBillingReservation | null> {
    const [row] = await db.select().from(generationBillingReservations)
      .where(eq(generationBillingReservations.taskRunId, taskRunId)).limit(1);
    return row ?? null;
  }

  async function findReservePayer(row: GenerationBillingReservation): Promise<{
    payer: GenerationBillingPayer;
    remainingReversibleUsd: number;
  } | null> {
    const walletPayer: GenerationBillingPayer | null = row.spaceId && walletBilling.status.configured
      ? { type: "space_wallet", id: spaceWalletCustomerId(row.spaceId) }
      : null;
    const candidates: GenerationBillingPayer[] = row.payerType === "space_wallet" && walletPayer
      ? [walletPayer]
      : row.payerType === "personal"
        ? [{ type: "personal", id: row.userId }]
        : walletPayer
          ? [walletPayer, { type: "personal", id: row.userId }]
          : [{ type: "personal", id: row.userId }];
    for (const payer of candidates) {
      const consumption = await operationsFor(payer).getUsageConsumption({
        userId: payer.id,
        operationId: row.reserveOperationId,
        tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
      });
      if (consumption) {
        return { payer, remainingReversibleUsd: consumption.remainingReversibleUsd };
      }
    }
    return null;
  }

  async function markSettled(
    taskRunId: string,
    actualUsd: number,
    receipt?: BillingUsageReversalReceipt | null,
  ): Promise<GenerationBillingReservation | null> {
    const [row] = await db.update(generationBillingReservations).set({
      status: "settled",
      actualUsd: roundUsd(actualUsd).toFixed(8),
      ...(receipt ? { reversalReceipt: { ...receipt } } : {}),
      settledAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    }).where(and(
      eq(generationBillingReservations.taskRunId, taskRunId),
      inArray(generationBillingReservations.status, ["held", "settling"]),
    )).returning();
    return row ?? null;
  }

  async function completeSettlement(
    settled: GenerationBillingReservation | null,
    overage: boolean,
  ): Promise<GenerationBillingSettleResult> {
    if (!settled) return { status: "missing" };
    await input.onSettled?.(settled, overage).catch((error) => {
      warn?.("Generation billing settlement notification failed", { taskRunId: settled.taskRunId, error });
    });
    return { status: "settled", reservation: settled, overage };
  }

  async function settle(input: {
    taskRunId: string;
    actualUsd: number;
    reason?: string;
  }): Promise<GenerationBillingSettleResult> {
    const row = await loadReservation(input.taskRunId);
    if (!row) return { status: "missing" };
    if (row.status === "settled") return { status: "settled", reservation: row, overage: false };
    if (row.status === "released") return { status: "released", reservation: row };
    if (row.status === "releasing") {
      return { status: "pending", reservation: row, error: new Error("Generation reservation is releasing.") };
    }
    let workingRow = row;
    if (row.status === "reserving" && (!billing.status.configured || (row.spaceId && !walletBilling.status.configured))) {
      return {
        status: "pending",
        reservation: row,
        error: new GenerationBillingUnavailableError("Generation settlement billing is not configured."),
      };
    }
    if (row.status === "reserving") {
      const found = await findReservePayer(row);
      if (!found) throw new GenerationBillingUnavailableError("Generation reserve has not been recorded yet.");
      workingRow = {
        ...row,
        payerType: found.payer.type,
        payerId: found.payer.id,
      };
      await db.update(generationBillingReservations).set({
        payerType: found.payer.type,
        payerId: found.payer.id,
        status: "held",
        updatedAt: new Date(),
      }).where(eq(generationBillingReservations.id, row.id));
    }

    const actualUsd = roundUsd(Math.max(0, input.actualUsd));
    const plan = planGenerationSettlement(rowUsd(row.reserveUsd), actualUsd);
    const payer: GenerationBillingPayer = {
      type: workingRow.payerType === "space_wallet" ? "space_wallet" : "personal",
      id: workingRow.payerId,
    };
    const operations = operationsFor(payer);
    if (!operations.status.configured) {
      return {
        status: "pending",
        reservation: workingRow,
        error: new GenerationBillingUnavailableError("Generation settlement billing is not configured."),
      };
    }

    try {
      if (plan.refundUsd > 0) {
        const reversalOperationId = row.reversalOperationId ?? generationSettleRefundOperationId(input.taskRunId);
        if (!row.reversalOperationId) {
          const [updated] = await db.update(generationBillingReservations).set({
            status: "settling",
            actualUsd: actualUsd.toFixed(8),
            reversalOperationId,
            updatedAt: new Date(),
          }).where(and(
            eq(generationBillingReservations.id, row.id),
            inArray(generationBillingReservations.status, ["held", "settling"]),
          )).returning();
          if (!updated) return await settle({ ...input, actualUsd });
        }
        const remaining = await operations.getUsageConsumption({
          userId: payer.id,
          operationId: row.reserveOperationId,
          tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
        }).catch(() => null);
        const amountUsd = remaining
          ? Math.min(plan.refundUsd, remaining.remainingReversibleUsd)
          : plan.refundUsd;
        if (amountUsd <= 0) {
          return completeSettlement(await markSettled(input.taskRunId, actualUsd), false);
        }
        const reversal = await operations.reverseUsage({
          userId: payer.id,
          amountUsd,
          tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
          originalOperationId: row.reserveOperationId,
          operationId: reversalOperationId,
          reason: reasonFor(payer, row.userId, input.reason ?? `Generation settlement refund ${row.model}`),
        });
        if (reversal.status !== "reversed") {
          throw new GenerationBillingUnavailableError("Generation settlement refund was not recorded.");
        }
        return completeSettlement(await markSettled(input.taskRunId, actualUsd, reversal.receipt), false);
      }

      if (plan.extraUsd > 0) {
        const settleOperationId = row.settleOperationId ?? generationSettleOperationId(input.taskRunId);
        if (!row.settleOperationId) {
          const [updated] = await db.update(generationBillingReservations).set({
            status: "settling",
            actualUsd: actualUsd.toFixed(8),
            settleOperationId,
            updatedAt: new Date(),
          }).where(and(
            eq(generationBillingReservations.id, row.id),
            inArray(generationBillingReservations.status, ["held", "settling"]),
          )).returning();
          if (!updated) return await settle({ ...input, actualUsd });
        }
        const result = await operations.recordUsage({
          userId: payer.id,
          amountUsd: plan.extraUsd,
          tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
          usageType: row.usageType,
          sourceId: input.taskRunId,
          operationId: settleOperationId,
          reason: reasonFor(payer, row.userId, input.reason ?? `Generation settlement ${row.model}`),
        });
        if (result.status === "disabled" || result.status === "skipped") {
          throw new GenerationBillingUnavailableError("Generation settlement debit was not recorded.");
        }
        return completeSettlement(await markSettled(input.taskRunId, actualUsd), result.status === "overage");
      }

      return completeSettlement(await markSettled(input.taskRunId, actualUsd), false);
    } catch (error) {
      await db.update(generationBillingReservations).set({
        status: "settling",
        actualUsd: actualUsd.toFixed(8),
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: new Date(),
      }).where(eq(generationBillingReservations.id, row.id)).catch(() => undefined);
      return { status: "pending", reservation: row, error };
    }
  }

  async function release(input: {
    taskRunId: string;
    reason?: string;
  }): Promise<GenerationBillingReservation | null> {
    const row = await loadReservation(input.taskRunId);
    if (!row) return null;
    if (row.status === "released" || row.status === "settled") return row;

    let payer: GenerationBillingPayer = {
      type: row.payerType === "space_wallet" ? "space_wallet" : "personal",
      id: row.payerId || row.userId,
    };
    const reserveOperationId = row.reserveOperationId;
    let operations = operationsFor(payer);
    if (row.status !== "reserving" && row.status !== "settling" && !operations.status.configured) {
      throw new GenerationBillingUnavailableError("Generation release billing is not configured.");
    }

    let amountUsd = rowUsd(row.reserveUsd);
    if (row.status === "reserving") {
      if (!billing.status.configured || (row.spaceId && !walletBilling.status.configured)) {
        throw new GenerationBillingUnavailableError("Generation release billing is not configured.");
      }
      const found = await findReservePayer(row);
      if (!found) {
        const [released] = await db.update(generationBillingReservations).set({
          status: "released",
          releasedAt: new Date(),
          lastError: input.reason ?? "released_before_debit",
          updatedAt: new Date(),
        }).where(eq(generationBillingReservations.id, row.id)).returning();
        return released ?? null;
      }
      payer = found.payer;
      operations = operationsFor(payer);
      amountUsd = found.remainingReversibleUsd;
      await db.update(generationBillingReservations).set({
        payerType: payer.type,
        payerId: payer.id,
        updatedAt: new Date(),
      }).where(eq(generationBillingReservations.id, row.id));
    } else if (row.status === "held" || row.status === "releasing") {
      if (!operations.status.configured) {
        throw new GenerationBillingUnavailableError("Generation release billing is not configured.");
      }
      const consumption = await operations.getUsageConsumption({
        userId: payer.id,
        operationId: reserveOperationId,
        tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
      });
      if (!consumption) {
        const [released] = await db.update(generationBillingReservations).set({
          status: "released",
          releasedAt: new Date(),
          lastError: input.reason ?? "released_before_debit",
          updatedAt: new Date(),
        }).where(eq(generationBillingReservations.id, row.id)).returning();
        return released ?? null;
      }
      amountUsd = Math.min(amountUsd, consumption.remainingReversibleUsd);
    } else if (row.status === "settling") {
      return row;
    }

    const reversalOperationId = row.reversalOperationId ?? generationReleaseRefundOperationId(input.taskRunId);
    if (row.status !== "releasing") {
      await db.update(generationBillingReservations).set({
        status: "releasing",
        reversalOperationId,
        updatedAt: new Date(),
      }).where(eq(generationBillingReservations.id, row.id));
    }

    try {
      if (amountUsd > 0) {
        const reversal = await operations.reverseUsage({
          userId: payer.id,
          amountUsd,
          tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
          originalOperationId: reserveOperationId,
          operationId: reversalOperationId,
          reason: reasonFor(payer, row.userId, input.reason ?? `Generation released ${row.model}`),
        });
        if (reversal.status !== "reversed") {
          throw new GenerationBillingUnavailableError("Generation release refund was not recorded.");
        }
        const [released] = await db.update(generationBillingReservations).set({
          status: "released",
          reversalReceipt: reversal.receipt ? { ...reversal.receipt } : null,
          releasedAt: new Date(),
          lastError: input.reason ?? null,
          updatedAt: new Date(),
        }).where(eq(generationBillingReservations.id, row.id)).returning();
        return released ?? null;
      }
      const [released] = await db.update(generationBillingReservations).set({
        status: "released",
        releasedAt: new Date(),
        lastError: input.reason ?? null,
        updatedAt: new Date(),
      }).where(eq(generationBillingReservations.id, row.id)).returning();
      return released ?? null;
    } catch (error) {
      await db.update(generationBillingReservations).set({
        status: "releasing",
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: new Date(),
      }).where(eq(generationBillingReservations.id, row.id)).catch(() => undefined);
      throw error;
    }
  }

  async function reconcile(now = new Date()): Promise<{ processed: number }> {
    let processed = 0;
    const stale = await db.select().from(generationBillingReservations)
      .where(inArray(generationBillingReservations.status, ["reserving", "held", "settling", "releasing"]))
      .orderBy(generationBillingReservations.updatedAt)
      .limit(RECONCILE_BATCH_SIZE);

    for (const row of stale) {
      const updatedAt = row.updatedAt ?? row.createdAt ?? now;
      if (row.status === "reserving" && updatedAt > new Date(now.getTime() - RESERVE_RECONCILE_GRACE_MS)) continue;
      if ((row.status === "settling" || row.status === "releasing") && updatedAt > new Date(now.getTime() - SETTLE_RECONCILE_GRACE_MS)) continue;
      processed += 1;
      try {
        if (row.status === "reserving") {
          const found = await findReservePayer(row);
          const [task] = await db.select({ status: taskRuns.status }).from(taskRuns)
            .where(eq(taskRuns.id, row.taskRunId)).limit(1);
          if (!found) {
            await db.update(generationBillingReservations).set({
              status: "released",
              releasedAt: new Date(),
              lastError: "reserve_missing",
              updatedAt: new Date(),
            }).where(eq(generationBillingReservations.id, row.id));
            continue;
          }
          await db.update(generationBillingReservations).set({
            payerType: found.payer.type,
            payerId: found.payer.id,
            updatedAt: new Date(),
          }).where(eq(generationBillingReservations.id, row.id));
          if (!task) {
            await release({ taskRunId: row.taskRunId, reason: "task_missing" });
            continue;
          }
          await db.update(generationBillingReservations).set({
            status: "held",
            updatedAt: new Date(),
          }).where(eq(generationBillingReservations.id, row.id));
          continue;
        }

        if (row.status === "held") {
          const [task] = await db.select({ status: taskRuns.status, result: taskRuns.result }).from(taskRuns)
            .where(eq(taskRuns.id, row.taskRunId)).limit(1);
          if (!task || task.status === "failed") {
            await release({ taskRunId: row.taskRunId, reason: "task_failed" });
            continue;
          }
          if (task.status === "completed") {
            const billingRecord = isRecord(task.result) && isRecord(task.result.billing) ? task.result.billing : null;
            const recorded = recordNumber(billingRecord, "amountUsd");
            const cost = recordNumber(task.result, "cost");
            const actual = recorded ?? (cost === null ? null : applyGenerationModelDiscount(cost, {
              multiplier: rowUsd(row.discountMultiplier),
            }));
            if (actual !== null) {
              await settle({ taskRunId: row.taskRunId, actualUsd: actual, reason: `Generation reconciliation ${row.model}` });
            } else {
              await release({ taskRunId: row.taskRunId, reason: "missing_cost" });
            }
            continue;
          }
          if (row.expiresAt <= now) {
            warn?.("Generation reservation expired while the task was still running", { taskRunId: row.taskRunId, status: task.status });
            await release({ taskRunId: row.taskRunId, reason: "reserve_expired" });
          }
          continue;
        }

        if (row.status === "settling") {
          await settle({
            taskRunId: row.taskRunId,
            actualUsd: rowUsd(row.actualUsd),
            reason: `Generation settlement retry ${row.model}`,
          });
          continue;
        }

        if (row.status === "releasing") {
          await release({ taskRunId: row.taskRunId, reason: "release_retry" });
        }
      } catch (error) {
        input.warn?.("Generation billing reconciliation failed", { taskRunId: row.taskRunId, error });
      }
    }
    return { processed };
  }

  return {
    reserve,
    settle,
    release,
    reconcile,
    getReservation: loadReservation,
  };
}

export type GenerationBillingReservations = ReturnType<typeof createGenerationBillingReservations>;
