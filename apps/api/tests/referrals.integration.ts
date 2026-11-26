import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "@cohub/db";
import { drizzle } from "drizzle-orm/pglite";

process.env.LOG_LEVEL = "silent";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../drizzle/v2");
const client = new PGlite({ extensions: { pg_trgm } });
const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
for (const entry of journal.entries) {
  await client.exec(readFileSync(join(migrations, `${entry.tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
}

mock.module("../src/db/index.js", { namedExports: { db: drizzle(client, { schema }) } });
mock.module("../src/user-profiles.js", { namedExports: { ensureCurrentUserProfile: async () => null } });

const { claimReferral, ensureReferralCode, getReferralDashboard, qualifyReferralPayment } = await import("../src/referrals.js");

const DAY_MS = 24 * 60 * 60_000;
const user = (uuid: string) => ({ uuid }) as Parameters<typeof claimReferral>[1];
const addProfile = (uuid: string, createdAt = new Date()) =>
  client.query(
    `INSERT INTO v2.user_profiles (user_uuid, logto_user_id, display_name, source, created_at) VALUES ($1, $1, $1, '{}', $2)`,
    [uuid, createdAt],
  );
const invite = async (inviter: string, count: number) => {
  const { code } = await ensureReferralCode(inviter);
  await addProfile(inviter);
  const invitees = Array.from({ length: count }, (_, index) => `${inviter}-invitee-${index}`);
  for (const invitee of invitees) await addProfile(invitee);
  const results = await Promise.all(invitees.map((invitee) => claimReferral(code, user(invitee))));
  return { code, invitees, results };
};
const statusOf = async (invitee: string) =>
  (await getReferralDashboard(invitee)).received?.status;

test("claims stay open for the payment window", async () => {
  const { code, invitees, results } = await invite("claims", 7);

  await addProfile("old", new Date(Date.now() - 2 * DAY_MS));
  assert.equal((await claimReferral(code, user("old")))?.status, "existing_user");
  assert.equal((await claimReferral(code, user("claims")))?.status, "self");

  assert.ok(results.every((result) => result?.status === "pending" && result.created));
  const [first] = invitees;
  assert.deepEqual(await claimReferral(code, user(first ?? "")), { referralId: results[0]?.referralId, status: "pending" });

  const dashboard = await getReferralDashboard("claims");
  assert.equal(dashboard.summary.pending, 7);
  for (const item of dashboard.items) {
    const windowMs = new Date(item.expiresAt ?? 0).getTime() - new Date(item.claimedAt).getTime();
    assert.equal(windowMs, 30 * DAY_MS);
  }
});

test("every first payment qualifies and redeliveries are no-ops", async () => {
  const { invitees } = await invite("payments", 7);
  const paidAt = new Date();

  await Promise.all(invitees.map((invitee) => qualifyReferralPayment({ userId: invitee, paidAt })));
  const redeliveredAt = new Date(paidAt.getTime() + 1000);
  await Promise.all(invitees.map((invitee) => qualifyReferralPayment({ userId: invitee, paidAt: redeliveredAt })));

  const dashboard = await getReferralDashboard("payments");
  assert.deepEqual(dashboard.summary, { total: 7, pending: 0, qualified: 7, rewarded: 0, earnedUsd: 0 });
  assert.deepEqual(new Set(dashboard.items.map((item) => item.qualifiedAt)), new Set([paidAt.toISOString()]));
});

test("only payments made between claiming and the deadline qualify", async () => {
  const { invitees } = await invite("window", 3);
  const [early = "", late = "", delayed = ""] = invitees;
  const now = Date.now();

  await qualifyReferralPayment({ userId: early, paidAt: new Date(now - DAY_MS) });
  assert.equal(await statusOf(early), "pending");

  await client.query(
    `UPDATE v2.referrals SET status = 'expired', claimed_at = $2, expires_at = $3 WHERE invitee_user_id = ANY($1)`,
    [[late, delayed], new Date(now - DAY_MS), new Date(now - 60_000)],
  );
  await qualifyReferralPayment({ userId: late, paidAt: new Date(now) });
  assert.equal(await statusOf(late), "expired");

  // A delivery retried after the deadline still counts the payment made before it.
  await qualifyReferralPayment({ userId: delayed, paidAt: new Date(now - 2 * 60_000) });
  assert.equal(await statusOf(delayed), "qualified");
});
