import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "@cohub/db";
import { eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

process.env.LOG_LEVEL = "silent";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../drizzle/v2");
const client = new PGlite({ extensions: { pg_trgm } });
const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
for (const entry of journal.entries) {
  await client.exec(readFileSync(join(migrations, `${entry.tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
}
const db = drizzle(client, { schema });

mock.module("../src/db/index.js", { namedExports: { db } });
mock.module("../src/realtime-events.js", { namedExports: {
  dispatchTurnCreated: async () => {},
  dispatchSessionUpdated: async () => {},
  dispatchSessionCreated: async () => {},
  dispatchLabelAssignmentsUpdated: async () => {},
  messageRecordFromRow: (row: unknown) => row,
} });
mock.module("../src/session-output.js", { namedExports: {
  buildSessionOutputsForPersistedMessage: async () => [],
  dispatchSessionOutputs: async () => {},
  dispatchTurnFinalized: async () => {},
  dispatchTurnUpdated: async () => {},
} });
mock.module("../src/space-activity.js", { namedExports: { touchSpaceActivity: async () => {} } });
mock.module("../src/session-title-queue.js", { namedExports: { enqueueSessionTitleGeneration: async () => {} } });
mock.module("../src/session-message-postprocess-queue.js", { namedExports: { enqueueSessionMessagePostprocess: async () => {} } });
mock.module("../src/agent-turn-queue.js", { namedExports: { enqueueAgentSessionForkJob: async () => {} } });
mock.module("../src/agent-turn-abort.js", { namedExports: { requestAgentTurnAbort: async () => {} } });
mock.module("../src/space-sandboxes.js", { namedExports: { getSpaceSandboxBySpaceId: async () => null, updateSpaceSandbox: async () => null } });
mock.module("../src/user-profiles.js", { namedExports: { fallbackPublicUserProfile: () => null, getProfilesByUuids: async () => new Map() } });
mock.module("@cohub/core/labels/session-user", { namedExports: { assignSessionParticipantSystemLabels: async () => [] } });

const { createSessionTurn } = await import("../src/session-turns.js");
const { listSpaceTurns } = await import("../src/space-turns.js");
const { backfillSessionTurnSpaceIds } = await import("../src/db/backfill-session-turn-space-ids.js");

test("Space Turns carry their Space, backfill safely, and page by keyset", async () => {
  const [spaceA, spaceB] = [crypto.randomUUID(), crypto.randomUUID()];
  const [mine, theirs, elsewhere] = await db.insert(schema.spaceSessions).values([
    { spaceId: spaceA, userUuid: "me", meta: {} },
    { spaceId: spaceA, userUuid: "them", meta: {} },
    { spaceId: spaceB, userUuid: "me", meta: {} },
  ]).returning();
  assert.ok(mine && theirs && elsewhere);

  const created = await createSessionTurn({ sessionId: mine.id, userUuid: "me", userContent: [] });
  assert.equal((await db.select().from(schema.sessionTurns).where(eq(schema.sessionTurns.id, created.id)))[0]?.spaceId, spaceA);

  // Pre-migration Turns: no space_id, several sharing one timestamp so pages split inside a tie.
  const tie = new Date("2026-07-01T00:00:00Z");
  await db.insert(schema.sessionTurns).values([
    ...[1, 2, 3, 4].map((sequence) => ({ sessionId: theirs.id, userUuid: "them", sequence, status: "completed" as const, userContent: [], createdAt: tie })),
    { sessionId: mine.id, userUuid: "me", sequence: 2, status: "completed" as const, userContent: [], createdAt: tie },
    { sessionId: elsewhere.id, userUuid: "me", sequence: 1, status: "completed" as const, userContent: [], createdAt: tie },
  ]);
  const missing = async () => (await db.select().from(schema.sessionTurns).where(isNull(schema.sessionTurns.spaceId))).length;
  assert.equal(await missing(), 6);

  const dryRun = await backfillSessionTurnSpaceIds(db as never, { write: false, batchSize: 2 });
  assert.deepEqual([dryRun.updated, await missing()], [6, 6]);
  const written = await backfillSessionTurnSpaceIds(db as never, { write: true, batchSize: 2 });
  assert.deepEqual([written.updated, written.remaining], [6, 0]);
  assert.equal((await backfillSessionTurnSpaceIds(db as never, { write: true, batchSize: 2 })).updated, 0);
  const wrong = await db.execute(sql`SELECT count(*)::int AS count FROM v2.session_turns t JOIN v2.space_sessions s ON s.id = t.session_id WHERE t.space_id IS DISTINCT FROM s.space_id`);
  assert.equal([...wrong.rows][0]?.count, 0);

  const pages = async (input: Omit<Parameters<typeof listSpaceTurns>[0], "spaceId" | "userUuid">) => {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listSpaceTurns({ spaceId: spaceA, userUuid: "me", limit: 2, ...input, cursor });
      ids.push(...page.turns.map((turn) => turn.id));
      cursor = page.pageInfo.nextCursor;
    } while (cursor);
    return ids;
  };
  const expected = (await db.execute(sql`SELECT id FROM v2.session_turns WHERE space_id = ${spaceA}::uuid ORDER BY created_at DESC, id DESC`)).rows.map((row) => (row as { id: string }).id);
  assert.equal(expected.length, 6);
  assert.deepEqual(await pages({}), expected);
  assert.equal((await pages({ author: "others" })).length, 4);
  const onlyMine = await pages({ accessibleSessionIds: [mine.id] });
  assert.equal(onlyMine.length, 2);
  assert.deepEqual(onlyMine, await pages({ sessionId: mine.id }));

  const first = await listSpaceTurns({ spaceId: spaceA, userUuid: "me", limit: 2 });
  const newer = await createSessionTurn({ sessionId: theirs.id, userUuid: "them", userContent: [] });
  const caughtUp = await listSpaceTurns({ spaceId: spaceA, userUuid: "me", after: first.snapshotCursor, before: new Date(Date.now() + 1000).toISOString() });
  assert.deepEqual(caughtUp.turns.map((turn) => turn.id), [newer.id]);
});
