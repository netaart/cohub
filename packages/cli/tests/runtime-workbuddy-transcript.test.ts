import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readNativeTranscript, readNativeTranscriptHeader } from "../src/runtime/native/transcript.js";
import { projectNativeSession, serializeProjection, type CanonicalProjectionMessage } from "../../protocol/src/runtime/projection.js";

const at = "2026-10-12T00:00:00.000Z";
const jsonl = (rows: unknown[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join("");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workbuddy-transcript-"));
  const sessionId = randomUUID();
  const path = join(root, `${sessionId}.jsonl`);
  const row = (id: string, parentId: string | null, type: string, rest: Record<string, unknown> = {}) => ({ id, parentId, type, sessionId, cwd: root, timestamp: at, ...rest });
  return { root, sessionId, path, row, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("WorkBuddy reads top-level messages, tools, reasoning, usage and exact byte receipts", async () => {
  const f = await fixture();
  try {
    const raw = jsonl([
      f.row("u1", null, "message", { role: "user", content: [{ type: "input_text", text: "你好" }] }),
      f.row("r1", "u1", "reasoning", { content: [], rawContent: [{ type: "reasoning_text", text: "think" }] }),
      f.row("c1", "r1", "function_call", { name: "bash", arguments: '{"command":"pwd"}', callId: "call" }),
      f.row("t1", "c1", "function_call_result", { name: "bash", output: { type: "input_text", text: "ok" }, callId: "call", status: "completed" }),
      f.row("a1", "t1", "message", { role: "assistant", status: "completed", content: [{ type: "output_text", text: "done" }], message: { usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, cache_read_input_tokens: 2 } } }),
    ]);
    await writeFile(f.path, `${raw}{"partial":`);
    assert.equal((await readNativeTranscript(f.path, "workbuddy")).turns[0]?.result, null);
    const transcript = await readNativeTranscript(f.path, "workbuddy", { settled: true });
    assert.equal(transcript.nativeSessionId, f.sessionId);
    assert.equal(transcript.cwd, f.root);
    const turn = transcript.turns[0];
    assert(turn);
    assert.deepEqual(turn.userContent, [{ type: "text", text: "你好" }]);
    assert.deepEqual(turn.messages.flatMap((message) => message.content.map((block) => block.type)), ["thinking", "tool_use", "tool_result", "text"]);
    assert.equal(turn.result?.status, "completed");
    assert.equal(turn.messages.at(-1)?.usage?.cacheRead, 2);
    assert.equal(turn.endBytes, Buffer.byteLength(raw));
    assert.equal(turn.sha256, createHash("sha256").update(raw).digest("hex"));
    assert.equal(transcript.prefixes.get(turn.endBytes), turn.sha256);
    assert.deepEqual(await readNativeTranscriptHeader(f.path, "workbuddy"), { nativeSessionId: f.sessionId, cwd: f.root });
  } finally { await f.cleanup(); }
});

test("WorkBuddy applies persisted message updates exactly once and retains the latest status", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, jsonl([
      f.row("u1", null, "message", { role: "user", content: [{ type: "input_text", text: "q" }] }),
      f.row("a1", "u1", "message", { role: "assistant", status: "incomplete", content: [{ type: "output_text", text: "par" }] }),
      f.row("a1", "u1", "message", { role: "assistant", status: "completed", content: [{ type: "output_text", text: "complete" }] }),
      { type: "ai-title", aiTitle: "Title" },
    ]));
    const turn = (await readNativeTranscript(f.path, "workbuddy", { settled: true })).turns[0];
    assert(turn);
    assert.deepEqual(turn.messages.map((message) => message.content), [[{ type: "text", text: "complete" }]]);
    assert.equal(turn.result?.status, "completed");
    assert.equal(turn.endBytes, (await readFile(f.path)).length, "metadata must remain in the archived byte range");
    assert.ok(turn.contentEndBytes < turn.endBytes, "title metadata must not move the content boundary");
  } finally { await f.cleanup(); }
});

