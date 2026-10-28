import assert from "node:assert/strict";
import { test } from "node:test";
import { fileWatcherStatusSchema, resolveRuntimeThinkingLevel, runtimeCapabilitiesSchema, runtimeClientFrameSchema, runtimeCommandSchema, runtimeReadySchema, parseRuntimeRegistration, contextToPiMessages, RUNTIME_MAX_BATCH_MESSAGES } from "./src/runtime/index.js";
import { getSessionStreamSnapshotKey, SESSION_STREAM_SNAPSHOT_CLEAR_TURN_LUA } from "./src/realtime/index.js";

test("file watcher telemetry validates codes and drops local details", () => {
  const value = { backend: "fsevents", state: "running", observedAt: new Date().toISOString() };
  assert.deepEqual(fileWatcherStatusSchema.parse({ ...value, path: "/private/project", token: "secret" }), value);
  assert(fileWatcherStatusSchema.safeParse({ ...value, backend: "readdcw" }).success);
  assert(!fileWatcherStatusSchema.safeParse({ ...value, backend: "arbitrary" }).success);
  assert(!fileWatcherStatusSchema.safeParse({ ...value, reason: "/private/error" }).success);
  assert(!fileWatcherStatusSchema.safeParse({ ...value, observedAt: "invalid" }).success);
});

test("Runtime batches retain ordered authors and enforce the final owner identity", () => {
  const messages = ["first", "last"].map((userId) => ({ userId, turnId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), content: [{ type: "text", text: userId }] }));
  const owner = messages.at(-1); assert(owner);
  const input = { spaceId: crypto.randomUUID(), sessionId: crypto.randomUUID(), turnId: owner.turnId, userMessageId: owner.userMessageId, harness: "pi", messages,
    accessMode: "full_access", context: { revision: "r", throughTurnId: null, messages: [] } };
  const parse = (patch: object) => runtimeCommandSchema.safeParse({ type: "turn.start", requestId: crypto.randomUUID(), input: { ...input, ...patch } });
  assert(parse({}).success);
  assert(!parse({ messages: [] }).success);
  assert(!parse({ turnId: messages[0]?.turnId }).success);
  assert(!parse({ userMessageId: messages[0]?.userMessageId }).success);
  assert(!parse({ messages: [owner, owner] }).success);
  assert(!parse({ messages: [{ ...messages[0], userMessageId: owner.userMessageId }, owner] }).success);
  const extra = { userId: null, turnId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), content: [{ type: "text", text: "extra" }] };
  const full = Array.from({ length: RUNTIME_MAX_BATCH_MESSAGES - 1 }, () => ({ ...extra, turnId: crypto.randomUUID(), userMessageId: crypto.randomUUID() }));
  assert(parse({ messages: [...full, owner] }).success);
  assert(!parse({ messages: [...full, extra, owner] }).success, "a batch cannot exceed the message budget");
});

test("Shared stream snapshot clearing targets one Session and one turn", () => {
  assert.equal(getSessionStreamSnapshotKey("space", "session"), "session:stream:snapshot:space:session");
  // The Lua guard must compare the stored turnId so a delayed older turn cannot drop live state.
  assert.match(SESSION_STREAM_SNAPSHOT_CLEAR_TURN_LUA, /snapshot\.turnId == ARGV\[1\]/);
  assert.match(SESSION_STREAM_SNAPSHOT_CLEAR_TURN_LUA, /redis\.call\('DEL', KEYS\[1\]\)/);
});

test("Runtime protocol validates execution identities, native archive versions and capabilities", () => {
  assert.equal(runtimeCommandSchema.safeParse({ type: "turn.abort", requestId: "arbitrary" }).success, false);
  assert.equal(runtimeClientFrameSchema.safeParse({ type: "runtime.hello", version: 2, spaceId: crypto.randomUUID(), token: "token", capabilities: { harnesses: ["pi"], models: [] } }).success, false);
  const hello = { type: "runtime.hello", version: 1, spaceId: crypto.randomUUID(), token: "token", capabilities: { harnesses: ["pi"], models: [] } };
  assert(runtimeClientFrameSchema.safeParse(hello).success);
  const recovery = { type: "runtime.recovery", executions: [{ sessionId: crypto.randomUUID(), turnId: crypto.randomUUID(), harness: "codex" }] };
  assert(runtimeClientFrameSchema.safeParse(recovery).success);
  assert(!runtimeClientFrameSchema.safeParse({ ...recovery, executions: [] }).success);
  assert(!runtimeClientFrameSchema.safeParse({ ...recovery, executions: [{ sessionId: "bad", turnId: crypto.randomUUID(), harness: "pi" }] }).success);
  assert(!runtimeClientFrameSchema.safeParse({ ...recovery, executions: Array.from({ length: 65 }, () => recovery.executions[0]) }).success);
});

test("Runtime registration parsing fails closed for corrupt and incompatible Redis values", () => {
  const registration = { connectionId: crypto.randomUUID(), ownerUserId: "owner", endpoint: "ws://gateway/internal/runtime-relay/space", capabilities: { harnesses: ["pi"], models: [] } };
  assert.deepEqual(parseRuntimeRegistration(JSON.stringify(registration)), registration);
  for (const raw of ["{", "null", "[]", "42", JSON.stringify({ capabilities: registration.capabilities }), JSON.stringify({ ...registration, connectionId: "bad" }), JSON.stringify({ ...registration, endpoint: "https://example.com" }), JSON.stringify({ ...registration, capabilities: { harnesses: ["unknown"], models: [] } })]) {
    assert.equal(parseRuntimeRegistration(raw), null);
  }
});

