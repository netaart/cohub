import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import type { Job } from "bullmq";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveRuntimeModelsConfig } from "@cohub/infra/config-runtime/models";
import type { AgentTurnAbortEvent } from "@cohub/protocol";
import type { ClaimedTurnBatch } from "../batch.js";

const root = await mkdtemp(join(tmpdir(), "cohub-agent-identity-"));
process.env.WORKSPACE_ROOT = root;
process.env.SESSIONS_DIR = join(root, "sessions");
process.env.PLATFORM_CONFIG_ROOT = join(root, "configs");
process.env.DATABASE_URL ??= "postgres://localhost/cohub_test";
process.env.APP_ENCRYPTION_KEY ??= "test-key";
process.env.SESSIONS_NAMESPACE ??= "test";
process.env.TEST_IDENTITY_API_KEY = "test-key";

const BASE_URL = "https://identity.test";
const modelsConfig = resolveRuntimeModelsConfig({ platform: { providers: { test: {
  api: "anthropic-messages", baseUrl: BASE_URL, apiKey: "TEST_IDENTITY_API_KEY", models: [{ id: "claude-sonnet-5" }],
} } } });

type Turn = ClaimedTurnBatch["ownerTurn"];
type Call = { kind: string; turnId?: string; userMessageId?: string; continuedByTurnId?: string | null; text?: string; stopReason?: unknown };

const calls: Call[] = [];
const claims: ClaimedTurnBatch[] = [];
const abortEvents = new Map<string, AgentTurnAbortEvent>();
let beforePrompt: ((turnId: string) => void) | null = null;

function textOf(content: unknown) {
  return Array.isArray(content) ? content.map((block) => (block as { text?: string }).text ?? "").join("") : "";
}

const unavailable = () => { throw new Error("db unavailable in test"); };
mock.module("../db.js", { exports: { db: new Proxy({}, { get: () => unavailable }) } });
mock.module("../redis.js", { exports: { redis: {}, sendOutput: async () => {}, publishRealtimeEnvelope: async () => {} } });
mock.module("../api.js", { exports: {
  getSpace: async () => ({ space: { userUuid: null } }),
  getSpaceSandbox: unavailable, recoverSpaceSandbox: unavailable, createSessionImageUpload: unavailable,
} });
mock.module("../persistence.js", { exports: {
  persistUserMessage: async (input: { turnId: string; userMessageId: string; content: unknown }) => {
    calls.push({ kind: "user", turnId: input.turnId, userMessageId: input.userMessageId, text: textOf(input.content) });
  },
  persistAssistantMessage: async (input: { turnId: string; userMessageId: string; event: { message: { stopReason?: unknown } } }) => {
    calls.push({ kind: "assistant", turnId: input.turnId, userMessageId: input.userMessageId, stopReason: input.event.message.stopReason });
  },
  interruptSessionTurn: async (input: { turnId: string; continuedByTurnId: string }) => {
    calls.push({ kind: "interrupt", turnId: input.turnId, continuedByTurnId: input.continuedByTurnId });
  },
  abortSessionTurn: async (input: { turnId: string }) => { calls.push({ kind: "abort", turnId: input.turnId }); },
  failSessionTurn: async (input: { turnId: string; errorMessage: string }) => { calls.push({ kind: "fail", turnId: input.turnId, text: input.errorMessage }); },
  publishSessionTurnsUpdated: async () => {},
  persistCompactionEvent: unavailable,
  persistBatchUserMessages: unavailable,
} });
mock.module("../session-lock.js", { exports: {
  acquireSessionLock: async () => ({ signal: new AbortController().signal, release: async () => { calls.push({ kind: "release" }); } }),
} });
mock.module("../batch.js", { exports: {
  claimNextTurnBatch: async () => {
    const batch = claims.shift();
    return batch ? { kind: "claimed", batch } : { kind: "noop" };
  },
  buildUserMessagesForBatch: (batch: ClaimedTurnBatch) => batch.turns.map((turn) => ({
    turnId: turn.id, turnSeq: turn.sequence, userMessageId: (turn.meta as { userMessageId: string }).userMessageId, content: turn.userContent, meta: turn.meta,
  })),
  resolveBatchAccessMode: () => "read_only",
  enqueueNextRunnableTurn: async () => { calls.push({ kind: "drain" }); return null; },
} });
mock.module("../logger.js", { exports: { logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } } });
mock.module("../board-session-sync.js", { exports: { syncSessionBoardsLater: async () => {} } });
mock.module("../queue.js", { exports: { agentTurnQueue: {}, enqueueAgentTurnJob: async () => {} } });
mock.module("../abort.js", { exports: {
  getAbortEvent: async (turnId: string) => {
    beforePrompt?.(turnId);
    return abortEvents.get(turnId) ?? null;
  },
} });
mock.module("../sandbox-pool.js", { exports: { ensureSandboxConnection: async () => {} } });
mock.module("../sandbox/tools.js", { exports: { createSandboxCodingTools: () => [readTool] } });
mock.module("../execution-grants.js", { exports: { createAgentExecutionToken: async () => null } });
mock.module("../runtime/models-loader.js", { exports: { loadRuntimeModelsConfigs: async () => [modelsConfig] } });
mock.module("../runtime/image-to-text-config.js", { exports: { loadImageToTextConfig: async () => null } });
mock.module("../runtime/env-cache.js", { exports: { loadSpaceEnvSnapshot: async () => ({}) } });
mock.module("../runtime/cross-space-query-access.js", { exports: { resolveSpaceFileVisibility: async () => "full", assertSpaceFileViewAccess: async () => {} } });
mock.module("../runtime/remote-runtime.js", { exports: { executeRemoteHarnessTurn: unavailable, markRuntimeRecovery: unavailable, RuntimeExecutionUncertainError: class extends Error {} } });
mock.module("../runtime/context-store.js", { exports: {
  loadRuntimeContext: async () => ({ complete: true, revision: "r1", throughTurnId: null, messages: [], resolvedTurnIds: [], settledTurnIds: [] }),
  loadRequestedThinkingLevel: async () => null,
  loadRequestedContextWindow: async () => null,
} });

