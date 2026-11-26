import { randomBytes } from "node:crypto";
import { billingOperations } from "@cohub/billing";
import {
  isNewReferralAccount,
  qualifyReferral,
  REFERRAL_CLAIM,
  referralClaimExpiresAt,
  rewardQualifiedReferral,
} from "@cohub/core/referrals";
import { createLogger } from "@cohub/infra/logging";
import {
  referralCodes,
  referrals,
  sessionTurns,
  userProfiles,
  type ReferralStatus,
} from "@cohub/db";
import { and, desc, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import type { AuthUser } from "./lib/middleware.js";
import { ensureCurrentUserProfile } from "./user-profiles.js";

const REFERRAL_REWARD_USD = 5;

export const REFERRAL_REWARD = {
  inviterUsd: REFERRAL_REWARD_USD,
  inviteeUsd: REFERRAL_REWARD_USD,
  paymentWindowDays: REFERRAL_CLAIM.paymentWindowDays,
};

const logger = createLogger({ serviceName: "cohub-api" });

function generateReferralCode() {
  return randomBytes(9).toString("base64url");
}

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export async function ensureReferralCode(userId: string) {
  const [existing] = await db
    .select()
    .from(referralCodes)
    .where(and(eq(referralCodes.userId, userId), eq(referralCodes.status, "active")))
    .limit(1);
  if (existing) return existing;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [created] = await db
      .insert(referralCodes)
      .values({ userId, code: generateReferralCode() })
      .onConflictDoNothing()
      .returning();
    if (created) return created;

    const [concurrent] = await db
      .select()
      .from(referralCodes)
      .where(and(eq(referralCodes.userId, userId), eq(referralCodes.status, "active")))
      .limit(1);
    if (concurrent) return concurrent;
  }
  throw new Error("failed to create referral code");
}

export async function rotateReferralCode(userId: string) {
  const now = new Date();
  return db.transaction(async (tx) => {
    await tx
      .update(referralCodes)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(and(eq(referralCodes.userId, userId), eq(referralCodes.status, "active")));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [created] = await tx
        .insert(referralCodes)
        .values({ userId, code: generateReferralCode() })
        .onConflictDoNothing()
        .returning();
      if (created) return created;
    }
    throw new Error("failed to rotate referral code");
  });
}

export async function getPublicReferral(code: string) {
  const [result] = await db
    .select({
      codeId: referralCodes.id,
      inviterUserId: referralCodes.userId,
      profile: {
        userUuid: userProfiles.userUuid,
        username: userProfiles.username,
        displayName: userProfiles.displayName,
        avatarUrl: userProfiles.avatarUrl,
      },
    })
    .from(referralCodes)
    .leftJoin(userProfiles, eq(userProfiles.userUuid, referralCodes.userId))
    .where(and(eq(referralCodes.code, code), eq(referralCodes.status, "active")))
    .limit(1);
  return result ?? null;
}

async function loadAccountCreatedAt(user: AuthUser) {
  const load = async () => {
    const [row] = await db
      .select({ createdAt: userProfiles.createdAt, source: userProfiles.source })
      .from(userProfiles)
      .where(eq(userProfiles.userUuid, user.uuid))
      .limit(1);
    return row;
  };
  let row = await load();
  if (!row) {
    await ensureCurrentUserProfile(user);
    row = await load();
  }
  if (!row) return null;
  const times = [row.createdAt?.getTime(), row.source.createdAt].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  return times.length > 0 ? new Date(Math.min(...times)) : null;
}

export type ClaimReferralResult = {
  referralId: string | null;
  status: ReferralStatus | "self" | "existing_user" | "already_claimed";
  created?: boolean;
};

async function loadInviteeReferral(inviteeUserId: string, codeId: string): Promise<ClaimReferralResult | null> {
  const [existing] = await db
    .select({
      id: referrals.id,
      referralCodeId: referrals.referralCodeId,
      status: referrals.status,
    })
    .from(referrals)
    .where(eq(referrals.inviteeUserId, inviteeUserId))
    .limit(1);
  if (!existing) return null;
  return {
    referralId: existing.id,
    status: existing.referralCodeId === codeId ? existing.status : "already_claimed",
  };
}