test("Runtime ready requires a valid connection identity", () => {
  assert(runtimeReadySchema.safeParse({ type: "runtime.ready", connectionId: crypto.randomUUID() }).success);
  for (const connectionId of [undefined, null, "", "invalid", 1]) {
    assert.equal(runtimeReadySchema.safeParse({ type: "runtime.ready", connectionId }).success, false);
  }
});

test("Context compiler preserves tool pairing without executing anything", () => {
  const messages = [{ id: "message", turnId: "turn", role: "assistant" as const, content: [
    { type: "tool_use" as const, id: "tool", name: "bash", input: { command: "echo historical" } },
    { type: "tool_result" as const, tool_use_id: "tool", content: "historical result", is_error: false },
  ] }];
  const pi = contextToPiMessages(messages);
  assert.equal(pi[0]?.role, "assistant");
  assert.equal(pi[1]?.role, "toolResult");
  assert.equal(pi[1]?.toolCallId, "tool");
  const result = (pi[1]?.content as Array<{ text?: string }> | undefined)?.[0];
  assert(result);
  assert.equal(result.text, "historical result");
});

test("Context projection passes native reasoning through and drops what has no native form", () => {
  const messages = [{
    id: "assistant", turnId: "turn", role: "assistant" as const,
    provider: "anthropic", model: "claude",
    content: [
      { type: "thinking" as const, thinking: "signed", signature: "sig-1" },
      { type: "thinking" as const, thinking: "unsigned" },
      { type: "text" as const, text: "answer" },
      { type: "image" as const, source: { type: "url" as const, url: "https://example.com/a.png" } },
      { type: "system_note" as const, note_type: "info" as const, text: "note" },
    ],
  }];
  const pi = contextToPiMessages(messages, { resolveApi: () => "anthropic-messages", fallbackProvider: "anthropic" });
  const content = pi[0]?.content as Record<string, unknown>[];
  assert.deepEqual(content[0], { type: "thinking", thinking: "signed", thinkingSignature: "sig-1" });
  assert.deepEqual(content[1], { type: "thinking", thinking: "unsigned" });
  assert.deepEqual(content[2], { type: "text", text: "answer" });
  assert.equal(content.length, 3, "URL images and system notes are dropped, never rewritten as text");
  assert.equal(pi[0]?.api, "anthropic-messages");
  assert.equal(pi[0]?.provider, "anthropic");
});

test("Context projection skips compaction rows, pending generation placeholders and system notes", () => {
  const messages = [
    { id: "compact", turnId: "t1", role: "system" as const, content: [{ type: "system_note" as const, note_type: "compacted" as const, text: "summary" }] },
    { id: "note", turnId: "t1", role: "system" as const, content: [{ type: "system_note" as const, note_type: "info" as const, text: "created" }] },
    { id: "pending", turnId: "t2", role: "assistant" as const, content: [{ type: "text" as const, text: "placeholder" }], meta: { messageKind: "generation_result", generationStatus: "queued" } },
    { id: "done", turnId: "t3", role: "assistant" as const, content: [{ type: "text" as const, text: "finished" }], meta: { messageKind: "generation_result", generationStatus: "completed" } },
  ];
  const pi = contextToPiMessages(messages, { fallbackProvider: "cohub" });
  const texts = pi.map((message) => (message.content as Array<{ text?: string }>).map((block) => block.text ?? "").join(""));
  assert.equal(texts.some((text) => text.includes("summary")), false);
  assert.equal(texts.some((text) => text.includes("placeholder")), false);
  assert.equal(texts.some((text) => text.includes("finished")), true);
  assert.equal(pi.every((message) => message.timestamp === 0), true);
});

test("Runtime capabilities drop thinking levels this build does not know", () => {
  const model = { harness: "codex", provider: "openai", id: "m", name: "M", reasoning: true };
  const [parsed] = runtimeCapabilitiesSchema.parse({ harnesses: ["codex"], models: [{ ...model, defaultThinkingLevel: "future", thinkingLevelMap: { high: "high", ultra: "ultra", future: "future" } }] }).models;
  assert.equal(parsed?.defaultThinkingLevel, undefined);
  assert.deepEqual(parsed?.thinkingLevelMap, { high: "high", ultra: "ultra" });
});

test("local thinking levels clamp to what a model declares and pass through otherwise", () => {
  const base = { harness: "pi" as const, provider: "p", id: "m", name: "M" };
  assert.equal(resolveRuntimeThinkingLevel({ ...base, reasoning: true }, "ultra"), "high");
  assert.equal(resolveRuntimeThinkingLevel({ ...base, reasoning: true, thinkingLevelMap: { ultra: "ultra" } }, "ultra"), "ultra");
  assert.equal(resolveRuntimeThinkingLevel({ ...base, reasoning: false }, "high"), "off");
  assert.equal(resolveRuntimeThinkingLevel(base, "high"), "high");
  assert.equal(resolveRuntimeThinkingLevel(undefined, "ultra"), "ultra");
});
