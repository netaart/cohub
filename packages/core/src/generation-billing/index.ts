import {
  BillingAccessBlockedError,
  COHUB_BILLING_TOKEN_TYPES,
  createBillingConversionIntent,
  type BillingAccessDecision,
  type BillingOperations,
  type SpaceWalletBillingOperations,
} from "@cohub/billing";
import type { GenerationReserveHold } from "@cohub/protocol/generation";
import { spaceWalletCustomerId, walletCreditsUsable } from "../space-wallet/index.js";

/**
 * Holds are a submission-time defense, not money: the generation is still charged once after success.
 * An expired or lost hold only frees the amount for new submissions.
 */
const HOLD_TTL_MS = 2 * 60 * 60 * 1000;
/** Keeps a settled hold counted briefly so a balance read taken before the charge cannot spend it twice. */
const SETTLED_HOLD_GRACE_MS = 60_000;
/** Billing's usd_micro_cent precision: eight USD decimal places. */
const UNITS_PER_USD = 100_000_000;

// Hash per payer: field = taskRunId, value = "<amountUnits>|<expiresAtMs>". Prunes expired holds,
// then adds this one only if every live hold plus it fits the balance. Returns {held, otherHoldsUnits}.
const HOLD_SCRIPT = `
local now = tonumber(ARGV[4])
local total = 0
local values = redis.call('HGETALL', KEYS[1])
for i = 1, #values, 2 do
  local amount, expiresAt = string.match(values[i + 1], '^(%d+)|(%d+)$')
  if not expiresAt or tonumber(expiresAt) <= now then
    redis.call('HDEL', KEYS[1], values[i])
  elseif values[i] ~= ARGV[1] then
    total = total + tonumber(amount)
  end
end
if total + tonumber(ARGV[2]) > tonumber(ARGV[3]) then return {0, total} end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2] .. '|' .. ARGV[5])
-- Relative TTL so the key's lifetime does not depend on the Redis clock matching the caller's.
local ttl = tonumber(ARGV[5]) - now
if redis.call('PTTL', KEYS[1]) < ttl then redis.call('PEXPIRE', KEYS[1], ttl) end
return {1, total}
`;

// Shortens a hold to ARGV[2] (ms epoch); never extends it.
const EXPIRE_SCRIPT = `
local value = redis.call('HGET', KEYS[1], ARGV[1])
if not value then return 0 end
local amount, expiresAt = string.match(value, '^(%d+)|(%d+)$')
if not expiresAt or tonumber(ARGV[2]) <= tonumber(ARGV[3]) then return redis.call('HDEL', KEYS[1], ARGV[1]) end
if tonumber(expiresAt) > tonumber(ARGV[2]) then redis.call('HSET', KEYS[1], ARGV[1], amount .. '|' .. ARGV[2]) end
return 1
`;

export type GenerationReserveRedis = {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
};

export type { GenerationReserveHold };
export type GenerationReservePayer = GenerationReserveHold["payer"];

export type GenerationReserveHoldResult =
  | { status: "held"; hold: GenerationReserveHold }
  | { status: "blocked"; error: BillingAccessBlockedError };

export class GenerationBillingUnavailableError extends Error {
  constructor(message = "Generation billing is temporarily unavailable. Please try again.", options?: ErrorOptions) {
    super(message, options);
    this.name = "GenerationBillingUnavailableError";
  }
}

const holdKey = (payer: GenerationReservePayer) => `generation:reserve-holds:${payer.type}:${payer.id}`;
const toUnits = (usd: number) => Math.round(usd * UNITS_PER_USD);
const toUsd = (units: number) => units / UNITS_PER_USD;

function blockedError(reserveUsd: number, availableUsd: number): BillingAccessBlockedError {
  const available = Math.max(0, availableUsd);
  const shortfall = Math.max(0, reserveUsd - available);
  const decision: Extract<BillingAccessDecision, { status: "blocked" }> = {
    status: "blocked",
    code: "billing_credit_limit_exceeded",
    balanceState: available > 0 ? "positive" : "zero",
    netUsd: available,
    minimumBalanceUsd: reserveUsd,
    conversion: createBillingConversionIntent({
      level: "hard",
      reason: "minimum_balance_not_met",
      source: "generation_task",
      title: "Insufficient balance for this generation",
      message: `This generation reserves $${reserveUsd.toFixed(2)}. Available balance is $${available.toFixed(2)}; add $${shortfall.toFixed(2)} to continue.`,
    }),
  };
  return new BillingAccessBlockedError(decision, decision.conversion.message);
}

