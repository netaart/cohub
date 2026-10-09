import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { sessionTurnSegments, sessionTurns, spaceSessions, taskRuns } from "@cohub/db";
import { refreshSessionStats } from "./stats.ts";
import { publishSessionSnapshot } from "./snapshot.ts";

// Same opt-in isolated engine convention as the runtime integration tests.
const home = process.env.RUNTIME_TEST_DB_HOME;
if (!home) throw new Error("Set RUNTIME_TEST_DB_HOME to an isolated @electric-sql/pglite installation");
const { PGlite } = await import(`${home}/node_modules/@electric-sql/pglite/dist/index.js`);
const { drizzle } = await import(`${home}/node_modules/drizzle-orm/pglite/index.js`);
const engine = new PGlite();
const db = drizzle(engine);
await engine.exec("create schema v2");
for (const table of [spaceSessions, sessionTurns, sessionTurnSegments, taskRuns]) {
  const config = getTableConfig(table);
  const columns = config.columns.map((column) => `"${column.name}" ${column.getSQLType()}${column.name === "id" ? " primary key default gen_random_uuid()" : column.name === "created_at" || column.name === "updated_at" ? " default now()" : ""}`);
  await engine.exec(`create table "${config.schema}"."${config.name}" (${columns.join(",")})`);
}
after(() => engine.close());
const spaceId = crypto.randomUUID();
async function session(meta = {}) {
  const [row] = await db.insert(spaceSessions).values({ spaceId, meta, title: "Keep title" }).returning();
  return row;
}
async function turn(sessionId, sequence, tokens, patch = {}) {
  const [row] = await db.insert(sessionTurns).values({ sessionId, sequence, intent: "steer", executionKind: "agent", status: "completed", totalUsage: { totalTokens: tokens, cost: { total: tokens / 1000 } }, durationMs: 1000, ...patch }).returning();
  return row;
}

test("rebuilds are idempotent and preserve unrelated metadata and session activity", async () => {
  const original = await session({ participants: { userUuids: ["u"] }, custom: { keep: true } });
  await turn(original.id, 1, 10);
  await turn(original.id, 2, 90, { status: "running" });
  const first = await refreshSessionStats(db, original.id);
  const second = await refreshSessionStats(db, original.id);
  assert.equal(second.stats.own.usage.totalTokens, 10);
  assert.equal(second.stats.own.turns, 1);
  assert.deepEqual(second.stats.own, first.stats.own);
  assert.equal(second.stats.revision, first.stats.revision + 1);
  assert.deepEqual(second.session.meta.participants, original.meta.participants);
  assert.deepEqual(second.session.meta.custom, { keep: true });
  assert.deepEqual(second.session.updatedAt, original.updatedAt);
  assert.equal(second.session.title, original.title);
});

test("fork aggregation respects segment bounds and does not duplicate overlapping ranges", async () => {
  const parent = await session();
  const child = await session({ fork: { version: 1 }, title: { generatedAt: "2000-01-01T00:00:00Z", usage: { title: { totalTokens: 999 } } } });
  await turn(parent.id, 1, 10);
  await turn(parent.id, 2, 20);
  await turn(parent.id, 3, 100);
  await turn(child.id, 3, 5);
  await db.insert(sessionTurnSegments).values([
    { sessionId: child.id, ordinal: 0, sourceSessionId: parent.id, fromSequence: 1, toSequence: 2 },
    { sessionId: child.id, ordinal: 1, sourceSessionId: parent.id, fromSequence: 2, toSequence: 2 },
    { sessionId: child.id, ordinal: 2, sourceSessionId: child.id, fromSequence: 3 },
  ]);
  const result = await refreshSessionStats(db, child.id);
  assert.equal(result.stats.own.usage.totalTokens, 5);
  assert.equal(result.stats.inherited.usage.totalTokens, 30);
  assert.equal(result.stats.inherited.turns, 2);
  assert.equal(result.stats.auxiliaryUsage, null, "copied parent title usage is not new consumption");
});

