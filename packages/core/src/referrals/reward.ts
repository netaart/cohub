import { randomBytes } from "node:crypto";
import type { BillingOperations } from "@cohub/billing";
import { referrals, type ReferralStatus } from "@cohub/db";
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

export const REFERRAL_REWARD_LEASE_MS = 5 * 60_000;
export const REFERRAL_REWARD_RETRY_COOLDOWN_MS = 5 * 60_000;

type ReferralsDb = PostgresJsDatabase<Record<string, unknown>>;
type ReferralRow = typeof referrals.$inferSelect;

export type ReferralRewardLogger = {
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
};

export type RewardQualifiedReferralInput = {
  db: ReferralsDb;
  billing: Pick<BillingOperations, "status" | "grantReferralReward">;
  referral: ReferralRow;
  logger?: ReferralRewardLogger;
  leaseMs?: number;
};

export type QualifyAndRewardReferralInput = {
  db: ReferralsDb;
  billing: Pick<BillingOperations, "status" | "grantReferralReward">;
  inviteeUserId: string;
  completedAt?: Date | null;
  logger?: ReferralRewardLogger;
  leaseMs?: number;
};

export type RetryQualifiedReferralRewardsInput = {
  db: ReferralsDb;
  billing: Pick<BillingOperations, "status" | "grantReferralReward">;
  limit?: number;
  cooldownMs?: number;
  logger?: ReferralRewardLogger;
  leaseMs?: number;
};

const rewardErrorMessage = (side: "inviter" | "invitee", error: unknown) =>
  `${side}: ${error instanceof Error ? error.message : String(error)}`;

async function loadReferralByInvitee(db: ReferralsDb, inviteeUserId: string) {
  const [row] = await db
    .select()
    .from(referrals)
    .where(eq(referrals.inviteeUserId, inviteeUserId))
    .limit(1);
  return row ?? null;
}

async function loadReferralById(db: ReferralsDb, referralId: string) {
  const [row] = await db
    .select()
    .from(referrals)
    .where(eq(referrals.id, referralId))
    .limit(1);
  return row ?? null;
}

async function grantReferralSide(input: {
  billing: Pick<BillingOperations, "grantReferralReward">;
  referralId: string;
  userId: string;
  side: "inviter" | "invitee";
  expectedAmountUsd: number;
}) {
  return input.billing.grantReferralReward({
    userId: input.userId,
    referralId: input.referralId,
    side: input.side,
    expectedAmountUsd: input.expectedAmountUsd,
    operationId: `referral:${input.referralId}:${input.side}`,
  });
}

/**
 * Grant both sides of an already-qualified referral.
 *
 * Keeps DB transactions short:
 * 1. Acquire a short DB lease before calling Billing
 * 2. Call Billing outside any transaction (operation_id + HTTP idempotency key)
 * 3. Persist each side and release the lease
 */
export async function rewardQualifiedReferral(
  input: RewardQualifiedReferralInput,
): Promise<ReferralRow | null> {
  const { db, billing, logger } = input;
  const current = input.referral;
  if (current.status !== "qualified") return current;
  if (!billing.status.configured) {
    logger?.warn?.("[Referrals] reward pending because billing is unavailable", {
      referralId: current.id,
      inviteeUserId: current.inviteeUserId,
      reason: billing.status.reason,
    });
    return current;
  }

  const attemptStartedAt = new Date();
  const leaseToken = randomBytes(16).toString("hex");
  const leaseMs = input.leaseMs ?? REFERRAL_REWARD_LEASE_MS;
  const leaseExpiresAt = new Date(attemptStartedAt.getTime() + leaseMs);
  const [leased] = await db
    .update(referrals)
    .set({
      rewardAttemptedAt: attemptStartedAt,
      rewardLeaseToken: leaseToken,
      rewardLeaseExpiresAt: leaseExpiresAt,
      updatedAt: attemptStartedAt,
    })
    .where(
      and(
        eq(referrals.id, current.id),
        eq(referrals.status, "qualified"),
        or(
          isNull(referrals.rewardLeaseExpiresAt),
          lt(referrals.rewardLeaseExpiresAt, attemptStartedAt),
        ),
      ),
    )
    .returning();
  if (!leased) return loadReferralById(db, current.id);

  const errors: string[] = [];

  if (!current.inviteeRewardedAt) {
    try {
      const result = await grantReferralSide({
        billing,
        referralId: current.id,
        userId: current.inviteeUserId,
        side: "invitee",
        expectedAmountUsd: Number(current.inviteeRewardAmountUsd),
      });
      const rewardedAt = new Date();
      if (result.amountUsd !== Number(current.inviteeRewardAmountUsd)) {
        logger?.warn?.("[Referrals] invitee reward amount differs from expected", {
          referralId: current.id,
          expectedAmountUsd: Number(current.inviteeRewardAmountUsd),
          actualAmountUsd: result.amountUsd,
        });
      }
      await db
        .update(referrals)
        .set({
          inviteeRewardedAt: rewardedAt,
          inviteeRewardAmountUsd: String(result.amountUsd),
          rewardAttemptedAt: rewardedAt,
          updatedAt: rewardedAt,
        })
        .where(
          and(
            eq(referrals.id, leased.id),
            eq(referrals.rewardLeaseToken, leaseToken),
            isNull(referrals.inviteeRewardedAt),
          ),
        );
    } catch (error) {
      errors.push(rewardErrorMessage("invitee", error));
    }
  }

  const afterInvitee = (await loadReferralById(db, current.id)) ?? leased;
  if (afterInvitee.rewardLeaseToken !== leaseToken) return afterInvitee;
  if (!afterInvitee.inviterRewardedAt) {
    try {
      const result = await grantReferralSide({
        billing,
        referralId: afterInvitee.id,
        userId: afterInvitee.inviterUserId,
        side: "inviter",
        expectedAmountUsd: Number(afterInvitee.inviterRewardAmountUsd),
      });
      const rewardedAt = new Date();
      if (result.amountUsd !== Number(afterInvitee.inviterRewardAmountUsd)) {
        logger?.warn?.("[Referrals] inviter reward amount differs from expected", {
          referralId: afterInvitee.id,
          expectedAmountUsd: Number(afterInvitee.inviterRewardAmountUsd),
          actualAmountUsd: result.amountUsd,
        });
      }
      await db
        .update(referrals)
        .set({
          inviterRewardedAt: rewardedAt,
          inviterRewardAmountUsd: String(result.amountUsd),
          rewardAttemptedAt: rewardedAt,
          updatedAt: rewardedAt,
        })
        .where(
          and(
            eq(referrals.id, afterInvitee.id),
            eq(referrals.rewardLeaseToken, leaseToken),
            isNull(referrals.inviterRewardedAt),
          ),
        );
    } catch (error) {
      errors.push(rewardErrorMessage("inviter", error));
    }
  }

  const latest = (await loadReferralById(db, current.id)) ?? leased;
  if (latest.status === "rewarded" || latest.rewardLeaseToken !== leaseToken) return latest;

  const bothRewarded = Boolean(latest.inviteeRewardedAt && latest.inviterRewardedAt);
  const rewardError = errors.length > 0 ? errors.join(" | ").slice(0, 2000) : null;

  if (bothRewarded) {
    const completedAt = new Date();
    const [updated] = await db
      .update(referrals)
      .set({
        status: "rewarded" satisfies ReferralStatus,
        rewardedAt: latest.rewardedAt ?? completedAt,
        rewardError: null,
        rewardAttemptedAt: completedAt,
        rewardLeaseToken: null,
        rewardLeaseExpiresAt: null,
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(referrals.id, latest.id),
          eq(referrals.status, "qualified"),
          eq(referrals.rewardLeaseToken, leaseToken),
        ),
      )
      .returning();
    return updated ?? (await loadReferralById(db, current.id));
  }

  const attemptCompletedAt = new Date();
  const [updated] = await db
    .update(referrals)
    .set({
      rewardError,
      rewardAttemptedAt: attemptCompletedAt,
      rewardLeaseToken: null,
      rewardLeaseExpiresAt: null,
      updatedAt: attemptCompletedAt,
    })
    .where(
      and(
        eq(referrals.id, latest.id),
        eq(referrals.status, "qualified"),
        eq(referrals.rewardLeaseToken, leaseToken),
      ),
    )
    .returning();

  if (errors.length > 0) {
    logger?.warn?.("[Referrals] reward grant failed", {
      referralId: latest.id,
      errors,
    });
  }

  return updated ?? (await loadReferralById(db, current.id));
}