export async function claimReferral(code: string, invitee: AuthUser): Promise<ClaimReferralResult | null> {
  const publicReferral = await getPublicReferral(code);
  if (!publicReferral) return null;
  const { codeId, inviterUserId } = publicReferral;
  if (inviterUserId === invitee.uuid) return { referralId: null, status: "self" };

  const existing = await loadInviteeReferral(invitee.uuid, codeId);
  if (existing) return existing;

  const [successfulTurn] = await db
    .select({ id: sessionTurns.id })
    .from(sessionTurns)
    .where(and(eq(sessionTurns.userUuid, invitee.uuid), eq(sessionTurns.status, "completed")))
    .limit(1);
  if (successfulTurn) return { referralId: null, status: "existing_user" };

  const accountCreatedAt = await loadAccountCreatedAt(invitee);
  if (!accountCreatedAt || !isNewReferralAccount(accountCreatedAt)) {
    return { referralId: null, status: "existing_user" };
  }

  const claimedAt = new Date();
  const amountUsd = String(REFERRAL_REWARD_USD);
  const [created] = await db
    .insert(referrals)
    .values({
      referralCodeId: codeId,
      inviterUserId,
      inviteeUserId: invitee.uuid,
      status: "pending",
      claimedAt,
      expiresAt: referralClaimExpiresAt(claimedAt),
      inviterRewardAmountUsd: amountUsd,
      inviteeRewardAmountUsd: amountUsd,
    })
    .onConflictDoNothing({ target: referrals.inviteeUserId })
    .returning({ id: referrals.id, status: referrals.status });

  if (created) return { referralId: created.id, status: created.status, created: true };
  return loadInviteeReferral(invitee.uuid, codeId);
}

/** Persist qualification before acknowledging the webhook; the grant runs after it, with the system worker retrying failures. */
export async function qualifyReferralPayment(payment: { userId: string; paidAt: Date }) {
  const referral = await qualifyReferral({ db, inviteeUserId: payment.userId, paidAt: payment.paidAt });
  if (referral?.status !== "qualified") return referral;
  void rewardQualifiedReferral({
    db,
    billing: billingOperations,
    referral,
    logger: {
      warn: (message, meta) => logger.warn(message, meta),
      info: (message, meta) => logger.info(message, meta),
    },
  }).catch((error: unknown) => logger.warn("[Referrals] reward grant failed", { referralId: referral.id, error }));
  return referral;
}

const displayStatus = (row: { status: ReferralStatus; expiresAt: Date | null }, now: Date): ReferralStatus =>
  row.status === "pending" && row.expiresAt && row.expiresAt <= now ? "expired" : row.status;

export async function getReferralDashboard(userId: string) {
  const code = await ensureReferralCode(userId);
  const now = new Date();
  const [rows, [received]] = await Promise.all([
    db
      .select({
        id: referrals.id,
        status: referrals.status,
        claimedAt: referrals.claimedAt,
        qualifiedAt: referrals.qualifiedAt,
        rewardedAt: referrals.rewardedAt,
        expiresAt: referrals.expiresAt,
        inviterRewardAmountUsd: referrals.inviterRewardAmountUsd,
        profile: {
          userUuid: userProfiles.userUuid,
          username: userProfiles.username,
          displayName: userProfiles.displayName,
          avatarUrl: userProfiles.avatarUrl,
        },
      })
      .from(referrals)
      .leftJoin(userProfiles, eq(userProfiles.userUuid, referrals.inviteeUserId))
      .where(eq(referrals.inviterUserId, userId))
      .orderBy(desc(referrals.claimedAt)),
    db
      .select({
        id: referrals.id,
        status: referrals.status,
        claimedAt: referrals.claimedAt,
        expiresAt: referrals.expiresAt,
        qualifiedAt: referrals.qualifiedAt,
        inviteeRewardedAt: referrals.inviteeRewardedAt,
      })
      .from(referrals)
      .where(eq(referrals.inviteeUserId, userId))
      .limit(1),
  ]);

  const items = rows.map((row) => ({ ...row, status: displayStatus(row, now) }));
  const count = (status: ReferralStatus) => items.filter((item) => item.status === status).length;
  const earnedUsd = Number(
    items
      .filter((item) => item.status === "rewarded")
      .reduce((total, item) => total + Number(item.inviterRewardAmountUsd), 0)
      .toFixed(8),
  );
  return {
    code: code.code,
    reward: REFERRAL_REWARD,
    received: received
      ? {
          id: received.id,
          status: displayStatus(received, now),
          claimedAt: toIso(received.claimedAt),
          expiresAt: toIso(received.expiresAt),
          qualifiedAt: toIso(received.qualifiedAt),
          inviteeRewardedAt: toIso(received.inviteeRewardedAt),
        }
      : null,
    summary: {
      total: items.length,
      pending: count("pending"),
      qualified: count("qualified"),
      rewarded: count("rewarded"),
      earnedUsd,
    },
    items: items.map(({ inviterRewardAmountUsd: _, ...item }) => ({
      ...item,
      claimedAt: toIso(item.claimedAt),
      qualifiedAt: toIso(item.qualifiedAt),
      rewardedAt: toIso(item.rewardedAt),
      expiresAt: item.status === "pending" ? toIso(item.expiresAt) : null,
      profile: item.profile?.userUuid ? item.profile : null,
    })),
  };
}
