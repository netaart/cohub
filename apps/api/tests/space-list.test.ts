import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildLegacySpaceListQuery, compareLegacySpaceRows, type SpaceListRow } from "../src/space-list.js";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../drizzle/v2");
const viewer = "viewer";
const other = "other";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function database() {
  const client = new PGlite({ extensions: { pg_trgm } });
  const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  for (const entry of journal.entries) {
    await client.exec(readFileSync(join(migrations, `${entry.tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  return client;
}

async function addSpace(client: PGlite, input: { id: string; owner: string; name: string; activityAt?: string; member?: { joinedAt: string } }) {
  await client.query(
    `INSERT INTO v2.spaces (id, user_uuid, name, last_activity_at, created_at) VALUES ($1, $2, $3, $4, '2026-01-01T00:00:00Z')`,
    [input.id, input.owner, input.name, input.activityAt ?? null],
  );
  if (input.member) {
    await client.query(
      `INSERT INTO v2.space_members (space_id, user_id, role, created_by, updated_by, created_at) VALUES ($1, $2, 'builder', $3, $3, $4)`,
      [input.id, viewer, input.owner, input.member.joinedAt],
    );
  }
}

async function archive(client: PGlite, spaceId: string) {
  const labelId = id(9000);
  await client.query(
    `INSERT INTO v2.labels (id, scope_type, scope_id, name, slug, source, system_key) VALUES ($1, 'user', $2, 'Archived', 'archived', 'system', 'user:archived') ON CONFLICT DO NOTHING`,
    [labelId, viewer],
  );
  await client.query(
    `INSERT INTO v2.label_assignments (label_id, scope_type, scope_id, resource_type, resource_ref) VALUES ($1, 'user', $2, 'space', $3)`,
    [labelId, viewer, spaceId],
  );
}

async function legacyList(client: PGlite) {
  const query = new PgDialect().sqlToQuery(buildLegacySpaceListQuery(viewer));
  const { rows } = await client.query<SpaceListRow>(query.sql, query.params);
  return rows.sort(compareLegacySpaceRows);
}

test("the legacy Space list keeps every membership, archived ones included, latest activity first", async () => {
  const client = await database();
  await addSpace(client, { id: id(1), owner: viewer, name: "Quiet", member: { joinedAt: "2026-02-01T00:00:00Z" } });
  await addSpace(client, { id: id(2), owner: other, name: "Busy", activityAt: "2026-03-02T00:00:00Z", member: { joinedAt: "2026-02-02T00:00:00Z" } });
  await addSpace(client, { id: id(3), owner: other, name: "Shelved", activityAt: "2026-03-01T00:00:00Z", member: { joinedAt: "2026-02-03T00:00:00Z" } });
  await addSpace(client, { id: id(4), owner: other, name: "Stranger", activityAt: "2026-03-03T00:00:00Z" });
  await archive(client, id(3));

  const rows = await legacyList(client);

  assert.deepEqual(rows.map((row) => row.name), ["Busy", "Shelved", "Quiet"]);
  assert.deepEqual(rows.map((row) => row.is_archived), [false, true, false]);
});