test("late usage corrections rebuild descendants and publish snapshots without leaking meta", async () => {
  const parent = await session({ privateCustom: "do not broadcast" });
  const child = await session();
  const row = await turn(parent.id, 1, 10);
  await db.insert(sessionTurnSegments).values({ sessionId: child.id, ordinal: 0, sourceSessionId: parent.id, fromSequence: 1, toSequence: 1 });
  await refreshSessionStats(db, child.id);
  await db.update(sessionTurns).set({ totalUsage: { totalTokens: 25 } }).where(eq(sessionTurns.id, row.id));
  const events = [];
  await publishSessionSnapshot(db, parent.id, async (event) => events.push(event), 1);
  assert.equal(events.length, 2);
  assert.equal(events.find((event) => event.sessionId === child.id).payload.session.stats.inherited.usage.totalTokens, 25);
  assert(events.every((event) => event.payload.session.meta === undefined));
  assert(events.every((event) => event.type === "session.updated" && event.payload.changed.includes("stats")));
});

test("compaction and title usage remain subsets or separate auxiliary operations", async () => {
  const original = await session({ title: { usage: { title: { totalTokens: 7 }, imageToText: { totalTokens: 3 } } } });
  await turn(original.id, 1, 20, { intent: "compact" });
  await turn(original.id, 2, 100, { intermediateSummary: { messageCount: 2, toolCallCount: 0, compaction: { count: 1, durationMsTotal: 300, usage: { totalTokens: 15 }, summarizedMessageCountTotal: 3, attemptCountTotal: 1, last: null } } });
  const { stats } = await refreshSessionStats(db, original.id);
  assert.equal(stats.own.turns, 1);
  assert.equal(stats.own.usage.totalTokens, 120);
  assert.equal(stats.own.compactions, 2);
  assert.equal(stats.own.compactionUsage.totalTokens, 35);
  assert.equal(stats.auxiliaryUsage.totalTokens, 10);
});

test("concurrent rebuilds serialize revisions and never multiply consumption", async () => {
  const original = await session();
  await turn(original.id, 1, 15);
  const results = await Promise.all(Array.from({ length: 4 }, () => refreshSessionStats(db, original.id)));
  assert.deepEqual(results.map((result) => result.stats.revision).sort(), [1, 2, 3, 4]);
  assert(results.every((result) => result.stats.own.usage.totalTokens === 15));
});

test("generation tasks are counted once without exposing private billing", async () => {
  const original = await session();
  const directId = crypto.randomUUID();
  const toolId = crypto.randomUUID();
  await turn(original.id, 1, 0, { executionKind: "direct_generation", meta: { generationTaskId: directId, generation: { officialCostUsd: 5, billing: { status: "skipped", reason: "record_failed", amountUsd: 4 } } } });
  await db.insert(taskRuns).values([
    { id: directId, sessionId: original.id, taskType: "generation", status: "completed", result: { cost: 5, billing: { status: "recorded", amountUsd: 4 } } },
    { id: toolId, sessionId: original.id, taskType: "generation", status: "completed", result: { cost: 3, billing: { status: "pending" } } },
    { sessionId: original.id, taskType: "generation.billing_retry", status: "completed", result: { taskRunId: toolId, status: "recorded", amountUsd: 2 } },
    { sessionId: original.id, taskType: "generation.billing_retry", status: "completed", result: { taskRunId: directId, status: "recorded", amountUsd: 4 } },
  ]);
  const { stats } = await refreshSessionStats(db, original.id);
  assert.equal(stats.own.turns, 1);
  assert.equal(stats.own.generations, 2);
  assert.equal(stats.own.chargedCostUsd, null);
  assert.equal(stats.own.generationCostUsd, 8);
});

test("deleted sessions return no projection", async () => {
  assert.equal(await refreshSessionStats(db, crypto.randomUUID()), null);
});
