import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  hasArchivedSessionLabel,
  sessionArchiveFilter,
} from "../src/session-archive.js";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../drizzle/v2");
const viewer = "viewer";
const other = "other";
const spaceId = "00000000-0000-4000-8000-000000000100";
const archivedSessionId = "00000000-0000-4000-8000-000000000001";
const keptSessionId = "00000000-0000-4000-8000-000000000002";
const labelId = "00000000-0000-4000-8000-000000000900";

async function database() {
  const client = new PGlite({ extensions: { pg_trgm } });
  const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  for (const entry of journal.entries) {
    await client.exec(readFileSync(join(migrations, `${entry.tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  await client.query(
    `INSERT INTO v2.space_sessions (id, space_id, user_uuid, title) VALUES ($1, $2, $3, 'Archived'), ($4, $2, $3, 'Kept')`,
    [archivedSessionId, spaceId, viewer, keptSessionId],
  );
  await client.query(
    `INSERT INTO v2.labels (id, scope_type, scope_id, name, slug, source, system_key) VALUES ($1, 'user', $2, 'Archived', 'archived', 'system', 'user:archived')`,
    [labelId, viewer],
  );
  await client.query(
    `INSERT INTO v2.label_assignments (label_id, scope_type, scope_id, resource_type, resource_ref) VALUES ($1, 'user', $2, 'session', $3)`,
    [labelId, viewer, archivedSessionId],
  );
  return client;
}

async function listSessionIds(client: PGlite, viewerUuid: string, archived: boolean) {
  const filter = sessionArchiveFilter(viewerUuid, archived, sql`v2.space_sessions.id`);
  assert.ok(filter);
  const query = new PgDialect().sqlToQuery(sql`
    select id from v2.space_sessions
    where ${filter}
    order by id
  `);
  const { rows } = await client.query<{ id: string }>(query.sql, query.params);
  return rows.map((row) => row.id);
}

test("sessionArchiveFilter hides archived sessions from the default list", async () => {
  const client = await database();

  assert.deepEqual(await listSessionIds(client, viewer, false), [keptSessionId]);
  assert.deepEqual(await listSessionIds(client, viewer, true), [archivedSessionId]);
  assert.deepEqual(await listSessionIds(client, other, false), [archivedSessionId, keptSessionId]);
});

test("sessionArchiveFilter disappears for anonymous viewers", () => {
  assert.equal(sessionArchiveFilter(null, false, sql`v2.space_sessions.id`), undefined);
  assert.equal(sessionArchiveFilter("  ", true, sql`v2.space_sessions.id`), undefined);
});

test("hasArchivedSessionLabel matches only the viewer's own archive", async () => {
  const client = await database();
  const check = (viewerUuid: string, sessionId: string) => {
    const query = new PgDialect().sqlToQuery(sql`
      select ${hasArchivedSessionLabel(viewerUuid, sql`${sessionId}::uuid`)} as archived
    `);
    return client.query<{ archived: boolean }>(query.sql, query.params);
  };

  assert.equal((await check(viewer, archivedSessionId)).rows[0]?.archived, true);
  assert.equal((await check(viewer, keptSessionId)).rows[0]?.archived, false);
  assert.equal((await check(other, archivedSessionId)).rows[0]?.archived, false);
});
