import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContentBlock } from "./src/core/content.js";
import { projectNativeMessageMeta, projectNativeSession, serializeProjection, type CanonicalProjectionMessage, type CanonicalProjectionTurn } from "./src/runtime/projection.js";

const sessionId = "session";
const iso = "2026-09-19T00:00:00.000Z";

function message(id: string, role: CanonicalProjectionMessage["role"], content: ContentBlock[], meta?: Record<string, unknown>): CanonicalProjectionMessage {
  return { id, turnId: "turn-1", role, content, meta, sourceSessionId: sessionId, sequence: 1, createdAt: iso };
}

function turn(messages: CanonicalProjectionMessage[], sequence = 1): CanonicalProjectionTurn {
  return {
    id: `turn-${sequence}`, sourceSessionId: sessionId, sourceTurnId: `turn-${sequence}`, sequence, status: "completed", intent: "followup",
    provider: "fixture", model: "test", userContent: [], assistantContent: null, meta: null, createdAt: iso, startedAt: iso, completedAt: iso, durationMs: 1, messages,
  };
}

test("Pi projection is deterministic, filters pending output, and preserves tool results", () => {
  const records = projectNativeSession({ spaceId: "space", sessionId, nativeSessionId: "native", cwd: "/repo", turns: [turn([
    message("user", "user", [{ type: "text", text: "run it" }, { type: "image", source: { type: "url", url: "https://example.invalid/image.png" } }]),
    message("pending", "assistant", [{ type: "text", text: "not settled" }], { messageKind: "generation_result", generationStatus: "running" }),
    message("assistant", "assistant", [{ type: "tool_use", id: "call-1", name: "shell", input: { command: "pwd" } }, { type: "tool_result", tool_use_id: "call-1", content: [{ type: "text", text: "/repo" }] }]),
  ])] }, "pi");
  const native = records.records.map((entry) => entry.record);
  assert.equal(native.filter((entry) => JSON.stringify(entry).includes("not settled")).length, 0);
  assert.equal(native.filter((entry) => entry.type === "message").length, 3);
  assert.equal(records.warnings.length, 1);
  assert.equal(serializeProjection(records).endsWith("\n"), true);
  assert.equal(records.cursor.sourceSequence, 1);
});

test("Codex projection emits a native rollout and excludes external images", () => {
  const result = projectNativeSession({ spaceId: "space", sessionId, nativeSessionId: "native", cwd: "/repo", turns: [turn([
    message("user", "user", [{ type: "text", text: "hello" }, { type: "image", source: { type: "url", url: "https://example.invalid/image.png" } }]),
    message("assistant", "assistant", [{ type: "thinking", thinking: "thinking" }, { type: "text", text: "done" }]),
  ])] }, "codex");
  assert.equal(result.records[0]?.record.type, "session_meta");
  assert(result.records.some((entry) => entry.record.type === "response_item"));
  assert(result.records.some((entry) => entry.record.type === "event_msg"));
  assert.equal(result.warnings.length, 1);
  assert.equal(JSON.stringify(result.records).includes("example.invalid"), false);
});

test("Codex projection shortens call ids over the Responses 64-char limit and keeps pairs linked", () => {
  const longId = `toolu_${"x".repeat(80)}`;
  const result = projectNativeSession({ spaceId: "space", sessionId, nativeSessionId: "native", cwd: "/repo", turns: [turn([
    message("assistant", "assistant", [
      { type: "tool_use", id: longId, name: "shell", input: { command: "pwd" } },
      { type: "tool_result", tool_use_id: longId, content: "/repo" },
      { type: "tool_use", id: "call-short", name: "shell", input: { command: "ls" } },
    ]),
  ])] }, "codex");
  const callIds = result.records.flatMap((entry) => {
    const payload = entry.record.payload as { call_id?: string } | undefined;
    return payload?.call_id ? [payload.call_id] : [];
  });
  assert.equal(callIds.length, 3);
  assert(callIds.every((id) => id.length <= 64));
  assert.equal(callIds[0], callIds[1]);
  assert.notEqual(callIds[0], longId);
  assert.equal(callIds[2], "call-short");
});

test("Codex projection preserves non-completed turn states as aborted terminal events", () => {
  for (const status of ["failed", "cancelled", "merged", "interrupted"] as const) {
    const result = projectNativeSession({ spaceId: "space", sessionId, nativeSessionId: "native", cwd: "/repo", turns: [{ ...turn([]), status }] }, "codex");
    const terminal = result.records.at(-1)?.record.payload as { type?: string; reason?: string } | undefined;
    assert.equal(terminal?.type, "turn_aborted");
    assert.equal(terminal?.reason, status);
  }
});

test("Pi compaction drops pre-boundary history and points to the first retained native record", () => {
  const prior = turn([message("prior", "user", [{ type: "text", text: "must be compacted away" }])]);
  const retained = { ...turn([
    message("compaction", "system", [{ type: "system_note", note_type: "compacted", text: "keep the next message" }], { compaction: { firstKeptEntryId: "agent-entry", tokensBefore: 20 } }),
    message("assistant", "assistant", [
      { type: "tool_use", id: "call-1", name: "shell", input: { command: "pwd" } },
      { type: "tool_result", tool_use_id: "call-1", content: [{ type: "text", text: "/repo" }] },
    ], { agentSessionEntryId: "agent-entry" }),
  ], 2), id: "turn-2", sourceTurnId: "turn-2" };
  const result = projectNativeSession({ spaceId: "space", sessionId, nativeSessionId: "native", cwd: "/repo", turns: [prior, retained] }, "pi");
  assert.equal(JSON.stringify(result.records).includes("must be compacted away"), false);
  const compaction = result.records.find((entry) => entry.record.type === "compaction")?.record;
  const messages = result.records.filter((entry) => entry.record.type === "message");
  assert.equal(compaction?.firstKeptEntryId, messages[0]?.record.id);
});

test("projection metadata is allowlisted", () => {
  const source = message("safe", "assistant", [{ type: "text", text: "ok" }], { nativeApi: "fixture", secret: "do not copy" });
  const meta = projectNativeMessageMeta(source);
  assert.equal(meta.nativeApi, "fixture");
  assert.equal("secret" in meta, false);
});

test("projection fingerprints change when source content changes", () => {
  const base = turn([message("assistant", "assistant", [{ type: "text", text: "one" }])]);
  const changed = turn([message("assistant", "assistant", [{ type: "text", text: "two" }])]);
  const input = { spaceId: "space", sessionId, nativeSessionId: "native", cwd: "/repo" };
  assert.notEqual(projectNativeSession({ ...input, turns: [base] }, "pi").cursor.sourceFingerprint, projectNativeSession({ ...input, turns: [changed] }, "pi").cursor.sourceFingerprint);
});
