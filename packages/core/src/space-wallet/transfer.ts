import type { BillingCreditDenomination, BillingCreditStatus, BillingOperations, SpaceWalletBillingOperations } from "@cohub/billing";
import {
  SPACE_WALLET_TRANSFER_MAX_USD,
  SPACE_WALLET_TRANSFER_MIN_USD,
  type SpaceWalletTransferRecoverJobData,
  type SpaceWalletTransferStatus,
} from "@cohub/protocol";
import { randomUUID } from "node:crypto";
import { spaceWalletCustomerId, walletActorReason } from "./customer.js";
import { SPACE_WALLET_TRANSFER_BENEFIT_PREFIX, SPACE_WALLET_TRANSFER_USAGE_TYPE } from "./transfer-policy.js";

const MAX_PIECES = 16;
const LOCK_TTL_MS = 5 * 60_000;

export type SpaceWalletTransferInput = Omit<SpaceWalletTransferRecoverJobData, "trace">;

export type SpaceWalletTransferRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, px: "PX", ttl: number, nx: "NX"): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
};

export class SpaceWalletTransferError extends Error {
  constructor(readonly code: "transfer_busy" | "transfer_unavailable" | "transfer_amount_invalid" | "transfer_insufficient" | "transfer_conflict", message: string) {
    super(message);
    this.name = "SpaceWalletTransferError";
  }
}

export const spaceWalletTransferOps = (spaceId: string, id: string) => ({
  sourceId: `cohub:swt:${spaceId}:${id}`,
  debit: `swt:${spaceId}:${id}:debit`,
  credit: (index: number) => `swt:${spaceId}:${id}:credit:${index}`,
  refund: `swt:${spaceId}:${id}:refund`,
});

export function planSpaceWalletTransfer(amountUsd: number, denominations: BillingCreditDenomination[]): BillingCreditDenomination[] | null {
  const pieces: BillingCreditDenomination[] = [];
  let remainingCents = Math.round(amountUsd * 100);
  for (const denomination of denominations) {
    const cents = Math.round(denomination.amountUsd * 100);
    while (cents > 0 && remainingCents >= cents && pieces.length < MAX_PIECES) {
      pieces.push(denomination);
      remainingCents -= cents;
    }
  }
  return remainingCents === 0 && pieces.length > 0 ? pieces : null;
}

export function transferableUsd(credit: BillingCreditStatus, transferredUsd: number): number {
  let remaining = 0;
  let purchased = 0;
  for (const group of credit.groups) {
    for (const grant of group.grants) {
      if (grant.grantKind !== "purchased" || grant.sourceType !== "order") continue;
      purchased += grant.originalAmountUsd ?? grant.remainingAmountUsd;
      if (grant.status === "active" && grant.availableNow !== false) remaining += grant.remainingAmountUsd;
    }
  }
  const available = Math.min(remaining, purchased - transferredUsd, credit.netUsd);
  return Math.max(0, Math.floor(available * 100) / 100);
}

