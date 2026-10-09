import assert from "node:assert/strict";
import { mock, test, after } from "node:test";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { is, eq, asc } from "drizzle-orm";
import * as schema from "@cohub/db";

// Opt-in isolated engine; no production DB or test dependency is required by the app.
const home = process.env.RUNTIME_TEST_DB_HOME;
if (!home) throw new Error("Set RUNTIME_TEST_DB_HOME to an isolated installation of @electric-sql/pglite and drizzle-orm");
const { PGlite } = await import(`${home}/node_modules/@electric-sql/pglite/dist/index.js`);
const { drizzle } = await import(`${home}/node_modules/drizzle-orm/pglite/index.js`);
const engine = new PGlite();
const database = drizzle(engine);
await engine.exec("create schema v2");
for (const table of Object.values(schema).filter((table) => is(table, PgTable))) {
  const config = getTableConfig(table);
  const columns = config.columns.map((column) => `"${column.name}" ${column.getSQLType()}${column.name === "id" && column.getSQLType() === "uuid" ? " primary key default gen_random_uuid()" : column.name === "created_at" || column.name === "updated_at" ? " default now()" : ""}`);
  await engine.exec(`create table if not exists "${config.schema}"."${config.name}" (${columns.join(",")})`);
}
await engine.exec("create unique index test_message_idempotency on v2.session_messages(session_id,idempotency_key)");
let queueUnavailable = false;
let gatewayUnavailable = false;
let rejectFinalUpdate = false;
let beforeFinalUpdate;
const wakes = [], processed = [], publications = [], gatewayCommands = [];
let gatewayTargets = [];
const db = new Proxy(database, { get(target, key) {
  if (key === "transaction") return (callback) => target.transaction((tx) => callback(new Proxy(tx, { get(transaction, method) {
    if (method === "execute") return async (query) => (await transaction.execute(query)).rows;
    if (method === "update") return (table) => {
      if (table === schema.sessionTurns) {
        beforeFinalUpdate?.();
        if (rejectFinalUpdate) throw new Error("injected failure between message insert and terminal update");
      }
      return transaction.update(table);
    };
    const value = transaction[method]; return typeof value === "function" ? value.bind(transaction) : value;
  } })));
  const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
} });
mock.module("../db.js", { exports: { db } });
mock.module("../env.js", { exports: { env: { ENV: "test", AGENT_STALE_ACTIVE_TURN_MS: 60_000 } } });
mock.module("../logger.js", { exports: { logger: { warn() {}, error() {}, debug() {} } } });
mock.module("../redis.js", { exports: {
  redis: { hget: async () => "gateway-node" }, publishRealtimeEnvelope: async (event) => { publications.push(event); }, clearPersistedSessionStreamSnapshot: async () => {}, getGatewayNodeOutboundStreamKey: () => "test",
  xaddWithMaxlen: async (_redis, _key, ...args) => { if (gatewayUnavailable) throw new Error("gateway unavailable"); gatewayCommands.push(JSON.parse(args.at(-1))); },
} });
mock.module("../queue.js", { exports: { agentTurnQueue: { add: async () => {} }, enqueueAgentTurnJob: async (job) => { if (queueUnavailable) throw new Error("queue unavailable"); wakes.push(job); } } });
mock.module("../session-message-postprocess-queue.js", { exports: { enqueueSessionMessagePostprocess: async (job) => { if (queueUnavailable) throw new Error("queue unavailable"); processed.push(job); } } });
mock.module("../session-title-queue.js", { exports: { enqueueSessionTitleGeneration: async () => {} } });
mock.module("../reference-index.js", { exports: { indexTurnReferences: () => {} } });
mock.module("../turn-object-storage.js", { exports: { buildTurnObjectPrefix: () => "test/", writeTurnObjectJson: async () => ({ sizeBytes: 0 }) } });
mock.module("../session-lock.js", { exports: { acquireSessionLock: async () => null } });
mock.module("../runtime/remote-runtime.js", { exports: { executeRemoteHarnessTurn: async () => {}, markRuntimeRecovery: async () => {} } });
const { persistAssistantMessage, persistBatchUserMessages, persistUserMessage } = await import("../persistence.js");
const { claimNextTurnBatch, loadClaimedTurnBatch, resolveBatchAccessMode } = await import("../batch.js");
const { createRuntimeContextReader } = await import("../runtime/context-reader.js");
const { scheduleSessionSnapshot } = await import("../session-snapshot.js");
after(async () => { await scheduleSessionSnapshot.flush(); await engine.close(); });