test("WorkBuddy preserves text and parallel tool calls that share one native message id", async () => {
  const f = await fixture();
  try {
    const raw = jsonl([
      f.row("u1", null, "message", { role: "user", content: [{ type: "input_text", text: "inspect" }] }),
      f.row("shared", "u1", "message", { role: "assistant", status: "completed", content: [{ type: "output_text", text: "Checking both" }] }),
      f.row("shared", "u1", "function_call", { name: "Read", arguments: '{"path":"first"}', callId: "first-call" }),
      f.row("shared", "u1", "function_call", { name: "Read", arguments: '{"path":"second"}', callId: "second-call" }),
      f.row("r1", "shared", "function_call_result", { name: "Read", output: { type: "text", text: "first result" }, callId: "first-call", status: "completed" }),
      f.row("r2", "r1", "function_call_result", { name: "Read", output: { type: "text", text: "second result" }, callId: "second-call", status: "completed" }),
      f.row("final", "r2", "message", { role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done" }] }),
    ]);
    await writeFile(f.path, raw);
    const turn = (await readNativeTranscript(f.path, "workbuddy", { settled: true })).turns[0];
    assert(turn);
    const blocks = turn.messages.flatMap((message) => message.content);
    assert.deepEqual(blocks.filter((block) => block.type === "text").map((block) => block.text), ["Checking both", "Done"]);
    assert.deepEqual(blocks.filter((block) => block.type === "tool_use").map((block) => block.id), ["first-call", "second-call"]);
    assert.deepEqual(blocks.filter((block) => block.type === "tool_result").map((block) => block.tool_use_id), ["first-call", "second-call"]);
    assert.equal(turn.result?.status, "completed");
    assert.equal(turn.endBytes, Buffer.byteLength(raw));
  } finally { await f.cleanup(); }
});

test("WorkBuddy preserves branches and never declares an unresolved tool successful", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, jsonl([
      f.row("u1", null, "message", { role: "user", content: [{ type: "input_text", text: "one" }] }),
      f.row("a1", "u1", "message", { role: "assistant", status: "completed", content: [{ type: "output_text", text: "answer" }] }),
      f.row("u2", "a1", "message", { role: "user", content: [{ type: "input_text", text: "old branch" }] }),
      f.row("u3", "a1", "message", { role: "user", content: [{ type: "input_text", text: "new branch" }] }),
      f.row("c1", "u3", "function_call", { name: "bash", arguments: "{}", callId: "call" }),
    ]));
    const parsed = await readNativeTranscript(f.path, "workbuddy", { settled: true });
    assert.deepEqual(parsed.turns.map((turn) => [turn.key, turn.parentKey]), [["u1", null], ["u2", "u1"], ["u3", "u1"]]);
    assert.equal(parsed.turns.at(-1)?.result?.status, "interrupted");
  } finally { await f.cleanup(); }
});

test("WorkBuddy rejects corrupt content and missing history instead of importing empty messages", async () => {
  const f = await fixture();
  try {
    for (const row of [
      f.row("u1", null, "message", { role: "user", content: [{ type: "unknown", text: "not disposable" }] }),
      f.row("u1", "missing", "message", { role: "user", content: [{ type: "input_text", text: "q" }] }),
      f.row("u1", null, "message", { role: "user", content: "bad" }),
    ]) {
      await writeFile(f.path, jsonl([row]));
      await assert.rejects(readNativeTranscript(f.path, "workbuddy"), /WorkBuddy/);
    }
  } finally { await f.cleanup(); }
});

test("WorkBuddy roundtrips projected compaction, images, tools and cloud identities", async () => {
  const f = await fixture();
  try {
    const turnId = randomUUID(), sessionId = randomUUID();
    const message = (role: CanonicalProjectionMessage["role"], content: CanonicalProjectionMessage["content"]): CanonicalProjectionMessage => ({ id: randomUUID(), turnId, role, content, sourceSessionId: sessionId, sequence: 1, createdAt: at });
    const projected = projectNativeSession({ spaceId: randomUUID(), sessionId, nativeSessionId: f.sessionId, cwd: f.root, turns: [{
      id: turnId, sourceSessionId: sessionId, sourceTurnId: turnId, sequence: 1, status: "completed", intent: "prompt", provider: null, model: null, userContent: [], assistantContent: null, meta: null, createdAt: at, startedAt: at, completedAt: at, durationMs: 0,
      messages: [message("system", [{ type: "system_note", note_type: "compacted", text: "summary" }]), message("user", [{ type: "text", text: "q" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }]), message("assistant", [{ type: "tool_use", id: "call", name: "bash", input: {} }, { type: "tool_result", tool_use_id: "call", content: "failed", is_error: true }, { type: "text", text: "a" }])],
    }] }, "workbuddy");
    assert.deepEqual(projected.warnings, []);
    await writeFile(f.path, serializeProjection(projected));
    const parsed = await readNativeTranscript(f.path, "workbuddy", { settled: true });
    assert.equal(parsed.cloudSessionId, sessionId);
    assert.equal(parsed.turns[0]?.cloudTurnId, turnId);
    assert.deepEqual(parsed.turns[0]?.userContent.map((block) => block.type), ["system_note", "text", "image"]);
    assert.deepEqual(parsed.turns[0]?.messages.flatMap((message) => message.content.map((block) => block.type)), ["tool_use", "tool_result", "text"]);
  } finally { await f.cleanup(); }
});