function isPermanent(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

type Guard = () => Promise<void>;
const UNLOCK_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";
const usd = (value: number) => Math.round(value * 100) / 100;
const pending = (id: string, amountUsd: number): SpaceWalletTransferStatus => ({ id, state: "processing", amountUsd, creditedUsd: 0, refundedUsd: 0 });

export function createSpaceWalletTransfers(input: {
  billing: BillingOperations;
  walletBilling: SpaceWalletBillingOperations;
  redis: SpaceWalletTransferRedis;
  scheduleRecovery: (transfer: SpaceWalletTransferInput) => Promise<unknown>;
  onSettled?: (spaceId: string) => Promise<unknown> | unknown;
  walletUsable: (spaceId: string) => Promise<boolean>;
  warn?: (message: string, context: Record<string, unknown>) => void;
}) {
  const { billing, walletBilling, redis } = input;
  const configured = () => billing.status.configured && walletBilling.status.configured;
  const notify = (spaceId: string) => void Promise.resolve().then(() => input.onSettled?.(spaceId)).catch(() => undefined);

  async function withLock<T>(userId: string, run: (guard: Guard) => Promise<T>): Promise<T> {
    const key = `space-wallet:transfer-lock:${userId}`;
    const token = randomUUID();
    const busy = () => new SpaceWalletTransferError("transfer_busy", "Another transfer is in progress");
    if (!await redis.set(key, token, "PX", LOCK_TTL_MS, "NX")) throw busy();
    try {
      return await run(async () => {
        if (await redis.get(key) !== token) throw busy();
      });
    } finally {
      await redis.eval(UNLOCK_SCRIPT, 1, key, token).catch(() => undefined);
    }
  }

  async function denominations() {
    const list = await walletBilling.listCreditDenominations({ keyPrefix: SPACE_WALLET_TRANSFER_BENEFIT_PREFIX });
    return list.filter((item) => Number.isInteger(item.amountUsd) && item.amountUsd > 0);
  }

  async function landed(transfer: SpaceWalletTransferInput) {
    const ops = spaceWalletTransferOps(transfer.spaceId, transfer.id);
    let count = 0;
    let total = 0;
    for (; count < MAX_PIECES; count += 1) {
      const { grantUsd } = await walletBilling.sumTransactions({ userId: spaceWalletCustomerId(transfer.spaceId), operationId: ops.credit(count) });
      if (grantUsd <= 0) break;
      total += grantUsd;
    }
    return { count, usd: usd(total) };
  }

  async function status(transfer: SpaceWalletTransferInput): Promise<SpaceWalletTransferStatus> {
    const consumption = await billing.getUsageConsumption({ userId: transfer.userId, operationId: spaceWalletTransferOps(transfer.spaceId, transfer.id).debit });
    if (!consumption) return { id: transfer.id, state: "none", amountUsd: 0, creditedUsd: 0, refundedUsd: 0 };
    const credited = (await landed(transfer)).usd;
    const state = consumption.reversedUsd > 0 ? "refunded" : credited >= consumption.amountUsd ? "completed" : "processing";
    return { id: transfer.id, state, amountUsd: consumption.amountUsd, creditedUsd: credited, refundedUsd: consumption.reversedUsd };
  }

  async function refund(transfer: SpaceWalletTransferInput, amountUsd: number, guard: Guard): Promise<SpaceWalletTransferStatus> {
    const ops = spaceWalletTransferOps(transfer.spaceId, transfer.id);
    const credited = (await landed(transfer)).usd;
    const remainder = usd(amountUsd - credited);
    if (remainder > 0) {
      await guard();
      await billing.reverseUsage({ userId: transfer.userId, originalOperationId: ops.debit, operationId: ops.refund, amountUsd: remainder, reason: `Returned from Space wallet "${transfer.spaceName}"` });
    }
    input.warn?.("Space wallet transfer refunded", { spaceId: transfer.spaceId, transferId: transfer.id, userId: transfer.userId, amountUsd, creditedUsd: credited, refundedUsd: remainder });
    if (credited > 0) notify(transfer.spaceId);
    return { id: transfer.id, state: remainder > 0 ? "refunded" : "completed", amountUsd, creditedUsd: credited, refundedUsd: Math.max(0, remainder) };
  }

  async function settle(transfer: SpaceWalletTransferInput, mode: "credit" | "refund", guard: Guard): Promise<SpaceWalletTransferStatus> {
    const ops = spaceWalletTransferOps(transfer.spaceId, transfer.id);
    const consumption = await billing.getUsageConsumption({ userId: transfer.userId, operationId: ops.debit });
    if (!consumption) return { id: transfer.id, state: "none", amountUsd: 0, creditedUsd: 0, refundedUsd: 0 };
    if (consumption.reversedUsd > 0) return status(transfer);
    if (mode === "refund") return refund(transfer, consumption.amountUsd, guard);
    // A debit not fully covered by credits (overage) must never fund a wallet, however it was observed.
    const covered = await billing.sumTransactions({ userId: transfer.userId, operationId: ops.debit });
    if (covered.consumeUsd < consumption.amountUsd) return refund(transfer, consumption.amountUsd, guard);
    const done = await landed(transfer);
    const completed: SpaceWalletTransferStatus = { id: transfer.id, state: "completed", amountUsd: consumption.amountUsd, creditedUsd: consumption.amountUsd, refundedUsd: 0 };
    const remaining = usd(consumption.amountUsd - done.usd);
    if (remaining <= 0) return completed;
    const plan = planSpaceWalletTransfer(remaining, await denominations());
    if (!plan || done.count + plan.length > MAX_PIECES) return refund(transfer, consumption.amountUsd, guard);
    for (const [offset, piece] of plan.entries()) {
      await guard();
      try {
        await walletBilling.grantCredits({
          userId: spaceWalletCustomerId(transfer.spaceId),
          benefitKey: piece.key,
          sourceId: ops.sourceId,
          operationId: ops.credit(done.count + offset),
          reason: walletActorReason(transfer.userId, `Contribution from ${transfer.actorName}`),
        });
      } catch (error) {
        if (isPermanent(error)) return refund(transfer, consumption.amountUsd, guard);
        throw error;
      }
    }
    notify(transfer.spaceId);
    return completed;
  }

  async function trySettle(transfer: SpaceWalletTransferInput, amountUsd: number, guard: Guard): Promise<SpaceWalletTransferStatus> {
    try {
      return await settle(transfer, "credit", guard);
    } catch (error) {
      input.warn?.("Space wallet transfer credit deferred", { spaceId: transfer.spaceId, transferId: transfer.id, userId: transfer.userId, error });
      return pending(transfer.id, amountUsd);
    }
  }

  async function allowance(userId: string): Promise<number> {
    const [credit, totals] = await Promise.all([
      billing.getCreditStatus({ userId }),
      billing.sumTransactions({ userId, usageType: SPACE_WALLET_TRANSFER_USAGE_TYPE }),
    ]);
    return transferableUsd(credit, totals.consumeUsd - totals.reversalUsd);
  }

  async function start(transfer: SpaceWalletTransferInput & { amountUsd: number }): Promise<SpaceWalletTransferStatus> {
    if (!configured()) throw new SpaceWalletTransferError("transfer_unavailable", "Space wallet transfers are unavailable");
    const { amountUsd, ...ref } = transfer;
    if (!Number.isInteger(amountUsd) || amountUsd < SPACE_WALLET_TRANSFER_MIN_USD || amountUsd > SPACE_WALLET_TRANSFER_MAX_USD) {
      throw new SpaceWalletTransferError("transfer_amount_invalid", `Amount must be a whole number of USD between ${SPACE_WALLET_TRANSFER_MIN_USD} and ${SPACE_WALLET_TRANSFER_MAX_USD}`);
    }
    return withLock(ref.userId, async (guard) => {
      const ops = spaceWalletTransferOps(ref.spaceId, ref.id);
      const existing = await billing.getUsageConsumption({ userId: ref.userId, operationId: ops.debit });
      if (existing) {
        if (existing.amountUsd !== amountUsd) throw new SpaceWalletTransferError("transfer_conflict", "This transfer ID was used for a different amount");
        if (existing.reversedUsd > 0) return status(ref);
        await input.scheduleRecovery(ref);
        return trySettle(ref, amountUsd, guard);
      }
      const [plan, available, usable] = await Promise.all([
        denominations().then((list) => planSpaceWalletTransfer(amountUsd, list)),
        allowance(ref.userId),
        input.walletUsable(ref.spaceId),
      ]);
      if (!plan || !usable) throw new SpaceWalletTransferError("transfer_unavailable", "This Space wallet cannot accept this transfer");
      if (amountUsd > available) throw new SpaceWalletTransferError("transfer_insufficient", "Not enough purchased balance to transfer");
      const preview = await billing.preflightUsage({ userId: ref.userId, usageType: SPACE_WALLET_TRANSFER_USAGE_TYPE, estimatedAmountUsd: amountUsd });
      if (!preview.allowed) throw new SpaceWalletTransferError("transfer_insufficient", "Not enough balance to transfer");
      await walletBilling.ensureCustomer({ userId: spaceWalletCustomerId(ref.spaceId) });
      await input.scheduleRecovery(ref);
      await guard();
      try {
        await billing.recordUsage({
          userId: ref.userId,
          amountUsd,
          usageType: SPACE_WALLET_TRANSFER_USAGE_TYPE,
          sourceId: ops.sourceId,
          operationId: ops.debit,
          reason: `Transfer to Space wallet "${ref.spaceName}"`,
        });
      } catch (error) {
        input.warn?.("Space wallet transfer debit failed", { spaceId: ref.spaceId, transferId: ref.id, userId: ref.userId, amountUsd, error });
        if (isPermanent(error)) throw error;
        return pending(ref.id, amountUsd);
      }
      return trySettle(ref, amountUsd, guard);
    });
  }

  return {
    configured,
    allowance,
    start,
    status,
    recover: async (transfer: SpaceWalletTransferInput, mode: "credit" | "refund") => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await withLock(transfer.userId, (guard) => settle(transfer, mode, guard));
        } catch (error) {
          if (!(error instanceof SpaceWalletTransferError) || error.code !== "transfer_busy" || attempt >= 5) throw error;
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
      }
    },
  };
}
