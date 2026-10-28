import { referrals, type ReferralStatus } from "@cohub/db";
import { and, eq, lt } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export const REFERRAL_QUOTA = {
  limit: 5,
  cycleDays: 30,
  claimHours: 72,
  newAccountHours: 24,
} as const;

const CYCLE_MS = REFERRAL_QUOTA.cycleDays * DAY_MS;

export const REFERRAL_QUOTA_STATUSES = ["pending", "qualified", "rewarded"] as const satisfies ReferralStatus[];

export type ReferralQuotaRow = {
  status: ReferralStatus;
  quotaCycle: number | null;
  qualifiedAt: Date | string | null;
  expiresAt: Date | string | null;
};

export type ReferralQuota = {
  limit: number;
  cycleDays: number;
  claimHours: number;
  cycle: number;
  cycleStartsAt: Date | null;
  cycleEndsAt: Date | null;
  used: number;
  reserved: number;
  available: number;
};

const time = (value: Date | string | null) => (value ? new Date(value).getTime() : null);

/** Cycles last 30 days from the first qualified referral; earlier claims belong to cycle 0. */
export function resolveReferralQuota(rows: readonly ReferralQuotaRow[], now = new Date()): ReferralQuota {
  const nowMs = now.getTime();
  const quotaRows = rows.filter((row) => row.quotaCycle !== null);
  let startMs: number | null = null;
  for (const row of quotaRows) {
    const qualifiedMs = time(row.qualifiedAt);
    if (qualifiedMs !== null && (startMs === null || qualifiedMs < startMs)) startMs = qualifiedMs;
  }
  const cycle = startMs === null ? 0 : Math.max(0, Math.floor((nowMs - startMs) / CYCLE_MS));
  let used = 0;
  let reserved = 0;
  for (const row of quotaRows) {
    if (row.quotaCycle !== cycle) continue;
    if (row.status === "qualified" || row.status === "rewarded") used += 1;
    else if (row.status === "pending" && (time(row.expiresAt) ?? Number.POSITIVE_INFINITY) > nowMs) reserved += 1;
  }
  const cycleStartMs = startMs === null ? null : startMs + cycle * CYCLE_MS;
  return {
    limit: REFERRAL_QUOTA.limit,
    cycleDays: REFERRAL_QUOTA.cycleDays,
    claimHours: REFERRAL_QUOTA.claimHours,
    cycle,
    cycleStartsAt: cycleStartMs === null ? null : new Date(cycleStartMs),
    cycleEndsAt: cycleStartMs === null ? null : new Date(cycleStartMs + CYCLE_MS),
    used,
    reserved,
    available: Math.max(0, REFERRAL_QUOTA.limit - used - reserved),
  };
}

export const referralClaimExpiresAt = (claimedAt: Date) =>
  new Date(claimedAt.getTime() + REFERRAL_QUOTA.claimHours * HOUR_MS);

export const isNewReferralAccount = (createdAt: Date, now = new Date()) =>
  now.getTime() - createdAt.getTime() <= REFERRAL_QUOTA.newAccountHours * HOUR_MS;

export async function expireReferralClaims(db: PostgresJsDatabase<Record<string, unknown>>, now = new Date()) {
  const expired = await db
    .update(referrals)
    .set({ status: "expired", updatedAt: now })
    .where(and(eq(referrals.status, "pending"), lt(referrals.expiresAt, now)))
    .returning({ id: referrals.id });
  return expired.length;
}
