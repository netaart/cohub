import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { randomUUID } from "node:crypto";
import { runtimeCommandSchema, type RuntimeTurnInput } from "@cohub/protocol";
import type { ClaimedTurnBatch } from "../batch.js";

let status = "running", online = true;
const commands: RuntimeTurnInput[] = [], contexts: Array<{ beforeSequence?: number; throughTurnId?: string }> = [];
const users: Array<{ turnId: string; userMessageId: string; meta: unknown }> = [];
const assistants: Array<{ turnId: string; userMessageId: string; userId: string; idempotencyKey: string }> = [];
const outputs: Array<{ turnId?: string }> = [];
const registration = { connectionId: randomUUID(), ownerUserId: "host-owner", endpoint: "ws://gateway/internal/runtime-relay/space",
  capabilities: { harnesses: ["pi", "codex"], models: [{ harness: "pi", id: "chosen", provider: "fixture", name: "chosen" }, { harness: "codex", id: "chosen", provider: "fixture", name: "chosen" }] } };
mock.module("../env.js", { exports: { env: {} } });
mock.module("../db.js", { exports: { db: {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ status, meta: {} }] }) }) }),
  update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ meta: {} }] }) }) }),
} } });
mock.module("../redis.js", { exports: { redis: { get: async () => online ? JSON.stringify(registration) : null }, sendOutput: async (event: { turnId?: string }) => { outputs.push(event); } } });
mock.module("../api.js", { exports: { getSpaceSandbox: async () => ({ sandbox: { provider: "local" } }) } });
mock.module("../logger.js", { exports: { logger: { info() {}, warn() {}, debug() {}, error() {} } } });
mock.module("../runtime/context-store.js", { exports: { loadRuntimeContext: async (input: { beforeSequence?: number; throughTurnId?: string }) => {
  contexts.push(input); return { revision: input.throughTurnId ? "completed" : "previous", throughTurnId: input.throughTurnId ?? null, messages: [] };
} } });
mock.module("../persistence.js", { exports: {
  persistBatchUserMessages: async ({ batch }: { batch: ClaimedTurnBatch }) => {
    const { buildUserMessagesForBatch } = await import("../batch.js"); users.push(...buildUserMessagesForBatch(batch));
  },
  persistAssistantMessage: async (input: typeof assistants[number]) => { assistants.push(input); status = "completed"; },
} });
mock.module("../runtime/exchange.js", { exports: {
  RuntimeExecutionUncertainError: class extends Error {}, RuntimeResultUnavailableError: class extends Error {},
  exchangeRuntimeTurn: async (options: { input: RuntimeTurnInput; recovery?: boolean; event: (event: unknown, send: (command: unknown) => void, id: string) => Promise<void> }) => {
    commands.push(options.input);
    assert(runtimeCommandSchema.safeParse({ type: "turn.start", requestId: options.input.turnId, input: options.input }).success);
    const sent: Array<{ type: string; turnId?: string }> = [];
    const send = (command: unknown) => { sent.push(command as typeof sent[number]); };
    if (!options.recovery) await options.event({ type: "context.required" }, send, options.input.turnId);
    await options.event({ type: "turn.end", resume: "native", message: { ordinal: 0, content: [{ type: "text", text: "combined result" }] },
      archive: { sessionId: options.input.sessionId, turnId: options.input.turnId, harness: options.input.harness } }, send, options.input.turnId);
    assert.equal(sent.at(-1)?.type, "turn.ack"); assert.equal(sent.at(-1)?.turnId, options.input.turnId);
  },
} });
const { executeRemoteHarnessTurn } = await import("../runtime/remote-runtime.js");

function batch(): ClaimedTurnBatch {
  const sessionId = randomUUID();
  const turns = ["cohub", "pi", "codex"].map((harness, index) => ({ id: randomUUID(), sessionId, sequence: index + 5,
    userUuid: `author-${index}`, status: index === 2 ? "running" : "merged", intent: "followup", userContent: [{ type: "text" as const, text: `input-${index}` }], userText: null, updatedAt: new Date(),
    meta: { harness, userMessageId: randomUUID(), userId: `author-${index}` },
  }));
  const owner = turns.at(-1); assert(owner);
  return { ownerTurn: owner, turns, mergedTurns: turns.slice(0, -1), executionBatch: { ownerTurnId: owner.id, turnIds: turns.map((turn) => turn.id), mergedTurnIds: turns.slice(0, -1).map((turn) => turn.id), userMessageIds: turns.map((turn) => turn.meta.userMessageId), anchorUserMessageId: owner.meta.userMessageId } };
}

for (const harness of ["pi", "codex"] as const) test(`${harness}: Local batch persists all inputs and uses only the last owner for context, output and archive`, async () => {
  status = "running"; online = true;
  commands.length = contexts.length = users.length = assistants.length = outputs.length = 0;
  const claimed = batch();
  const input = { spaceId: randomUUID(), sessionId: claimed.ownerTurn.sessionId, batch: claimed, actorUserId: claimed.ownerTurn.userUuid,
    harness, provider: "fixture", model: "chosen", accessMode: "full_access" as const, abortSignal: new AbortController().signal };
  await executeRemoteHarnessTurn(input);
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0]?.messages.map((message) => [message.turnId, message.userMessageId, message.userId, message.content]), claimed.turns.map((turn, index) => [turn.id, claimed.executionBatch.userMessageIds[index], turn.userUuid, turn.userContent]));
  assert.equal(commands[0]?.model, "chosen");
  assert.equal(commands[0]?.turnId, claimed.ownerTurn.id);
  assert.deepEqual(users.map((user) => user.turnId), claimed.executionBatch.turnIds);
  assert.deepEqual(contexts.filter((context) => !context.throughTurnId).map((context) => context.beforeSequence), [5, 5]);
  assert(outputs.every((output) => output.turnId === claimed.ownerTurn.id));
  assert.equal(assistants[0]?.turnId, claimed.ownerTurn.id);
  assert.equal(assistants[0]?.userId, claimed.ownerTurn.userUuid);
  assert.equal(assistants[0]?.userMessageId, claimed.executionBatch.anchorUserMessageId);
  contexts.length = 0; status = "running";
  await executeRemoteHarnessTurn({ ...input, recovery: true, accessMode: "read_only" });
  assert.equal(contexts[0]?.beforeSequence, 5, "recovery retains the original earliest input boundary");
  assert.equal(assistants[0]?.idempotencyKey, assistants[1]?.idempotencyKey, "recovery reuses the same result identity");
});

test("read-only Pi and offline selected harness fail before dispatch without switching executors", async () => {
  const claimed = batch(); commands.length = users.length = 0;
  const input = { spaceId: randomUUID(), sessionId: claimed.ownerTurn.sessionId, batch: claimed, actorUserId: claimed.ownerTurn.userUuid, harness: "pi" as const, accessMode: "read_only" as const, abortSignal: new AbortController().signal };
  await assert.rejects(executeRemoteHarnessTurn(input), /read-only/);
  online = false;
  await assert.rejects(executeRemoteHarnessTurn({ ...input, accessMode: "full_access" }), /offline/);
  assert.equal(commands.length, 0); assert.equal(users.length, 0);
});
