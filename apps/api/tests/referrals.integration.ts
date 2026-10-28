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

const { claimReferral, ensureReferralCode, getReferralDashboard, isReferralRewardAvailable } = await import("../src/referrals.js");

const user = (uuid: string) => ({ uuid }) as Parameters<typeof claimReferral>[1];
const addProfile = (uuid: string, createdAt = new Date()) =>
  client.query(
    `INSERT INTO v2.user_profiles (user_uuid, logto_user_id, display_name, source, created_at) VALUES ($1, $1, $1, '{}', $2)`,
    [uuid, createdAt],
  );

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
  assert.equal(await isReferralRewardAvailable("inviter"), true);

  const dashboard = await getReferralDashboard("inviter");
  assert.deepEqual(
    { used: dashboard.quota.used, reserved: dashboard.quota.reserved, available: dashboard.quota.available },
    { used: 0, reserved: 4, available: 1 },
  );
  assert.equal(dashboard.items.find((item) => item.profile?.userUuid === firstInvitee)?.status, "expired");
  assert.equal(dashboard.items.filter((item) => item.status === "capped").length, 2);
  assert.ok(dashboard.items.filter((item) => item.status === "pending").every((item) => item.expiresAt));
  assert.ok(dashboard.items.every((item) => item.inCurrentCycle));
  assert.equal((await getReferralDashboard(firstInvitee)).received?.status, "expired");
});
