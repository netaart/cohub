import { referrals, sessionMessages, sessionTurns } from "@cohub/db";
import { and, asc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { isQualifyingReferralTurn } from "./qualification.js";

type ReferralsDb = PostgresJsDatabase<Record<string, unknown>>;
type ReferralExecutor = Pick<ReferralsDb, "select" | "update" | "execute">;

export async function lockReferralQuota(db: ReferralExecutor, inviterUserId: string) {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`referral-quota:${inviterUserId}`}))`);
}

/** Read the database clock after acquiring the lock, not the transaction start time. */
export async function referralTransactionTime(db: ReferralExecutor): Promise<Date> {
  const [row] = await db.select({ now: sql<string>`clock_timestamp()::text` }).from(sql`(select 1) as clock`);
  if (!row) throw new Error("Referral transaction clock unavailable");
  return new Date(row.now);
}

/** Caller holds the inviter lock. Resolve successful turns before releasing any reservation. */
export async function reconcileReferralClaims(db: ReferralExecutor, inviterUserId: string, now: Date) {
  const candidates = await db
    .select({ referralId: referrals.id, turn: sessionTurns, message: sessionMessages })
    .from(referrals)
    .innerJoin(sessionTurns, and(
      eq(sessionTurns.userUuid, referrals.inviteeUserId),
      eq(sessionTurns.status, "completed"),
      eq(sessionTurns.executionKind, "agent"),
      gte(sessionTurns.completedAt, referrals.claimedAt),
      or(isNull(referrals.expiresAt), lt(sessionTurns.completedAt, referrals.expiresAt)),
    ))
    .innerJoin(sessionMessages, and(
      eq(sessionMessages.sessionId, sessionTurns.sessionId),
      or(
        eq(sessionMessages.turnId, sessionTurns.id),
        and(isNull(sessionMessages.turnId), sql`${sessionMessages.meta}->>'turnId' = ${sessionTurns.id}::text`),
      ),
      eq(sessionMessages.role, "assistant"),
      sql`${sessionMessages.meta}->>'messageKind' = 'assistant_final'`,
    ))
    .where(and(eq(referrals.inviterUserId, inviterUserId), eq(referrals.status, "pending")))
    .orderBy(asc(sessionTurns.completedAt), asc(sessionTurns.id));

  const qualified = new Set<string>();
  for (const { referralId, turn, message } of candidates) {
    if (qualified.has(referralId) || !isQualifyingReferralTurn(turn, message)) continue;
    await db.update(referrals)
      .set({ status: "qualified", qualifiedAt: turn.completedAt, updatedAt: now })
      .where(and(eq(referrals.id, referralId), eq(referrals.status, "pending")));
    qualified.add(referralId);
  }

  const expired = await db.update(referrals)
    .set({ status: "expired", updatedAt: now })
    .where(and(
      eq(referrals.inviterUserId, inviterUserId),
      eq(referrals.status, "pending"),
      lte(referrals.expiresAt, now),
    ))
    .returning({ id: referrals.id });
  return { qualified: qualified.size, expired: expired.length };
}

export async function expireReferralClaims(db: ReferralsDb) {
  const inviters = await db.selectDistinct({ userId: referrals.inviterUserId })
    .from(referrals)
    .where(and(eq(referrals.status, "pending"), lte(referrals.expiresAt, sql`clock_timestamp()`)));
  let expired = 0;
  for (const { userId } of inviters) {
    expired += await db.transaction(async (tx) => {
      await lockReferralQuota(tx, userId);
      return (await reconcileReferralClaims(tx, userId, await referralTransactionTime(tx))).expired;
    });
  }
  return expired;
}

/** Cloud turn completion and its referral qualification share the expiry/claim lock. */
export async function finalizeReferralTurn<T>(
  db: ReferralsDb,
  turnId: string,
  finalize: (executor: ReferralExecutor, completedAt?: Date) => Promise<T>,
): Promise<T> {
  const [referral] = await db.select({ inviterUserId: referrals.inviterUserId })
    .from(referrals)
    .innerJoin(sessionTurns, eq(sessionTurns.userUuid, referrals.inviteeUserId))
    .where(and(eq(sessionTurns.id, turnId), eq(referrals.status, "pending")))
    .limit(1);
  if (!referral) return finalize(db);

  return db.transaction(async (tx) => {
    await lockReferralQuota(tx, referral.inviterUserId);
    const completedAt = await referralTransactionTime(tx);
    const result = await finalize(tx, completedAt);
    await reconcileReferralClaims(tx, referral.inviterUserId, completedAt);
    return result;
  });
}
