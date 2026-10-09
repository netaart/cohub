import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RuntimeTurnInput } from "@neta-art/cohub";
import type { SessionTurnRecord, TurnIntermediateMessagesFile } from "@cohub/protocol";
import { ProjectionStore } from "../src/runtime/projection-store.js";
import { testNativeRuntime } from "./fixtures/runtime-native.js";
import { listSessionProjectionTurns } from "../src/runtime/turn-projection.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const turnId = "22222222-2222-4222-8222-222222222222";
const messageId = "33333333-3333-4333-8333-333333333333";

const turn = (sequence: number, id = turnId): SessionTurnRecord => ({
  id,
  sessionId,
  sourceSessionId: sessionId,
  sourceTurnId: id,
  userUuid: null,
  sequence,
  status: "completed",
  intent: "followup",
  userContent: [{ type: "text", text: `user-${sequence}` }],
  userText: `user-${sequence}`,
  assistantContent: [{ type: "text", text: `assistant-${sequence}` }],
  assistantText: `assistant-${sequence}`,
  provider: "fixture",
  model: "test",
  stopReason: "stop",
  errorMessage: null,
  finalUsage: null,
  totalUsage: null,
  summary: null,
  intermediateIndex: null,
  intermediateSummary: null,
  harnessIndex: null,
  meta: null,
  startedAt: "2026-09-19T00:00:00.000Z",
  completedAt: "2026-09-19T00:00:01.000Z",
  durationMs: 1000,
  createdAt: "2026-09-19T00:00:00.000Z",
  updatedAt: "2026-09-19T00:00:01.000Z",
});

function client(turns: SessionTurnRecord[], archive: TurnIntermediateMessagesFile | Error | null = null, getError?: unknown | ((turnId: string) => unknown)) {
  return {
    session: () => ({
      turns: {
        async listPaginated(options?: { cursor?: number }) {
          const rows = turns.filter((row) => options?.cursor === undefined || row.sequence > options.cursor);
          return { turns: rows, hasMore: false, nextCursor: undefined };
        },
        async get(id: string) {
          const error = typeof getError === "function" ? getError(id) : getError;
          if (error !== undefined) throw error;
          const found = turns.find((row) => row.id === id) ?? turns[0];
          if (!found) throw new Error("missing fixture turn");
          return { turn: found };
        },
        intermediate: {
          async get() { if (archive instanceof Error) throw archive; return archive; },
          async getToolCalls() { return null; },
        },
      },
    }),
  };
}

test("Turn pagination hydrates intermediate object storage into the canonical projection", async () => {
  const archive: TurnIntermediateMessagesFile = {
    version: 1,
    spaceId: "space",
    sessionId,
    turnId,
    summary: { messageCount: 1, toolCallCount: 0 },
    messages: [{
      id: messageId,
      sessionId,
      sequence: 2,
      role: "assistant",
      content: [{ type: "text", text: "intermediate" }],
      text: "intermediate",
      provider: "fixture",
      model: "test",
      stopReason: "tool_use",
      errorMessage: null,
      usage: null,
      durationMs: 1,
      toolCallsObjectKey: null,
      meta: { turnId },
      createdAt: "2026-09-19T00:00:00.500Z",
    }],
  };
  const source = { ...turn(1), intermediateIndex: { version: 1 as const, messagesObjectKey: "turn-1.json", messagesSizeBytes: 1, toolCallsBaseObjectKey: "tool/" } };
  const result = await listSessionProjectionTurns(client([source], archive), sessionId);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0]?.messages.map((message) => message.id), [`${turnId}:user`, messageId, `${turnId}:assistant`]);
  assert.equal(result[0]?.messages[1]?.content[0]?.type, "text");
});

test("Turn pagination respects both incremental and request context boundaries", async () => {
  const second = turn(2, "44444444-4444-4444-8444-444444444444");
  const future = turn(3, "55555555-5555-4555-8555-555555555555");
  const result = await listSessionProjectionTurns(client([turn(1), second, future]), sessionId, { afterSequence: 1, throughSequence: 2 });
  assert.deepEqual(result.map((item) => item.sequence), [2]);
});

test("final assistant projection retains Turn result metadata", async () => {
  const source = { ...turn(1), finalUsage: { input: 4, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 7, cost: null }, stopReason: "error", errorMessage: "provider failed" };
  const result = await listSessionProjectionTurns(client([source]), sessionId);
  const assistant = result[0]?.messages.at(-1);
  assert.deepEqual(assistant?.usage, source.finalUsage);
  assert.equal(assistant?.stopReason, source.stopReason);
  assert.equal(assistant?.errorMessage, source.errorMessage);
});