export function parseGenerationReserveHold(value: unknown): GenerationReserveHold | null {
  if (!value || typeof value !== "object") return null;
  const { payer, amountUsd } = value as Record<string, unknown>;
  if (!payer || typeof payer !== "object" || typeof amountUsd !== "number" || !(amountUsd > 0)) return null;
  const { type, id } = payer as Record<string, unknown>;
  if ((type !== "personal" && type !== "space_wallet") || typeof id !== "string" || !id) return null;
  return { payer: { type, id }, amountUsd };
}

export function createGenerationReserveHolds(input: {
  redis: GenerationReserveRedis;
  billing: BillingOperations;
  walletBilling: SpaceWalletBillingOperations;
  warn?: (message: string, context: Record<string, unknown>) => void;
}) {
  const { redis, billing, walletBilling, warn } = input;

  /** Spendable balance after outstanding overage, which billing settles before any new usage. */
  async function availableBalance(payer: GenerationReservePayer, amountUsd: number, usageType: string): Promise<number> {
    const operations = payer.type === "space_wallet" ? walletBilling : billing;
    const preview = await operations.preflightUsage({
      userId: payer.id,
      tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
      usageType,
      estimatedAmountUsd: amountUsd,
    });
    return preview.netBalance;
  }

  async function tryHold(payer: GenerationReservePayer, taskRunId: string, amountUsd: number, balanceUsd: number) {
    const now = Date.now();
    let result: [number, number];
    try {
      result = await redis.eval(
        HOLD_SCRIPT,
        1,
        holdKey(payer),
        taskRunId,
        toUnits(amountUsd),
        Math.floor(balanceUsd * UNITS_PER_USD),
        now,
        now + HOLD_TTL_MS,
      ) as [number, number];
    } catch (error) {
      // A timed-out script may still have run; the caller falls back without a hold, so drop it.
      await redis.eval(EXPIRE_SCRIPT, 1, holdKey(payer), taskRunId, now, now).catch(() => undefined);
      throw error;
    }
    return { held: Number(result[0]) === 1, availableUsd: balanceUsd - toUsd(Number(result[1])) };
  }

  /**
   * Holds `amountUsd` against the Space wallet when it is usable and covers the amount on top of its
   * live holds, otherwise against the personal balance. Billing failures throw
   * GenerationBillingUnavailableError; Redis failures propagate so callers can fall back.
   */
  async function hold(request: {
    taskRunId: string;
    userId: string;
    spaceId: string | null;
    usageType: string;
    amountUsd: number;
  }): Promise<GenerationReserveHoldResult> {
    let bestAvailableUsd = 0;
    if (request.spaceId && walletBilling.status.configured && billing.status.configured) {
      const payer: GenerationReservePayer = { type: "space_wallet", id: spaceWalletCustomerId(request.spaceId) };
      let balanceUsd: number | null = null;
      try {
        const credit = await walletBilling.getCreditStatus({ userId: payer.id, createCustomer: false });
        if (walletCreditsUsable(credit)) balanceUsd = await availableBalance(payer, request.amountUsd, request.usageType);
      } catch (error) {
        warn?.("Space wallet reserve preview failed", { spaceId: request.spaceId, error });
      }
      if (balanceUsd !== null) {
        const attempt = await tryHold(payer, request.taskRunId, request.amountUsd, balanceUsd);
        if (attempt.held) return { status: "held", hold: { payer, amountUsd: request.amountUsd } };
        bestAvailableUsd = attempt.availableUsd;
      }
    }

    const payer: GenerationReservePayer = { type: "personal", id: request.userId };
    let balanceUsd: number;
    try {
      balanceUsd = await availableBalance(payer, request.amountUsd, request.usageType);
    } catch (error) {
      throw new GenerationBillingUnavailableError(undefined, { cause: error });
    }
    const attempt = await tryHold(payer, request.taskRunId, request.amountUsd, balanceUsd);
    if (attempt.held) return { status: "held", hold: { payer, amountUsd: request.amountUsd } };
    return {
      status: "blocked",
      error: blockedError(request.amountUsd, Math.max(bestAvailableUsd, attempt.availableUsd)),
    };
  }

  /** Best effort: a failed release only leaves the hold until its TTL. */
  async function release(taskRunId: string, payer: GenerationReservePayer, options: { settled?: boolean } = {}) {
    const now = Date.now();
    await redis.eval(
      EXPIRE_SCRIPT,
      1,
      holdKey(payer),
      taskRunId,
      options.settled ? now + SETTLED_HOLD_GRACE_MS : now,
      now,
    ).catch((error) => {
      warn?.("Generation reserve hold release failed", { taskRunId, error });
    });
  }

  return { hold, release };
}

export type GenerationReserveHolds = ReturnType<typeof createGenerationReserveHolds>;
