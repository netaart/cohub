import { referrals, type ReferralStatus } from "@cohub/db";
import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export const REFERRAL_QUOTA = {
  limit: 5,
  cycleDays: 30,
  paymentWindowDays: 30,
  newAccountHours: 24,
} as const;

const CYCLE_MS = REFERRAL_QUOTA.cycleDays * DAY_MS;

export const REFERRAL_QUOTA_STATUSES = ["qualified", "rewarded"] as const satisfies ReferralStatus[];

export type ReferralQuotaRow = {
  status: ReferralStatus;
  quotaCycle: number | null;
  qualifiedAt: Date | string | null;
};

export type ReferralQuota = {
  limit: number;
  cycleDays: number;
  paymentWindowDays: number;
  cycle: number;
  cycleStartsAt: Date | null;
  cycleEndsAt: Date | null;
  used: number;
  available: number;
};

const time = (value: Date | string | null) => (value ? new Date(value).getTime() : null);
const isQuotaRow = (row: ReferralQuotaRow) =>
  row.quotaCycle !== null && (REFERRAL_QUOTA_STATUSES as readonly ReferralStatus[]).includes(row.status);

/** Cycles last 30 days from the first qualified referral; a slot is used when an invitee's payment qualifies. */
export function resolveReferralQuota(rows: readonly ReferralQuotaRow[], now = new Date()): ReferralQuota {
  const quotaRows = rows.filter(isQuotaRow);
  let startMs: number | null = null;
  for (const row of quotaRows) {
    const qualifiedMs = time(row.qualifiedAt);
    if (qualifiedMs !== null && (startMs === null || qualifiedMs < startMs)) startMs = qualifiedMs;
  }
  const cycle = startMs === null ? 0 : Math.max(0, Math.floor((now.getTime() - startMs) / CYCLE_MS));
  const used = quotaRows.filter((row) => row.quotaCycle === cycle).length;
  const cycleStartMs = startMs === null ? null : startMs + cycle * CYCLE_MS;
  return {
    limit: REFERRAL_QUOTA.limit,
    cycleDays: REFERRAL_QUOTA.cycleDays,
    paymentWindowDays: REFERRAL_QUOTA.paymentWindowDays,
    cycle,
    cycleStartsAt: cycleStartMs === null ? null : new Date(cycleStartMs),
    cycleEndsAt: cycleStartMs === null ? null : new Date(cycleStartMs + CYCLE_MS),
    used,
    available: Math.max(0, REFERRAL_QUOTA.limit - used),
  };
}

export async function loadReferralQuota(
  executor: Pick<PostgresJsDatabase<Record<string, unknown>>, "select">,
  inviterUserId: string,
  now = new Date(),
) {
  const rows = await executor
    .select({ status: referrals.status, quotaCycle: referrals.quotaCycle, qualifiedAt: referrals.qualifiedAt })
    .from(referrals)
    .where(
      and(
        eq(referrals.inviterUserId, inviterUserId),
        isNotNull(referrals.quotaCycle),
        inArray(referrals.status, [...REFERRAL_QUOTA_STATUSES]),
      ),
    );
  return resolveReferralQuota(rows, now);
}

export const referralClaimExpiresAt = (claimedAt: Date) =>
  new Date(claimedAt.getTime() + REFERRAL_QUOTA.paymentWindowDays * DAY_MS);

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