async function setup(resolution = false, channels = 0) {
  const spaceId = crypto.randomUUID(), sessionId = crypto.randomUUID(), turnId = crypto.randomUUID(), userMessageId = crypto.randomUUID();
  await database.insert(schema.spaceSessions).values({ id: sessionId, spaceId, meta: {} });
  await database.insert(schema.sessionTurns).values({ id: turnId, sessionId, sequence: 1, status: "running", executionKind: "agent", intent: "followup", userContent: [{ type: "text", text: "input" }], meta: { harness: "pi", ...(resolution ? { runtimeRecovery: { state: "confirmed_stopped" } } : {}) } });
  await database.insert(schema.sessionMessages).values({ id: userMessageId, sessionId, turnId, sequence: 1, role: "user", content: [{ type: "text", text: "input" }], meta: {} });
  gatewayTargets = [];
  for (let index = 0; index < channels; index++) {
    const target = { spaceChannelId: crypto.randomUUID(), provider: "discord", externalChatId: `chat-${index}`, bindingKey: `binding-${index}` };
    gatewayTargets.push(target);
    await database.insert(schema.spaceSessionBindings).values({ id: crypto.randomUUID(), spaceId, spaceSessionId: sessionId, ...target });
  }
  return { spaceId, sessionId, turnId, userMessageId };
}
const finish = (identity, resolution = false) => persistAssistantMessage({ ...identity, spaceSessionId: identity.sessionId, idempotencyKey: `final:${identity.turnId}`, messageOrdinal: 0,
  event: { message: { role: "assistant", content: [{ type: "text", text: "durable result" }], stopReason: resolution ? "aborted" : "stop", meta: { runtime: "local", messageKind: "assistant_final", ...(resolution ? { runtimeResolution: true } : {}) } } },
});
const readTurn = async (id) => (await database.select().from(schema.sessionTurns).where(eq(schema.sessionTurns.id, id)))[0];