const readTool: AgentTool = {
  name: "read", label: "read", description: "read a file", parameters: Type.Object({ path: Type.String() }),
  execute: async () => ({ content: [{ type: "text", text: "same" }], details: undefined }),
};

const { processAgentTurnJob, getActiveSessionHandles } = await import("../processor.js");
const { abortActiveTurnExecutions, clearActiveAbortEvent } = await import("../active-turns.js");

function sse(events: Array<Record<string, unknown>>) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}
const textReply = (text: string) => sse([
  { type: "message_start", message: { id: "msg", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
]);
const toolReply = (id: string) => sse([
  { type: "message_start", message: { id: "msg", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "read", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a.txt\"}" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
]);

type UpstreamRequest = { lastUserText: string; signal?: AbortSignal | null };
let replies: Array<(request: UpstreamRequest) => string | Promise<string>> = [];
const upstream: UpstreamRequest[] = [];
const previousFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith(BASE_URL)) return previousFetch(input, init);
  const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: unknown }> };
  const lastUser = body.messages.filter((message) => message.role === "user").at(-1);
  const request = { lastUserText: typeof lastUser?.content === "string" ? lastUser.content : textOf(lastUser?.content), signal: init?.signal };
  upstream.push(request);
  const reply = replies.shift() ?? (() => textReply("ok"));
  return new Response(await reply(request), { status: 200, headers: { "content-type": "text/event-stream" } });
};

after(async () => {
  globalThis.fetch = previousFetch;
  for (const handle of getActiveSessionHandles().values()) handle.session.dispose();
  await rm(root, { recursive: true, force: true });
});

const spaceId = crypto.randomUUID();
const ownerId = crypto.randomUUID();
let sequence = 0;

function makeTurn(sessionId: string, text: string): Turn {
  const id = crypto.randomUUID();
  sequence += 1;
  return {
    id, sessionId, userUuid: ownerId, sequence, status: "running", intent: "followup", userText: text, updatedAt: new Date(),
    userContent: [{ type: "text", text }],
    meta: { userId: ownerId, provider: "test", model: "claude-sonnet-5", accessMode: "read_only", userMessageId: `msg-${id}` },
  };
}

function batchOf(turns: Turn[]): ClaimedTurnBatch {
  const ownerTurn = turns.at(-1);
  assert(ownerTurn);
  const userMessageIds = turns.map((turn) => (turn.meta as { userMessageId: string }).userMessageId);
  return {
    ownerTurn, turns, mergedTurns: turns.slice(0, -1),
    executionBatch: { ownerTurnId: ownerTurn.id, turnIds: turns.map((turn) => turn.id), mergedTurnIds: turns.slice(0, -1).map((turn) => turn.id), userMessageIds, anchorUserMessageId: userMessageIds.at(-1) ?? null },
  };
}

const idOf = (turn: Turn) => (turn.meta as { userMessageId: string }).userMessageId;

async function run(sessionId: string, turns: Turn[]) {
  claims.push(batchOf(turns));
  calls.length = 0;
  upstream.length = 0;
  const job = { id: "job", data: { spaceId, sessionId, reason: "prompt" }, attemptsMade: 0, timestamp: Date.now() } as unknown as Job<never>;
  return processAgentTurnJob(job).then(() => null, (error: unknown) => error);
}

