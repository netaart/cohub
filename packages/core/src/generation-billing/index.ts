import {
  applyGenerationModelDiscount,
  BillingAccessBlockedError,
  COHUB_BILLING_TOKEN_TYPES,
  createBillingConversionIntent,
  type BillingAccessDecision,
  type BillingOperations,
  type BillingUsageReversalReceipt,
  type BillingUsageReversalResult,
  type SpaceWalletBillingOperations,
} from "@cohub/billing";
import { generationBillingReservations, taskRuns } from "@cohub/db";
import { and, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { spaceWalletCustomerId, walletCreditsUsable } from "../space-wallet/index.js";

// Hard cap for zombie tasks only; well past the longest provider wait (1h) plus queueing.
const RESERVE_TTL_MS = 24 * 60 * 60 * 1000;
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

/** Billing must reverse exactly the requested amount; anything else keeps the row retryable. */
function fullReversalReceipt(result: BillingUsageReversalResult, label: string): BillingUsageReversalReceipt {
  if (result.status !== "reversed" || !result.receipt) {
    throw new GenerationBillingUnavailableError(`${label} was not recorded.`);
  }
  if (Math.abs(result.receipt.amountUsd - result.amountUsd) > 1e-9) {
    throw new GenerationBillingUnavailableError(
      `${label} reversed ${result.receipt.amountUsd} of ${result.amountUsd} USD.`,
    );
  }
  return result.receipt;
}

/** Billing metadata for a settled reservation, derived only from persisted values. */
export function settledReservationBilling(reservation: GenerationBillingReservation): {
  amountUsd: number;
  reservedAmountUsd: number;
  refundedAmountUsd: number;
  additionalAmountUsd: number;
} {
  const reservedAmountUsd = rowUsd(reservation.reserveUsd);
  const amountUsd = rowUsd(reservation.actualUsd);
  const plan = planGenerationSettlement(reservedAmountUsd, amountUsd);
  return { amountUsd, reservedAmountUsd, refundedAmountUsd: plan.refundUsd, additionalAmountUsd: plan.extraUsd };
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
  /** Fires only when reconciliation settles a reservation; inline callers persist their own result. */
  onReconcileSettled?: (reservation: GenerationBillingReservation, overage: boolean) => Promise<void>;
}) {
  const { db, billing, walletBilling } = input;
  const warn = input.warn;

  const operationsFor = (payer: GenerationBillingPayer): BillingOperations =>
    payer.type === "space_wallet" ? walletBilling : billing;

  // Billing reasons derive only from the row so every replay of an operation id sends identical values.
  const reasonFor = (payer: GenerationBillingPayer, userId: string, reason: string) =>
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
          const wallet = await previewPayer({
            payer: { type: "space_wallet", id: walletId },
            reserveUsd: input.reserveUsd,
            usageType: input.usageType,
          });
          if (wallet.allowed) return { payer: wallet.payer, availableUsd: wallet.availableUsd };
          candidates.push(wallet);
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

  type ReservationStatus = "reserving" | "held" | "running" | "settling" | "settled" | "releasing" | "released";
  type ReservationPatch = Partial<typeof generationBillingReservations.$inferInsert>;

  // Every state change is a compare-and-set so concurrent settle/release/reconcile cannot clobber each other.
  async function transition(
    id: string,
    from: ReservationStatus[],
    patch: ReservationPatch,
  ): Promise<GenerationBillingReservation | null> {
    const [row] = await db.update(generationBillingReservations)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(generationBillingReservations.id, id), inArray(generationBillingReservations.status, from)))
      .returning();
    return row ?? null;
  }

  async function recordError(row: GenerationBillingReservation, error: unknown): Promise<void> {
    await db.update(generationBillingReservations).set({
      lastError: error instanceof Error ? error.message : String(error),
      updatedAt: new Date(),
    }).where(and(
      eq(generationBillingReservations.id, row.id),
      eq(generationBillingReservations.status, row.status),
    )).catch(() => undefined);
  }

  function payerOf(row: GenerationBillingReservation): GenerationBillingPayer {
    return { type: row.payerType === "space_wallet" ? "space_wallet" : "personal", id: row.payerId || row.userId };
  }

  async function loadReservation(taskRunId: string): Promise<GenerationBillingReservation | null> {
    const [row] = await db.select().from(generationBillingReservations)
      .where(eq(generationBillingReservations.taskRunId, taskRunId)).limit(1);
    return row ?? null;
  }

  async function reserve(input: {
    taskRunId: string;
    userId: string;
    spaceId: string | null;
    model: string;
    usageType: string;
    reserveUsd: number;
    discountMultiplier: number;
  }): Promise<GenerationBillingReserveResult> {
    const reserveUsd = roundUsd(input.reserveUsd);
    if (reserveUsd <= 0) return { status: "disabled" };
    if (!billing.status.configured) return { status: "disabled" };

    const row = await insertReservation({ ...input, reserveUsd });
    if (row.status === "held") return { status: "held", reservation: row };
    if (row.status !== "reserving" || row.payerType !== "pending") {
      throw new GenerationBillingUnavailableError(`Generation billing reservation is already ${row.status}.`);
    }

    // No local lock: the reserve is a real debit, so a concurrent overdraft surfaces as overage and is reversed below.
    try {
      const selected = await selectPayer({
        userId: input.userId,
        spaceId: input.spaceId,
        reserveUsd,
        usageType: input.usageType,
      });
      if (!selected.payer) {
        const error = blockedError({ reserveUsd, availableUsd: selected.availableUsd });
        await transition(row.id, ["reserving"], {
          status: "released",
          payerType: "personal",
          payerId: input.userId,
          releasedAt: new Date(),
          lastError: error.message,
        });
        return { status: "blocked", error };
      }

      const payer = selected.payer;
      // Persist the payer before debiting so recovery only queries the identity that can hold the debit.
      const [claimed] = await db.update(generationBillingReservations)
        .set({ payerType: payer.type, payerId: payer.id, updatedAt: new Date() })
        .where(and(
          eq(generationBillingReservations.id, row.id),
          eq(generationBillingReservations.status, "reserving"),
          eq(generationBillingReservations.payerType, "pending"),
        ))
        .returning();
      if (!claimed) throw new GenerationBillingUnavailableError("Generation billing reservation changed during reserve.");

      const overage = await debitReserve(claimed);
      if (overage) {
        await releaseRow(claimed, "reserve_overage");
        const refreshed = await previewPayer({ payer, reserveUsd, usageType: input.usageType }).catch(() => null);
        return {
          status: "blocked",
          error: blockedError({ reserveUsd, availableUsd: refreshed?.availableUsd ?? selected.availableUsd }),
        };
      }

      const held = await transition(row.id, ["reserving"], { status: "held", lastError: null });
      if (!held) throw new GenerationBillingUnavailableError("Generation billing reservation could not be marked held.");
      return { status: "held", reservation: held };
    } catch (error) {
      if (error instanceof BillingAccessBlockedError || error instanceof GenerationBillingUnavailableError) throw error;
      throw new GenerationBillingUnavailableError(undefined, { cause: error });
    }
  }

  /**
   * Sends (or idempotently replays) the reserve debit from persisted row values; returns whether it created overage.
   * Recovery replays it too, so a debit still in flight from a stalled caller can never land after a release.
   */
  async function debitReserve(row: GenerationBillingReservation): Promise<boolean> {
    const payer = payerOf(row);
    const operations = operationsFor(payer);
    if (!operations.status.configured) throw new GenerationBillingUnavailableError("Generation billing is not configured.");
    const result = await operations.recordUsage({
      userId: payer.id,
      amountUsd: rowUsd(row.reserveUsd),
      tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
      usageType: row.usageType,
      sourceId: row.taskRunId,
      operationId: row.reserveOperationId,
      reason: reasonFor(payer, row.userId, `Generation reserve ${row.model}`),
    });
    if (result.status === "disabled" || result.status === "skipped") {
      throw new GenerationBillingUnavailableError("Generation reserve debit was not recorded.");
    }
    return result.status === "overage";
  }

  /** Marks the reservation as used by a running worker; API-side releases no longer apply after this. */
  async function claim(taskRunId: string): Promise<GenerationBillingReservation | null> {
    const row = await loadReservation(taskRunId);
    if (!row || row.status === "running") return row;
    return await transition(row.id, ["held"], { status: "running" }) ?? await loadReservation(taskRunId);
  }

  async function settle(
    input: { taskRunId: string; actualUsd: number },
    notify = false,
  ): Promise<GenerationBillingSettleResult> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const row = await loadReservation(input.taskRunId);
      if (!row) return { status: "missing" };
      switch (row.status) {
        case "settled":
          return { status: "settled", reservation: row, overage: row.settleOverage };
        case "released":
          return { status: "released", reservation: row };
        case "releasing":
          return { status: "pending", reservation: row, error: new Error("Generation reservation is releasing.") };
        case "settling":
          return finishSettlement(row, notify);
        case "reserving":
          throw new GenerationBillingUnavailableError("Generation reserve has not been recorded yet.");
        case "held":
        case "running": {
          // The settlement amounts are fixed here; retries replay these exact values.
          const actualUsd = roundUsd(Math.max(0, input.actualUsd));
          const plan = planGenerationSettlement(rowUsd(row.reserveUsd), actualUsd);
          const claimed = await transition(row.id, ["held", "running"], {
            status: "settling",
            actualUsd: actualUsd.toFixed(8),
            reversalOperationId: plan.refundUsd > 0 ? generationSettleRefundOperationId(row.taskRunId) : null,
            settleOperationId: plan.extraUsd > 0 ? generationSettleOperationId(row.taskRunId) : null,
          });
          if (claimed) return finishSettlement(claimed, notify);
          continue;
        }
        default:
          throw new GenerationBillingUnavailableError(`Unknown generation reservation status: ${row.status}`);
      }
    }
    throw new GenerationBillingUnavailableError("Generation reservation kept changing during settlement.");
  }

  async function finishSettlement(
    row: GenerationBillingReservation,
    notify = false,
  ): Promise<GenerationBillingSettleResult> {
    const actualUsd = rowUsd(row.actualUsd);
    const plan = planGenerationSettlement(rowUsd(row.reserveUsd), actualUsd);
    const payer = payerOf(row);
    const operations = operationsFor(payer);
    if (!operations.status.configured) {
      return {
        status: "pending",
        reservation: row,
        error: new GenerationBillingUnavailableError("Generation settlement billing is not configured."),
      };
    }

    try {
      let receipt: BillingUsageReversalReceipt | null = null;
      let overage = false;
      if (plan.refundUsd > 0) {
        const reversal = await operations.reverseUsage({
          userId: payer.id,
          amountUsd: plan.refundUsd,
          tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
          originalOperationId: row.reserveOperationId,
          operationId: row.reversalOperationId ?? generationSettleRefundOperationId(row.taskRunId),
          reason: reasonFor(payer, row.userId, `Generation settlement refund ${row.model}`),
        });
        receipt = fullReversalReceipt(reversal, "Generation settlement refund");
      } else if (plan.extraUsd > 0) {
        const result = await operations.recordUsage({
          userId: payer.id,
          amountUsd: plan.extraUsd,
          tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
          usageType: row.usageType,
          sourceId: row.taskRunId,
          operationId: row.settleOperationId ?? generationSettleOperationId(row.taskRunId),
          reason: reasonFor(payer, row.userId, `Generation settlement ${row.model}`),
        });
        if (result.status === "disabled" || result.status === "skipped") {
          throw new GenerationBillingUnavailableError("Generation settlement debit was not recorded.");
        }
        overage = result.status === "overage";
      }

      const settled = await transition(row.id, ["settling"], {
        status: "settled",
        settleOverage: overage,
        ...(receipt ? { reversalReceipt: { ...receipt } } : {}),
        settledAt: new Date(),
        lastError: null,
      });
      if (!settled) {
        const latest = await loadReservation(row.taskRunId);
        return latest?.status === "settled"
          ? { status: "settled", reservation: latest, overage: latest.settleOverage }
          : { status: "missing" };
      }
      if (notify) await input.onReconcileSettled?.(settled, overage).catch((error) => {
        warn?.("Generation billing settlement notification failed", { taskRunId: settled.taskRunId, error });
      });
      return { status: "settled", reservation: settled, overage };
    } catch (error) {
      await recordError(row, error);
      return { status: "pending", reservation: row, error };
    }
  }

  /**
   * Reverses the full reserve. `unclaimedOnly` is for submit-side cleanup: once a worker has claimed the
   * reservation, only the task outcome may release it.
   */
  async function release(input: {
    taskRunId: string;
    reason?: string;
    unclaimedOnly?: boolean;
  }): Promise<GenerationBillingReservation | null> {
    const row = await loadReservation(input.taskRunId);
    if (!row) return null;
    return releaseRow(row, input.reason, input.unclaimedOnly === true);
  }

  async function releaseRow(
    initial: GenerationBillingReservation,
    reason: string | undefined,
    unclaimedOnly = false,
  ): Promise<GenerationBillingReservation | null> {
    let row: GenerationBillingReservation | null = initial;
    for (let attempt = 0; row && attempt < 4; attempt += 1) {
      // Once settlement starts the reserve belongs to the settlement; a release must never undo it.
      if (row.status === "released" || row.status === "settled" || row.status === "settling") return row;
      if (row.status === "running" && unclaimedOnly) return row;
      if (row.status === "releasing") return replayRelease(row);

      if (row.status === "reserving" && row.payerType === "pending") {
        // The debit is only sent after the payer is persisted, so this row never reached billing.
        const [released] = await db.update(generationBillingReservations).set({
          status: "released",
          releasedAt: new Date(),
          lastError: reason ?? "released_before_debit",
          updatedAt: new Date(),
        }).where(and(
          eq(generationBillingReservations.id, row.id),
          eq(generationBillingReservations.status, "reserving"),
          eq(generationBillingReservations.payerType, "pending"),
        )).returning();
        if (released) return released;
      } else {
        if (row.status === "reserving") await debitReserve(row);
        const next = await transition(row.id, [row.status as ReservationStatus], {
          status: "releasing",
          reversalOperationId: generationReleaseRefundOperationId(row.taskRunId),
          lastError: reason ?? null,
        });
        if (next) return replayRelease(next);
      }
      row = await loadReservation(initial.taskRunId);
    }
    if (!row) return null;
    throw new GenerationBillingUnavailableError("Generation reservation kept changing during release.");
  }

  async function replayRelease(row: GenerationBillingReservation): Promise<GenerationBillingReservation | null> {
    const payer = payerOf(row);
    const operations = operationsFor(payer);
    if (!operations.status.configured) throw new GenerationBillingUnavailableError("Generation release billing is not configured.");
    try {
      // A release always reverses the full reserve under one operation id, so a replay sends identical values.
      const reversal = await operations.reverseUsage({
        userId: payer.id,
        amountUsd: rowUsd(row.reserveUsd),
        tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
        originalOperationId: row.reserveOperationId,
        operationId: row.reversalOperationId ?? generationReleaseRefundOperationId(row.taskRunId),
        reason: reasonFor(payer, row.userId, `Generation released ${row.model}`),
      });
      const receipt = fullReversalReceipt(reversal, "Generation release refund");
      const released = await transition(row.id, ["releasing"], {
        status: "released",
        reversalReceipt: { ...receipt },
        releasedAt: new Date(),
      });
      return released ?? await loadReservation(row.taskRunId);
    } catch (error) {
      await recordError(row, error);
      throw error;
    }
  }

  async function reconcile(now = new Date()): Promise<{ processed: number }> {
    const reserveCutoff = new Date(now.getTime() - RESERVE_RECONCILE_GRACE_MS);
    const retryCutoff = new Date(now.getTime() - SETTLE_RECONCILE_GRACE_MS);
    const reservations = generationBillingReservations;
    // Only actionable rows are selected, so long-running holds never occupy the batch.
    const rows = await db.select({
      reservation: reservations,
      taskId: taskRuns.id,
      taskStatus: taskRuns.status,
      taskResult: taskRuns.result,
    }).from(reservations)
      .leftJoin(taskRuns, eq(taskRuns.id, reservations.taskRunId))
      .where(or(
        and(eq(reservations.status, "reserving"), lt(reservations.updatedAt, reserveCutoff)),
        and(inArray(reservations.status, ["settling", "releasing"]), lt(reservations.updatedAt, retryCutoff)),
        and(inArray(reservations.status, ["held", "running"]), or(
          inArray(taskRuns.status, ["completed", "failed"]),
          and(isNull(taskRuns.id), lt(reservations.createdAt, reserveCutoff)),
          lte(reservations.expiresAt, now),
        )),
      ))
      .orderBy(reservations.updatedAt)
      .limit(RECONCILE_BATCH_SIZE);

    let processed = 0;
    for (const { reservation: row, taskId, taskStatus, taskResult } of rows) {
      processed += 1;
      try {
        if (row.status === "reserving") {
          if (taskId && taskStatus !== "failed" && row.payerType !== "pending") {
            await debitReserve(row);
            await transition(row.id, ["reserving"], { status: "held" });
          } else {
            await releaseRow(row, !taskId ? "task_missing" : taskStatus === "failed" ? "task_failed" : "reserve_missing");
          }
          continue;
        }

        if (row.status === "held" || row.status === "running") {
          if (taskStatus === "completed") {
            const billingRecord = isRecord(taskResult) && isRecord(taskResult.billing) ? taskResult.billing : null;
            const recorded = recordNumber(billingRecord, "amountUsd");
            const cost = recordNumber(taskResult, "cost");
            const actual = recorded ?? (cost === null ? null : applyGenerationModelDiscount(cost, {
              multiplier: rowUsd(row.discountMultiplier),
            }));
            if (actual !== null) {
              const result = await settle({ taskRunId: row.taskRunId, actualUsd: actual }, true);
              if (result.status === "pending") throw result.error;
            } else {
              await releaseRow(row, "missing_cost");
            }
          } else if (!taskId || taskStatus === "failed") {
            await releaseRow(row, taskId ? "task_failed" : "task_missing");
          } else {
            warn?.("Generation reservation hit its hard limit while the task was unfinished", { taskRunId: row.taskRunId, status: taskStatus });
            await releaseRow(row, "reserve_expired");
          }
          continue;
        }

        if (row.status === "settling") {
          const result = await finishSettlement(row, true);
          if (result.status === "pending") throw result.error;
          continue;
        }

        if (row.status === "releasing") await replayRelease(row);
      } catch (error) {
        await recordError(row, error);
        warn?.("Generation billing reconciliation failed", { taskRunId: row.taskRunId, error });
      }
    }
    return { processed };
  }

  return {
    reserve,
    claim,
    settle: (input: { taskRunId: string; actualUsd: number }) => settle(input),
    release,
    reconcile,
    getReservation: loadReservation,
  };
}

export type GenerationBillingReservations = ReturnType<typeof createGenerationBillingReservations>;