for (const harness of ["cohub", "pi", "codex"]) test(`mixed follow-ups use the last ${harness} owner, preserve inputs and recover the original claim`, async () => {
  const sessionId = crypto.randomUUID(), spaceId = crypto.randomUUID();
  await database.insert(schema.spaceSessions).values({ id: sessionId, spaceId });
  const turns = ["cohub", "pi", harness].map((requested, index) => ({
    id: crypto.randomUUID(), sessionId, sequence: index + 1, executionKind: "agent", intent: "followup", status: "queued",
    userUuid: `actor-${index}`, userContent: [{ type: "text", text: `message-${index}` }],
    meta: { userId: `actor-${index}`, harness: requested, userMessageId: crypto.randomUUID(), model: `model-${index}` },
  }));
  await database.insert(schema.sessionTurns).values(turns);
  const claim = await claimNextTurnBatch({ sessionId });
  assert.equal(claim.kind, "claimed");
  const { batch } = claim;
  const owner = turns.at(-1);
  assert.equal(batch.ownerTurn.id, owner.id);
  assert.equal(batch.ownerTurn.meta.harness, harness);
  assert.equal(batch.ownerTurn.meta.model, "model-2");
  assert.equal(resolveBatchAccessMode(batch), "full_access");
  assert.equal(resolveBatchAccessMode({ turns: [{ meta: { accessMode: "read_only" } }, ...batch.turns] }), "read_only");
  assert.deepEqual(batch.executionBatch.turnIds, turns.map((turn) => turn.id));
  assert.deepEqual(batch.executionBatch.userMessageIds, turns.map((turn) => turn.meta.userMessageId));
  assert.equal(batch.executionBatch.anchorUserMessageId, owner.meta.userMessageId);
  assert.deepEqual((await database.select().from(schema.sessionTurns).where(eq(schema.sessionTurns.sessionId, sessionId)).orderBy(asc(schema.sessionTurns.sequence))).map((row) => row.status), ["merged", "merged", "running"]);
  // A crash can leave only a prefix persisted; claim metadata has changed since submission.
  await persistUserMessage({ spaceId, sessionId, turnId: turns[0].id, userMessageId: turns[0].meta.userMessageId, content: turns[0].userContent, meta: turns[0].meta });
  await persistBatchUserMessages({ spaceId, sessionId, batch });
  const newer = { ...turns[0], id: crypto.randomUUID(), sequence: 4, meta: { ...turns[0].meta, userMessageId: crypto.randomUUID() } };
  await database.insert(schema.sessionTurns).values(newer);
  const storedOwner = await readTurn(owner.id);
  const recovered = await loadClaimedTurnBatch(storedOwner);
  assert.deepEqual(recovered.executionBatch, batch.executionBatch);
  await assert.rejects(() => loadClaimedTurnBatch({ ...storedOwner, meta: { ...storedOwner.meta, executionBatch: { ownerTurnId: owner.id, turnIds: [newer.id, owner.id] } } }), /history mismatch/);
  await assert.rejects(() => loadClaimedTurnBatch({ ...storedOwner, meta: { ...storedOwner.meta, executionBatch: { ownerTurnId: owner.id, turnIds: [owner.id, owner.id] } } }), /Invalid execution batch/);
  await persistBatchUserMessages({ spaceId, sessionId, batch: recovered });
  const users = await database.select().from(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, sessionId)).orderBy(asc(schema.sessionMessages.sequence));
  assert.deepEqual(users.map((row) => [row.id, row.turnId, row.meta.actorUserId, row.content]), turns.map((turn) => [turn.meta.userMessageId, turn.id, turn.userUuid, turn.userContent]));
  const load = createRuntimeContextReader(database);
  assert.equal((await load({ spaceId, sessionId, beforeSequence: recovered.turns[0].sequence })).messages.length, 0, "current batch must not re-enter historical context");
  if (harness !== "cohub") {
    await database.update(schema.sessionTurns).set({ updatedAt: new Date(0) }).where(eq(schema.sessionTurns.id, owner.id));
    assert.equal((await claimNextTurnBatch({ sessionId })).kind, "busy", "uncertain Local execution never gives way to the next harness");
  }
  await database.update(schema.sessionTurns).set({ status: "completed" }).where(eq(schema.sessionTurns.id, owner.id));
  const next = await claimNextTurnBatch({ sessionId });
  assert.equal(next.batch.ownerTurn.id, newer.id);
  assert.equal(next.batch.turns.length, 1);
  const history = await load({ spaceId, sessionId, beforeSequence: newer.sequence });
  assert.deepEqual(history.messages.map((message) => message.id), turns.map((turn) => turn.meta.userMessageId));
});