const findHandle = (sessionId: string) => [...getActiveSessionHandles().values()].find((item) => item.sessionId === sessionId);
function handleOf(sessionId: string) {
  const handle = findHandle(sessionId);
  assert(handle);
  return handle;
}

const kinds = (...names: string[]) => calls.filter((call) => names.includes(call.kind));

test("the production timeline keeps every message on its own Turn", async () => {
  const sessionId = crypto.randomUUID();
  const t139 = makeTurn(sessionId, "message 139");
  const t140 = makeTurn(sessionId, "message 140");
  const t143 = makeTurn(sessionId, "message 143");

  // #139 is stopped after its pending message is registered but before the prompt is sent.
  let lookups = 0;
  beforePrompt = (turnId) => {
    if (turnId !== t139.id) return;
    lookups += 1;
    if (lookups === 2) abortEvents.set(t139.id, { spaceId, sessionId, turnId: t139.id, reason: "abort", actorUserId: "owner" } as AgentTurnAbortEvent);
  };
  await run(sessionId, [t139]);
  beforePrompt = null;
  clearActiveAbortEvent(t139.id);
  assert.deepEqual(kinds("abort", "interrupt", "user"), [{ kind: "abort", turnId: t139.id }]);
  assert.equal(upstream.length, 0);
  assert.deepEqual(handleOf(sessionId).pendingUserMessages, []);

  for (const turn of [t140, t143]) {
    assert.equal(await run(sessionId, [turn]), null);
    assert.deepEqual(upstream.map((request) => request.lastUserText), [turn.userText]);
    assert.deepEqual(kinds("user", "assistant", "interrupt", "fail"), [
      { kind: "user", turnId: turn.id, userMessageId: idOf(turn), text: turn.userText },
      { kind: "assistant", turnId: turn.id, userMessageId: idOf(turn), stopReason: "stop" },
    ]);
  }
});

test("a stale pending message does not take over the current message", async () => {
  const sessionId = crypto.randomUUID();
  const owner = makeTurn(sessionId, "current");
  beforePrompt = (turnId) => {
    if (turnId !== owner.id) return;
    findHandle(sessionId)?.pendingUserMessages.unshift({ userMessageId: "msg-stale", turnId: "turn-stale", content: [{ type: "text", text: "stale" }] });
  };
  await run(sessionId, [owner]);
  beforePrompt = null;
  assert.deepEqual(kinds("user", "assistant", "interrupt", "fail"), [
    { kind: "user", turnId: owner.id, userMessageId: idOf(owner), text: "current" },
    { kind: "assistant", turnId: owner.id, userMessageId: idOf(owner), stopReason: "stop" },
  ]);
});

test("a merged batch keeps each message on its Turn while persistence is blocked", async () => {
  const sessionId = crypto.randomUUID();
  const first = makeTurn(sessionId, "first");
  const owner = makeTurn(sessionId, "second");
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  beforePrompt = (turnId) => {
    const handle = findHandle(sessionId);
    if (turnId === owner.id && handle) handle.persistenceChain = handle.persistenceChain.then(() => gate);
  };
  replies = [() => { open(); return textReply("ok"); }];
  await run(sessionId, [first, owner]);
  beforePrompt = null;
  assert.deepEqual(kinds("user", "interrupt", "fail"), [
    { kind: "user", turnId: first.id, userMessageId: idOf(first), text: "first" },
    { kind: "user", turnId: owner.id, userMessageId: idOf(owner), text: "second" },
  ]);
  assert.deepEqual(kinds("assistant").map((call) => call.turnId), [owner.id]);
});

test("the loop guard message reaches the model without consuming pending messages", async () => {
  const sessionId = crypto.randomUUID();
  const owner = makeTurn(sessionId, "loop");
  const userStarts: Array<Record<string, unknown> | null> = [];
  let subscribed = false;
  beforePrompt = (turnId) => {
    const handle = findHandle(sessionId);
    if (turnId !== owner.id || subscribed || !handle) return;
    subscribed = true;
    handle.session.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "user") userStarts.push((event.message as { meta?: Record<string, unknown> }).meta ?? null);
    });
  };
  replies = [1, 2, 3, 4, 5].map((index) => () => {
    if (index === 5) handleOf(sessionId).pendingUserMessages.push({ userMessageId: "msg-sentinel", turnId: "turn-sentinel", content: [{ type: "text", text: "sentinel" }] });
    return toolReply(`toolu_${index}`);
  });
  const error = await run(sessionId, [owner]);
  beforePrompt = null;
  assert.equal(error, null);
  assert.equal(userStarts[0]?.userMessageId, idOf(owner));
  assert.equal(userStarts[1]?.internal, true);
  assert.equal(userStarts[1]?.userMessageId, undefined);
  assert.deepEqual(handleOf(sessionId).pendingUserMessages.map((item) => item.userMessageId), ["msg-sentinel"]);
  assert.deepEqual(kinds("user", "interrupt", "fail"), [{ kind: "user", turnId: owner.id, userMessageId: idOf(owner), text: "loop" }]);
  assert.ok(kinds("assistant").every((call) => call.turnId === owner.id && call.userMessageId === idOf(owner)));
});

