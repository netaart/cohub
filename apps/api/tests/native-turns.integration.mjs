// RUNTIME_TEST_DB_HOME=/tmp/isolated-db node --experimental-test-module-mocks --import tsx --test apps/api/tests/native-turns.integration.mjs
import assert from "node:assert/strict";
import { test, mock, after } from "node:test";
import { and, eq, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { sessionTurns, sessionMessages, spaceSessions, sessionForks, sessionTurnSegments, labelAssignments } from "@cohub/db";

const home = process.env.RUNTIME_TEST_DB_HOME;
if (!home) throw new Error("RUNTIME_TEST_DB_HOME must point to an isolated PGlite installation");
const { PGlite } = await import(`${home}/node_modules/@electric-sql/pglite/dist/index.js`);
const { drizzle } = await import(`${home}/node_modules/drizzle-orm/pglite/index.js`);
const engine = new PGlite();
const database = drizzle(engine);
const dialect = new PgDialect();
await engine.exec("create schema v2");
for (const table of [sessionTurns, sessionMessages, spaceSessions, sessionForks, sessionTurnSegments, labelAssignments]) {
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
mock.module("../src/db/index.js", { exports: { db: database } });
mock.module("../src/reference-index-queue.js", { exports: { enqueueReferences: () => {} } });
mock.module("@cohub/core/labels/session-user", { exports: { assignSessionParticipantSystemLabels: async () => [] } });
mock.module("../src/lib/middleware.js", { exports: { useAuth: (c) => ({ uuid: c.req.header("x-user") ?? "owner" }), requireValidId: (id) => /^[a-f0-9-]{36}$/.test(id), authzDenied: (c) => c.json({ message: "forbidden" }, 403) } });
mock.module("../src/permissions.js", { exports: { hasPermission: async (user, _permission, context) => user.uuid !== "denied" && !(user.uuid === "no-session-access" && context?.sessionId) } });
mock.module("../src/space-sessions.js", { exports: { getSpaceSessionById: async (id) => (await database.select().from(spaceSessions).where(eq(spaceSessions.id, id)))[0] } });
mock.module("../src/realtime-events.js", { exports: { dispatchSessionCreated: async () => {}, dispatchSessionUpdated: async () => {}, dispatchTurnCreated: async () => {}, dispatchLabelAssignmentsUpdated: async () => {}, messageRecordFromRow: (row) => row } });
mock.module("../src/session-output.js", { exports: { dispatchTurnUpdated: async () => {}, dispatchTurnFinalized: async () => {}, dispatchSessionOutput: async () => {} } });
mock.module("../src/space-activity.js", { exports: { touchSpaceActivity: async () => {} } });
mock.module("../src/agent-turn-queue.js", { exports: { enqueueAgentTurnJob: async () => {} } });
mock.module("../src/session-message-postprocess-queue.js", { exports: { enqueueSessionMessagePostprocess: async () => {} } });
let failArtifacts = false;
mock.module("../src/session-turns.js", { exports: {
  getSessionTurnById: async (sessionId, id) => (await database.select().from(sessionTurns).where(and(eq(sessionTurns.id, id), eq(sessionTurns.sessionId, sessionId))))[0],
  hydrateTurnAuthorProfiles: async (turns) => turns,
  addUsage: (a, b) => a || b ? { input: (a?.input ?? 0) + (b?.input ?? 0), output: (a?.output ?? 0) + (b?.output ?? 0) } : null,
  buildIntermediateObjectsForTurn: async (_input, rows) => {
    if (failArtifacts) throw new Error("storage offline");
    return { index: null, summary: { messageCount: rows.length - 1, toolCallCount: 0, usage: null, durationMs: null, lastMessageText: null, hasError: false } };
  },
} });
const { startNativeTurn, completeNativeTurn, getOwnedNativeTurn } = await import("../src/native-turns.js");
after(() => engine.close());
const at = "2026-09-21T00:00:00.000Z";
const content = (text) => [{ type: "text", text }];
function start(overrides = {}) {
  return { turnId: crypto.randomUUID(), sessionId: null, parentTurnId: null, branchSessionId: crypto.randomUUID(), harness: "pi", nativeSessionId: "native-session", userContent: content("hello"), startedAt: at, ...overrides };
}
const result = { status: "completed", completedAt: at, messages: [{ content: content("answer"), provider: "native", model: "native-model", usage: { input: 7, output: 3 } }] };
async function root() {
  const spaceId = crypto.randomUUID(), request = start();
  const { binding } = await startNativeTurn(spaceId, "owner", request);
  await completeNativeTurn(spaceId, "owner", binding.sessionId, binding.turnId, result);
  return { spaceId, binding, request };
}

test("start and completion are idempotent; original IDs cannot be hijacked or changed", async () => {
  const spaceId = crypto.randomUUID(), input = start();
  const first = await startNativeTurn(spaceId, "owner", input);
  const replay = await startNativeTurn(spaceId, "owner", input);
  assert.deepEqual(first.binding, replay.binding);
  assert.equal(replay.created, false);
  await assert.rejects(startNativeTurn(spaceId, "other", input), /identity mismatch/);
  await assert.rejects(startNativeTurn(crypto.randomUUID(), "owner", input), /identity mismatch/);
  await assert.rejects(startNativeTurn(spaceId, "owner", { ...input, userContent: content("changed") }), /identity mismatch/);
  await completeNativeTurn(spaceId, "owner", first.binding.sessionId, input.turnId, result);
  await completeNativeTurn(spaceId, "owner", first.binding.sessionId, input.turnId, result);
  await assert.rejects(completeNativeTurn(spaceId, "owner", first.binding.sessionId, input.turnId, { ...result, messages: [{ content: content("overwrite") }] }), /immutable/);
  assert.equal((await database.select().from(sessionMessages).where(eq(sessionMessages.turnId, input.turnId))).length, 2);
  const turn = await getOwnedNativeTurn(spaceId, "owner", first.binding.sessionId, input.turnId);
  assert.equal(turn.status, "completed"); assert.equal(turn.meta.runtime, "local");
});

test("two native clients sharing a Turn fork only the competing execution, atomically", async () => {
  const { spaceId, binding } = await root();
  const left = start({ sessionId: binding.sessionId, parentTurnId: binding.turnId });
  const right = start({ sessionId: binding.sessionId, parentTurnId: binding.turnId });
  const [a, b] = await Promise.all([startNativeTurn(spaceId, "owner", left), startNativeTurn(spaceId, "owner", right)]);
  assert.equal(a.binding.sessionId, binding.sessionId);
  assert.equal(b.binding.sessionId, right.branchSessionId);
  assert.equal(b.binding.forked, true);
  const [fork] = await database.select().from(sessionForks).where(eq(sessionForks.childSessionId, b.binding.sessionId));
  assert.equal(fork.anchorTurnId, binding.turnId); assert.equal(fork.anchorSequence, 1);
  assert.equal((await database.select().from(sessionTurns).where(and(eq(sessionTurns.sessionId, binding.sessionId), eq(sessionTurns.status, "running")))).length, 1);
  assert.deepEqual((await startNativeTurn(spaceId, "owner", right)).binding, b.binding);
  assert.equal((await database.select().from(sessionForks).where(eq(sessionForks.childSessionId, b.binding.sessionId))).length, 1);
  const segments = await database.select().from(sessionTurnSegments).where(eq(sessionTurnSegments.sessionId, b.binding.sessionId));
  assert.equal(segments.length, 2); assert.equal(segments[0].toSequence, 1); assert.equal(segments[1].fromSequence, 2);
});

test("completed remote advancement also forks at the local Turn, without inheriting unseen results", async () => {
  const { spaceId, binding } = await root();
  const second = await startNativeTurn(spaceId, "owner", start({ sessionId: binding.sessionId, parentTurnId: binding.turnId }));
  await completeNativeTurn(spaceId, "owner", second.binding.sessionId, second.binding.turnId, result);
  const next = await startNativeTurn(spaceId, "owner", start({ sessionId: binding.sessionId, parentTurnId: binding.turnId }));
  assert.equal(next.binding.forked, true);
  const [fork] = await database.select().from(sessionForks).where(eq(sessionForks.childSessionId, next.binding.sessionId));
  assert.equal(fork.anchorTurnId, binding.turnId);
  const [turn] = await database.select().from(sessionTurns).where(eq(sessionTurns.id, next.binding.turnId));
  assert.equal(turn.sequence, 2);
});

test("only visible settled Turn anchors are accepted; no message-level or cross-space fork", async () => {
  const { spaceId, binding } = await root();
  const active = await startNativeTurn(spaceId, "owner", start({ sessionId: binding.sessionId, parentTurnId: binding.turnId }));
  await assert.rejects(startNativeTurn(spaceId, "owner", start({ sessionId: binding.sessionId, parentTurnId: active.binding.turnId })), /settled Turn/);
  await assert.rejects(startNativeTurn(crypto.randomUUID(), "owner", start({ sessionId: binding.sessionId, parentTurnId: binding.turnId })), /not found/);
  const other = await root();
  await assert.rejects(startNativeTurn(spaceId, "owner", start({ sessionId: binding.sessionId, parentTurnId: other.binding.turnId })), /settled Turn/);
  await assert.rejects(getOwnedNativeTurn(spaceId, "other", binding.sessionId, binding.turnId), /owner mismatch/);
});

test("object-storage failure never strands a running Turn; artifacts retry after terminal state", async () => {
  const spaceId = crypto.randomUUID(), input = start();
  const { binding } = await startNativeTurn(spaceId, "owner", input);
  failArtifacts = true;
  // Terminal state, messages and digest commit atomically; artifact failure reports artifactsPending.
  const first = await completeNativeTurn(spaceId, "owner", binding.sessionId, binding.turnId, result);
  assert.equal(first.completed, true);
  assert.equal(first.artifactsPending, true, "artifact failure must keep the receipt unacknowledged");
  let turn = await getOwnedNativeTurn(spaceId, "owner", binding.sessionId, binding.turnId);
  assert.equal(turn.status, "completed");
  assert(turn.meta.nativeSync.completionDigest, "digest persists with terminal state");
  assert.equal((await database.select().from(sessionMessages).where(eq(sessionMessages.turnId, binding.turnId))).length, 2);
  assert.equal(turn.intermediateIndex, null, "artifacts pending");
  failArtifacts = false;
  // Same completion replays idempotently and fills the missing artifacts.
  const replay = await completeNativeTurn(spaceId, "owner", binding.sessionId, binding.turnId, result);
  assert.equal(replay.artifactsPending, false, "artifacts recovered on replay");
  turn = await getOwnedNativeTurn(spaceId, "owner", binding.sessionId, binding.turnId);
  assert.deepEqual(turn.intermediateSummary.messageCount, 0, "artifact snapshot stored");
  assert.equal((await database.select().from(sessionMessages).where(eq(sessionMessages.turnId, binding.turnId))).length, 2, "no duplicate messages");
});

test("an aborted native Turn still submits its final interrupted result", async () => {
  const spaceId = crypto.randomUUID(), input = start();
  const { binding } = await startNativeTurn(spaceId, "owner", input);
  await database.update(sessionTurns).set({ status: "abort_requested" }).where(eq(sessionTurns.id, binding.turnId));
  const outcome = await completeNativeTurn(spaceId, "owner", binding.sessionId, binding.turnId, { ...result, status: "interrupted" });
  assert.equal(outcome.changed, true);
  const turn = await getOwnedNativeTurn(spaceId, "owner", binding.sessionId, binding.turnId);
  assert.equal(turn.status, "interrupted");
  assert.equal(turn.stopReason, "aborted");
});

test("confirmed stop is authoritative: late native results never replace it", async () => {
  const spaceId = crypto.randomUUID(), input = start();
  const { binding } = await startNativeTurn(spaceId, "owner", input);
  const turn = await getOwnedNativeTurn(spaceId, "owner", binding.sessionId, binding.turnId);
  await database.update(sessionTurns).set({ meta: { ...turn.meta, runtimeRecovery: { state: "confirmed_stopped", ownerUserId: "owner" } } }).where(eq(sessionTurns.id, binding.turnId));
  await assert.rejects(completeNativeTurn(spaceId, "owner", binding.sessionId, binding.turnId, result), /resolved/);
  assert.equal((await database.select().from(sessionMessages).where(eq(sessionMessages.turnId, binding.turnId))).length, 1);
});

test("session prompt permission gates native turns even with a space-level Runtime lease", async () => {
  const { spaceId, binding } = await root();
  await assert.rejects(startNativeTurn(spaceId, "no-session-access", start({ sessionId: binding.sessionId, parentTurnId: binding.turnId })), /No permission to prompt this Session/);
  await assert.rejects(startNativeTurn(spaceId, "denied", start({ sessionId: binding.sessionId, parentTurnId: binding.turnId })), /No permission to prompt this Session/);
  // Root sessions and fork targets remain open to any space Runtime owner: they are created by that owner.
  const fresh = await startNativeTurn(spaceId, "no-session-access", start());
  assert.equal(fresh.binding.forked, false);
});