test("steer remains single and direct generation remains a claim barrier", async () => {
  const sessionId = crypto.randomUUID(), spaceId = crypto.randomUUID();
  await database.insert(schema.spaceSessions).values({ id: sessionId, spaceId });
  const turns = ["followup", "steer", "followup", "followup"].map((intent, index) => ({
    id: crypto.randomUUID(), sessionId, sequence: index + 1, executionKind: index === 2 ? "direct_generation" : "agent", intent, status: "queued", userContent: [], meta: {},
  }));
  await database.insert(schema.sessionTurns).values(turns);
  const steer = await claimNextTurnBatch({ sessionId });
  assert.equal(steer.batch.ownerTurn.id, turns[1].id); assert.equal(steer.batch.turns.length, 1);
  await database.update(schema.sessionTurns).set({ status: "completed" }).where(eq(schema.sessionTurns.id, turns[1].id));
  const earlier = await claimNextTurnBatch({ sessionId });
  assert.equal(earlier.batch.ownerTurn.id, turns[0].id); assert.equal(earlier.batch.turns.length, 1);
  await database.update(schema.sessionTurns).set({ status: "completed" }).where(eq(schema.sessionTurns.id, turns[0].id));
  assert.equal((await claimNextTurnBatch({ sessionId })).kind, "noop");
  await database.update(schema.sessionTurns).set({ status: "completed" }).where(eq(schema.sessionTurns.id, turns[2].id));
  assert.equal((await claimNextTurnBatch({ sessionId })).batch.ownerTurn.id, turns[3].id);
});

test("resolution lookup stays bounded and validates Session and execution boundary", async () => {
  const identity = await setup();
  await database.update(schema.sessionTurns).set({ status: "completed" }).where(eq(schema.sessionTurns.id, identity.turnId));
  const history = Array.from({ length: 300 }, (_, index) => ({ id: crypto.randomUUID(), sessionId: identity.sessionId, sequence: index + 2, status: "interrupted", executionKind: "agent", userContent: [], meta: { harness: "pi", runtimeRecovery: { state: "confirmed_stopped" } } }));
  await database.insert(schema.sessionTurns).values(history);
  const foreign = await setup(true);
  const load = createRuntimeContextReader(database);
  const base = { spaceId: identity.spaceId, sessionId: identity.sessionId, beforeSequence: 300, headOnly: true, harness: "pi" };
  assert.deepEqual((await load(base)).resolvedTurnIds, []);
  const normallySettled = await load({ ...base, pendingTurnIds: [identity.turnId] });
  assert.deepEqual(normallySettled.settledTurnIds, [identity.turnId]);
  assert.deepEqual(normallySettled.resolvedTurnIds, []);
  const result = await load({ ...base, pendingTurnIds: [history[0].id, foreign.turnId] });
  assert.deepEqual(result.resolvedTurnIds, [history[0].id]);
  assert(JSON.stringify(result).length < 450);
  assert.deepEqual((await load({ ...base, pendingTurnIds: [history.at(-1).id] })).resolvedTurnIds, []);
  await assert.rejects(() => load({ ...base, pendingTurnIds: history.slice(0, 3).map((turn) => turn.id) }), /Too many/);
});

test("local message insertion and terminal state roll back together", async () => {
  const identity = await setup(); rejectFinalUpdate = true;
  await assert.rejects(() => finish(identity), /injected failure/); rejectFinalUpdate = false;
  assert.equal((await readTurn(identity.turnId)).status, "running");
  assert.equal((await database.select().from(schema.sessionMessages).where(eq(schema.sessionMessages.turnId, identity.turnId))).length, 1);
});

test("confirmation queued after message insertion cannot observe a half-committed final result", async () => {
  const identity = await setup();
  let confirmation;
  beforeFinalUpdate = () => {
    beforeFinalUpdate = undefined;
    // PGlite serializes connections; this competing SQL waits behind the real transaction.
    confirmation = engine.query(`update v2.session_turns set meta = meta || '{"runtimeRecovery":{"state":"confirmed_stopped"}}'::jsonb where id=$1 and status in ('running','abort_requested') returning id`, [identity.turnId]);
  };
  await finish(identity);
  assert.deepEqual((await confirmation).rows, []);
  assert.equal((await readTurn(identity.turnId)).status, "completed");
});