test("an unidentified external message fails the run without persisting under a wrong identity", async () => {
  const sessionId = crypto.randomUUID();
  const owner = makeTurn(sessionId, "owner");
  replies = [
    () => {
      handleOf(sessionId).session.agent.steer({ role: "user", content: [{ type: "text", text: "stray" }], timestamp: Date.now() });
      return textReply("first");
    },
    () => textReply("after stray"),
  ];
  const error = await run(sessionId, [owner]);
  assert.match(String(error), /without a pending identity/);
  assert.deepEqual(kinds("user", "assistant", "interrupt"), [
    { kind: "user", turnId: owner.id, userMessageId: idOf(owner), text: "owner" },
    { kind: "assistant", turnId: owner.id, userMessageId: idOf(owner), stopReason: "stop" },
  ]);
  assert.deepEqual(kinds("fail").map((call) => call.turnId), [owner.id]);
  assert.ok(kinds("release").length === 1 && kinds("drain").length === 1);

  const next = makeTurn(sessionId, "next");
  replies = [];
  assert.equal(await run(sessionId, [next]), null);
  assert.deepEqual(kinds("user", "assistant", "interrupt", "fail"), [
    { kind: "user", turnId: next.id, userMessageId: idOf(next), text: "next" },
    { kind: "assistant", turnId: next.id, userMessageId: idOf(next), stopReason: "stop" },
  ]);
});

test("an unidentified first message keeps the rest of the batch from restoring an identity", async () => {
  const sessionId = crypto.randomUUID();
  const first = makeTurn(sessionId, "first");
  const owner = makeTurn(sessionId, "second");
  beforePrompt = (turnId) => {
    const handle = findHandle(sessionId);
    if (turnId === owner.id && handle) handle.pendingUserMessages = handle.pendingUserMessages.filter((item) => item.userMessageId !== idOf(first));
  };
  const error = await run(sessionId, [first, owner]);
  beforePrompt = null;
  assert.match(String(error), /without a pending identity/);
  assert.deepEqual(kinds("user", "assistant", "interrupt"), []);
  assert.deepEqual(kinds("fail").map((call) => call.turnId), [owner.id]);
});

function blockingReply(onRequest: () => void) {
  return (request: UpstreamRequest) => new Promise<string>((_, reject) => {
    request.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    onRequest();
  });
}

test("steering a running Turn interrupts it and continues with the steer Turn", async () => {
  const sessionId = crypto.randomUUID();
  const running = makeTurn(sessionId, "running");
  const steer = makeTurn(sessionId, "steer");
  replies = [blockingReply(() => {
    abortActiveTurnExecutions({ spaceId, sessionId, turnId: running.id, reason: "interrupt", continuedByTurnId: steer.id, actorUserId: "owner" } as AgentTurnAbortEvent);
  })];
  await run(sessionId, [running]);
  clearActiveAbortEvent(running.id);
  assert.deepEqual(kinds("interrupt", "abort", "fail"), [{ kind: "interrupt", turnId: running.id, continuedByTurnId: steer.id }]);

  await run(sessionId, [steer]);
  assert.deepEqual(kinds("user", "assistant", "interrupt", "fail"), [
    { kind: "user", turnId: steer.id, userMessageId: idOf(steer), text: "steer" },
    { kind: "assistant", turnId: steer.id, userMessageId: idOf(steer), stopReason: "stop" },
  ]);
});

test("stopping the running Turn reaches its execution", async () => {
  const sessionId = crypto.randomUUID();
  const owner = makeTurn(sessionId, "stop me");
  replies = [blockingReply(() => {
    const { controllersAborted } = abortActiveTurnExecutions({ spaceId, sessionId, turnId: owner.id, reason: "abort", actorUserId: "owner" } as AgentTurnAbortEvent);
    assert.equal(controllersAborted, 1);
  })];
  await run(sessionId, [owner]);
  clearActiveAbortEvent(owner.id);
  assert.deepEqual(kinds("abort", "interrupt", "fail"), [{ kind: "abort", turnId: owner.id }]);
  assert.equal(kinds("release").length, 1);
});
