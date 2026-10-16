// RUNTIME_TEST_DB_HOME=/tmp/isolated-db node --experimental-test-module-mocks --import tsx --test apps/api/tests/session-fork-anchors.integration.mjs
import assert from "node:assert/strict";
import { test, mock, after } from "node:test";
import { eq, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { sessionTurns, sessionMessages, spaceSessions, sessionForks, sessionTurnSegments, labelAssignments, taskRuns } from "@cohub/db";

const home = process.env.RUNTIME_TEST_DB_HOME;
if (!home) throw new Error("RUNTIME_TEST_DB_HOME must point to an isolated PGlite installation");
const { PGlite } = await import(`${home}/node_modules/@electric-sql/pglite/dist/index.js`);
const { drizzle } = await import(`${home}/node_modules/drizzle-orm/pglite/index.js`);
const engine = new PGlite();
const database = drizzle(engine);
const dialect = new PgDialect();
await engine.exec("create schema v2");
for (const table of [sessionTurns, sessionMessages, spaceSessions, sessionForks, sessionTurnSegments, labelAssignments, taskRuns]) {
  const config = getTableConfig(table);
  const columns = config.columns.map((column) => {
    const value = column.default;
    const defaultSql = value instanceof SQL ? dialect.sqlToQuery(value).sql : value === undefined ? null : typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : String(value);
    return `"${column.name}" ${column.getSQLType()}${column.name === "id" ? " primary key" : ""}${defaultSql ? ` default ${defaultSql}` : ""}`;
  });
  await engine.exec(`create table v2."${config.name}" (${columns.join(",")})`);
}
await engine.exec(`create unique index turns_sequence on v2.session_turns(session_id, sequence);
create unique index messages_sequence on v2.session_messages(session_id, sequence);
create unique index segments_ordinal on v2.session_turn_segments(session_id, ordinal);
create unique index fork_child on v2.session_forks(child_session_id);`);
mock.module("../src/db/index.js", { namedExports: { db: database } });
mock.module("../src/reference-index-queue.js", { namedExports: { enqueueReferences: () => {} } });
mock.module("@cohub/core/labels/session-user", { namedExports: { assignSessionParticipantSystemLabels: async () => [] } });
mock.module("../src/realtime-events.js", { namedExports: { dispatchSessionCreated: async () => {} } });
const { createSessionForkInTransaction } = await import("../src/session-forks.js");
after(() => engine.close());
async function root() {
  const spaceId = crypto.randomUUID(), sessionId = crypto.randomUUID(), turnId = crypto.randomUUID();
  await database.insert(spaceSessions).values({ id: sessionId, spaceId, userUuid: "owner" });
  await database.insert(sessionTurns).values({ id: turnId, sessionId, sequence: 1, status: "completed", userContent: [], meta: { harness: "codex" } });
  return { spaceId, binding: { sessionId, turnId } };
}

test("Codex fork anchors must be executed and settled; rejection never creates a child", async () => {
  const { spaceId, binding } = await root();
  for (const status of ["queued", "running", "abort_requested", "merged", "cancelled"]) {
    await database.update(sessionTurns).set({ status, meta: { harness: "codex" } }).where(eq(sessionTurns.id, binding.turnId));
    const childSessionId = crypto.randomUUID();
    await assert.rejects(database.transaction((tx) => createSessionForkInTransaction(tx, { spaceId, parentSessionId: binding.sessionId, childSessionId, turnId: binding.turnId, createdBy: "owner" })), /Cannot fork/);
    assert.deepEqual(await database.select().from(spaceSessions).where(eq(spaceSessions.id, childSessionId)), []);
  }
  for (const status of ["completed", "failed", "interrupted"]) {
    await database.update(sessionTurns).set({ status, meta: { harness: "codex" } }).where(eq(sessionTurns.id, binding.turnId));
    const childSessionId = crypto.randomUUID();
    const fork = await database.transaction((tx) => createSessionForkInTransaction(tx, { spaceId, parentSessionId: binding.sessionId, childSessionId, turnId: binding.turnId, createdBy: "owner" }));
    assert.equal(fork.session.id, childSessionId);
    assert.equal(fork.fork.anchorSourceSessionId, binding.sessionId);
    assert.equal(fork.fork.anchorTurnId, binding.turnId);
    const nestedId = crypto.randomUUID();
    const nested = await database.transaction((tx) => createSessionForkInTransaction(tx, { spaceId, parentSessionId: childSessionId, childSessionId: nestedId, turnId: binding.turnId, createdBy: "owner" }));
    assert.equal(nested.fork.parentSessionId, childSessionId);
    assert.equal(nested.fork.anchorSourceSessionId, binding.sessionId);
    assert.equal(nested.fork.rootSessionId, binding.sessionId);
    assert.equal(nested.fork.depth, 2);
    const segments = await database.select().from(sessionTurnSegments).where(eq(sessionTurnSegments.sessionId, nestedId));
    assert.deepEqual(segments.map((segment) => [segment.sourceSessionId, segment.fromSequence, segment.toSequence]), [[binding.sessionId, 1, 1], [nestedId, 2, null]]);
  }
});