test("native archive resume returns only a reference while Cloud and handoff still read DB history", async () => {
  const identity = await setup();
  const index = { version: 1, sessionId: identity.sessionId, turnId: identity.turnId, harness: "pi", nativeFormat: "pi.jsonl", nativeSessionId: "native", parentTurnId: null, sizeBytes: 1, sha256: "a".repeat(64), segments: [{ offset: 0, sizeBytes: 1, sha256: "a".repeat(64), md5: "b".repeat(32) }] };
  const meta = { harness: "pi", runtimeArchiveStatus: "ready" };
  await database.update(schema.sessionTurns).set({ status: "completed", harnessIndex: index, meta }).where(eq(schema.sessionTurns.id, identity.turnId));
  const load = createRuntimeContextReader(database);
  const native = await load({ ...identity, throughTurnId: identity.turnId, harness: "pi" });
  assert.deepEqual(native.archive, { sessionId: identity.sessionId, turnId: identity.turnId, harness: "pi" });
  assert.equal(native.messages.length, 0);
  assert.equal(native.complete, false);
  const head = await load({ ...identity, throughTurnId: identity.turnId, harness: "pi", headOnly: true });
  assert.deepEqual(head.archive, native.archive, "the initial head request already includes a ready archive");
  assert.equal(head.messages.length, 0); assert.equal(head.complete, false);
  const cloud = await load({ ...identity, throughTurnId: identity.turnId });
  assert.equal(cloud.archive, undefined); assert.equal(cloud.messages.length, 1);
  const handoff = await load({ ...identity, throughTurnId: identity.turnId, harness: "codex" });
  assert.equal(handoff.archive, undefined); assert.equal(handoff.messages.length, 1);
  for (const status of [undefined, "pending", "failed"]) {
    await database.update(schema.sessionTurns).set({ meta: { ...meta, runtimeArchiveStatus: status } }).where(eq(schema.sessionTurns.id, identity.turnId));
    const context = await load({ ...identity, throughTurnId: identity.turnId, harness: "pi" });
    assert.equal(context.archive, undefined); assert.equal(context.messages.length, 1); assert.equal(context.complete, true);
    const head = await load({ ...identity, throughTurnId: identity.turnId, harness: "pi", headOnly: true });
    assert.equal(head.archive, undefined); assert.equal(head.messages.length, 0);
  }
  for (const invalid of [{ objectKey: "old.json", harness: "pi", nativeFormat: "pi.jsonl" }, { ...index, sessionId: crypto.randomUUID() }, { ...index, turnId: crypto.randomUUID() }]) {
    await database.update(schema.sessionTurns).set({ meta, harnessIndex: invalid }).where(eq(schema.sessionTurns.id, identity.turnId));
    const context = await load({ ...identity, throughTurnId: identity.turnId, harness: "pi" });
    assert.equal(context.archive, undefined); assert.equal(context.messages.length, 1);
  }
});

test("confirmation winning first rejects a late result without inserting a message", async () => {
  const identity = await setup(true);
  await assert.rejects(() => finish(identity), /manually resolved/);
  assert.equal((await database.select().from(schema.sessionMessages).where(eq(schema.sessionMessages.turnId, identity.turnId))).length, 1);
});

test("channel delivery failure is best effort after the local result is durable", async () => {
  const identity = await setup(false, 2);
  gatewayUnavailable = true;
  await finish(identity);
  gatewayUnavailable = false;
  assert.equal((await readTurn(identity.turnId)).status, "completed");
  const messages = await database.select().from(schema.sessionMessages).where(eq(schema.sessionMessages.turnId, identity.turnId));
  assert(messages.some((message) => message.role === "assistant"));
});

test("queue failure after confirmed stop does not weaken the terminal database result", async () => {
  const identity = await setup(true); queueUnavailable = true;
  await finish(identity, true);
  queueUnavailable = false;
  assert.equal((await readTurn(identity.turnId)).status, "interrupted");
  const messages = await database.select().from(schema.sessionMessages).where(eq(schema.sessionMessages.turnId, identity.turnId));
  assert.equal(messages.length, 2);
  assert(messages.some((message) => message.role === "assistant"));
  await finish(identity, true);
  assert.equal((await database.select().from(schema.sessionMessages).where(eq(schema.sessionMessages.turnId, identity.turnId))).length, 2);
});
