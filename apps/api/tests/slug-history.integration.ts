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

process.env.LOG_LEVEL = "silent";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../drizzle/v2");
const client = new PGlite({ extensions: { pg_trgm } });
const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
for (const entry of journal.entries) {
  await client.exec(readFileSync(join(migrations, `${entry.tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
}
const db = drizzle(client, { schema });

const logtoUsers = new Map<string, Record<string, unknown>>();
let failLogtoUpdate = false;
mock.module("../src/db/index.js", { namedExports: { db } });
mock.module("../src/logto-management.js", {
  namedExports: {
    getLogtoUser: async (id: string) => ({ ...logtoUsers.get(id) }),
    updateLogtoUserProfile: async (id: string, input: { username?: string | null }) => {
      if (failLogtoUpdate) throw new Error("Logto management request failed: 500");
      const user = logtoUsers.get(id) ?? {};
      if (input.username !== undefined) user.username = input.username;
      logtoUsers.set(id, user);
    },
  },
});

const { recordSpaceSlugChange, resolveOwnerByUsername, resolvePublicSpace } = await import("../src/slug-history.js");
const { updateCurrentUserProfile, UsernameChangeTooSoonError } = await import("../src/user-profiles.js");

async function createUser(uuid: string, username: string) {
  logtoUsers.set(`logto-${uuid}`, { id: `logto-${uuid}`, username, name: uuid });
  await client.query(
    `INSERT INTO v2.user_profiles (user_uuid, logto_user_id, username, display_name, source) VALUES ($1, $2, $3, $1, '{}')`,
    [uuid, `logto-${uuid}`, username],
  );
  return { uuid, sub: `logto-${uuid}` } as Parameters<typeof updateCurrentUserProfile>[0];
}

async function createSpace(userUuid: string, slug: string) {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO v2.spaces (user_uuid, name, slug) VALUES ($1, gen_random_uuid()::text, $2) RETURNING id`,
    [userUuid, slug],
  );
  const id = rows[0]?.id;
  assert.ok(id);
  return id;
}

const renameSpace = (id: string, userUuid: string, from: string, to: string) => db.transaction(async (tx) => {
  await recordSpaceSlugChange(tx, { id, userUuid }, from);
  await tx.update(schema.spaces).set({ slug: to }).where(eq(schema.spaces.id, id));
});

const historyCount = async (entityId: string) =>
  (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM v2.slug_history WHERE entity_id = $1`, [entityId])).rows[0]?.n;

const backdateHistory = (entityId: string) =>
  client.query(`UPDATE v2.slug_history SET created_at = now() - interval '8 days' WHERE entity_id = $1`, [entityId]);

test("username renames redirect, are rate limited, and old names stay claimable", async () => {
  const alice = await createUser("alice-uuid", "alice");
  await createUser("bob-uuid", "bob");

  await updateCurrentUserProfile(alice, { username: "alice2" });
  assert.equal(await historyCount("alice-uuid"), 1);

  await assert.rejects(updateCurrentUserProfile(alice, { username: "alice3" }), (error) => {
    assert.ok(error instanceof UsernameChangeTooSoonError);
    assert.ok(error.nextAllowedAt.getTime() > Date.now());
    return true;
  });
  assert.equal(await historyCount("alice-uuid"), 1);

  await backdateHistory("alice-uuid");
  await updateCurrentUserProfile(alice, { username: "alice3" });
  assert.equal(await historyCount("alice-uuid"), 2);

  for (const old of ["alice", "alice2", "alice3"]) {
    const owner = await resolveOwnerByUsername(old);
    assert.equal(owner?.profile.username, "alice3");
    assert.equal(owner?.redirected, old !== "alice3");
  }

  // Anyone may claim an old name; the live holder wins over history.
  const bob = { uuid: "bob-uuid", sub: "logto-bob-uuid" } as typeof alice;
  await updateCurrentUserProfile(bob, { username: "alice" });
  const claimed = await resolveOwnerByUsername("alice");
  assert.equal(claimed?.profile.userUuid, "bob-uuid");
  assert.equal(claimed?.redirected, false);

  // Two history rows for "alice": the latest holder to give it up wins.
  await backdateHistory("bob-uuid");
  await updateCurrentUserProfile(bob, { username: "bobby" });
  const latest = await resolveOwnerByUsername("alice");
  assert.equal(latest?.profile.username, "bobby");
  assert.equal(latest?.redirected, true);
});

test("a failed Logto write leaves no history row", async () => {
  const carol = await createUser("carol-uuid", "carol");
  failLogtoUpdate = true;
  await assert.rejects(updateCurrentUserProfile(carol, { username: "carol2" }));
  failLogtoUpdate = false;
  assert.equal(await historyCount("carol-uuid"), 0);
});

test("public Space paths resolve old username and slug in one step", async () => {
  await createUser("dan-uuid", "dan");
  await createUser("erin-uuid", "erin");
  const danSpace = await createSpace("dan-uuid", "notes");
  const erinSpace = await createSpace("erin-uuid", "notes");

  await renameSpace(danSpace, "dan-uuid", "notes", "notes-v2");
  await renameSpace(danSpace, "dan-uuid", "notes-v2", "journal");
  await client.query(`INSERT INTO v2.slug_history (entity_type, entity_id, old_slug) VALUES ('username', 'dan-uuid', 'danny')`);

  for (const slug of ["notes", "notes-v2"]) {
    const resolved = await resolvePublicSpace("danny", slug);
    assert.equal(resolved?.space.id, danSpace);
    assert.equal(resolved?.space.slug, "journal");
    assert.equal(resolved?.owner.username, "dan");
    assert.equal(resolved?.redirected, true);
  }
  assert.equal((await resolvePublicSpace("dan", "journal"))?.redirected, false);

  // Another owner's identical slug is unaffected.
  const erin = await resolvePublicSpace("erin", "notes");
  assert.equal(erin?.space.id, erinSpace);
  assert.equal(erin?.redirected, false);

  // The owner can reuse an old slug; the live Space wins, then the latest holder.
  const reused = await createSpace("dan-uuid", "notes");
  const live = await resolvePublicSpace("dan", "notes");
  assert.equal(live?.space.id, reused);
  assert.equal(live?.redirected, false);
  await renameSpace(reused, "dan-uuid", "notes", "diary");
  assert.equal((await resolvePublicSpace("dan", "notes"))?.space.slug, "diary");

  // A deleted latest holder 404s rather than falling back to an older one.
  await client.query(`DELETE FROM v2.spaces WHERE id = $1`, [reused]);
  assert.equal(await resolvePublicSpace("dan", "notes"), null);
  assert.equal((await resolvePublicSpace("dan", "notes-v2"))?.space.id, danSpace);
});

test("the old Home address follows the latest former Home", async () => {
  await createUser("fay-uuid", "fay");

  const homeHistory = async () =>
    (await client.query<{ entity_id: string }>(
      `SELECT entity_id FROM v2.slug_history WHERE owner_uuid = 'fay-uuid' AND old_slug = 'home' ORDER BY created_at`,
    )).rows.map((row) => row.entity_id);

  const first = await createSpace("fay-uuid", "home");
  await renameSpace(first, "fay-uuid", "home", "first");
  assert.deepEqual(await homeHistory(), [first]);
  const redirected = await resolvePublicSpace("fay", "home");
  assert.equal(redirected?.space.id, first);
  assert.equal(redirected?.redirected, true);

  // ensureHome re-creates the system slug; the live Home wins over history.
  const second = await createSpace("fay-uuid", "home");
  const live = await resolvePublicSpace("fay", "home");
  assert.equal(live?.space.id, second);
  assert.equal(live?.redirected, false);

  await renameSpace(second, "fay-uuid", "home", "second");
  assert.deepEqual(await homeHistory(), [first, second]);
  assert.equal((await resolvePublicSpace("fay", "home"))?.space.id, second);
});
