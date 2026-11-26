import { referrals } from "@cohub/db";
import { and, eq, lt } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export const REFERRAL_CLAIM = {
  paymentWindowDays: 30,
  newAccountHours: 24,
} as const;

export const referralClaimExpiresAt = (claimedAt: Date) =>
  new Date(claimedAt.getTime() + REFERRAL_CLAIM.paymentWindowDays * DAY_MS);

export const isNewReferralAccount = (createdAt: Date, now = new Date()) =>
  now.getTime() - createdAt.getTime() <= REFERRAL_CLAIM.newAccountHours * HOUR_MS;

export async function expireReferralClaims(db: PostgresJsDatabase<Record<string, unknown>>, now = new Date()) {
  const expired = await db
    .update(referrals)
    .set({ status: "expired", updatedAt: now })
    .where(and(eq(referrals.status, "pending"), lt(referrals.expiresAt, now)))
    .returning({ id: referrals.id });
  return expired.length;
}
