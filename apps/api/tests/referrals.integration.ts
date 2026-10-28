import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "@cohub/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { expireReferralClaims, qualifyAndRewardReferral, retryQualifiedReferralRewards } from "../../../packages/core/src/referrals/index.js";

process.env.LOG_LEVEL = "silent";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../drizzle/v2");
const client = new PGlite({ extensions: { pg_trgm } });
const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
for (const entry of journal.entries) {
  await client.exec(readFileSync(join(migrations, `${entry.tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
}

const db = drizzle(client, { schema });
const referralsDb = db as unknown as Parameters<typeof expireReferralClaims>[0];
mock.module("../src/db/index.js", { namedExports: { db } });
mock.module("../src/user-profiles.js", { namedExports: { ensureCurrentUserProfile: async () => null } });

const { claimReferral, ensureReferralCode, getReferralDashboard, isReferralRewardAvailable } = await import("../src/referrals.js");

const user = (uuid: string) => ({ uuid }) as Parameters<typeof claimReferral>[1];
const addProfile = (uuid: string, createdAt = new Date()) =>
  client.query(
    `INSERT INTO v2.user_profiles (user_uuid, logto_user_id, display_name, source, created_at) VALUES ($1, $1, $1, '{}', $2)`,
    [uuid, createdAt],
  );

const addReferral = async (
  inviterUserId: string,
  inviteeUserId: string,
  fields: Partial<typeof schema.referrals.$inferInsert> = {},
) => {
  const code = await ensureReferralCode(inviterUserId);
  const [row] = await db.insert(schema.referrals).values({
    referralCodeId: code.id,
    inviterUserId,
    inviteeUserId,
    inviterRewardAmountUsd: "5",
    inviteeRewardAmountUsd: "5",
    ...fields,
  }).returning();
  assert.ok(row);
  return row;
};

const addCompletedTurn = async (userUuid: string, completedAt: Date, meta: Record<string, unknown> = {}) => {
  const [session] = await db.insert(schema.spaceSessions).values({ spaceId: crypto.randomUUID(), userUuid }).returning();
  assert.ok(session);
  const [turn] = await db.insert(schema.sessionTurns).values({
    sessionId: session.id,
    userUuid,
    sequence: 1,
    executionKind: "agent",
    status: "completed",
    intent: "followup",
    userContent: [{ type: "text", text: "Hello" }],
    completedAt,
    meta,
  }).returning();
  assert.ok(turn);
  await db.insert(schema.sessionMessages).values({
    sessionId: session.id,
    turnId: turn.id,
    role: "assistant",
    sequence: 1,
    content: [{ type: "text", text: "Hello!" }],
    stopReason: "end_turn",
    meta: { turnId: turn.id, actorUserId: userUuid, messageKind: "assistant_final" },
  });
  return turn;
};

const disabledBilling: Parameters<typeof qualifyAndRewardReferral>[0]["billing"] = {
  status: { configured: false, provider: "disabled" },
  grantReferralReward: async () => assert.fail("Disabled Billing must not grant rewards"),
};

test("claims reserve at most five slots per cycle and reject old accounts", async () => {
  const { code } = await ensureReferralCode("inviter");
  await addProfile("inviter");

  await addProfile("old", new Date(Date.now() - 2 * 24 * 60 * 60_000));
  assert.equal((await claimReferral(code, user("old")))?.status, "existing_user");
  assert.equal((await claimReferral(code, user("inviter")))?.status, "self");

  const invitees = Array.from({ length: 7 }, (_, index) => `invitee-${index}`);
  for (const invitee of invitees) await addProfile(invitee);
  const results = await Promise.all(invitees.map((invitee) => claimReferral(code, user(invitee))));
  const statuses = results.map((result) => result?.status);
  assert.equal(statuses.filter((status) => status === "pending").length, 5);
  assert.equal(statuses.filter((status) => status === "capped").length, 2);
  assert.ok(results.every((result) => result?.created));
  assert.equal(await isReferralRewardAvailable("inviter"), false);

  const first = results[statuses.indexOf("pending")];
  const firstInvitee = invitees[statuses.indexOf("pending")] ?? "";
  assert.deepEqual(await claimReferral(code, user(firstInvitee)), { referralId: first?.referralId, status: "pending" });

  await client.query(`UPDATE v2.referrals SET expires_at = now() - interval '1 second' WHERE invitee_user_id = $1`, [firstInvitee]);
  assert.equal(await isReferralRewardAvailable("inviter"), false);
  assert.equal(await expireReferralClaims(referralsDb), 1);
  assert.equal(await isReferralRewardAvailable("inviter"), true);

  const dashboard = await getReferralDashboard("inviter");
  assert.deepEqual(
    { used: dashboard.quota.used, reserved: dashboard.quota.reserved, available: dashboard.quota.available },
    { used: 0, reserved: 4, available: 1 },
  );
  assert.equal(dashboard.items.find((item) => item.profile?.userUuid === firstInvitee)?.status, "expired");
  assert.equal(dashboard.items.filter((item) => item.status === "capped").length, 2);
  assert.ok(dashboard.items.filter((item) => item.status === "pending").every((item) => item.expiresAt));
});

test("reward retries only the failed side and preserves stable per-side operation IDs", async () => {
  const now = Date.now();
  const referral = await addReferral("retry-inviter", "retry-invitee", {
    status: "pending", quotaCycle: 0,
    claimedAt: new Date(now - 60_000), expiresAt: new Date(now + 60_000),
  });
  await addCompletedTurn(referral.inviteeUserId, new Date(now - 30_000));
  const calls: Array<{ side: string; operationId: string }> = [];
  let failInviter = true;
  const billing: Parameters<typeof qualifyAndRewardReferral>[0]["billing"] = {
    status: { configured: true, provider: "talesofai" },
    grantReferralReward: async (input) => {
      calls.push({ side: input.side, operationId: input.operationId });
      if (input.side === "inviter" && failInviter) {
        failInviter = false;
        throw new Error("Temporary Billing failure");
      }
      return { amountUsd: 5, benefitKey: `referral_${input.side}_credit`, grantId: `grant-${input.side}`, transactionId: `transaction-${input.side}` };
    },
  };
  const partial = await qualifyAndRewardReferral({ db: referralsDb, billing, inviteeUserId: referral.inviteeUserId });
  assert.equal(partial?.status, "qualified");
  assert.ok(partial?.inviteeRewardedAt);
  assert.equal(partial?.inviterRewardedAt, null);
  await db.update(schema.referrals).set({ rewardAttemptedAt: new Date(0) }).where(eq(schema.referrals.id, referral.id));
  await retryQualifiedReferralRewards({ db: referralsDb, billing, cooldownMs: 0 });
  const completed = await qualifyAndRewardReferral({ db: referralsDb, billing, inviteeUserId: referral.inviteeUserId });
  assert.equal(completed?.status, "rewarded");
  assert.equal(completed?.inviteeRewardedAt?.toISOString(), partial?.inviteeRewardedAt?.toISOString());
  assert.deepEqual(calls, [
    { side: "invitee", operationId: `referral:${referral.id}:invitee` },
    { side: "inviter", operationId: `referral:${referral.id}:inviter` },
    { side: "inviter", operationId: `referral:${referral.id}:inviter` },
  ]);
});

test("dashboard exposes only the caller's received referral and preserves deadlines and partial rewards", async () => {
  const claimedAt = new Date(Date.now() - 4 * 24 * 60 * 60_000);
  const expiredAt = new Date(Date.now() - 60_000);
  const pendingAt = new Date(Date.now() + 60_000);
  const qualifiedAt = new Date(expiredAt.getTime() - 60_000);
  const inviteeRewardedAt = new Date(qualifiedAt.getTime() + 1_000);
  const scenarios = [
    { status: "pending", expiresAt: pendingAt },
    { status: "pending", expiresAt: expiredAt },
    { status: "expired", expiresAt: expiredAt },
    { status: "qualified", expiresAt: expiredAt, qualifiedAt, inviteeRewardedAt },
    { status: "rewarded", expiresAt: expiredAt, qualifiedAt, inviteeRewardedAt },
    { status: "capped", expiresAt: null },
  ] as const;

  for (const [index, scenario] of scenarios.entries()) {
    const invitee = `received-invitee-${index}`;
    const row = await addReferral("received-inviter", invitee, { claimedAt, ...scenario });
    const dashboard = await getReferralDashboard(invitee);
    assert.deepEqual(dashboard.received, {
      id: row.id,
      status: row.status,
      claimedAt: claimedAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      qualifiedAt: row.qualifiedAt?.toISOString() ?? null,
      inviteeRewardedAt: row.inviteeRewardedAt?.toISOString() ?? null,
    });
    assert.deepEqual(dashboard.items, []);
  }

  const inviterDashboard = await getReferralDashboard("received-inviter");
  assert.equal(inviterDashboard.received, null);
  assert.equal(inviterDashboard.items.find((item) => item.status === "expired")?.expiresAt, expiredAt.toISOString());
  assert.equal((await getReferralDashboard("received-unrelated")).received, null);
});

test("dashboard reports stored cycle membership for cross-cycle, pre-anchor and legacy claims", async () => {
  const hour = 60 * 60_000;
  const day = 24 * hour;
  const now = Date.now();
  const inviter = "cycle-dashboard-inviter";
  const anchor = await addReferral(inviter, "cycle-anchor", {
    status: "rewarded", quotaCycle: 0,
    claimedAt: new Date(now - 31 * day - hour), qualifiedAt: new Date(now - 31 * day),
  });
  const previous = await addReferral(inviter, "cycle-completed-late", {
    status: "qualified", quotaCycle: 0,
    claimedAt: new Date(now - 2 * day), qualifiedAt: new Date(now - hour),
  });
  const current = await addReferral(inviter, "cycle-current", {
    status: "pending", quotaCycle: 1,
    claimedAt: new Date(now - hour), expiresAt: new Date(now + 2 * day),
  });
  const legacy = await addReferral(inviter, "cycle-legacy", {
    status: "rewarded", quotaCycle: null,
    claimedAt: new Date(now - hour), qualifiedAt: new Date(now - hour / 2),
  });
  const capped = await addReferral(inviter, "cycle-capped", { status: "capped", quotaCycle: 1 });
  const dashboard = await getReferralDashboard(inviter);
  assert.deepEqual(Object.fromEntries(dashboard.items.map((item) => [item.id, item.inCurrentCycle])), {
    [anchor.id]: false,
    [previous.id]: false,
    [current.id]: true,
    [legacy.id]: false,
    [capped.id]: true,
  });
  assert.equal(dashboard.quota.used, 0);
  assert.equal(dashboard.quota.reserved, 1);

  const first = await addReferral("pre-anchor-inviter", "pre-anchor-first", {
    status: "qualified", quotaCycle: 0,
    claimedAt: new Date(now - 2 * hour), qualifiedAt: new Date(now - hour),
  });
  const reserved = await addReferral("pre-anchor-inviter", "pre-anchor-reserved", {
    status: "pending", quotaCycle: 0,
    claimedAt: new Date(now - 2 * hour), expiresAt: new Date(now + 2 * day),
  });
  const firstCycle = await getReferralDashboard("pre-anchor-inviter");
  assert.deepEqual(firstCycle.items.map((item) => item.id).sort(), [first.id, reserved.id].sort());
  assert.ok(firstCycle.items.every((item) => item.inCurrentCycle));
});

test("claim reconciles an on-time completed turn before reusing its expired reservation", async () => {
  const now = Date.now();
  const hour = 60 * 60_000;
  const inviter = "delayed-inviter";
  for (let index = 0; index < 4; index += 1) {
    await addReferral(inviter, `delayed-rewarded-${index}`, {
      status: "rewarded", quotaCycle: 0,
      claimedAt: new Date(now - 24 * hour), qualifiedAt: new Date(now - 23 * hour),
    });
  }
  const pending = await addReferral(inviter, "delayed-invitee", {
    status: "pending", quotaCycle: 0,
    claimedAt: new Date(now - 24 * hour), expiresAt: new Date(now - hour),
  });
  const completedAt = new Date(now - 2 * hour);
  await addCompletedTurn(pending.inviteeUserId, completedAt);
  await addProfile("delayed-next-invitee");
  const { code } = await ensureReferralCode(inviter);

  assert.equal((await claimReferral(code, user("delayed-next-invitee")))?.status, "capped");
  const dashboard = await getReferralDashboard(inviter);
  assert.equal(dashboard.quota.used, 5);
  assert.equal(dashboard.quota.reserved, 0);
  assert.equal(dashboard.quota.available, 0);
  assert.equal(dashboard.items.find((item) => item.id === pending.id)?.status, "qualified");
  assert.equal(dashboard.items.find((item) => item.id === pending.id)?.qualifiedAt, completedAt.toISOString());
});

test("confirmed expiry releases the slot and cannot be revived by a later backdated completion", async () => {
  const now = Date.now();
  const hour = 60 * 60_000;
  const referral = await addReferral("expired-inviter", "expired-invitee", {
    status: "pending", quotaCycle: 0,
    claimedAt: new Date(now - 24 * hour), expiresAt: new Date(now - hour),
  });
  await expireReferralClaims(referralsDb);
  assert.equal((await getReferralDashboard(referral.inviteeUserId)).received?.status, "expired");
  assert.equal((await getReferralDashboard(referral.inviterUserId)).quota.available, 5);
  await addProfile("expired-next-invitee");
  const { code } = await ensureReferralCode(referral.inviterUserId);
  assert.equal((await claimReferral(code, user("expired-next-invitee")))?.status, "pending");

  await addCompletedTurn(referral.inviteeUserId, new Date(now - 2 * hour));
  let grants = 0;
  const result = await qualifyAndRewardReferral({
    db: referralsDb,
    inviteeUserId: referral.inviteeUserId,
    billing: {
      status: { configured: true, provider: "talesofai" },
      grantReferralReward: async () => {
        grants += 1;
        assert.fail("Expired referrals must not grant rewards");
      },
    },
  });
  assert.equal(result?.status, "expired");
  assert.equal(grants, 0);
});

test("recovery skips automatic turns and keeps an on-time cross-cycle completion in its claim cycle", async () => {
  const now = Date.now();
  const hour = 60 * 60_000;
  const day = 24 * hour;
  const inviter = "recovery-cycle-inviter";
  await addReferral(inviter, "recovery-cycle-anchor", {
    status: "rewarded", quotaCycle: 0,
    claimedAt: new Date(now - 31 * day - hour), qualifiedAt: new Date(now - 31 * day),
  });
  const referral = await addReferral(inviter, "recovery-cycle-invitee", {
    status: "pending", quotaCycle: 0,
    claimedAt: new Date(now - 2 * day), expiresAt: new Date(now + day),
  });
  await addCompletedTurn(referral.inviteeUserId, new Date(now - 2 * hour), { context: { kind: "scheduled_task" } });
  const completedAt = new Date(now - hour);
  await addCompletedTurn(referral.inviteeUserId, completedAt);

  const result = await qualifyAndRewardReferral({ db: referralsDb, billing: disabledBilling, inviteeUserId: referral.inviteeUserId });
  assert.equal(result?.status, "qualified");
  assert.equal(result?.qualifiedAt?.toISOString(), completedAt.toISOString());
  assert.equal(result?.quotaCycle, 0);
  const dashboard = await getReferralDashboard(inviter);
  assert.equal(dashboard.quota.used, 0);
  assert.equal(dashboard.quota.available, 5);
  assert.equal(dashboard.items.find((item) => item.id === referral.id)?.inCurrentCycle, false);
});
