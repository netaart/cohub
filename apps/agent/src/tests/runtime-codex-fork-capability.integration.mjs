import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";

const spaceId = crypto.randomUUID(), sessionId = crypto.randomUUID(), turnId = crypto.randomUUID();
const mergedTurnId = crypto.randomUUID();
let registrations, persisted = 0, dispatched = 0;
const rejectionWrites = [];
let context = { complete: false, revision: "parent", throughTurnId: crypto.randomUUID(), messages: [], fork: { sessionId: crypto.randomUUID(), turnId: crypto.randomUUID() } };
const registration = (codexFork) => JSON.stringify({ connectionId: crypto.randomUUID(), ownerUserId: "owner", endpoint: `ws://gateway/internal/runtime-relay/${spaceId}`, capabilities: { harnesses: ["codex"], models: [], ...(codexFork === undefined ? {} : { codexFork }) } });
mock.module("../env.js", { namedExports: { env: {} } });
mock.module("../db.js", { namedExports: { db: {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ status: "running", meta: {} }] }) }) }),
  update: () => ({ set: (values) => ({ where: (predicate) => ({
    // biome-ignore lint/suspicious/noThenProperty: Drizzle updates are awaitable and also support returning().
    then: (resolve) => { rejectionWrites.push({ values: new PgDialect().sqlToQuery(values.meta), predicate: new PgDialect().sqlToQuery(predicate) }); resolve([]); },
    returning: async () => [{ meta: {} }],
  }) }) }),
} } });
mock.module("../redis.js", { namedExports: { redis: { get: async () => registrations.shift() }, sendOutput: async () => {} } });
mock.module("../api.js", { namedExports: { getSpaceSandbox: async () => ({ sandbox: { provider: "local" } }) } });
mock.module("../logger.js", { namedExports: { logger: { info() {}, warn() {} } } });
mock.module("../runtime/context-store.js", { namedExports: { loadRuntimeContext: async () => context } });
mock.module("../persistence.js", { namedExports: { persistBatchUserMessages: async () => { persisted++; }, persistAssistantMessage: async () => {} } });
mock.module("../batch.js", { namedExports: { buildUserMessagesForBatch: () => [mergedTurnId, turnId].map((id, index) => ({ turnId: id, userMessageId: crypto.randomUUID(), turnSeq: index + 2, content: [{ type: "text", text: "follow-up" }] })) } });
mock.module("../stream/runtime-stream.js", { namedExports: { createRuntimeStream: () => ({ dispose() {} }) } });
mock.module("../runtime/exchange.js", { namedExports: {
  RuntimeExecutionUncertainError: class extends Error {}, RuntimeResultUnavailableError: class extends Error {},
  exchangeRuntimeTurn: async (options) => { await options.endpoint(); dispatched++; },
} });
const { executeRemoteHarnessTurn } = await import("../runtime/remote-runtime.js");
const input = { spaceId, sessionId, batch: { ownerTurn: { id: turnId, meta: {} }, turns: [{}, {}] }, actorUserId: "owner", harness: "codex", accessMode: "full_access", abortSignal: new AbortController().signal };

test("an old Runtime cannot silently discard a Codex fork boundary", async () => {
  for (const capability of [undefined, false]) {
    registrations = [registration(capability), registration(capability)]; persisted = dispatched = 0;
    rejectionWrites.length = 0;
    await assert.rejects(executeRemoteHarnessTurn(input), /upgrade.*fork/i);
    assert.equal(persisted, 0);
    assert.equal(dispatched, 0);
    assert.equal(rejectionWrites.length, 1, "record that this attempt was rejected before dispatch");
    assert(rejectionWrites[0].values.params.includes(JSON.stringify({ runtimeForkRejection: "unsupported_runtime" })));
    assert(rejectionWrites[0].predicate.params.includes(sessionId), "the marker is scoped to this session");
    assert(rejectionWrites[0].predicate.params.includes(turnId));
    assert(rejectionWrites[0].predicate.params.includes(mergedTurnId), "mark the complete rejected batch, including merged inputs");
  }
});

test("a reconnect to an old Runtime is rejected before the fork command is sent", async () => {
  registrations = [registration(true), registration(undefined)]; persisted = dispatched = 0;
  rejectionWrites.length = 0;
  await assert.rejects(executeRemoteHarnessTurn(input), /upgrade.*fork/i);
  assert.equal(dispatched, 0);
  assert.equal(rejectionWrites.length, 0, "reconnects may follow an earlier dispatch and must never get the safe-retry marker");
});

test("fork-capable Runtime dispatches; result recovery does not require fork support", async () => {
  registrations = [registration(true), registration(true)]; persisted = dispatched = 0;
  await executeRemoteHarnessTurn(input);
  assert.equal(dispatched, 1);
  registrations = [registration(undefined), registration(undefined)];
  await executeRemoteHarnessTurn({ ...input, recovery: true });
  assert.equal(dispatched, 2);
  const { fork, ...ordinaryContext } = context;
  context = ordinaryContext;
  registrations = [registration(undefined), registration(undefined)];
  await executeRemoteHarnessTurn(input);
  assert.equal(dispatched, 3, "ordinary continuation remains compatible with older Runtimes");
});