test("intermediate object failures stop projection instead of using incomplete history", async () => {
  const source = { ...turn(1), intermediateIndex: { version: 1 as const, messagesObjectKey: "turn-1.json", messagesSizeBytes: 1, toolCallsBaseObjectKey: "tool/" } };
  await assert.rejects(listSessionProjectionTurns(client([source], new Error("object storage unavailable")), sessionId), /object storage unavailable/);
});

test("completed generation results are not duplicated with final assistant content", async () => {
  const source = { ...turn(1), intermediateIndex: { version: 1 as const, messagesObjectKey: "turn-1.json", messagesSizeBytes: 1, toolCallsBaseObjectKey: "tool/" } };
  const archive: TurnIntermediateMessagesFile = {
    version: 1, spaceId: "space", sessionId, turnId: source.id, summary: { messageCount: 1, toolCallCount: 0 },
    messages: [{ id: "generation", sessionId, sequence: 1, role: "assistant", content: [{ type: "text", text: "assistant-1" }], text: "assistant-1", provider: "fixture", model: "test", stopReason: "stop", errorMessage: null, usage: null, durationMs: 1, toolCallsObjectKey: null, meta: { messageKind: "generation_result", generationStatus: "completed" }, createdAt: source.createdAt }],
  };
  const result = await listSessionProjectionTurns(client([source], archive), sessionId);
  assert.deepEqual(result[0]?.messages.map((message) => message.id), [`${source.id}:user`, "generation"]);
});

test("a Session that moved past its native file is projected into a new file; the old file is untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-projection-safety-"));
  const prior = turn(1);
  const current = turn(2, "44444444-4444-4444-8444-444444444444");
  const runtime = await testNativeRuntime({ spaceId: "space", root, harnesses: ["pi"], projectionSource: client([prior, current]) });
  try {
    const { sessions, ingest } = runtime.native.executor;
    const input: RuntimeTurnInput = {
      spaceId: "space", sessionId, turnId: current.id, userMessageId: current.id, harness: "pi", messages: [], accessMode: "full_access",
      context: { complete: true, revision: "one", throughTurnId: prior.id, messages: [] },
    };
    const first = await sessions.prepare({ ...input, cwd: root, resumable: () => true });
    ingest.advance(first.session.path, current.id);
    const original = await readFile(first.session.path, "utf8");
    // Elsewhere the Session gained a Turn this file does not have.
    const rebuilt = await sessions.prepare({ ...input, cwd: root, turnId: "55555555-5555-4555-8555-555555555555", context: { ...input.context, revision: "two", throughTurnId: "66666666-6666-4666-8666-666666666666" }, resumable: () => true });
    assert.equal(rebuilt.resume, "handoff");
    assert.notEqual(rebuilt.session.path, first.session.path);
    assert.equal(await readFile(first.session.path, "utf8"), original);
    // The file that does end at the Session head is continued in place.
    const resumed = await sessions.prepare({ ...input, cwd: root, turnId: "77777777-7777-4777-8777-777777777777", context: { ...input.context, revision: "two", throughTurnId: current.id }, resumable: () => true });
    assert.equal(resumed.resume, "native");
    assert.equal(resumed.session.path, first.session.path);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectionStore projects every settled Turn through the head, without the running Turn", async () => {
  const first = turn(1);
  const second = turn(2, "44444444-4444-4444-8444-444444444444");
  const input = {
    spaceId: "space", sessionId, turnId: "55555555-5555-4555-8555-555555555555", nativeSessionId: "native", cwd: "/repo", target: "pi" as const, throughTurnId: second.id,
  };
  const projected = await new ProjectionStore(client([first, second])).project(input);
  assert.deepEqual(projected.turns.map((item) => item.id), [first.id, second.id]);
  assert(projected.projection.records.some((record) => record.sourceTurnId === null), "a projection is a complete file with its header");
  const head = await new ProjectionStore(client([first, second])).project({ ...input, throughTurnId: first.id });
  assert.deepEqual(head.turns.map((item) => item.id), [first.id]);
  const offline = new ProjectionStore(client([first, second], null, new Error("network unavailable")));
  await assert.rejects(offline.project(input), /network unavailable/);
});