/**
 * CAS pending → qualified (if needed), then grant rewards under lease.
 * Safe to call from system worker after a successful invitee turn.
 */
export async function qualifyAndRewardReferral(
  input: QualifyAndRewardReferralInput,
): Promise<ReferralRow | null> {
  const { db, inviteeUserId } = input;
  const qualifiedAt = input.completedAt ?? new Date();
  const [qualified] = await db
    .update(referrals)
    .set({ status: "qualified", qualifiedAt, updatedAt: new Date() })
    .where(
      and(
        eq(referrals.inviteeUserId, inviteeUserId),
        inArray(referrals.status, ["pending", "expired"]),
        or(isNull(referrals.expiresAt), gt(referrals.expiresAt, qualifiedAt)),
      ),
    )
    .returning();

  if (qualified) {
    return rewardQualifiedReferral({
      db,
      billing: input.billing,
      referral: qualified,
      logger: input.logger,
      leaseMs: input.leaseMs,
    });
  }

  // Already qualified (or rewarded) — still try to finish incomplete grants.
  const existing = await loadReferralByInvitee(db, inviteeUserId);
  if (existing?.status !== "qualified") return existing;
  return rewardQualifiedReferral({
    db,
    billing: input.billing,
    referral: existing,
    logger: input.logger,
    leaseMs: input.leaseMs,
  });
}

export async function retryQualifiedReferralRewards(
  input: RetryQualifiedReferralRewardsInput,
) {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
  const cooldownMs = input.cooldownMs ?? REFERRAL_REWARD_RETRY_COOLDOWN_MS;
  const retryBefore = new Date(Date.now() - cooldownMs);
  const retryable = await input.db
    .select()
    .from(referrals)
    .where(
      and(
        eq(referrals.status, "qualified"),
        or(
          isNull(referrals.rewardAttemptedAt),
          lt(referrals.rewardAttemptedAt, retryBefore),
        ),
      ),
    )
    .orderBy(sql`${referrals.rewardAttemptedAt} asc nulls first`)
    .limit(limit);

  let rewarded = 0;
  for (const referral of retryable) {
    const result = await rewardQualifiedReferral({
      db: input.db,
      billing: input.billing,
      referral,
      logger: input.logger,
      leaseMs: input.leaseMs,
    });
    if (result?.status === "rewarded") rewarded += 1;
  }
  return { attempted: retryable.length, rewarded };
}

export function startReferralRewardRetryLoop(input: {
  run: () => Promise<Record<string, number> | undefined>;
  intervalMs?: number;
  logger?: ReferralRewardLogger;
}) {
  let running = false;
  const intervalMs = input.intervalMs ?? 60_000;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await input.run();
      if (result && Object.values(result).some((count) => count > 0)) {
        input.logger?.info?.("[Referrals] reward retry completed", result);
      }
    } catch (error) {
      input.logger?.warn?.("[Referrals] reward retry failed", { error });
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
