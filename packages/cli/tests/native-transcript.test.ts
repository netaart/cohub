import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm, mkdir, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readNativeTranscript, readNativeTranscriptHeader, ensurePlainCodexRollout } from "../src/runtime/native/transcript.js";

const at = "2026-09-21T00:00:00.000Z";
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
/** Paginated rollouts stamp every record with a file-wide continuous ordinal. */
const writeRollout = async (path: string, header: Record<string, unknown>, ...groups: Array<Array<Record<string, unknown>>>) => {
  const rows = [header, ...groups.flat()].map((row, ordinal) => ({ timestamp: at, ...row, ordinal }));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map(line).join(""));
};
function piHeader(id: string, cwd: string) { return line({ type: "session", version: 3, id, cwd, timestamp: at }); }
function piMessage(id: string, parentId: string | null, role: string, content: unknown, extra: Record<string, unknown> = {}) {
  return line({ type: "message", id, parentId, timestamp: at, message: { role, content, timestamp: Date.parse(at), ...extra } });
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cohub-native-sync-"));
  const nativeSessionId = randomUUID();
  const path = join(root, "session.jsonl");
  return { root, path, nativeSessionId, header: piHeader(nativeSessionId, root), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("Pi captures complete user Turns, preserves tools/thinking, and excludes partial trailing records", async () => {
  const f = await fixture();
  try {
    const raw = f.header + piMessage("u1", null, "user", "你好")
      + piMessage("a1", "u1", "assistant", [{ type: "thinking", thinking: "reason" }, { type: "toolCall", id: "call", name: "bash", arguments: { command: "echo ok" } }], { stopReason: "toolUse" })
      + piMessage("r1", "a1", "toolResult", [{ type: "text", text: "ok" }], { toolCallId: "call" })
      + piMessage("done", "r1", "assistant", [{ type: "text", text: "done" }], { stopReason: "stop" });
    await writeFile(f.path, `${raw}{"partial":`);
    const running = await readNativeTranscript(f.path, "pi");
    assert.equal(running.turns[0]?.result, null);
    const settled = await readNativeTranscript(f.path, "pi", { settled: true });
    assert.equal(settled.turns.length, 1);
    assert.equal(settled.turns[0]?.endBytes, Buffer.byteLength(raw));
    assert.equal(settled.turns[0]?.result?.messages.length, 2);
    assert.deepEqual(settled.turns[0]?.result?.messages[0]?.content.map((block) => block.type), ["thinking", "tool_use", "tool_result"]);
    assert.equal(settled.turns[0]?.result?.status, "completed");
  } finally { await f.cleanup(); }
});

test("large UTF-8 native records keep exact byte boundaries and hashes across read chunks", async () => {
  const f = await fixture();
  try {
    const text = "原始内容".repeat(40_000);
    const raw = f.header + piMessage("u1", null, "user", text) + piMessage("a1", "u1", "assistant", [{ type: "text", text: "done" }], { stopReason: "stop" });
    await writeFile(f.path, raw);
    const turn = (await readNativeTranscript(f.path, "pi", { settled: true })).turns[0];
    assert.deepEqual(turn?.userContent, [{ type: "text", text }]);
    assert.equal(turn?.endBytes, Buffer.byteLength(raw));
    assert.equal(turn?.sha256, createHash("sha256").update(raw).digest("hex"));
  } finally { await f.cleanup(); }
});

test("Codex uses native Turn boundaries, not Stop-hook timing; usage and tool pairing survive", async () => {
  const f = await fixture();
  try {
    const rows = [
      { type: "session_meta", payload: { id: f.nativeSessionId, cwd: f.root, history_mode: "paginated" } },
      { type: "event_msg", payload: { type: "turn_started", turn_id: "native-turn" } },
      { type: "turn_context", payload: { model: "codex-model" } },
      { type: "event_msg", payload: { type: "user_message", message: "question" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "question" }] } },
      { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "tool", arguments: '{"cmd":"pwd"}' } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "tool", output: "/project" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] } },
      { type: "token_usage_record", payload: { turn_id: "native-turn", turn_token_usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 5, total_tokens: 15 } } },
    ].map((row) => ({ timestamp: at, ...row }));
    await writeFile(f.path, rows.map(line).join(""));
    assert.equal((await readNativeTranscript(f.path, "codex", { settled: true })).turns[0]?.result, null);
    rows.push({ timestamp: at, type: "event_msg", payload: { type: "turn_complete", turn_id: "native-turn" } } as typeof rows[number]);
    await writeFile(f.path, rows.map(line).join(""));
    const turn = (await readNativeTranscript(f.path, "codex")).turns[0];
    assert.equal(turn?.result?.status, "completed");
    assert.deepEqual(turn?.result?.messages[0]?.content.map((block) => block.type), ["tool_use", "tool_result"]);
    assert.equal(turn?.result?.messages.at(-1)?.usage?.input, 7);
    assert.equal(turn?.result?.messages.at(-1)?.usage?.cacheRead, 3);
  } finally { await f.cleanup(); }
});

test("Codex terminal errors remain failed, rather than becoming successful completions", async () => {
  const f = await fixture();
  try {
    const rows = [
      { type: "session_meta", payload: { id: f.nativeSessionId, cwd: f.root } },
      { type: "event_msg", payload: { type: "turn_started", turn_id: "failed" } },
      { type: "event_msg", payload: { type: "user_message", message: "request" } },
      { type: "event_msg", payload: { type: "turn_complete", turn_id: "failed", error: { message: "provider unavailable" } } },
    ];
    await writeFile(f.path, rows.map((row) => line({ timestamp: at, ...row })).join(""));
    const result = (await readNativeTranscript(f.path, "codex")).turns[0]?.result;
    assert.equal(result?.status, "failed");
    assert.equal(result?.messages.at(-1)?.errorMessage, "provider unavailable");
  } finally { await f.cleanup(); }
});

test("Codex lineage stitches a rollout chain with exact history bases", async () => {
  const f = await fixture();
  const previousHome = process.env.CODEX_HOME;
  const home = join(f.root, "codex-home");
  process.env.CODEX_HOME = home;
  try {
    // Ancestor rollout under sessions/YYYY/MM/DD with two settled Turns.
    const ancestorDir = join(home, "sessions", "2026", "09", "21");
    await mkdir(ancestorDir, { recursive: true });
    const ancestorId = randomUUID();
    const ancestorPath = join(ancestorDir, `rollout-2026-09-21T00-00-00-${ancestorId}.jsonl`);
    const ancestorTurn = (n: number) => [
      { type: "event_msg", payload: { type: "turn_started", turn_id: `a${n}` } },
      { type: "event_msg", payload: { type: "user_message", message: `q${n}` } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `a${n}` }] } },
      { type: "event_msg", payload: { type: "turn_complete", turn_id: `a${n}` } },
    ];
    await writeRollout(ancestorPath, { type: "session_meta", payload: { id: ancestorId, cwd: f.root, history_mode: "paginated" } }, ancestorTurn(1), ancestorTurn(2));
    const endByteOffset = (await stat(ancestorPath)).size;
    // Leaf rollout references the ancestor prefix through history_base.
    const leafDir = join(home, "sessions", "2026", "09", "22");
    await mkdir(leafDir, { recursive: true });
    const leafThread = randomUUID();
    const leafPath = join(leafDir, `rollout-2026-09-22T00-00-00-${leafThread}.jsonl`);
    await writeRollout(leafPath, { type: "session_meta", payload: { id: leafThread, cwd: f.root, history_mode: "paginated", history_base: { thread_id: ancestorId, end_ordinal_exclusive: 9, end_byte_offset: endByteOffset } } },
      [{ type: "event_msg", payload: { type: "turn_started", turn_id: "l1" } },
       { type: "event_msg", payload: { type: "user_message", message: "leaf question" } },
       { type: "event_msg", payload: { type: "turn_complete", turn_id: "l1", last_agent_message: "leaf answer" } }]);

    const transcript = await readNativeTranscript(leafPath, "codex");
    assert.equal(transcript.nativeSessionId, leafThread);
    assert.equal(transcript.turns.length, 3);
    assert.deepEqual(transcript.turns.map((turn) => turn.key), ["a1", "a2", "l1"]);
    assert.deepEqual(transcript.turns.map((turn) => turn.parentKey), [null, "a1", "a2"]);
    assert.equal(transcript.turns[0]?.path, ancestorPath);
    assert.equal(transcript.turns[2]?.path, leafPath);
    assert.equal(transcript.turns[2]?.sequence, 2);
    assert.deepEqual(transcript.lineagePaths, [ancestorPath, leafPath]);

    // Incomplete ancestor prefix: the referenced boundary must sit at a settled Turn end.
    const midTurn = Buffer.byteLength(
      [ { type: "session_meta", payload: { id: ancestorId, cwd: f.root, history_mode: "paginated" } }, ...ancestorTurn(1), ancestorTurn(2)[0], ancestorTurn(2)[1] ]
        .map((row, ordinal) => ({ timestamp: at, ...row, ordinal })).map(line).join(""),
    );
    const brokenPath = join(leafDir, `rollout-2026-09-22T01-00-00-${randomUUID()}.jsonl`);
    // The cut lands mid-Turn (after a2's user message, ordinal 5): the settled-Turn check fires
    // first via the ordinal bound, since 5 != any whole-Turn edge; both errors are acceptable.
    await writeFile(brokenPath, line({ type: "session_meta", payload: { id: randomUUID(), cwd: f.root, history_mode: "paginated", history_base: { thread_id: ancestorId, end_ordinal_exclusive: 6, end_byte_offset: midTurn } } }));
    await assert.rejects(readNativeTranscript(brokenPath, "codex"), /not at a completed Turn|ordinal bound/);

  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await f.cleanup();
  }
});

test("Codex lineage rejects an ordinal bound that does not match the ancestor prefix", async () => {
  const f = await fixture();
  const previousHome = process.env.CODEX_HOME;
  const home = join(f.root, "codex-home");
  process.env.CODEX_HOME = home;
  try {
    const dir = join(home, "sessions", "2026", "09", "21");
    await mkdir(dir, { recursive: true });
    const ancestorId = randomUUID();
    const ancestorPath = join(dir, `rollout-2026-09-21T00-00-00-${ancestorId}.jsonl`);
    // A paginated ancestor stamps every record with its ordinal.
    const rows = [{ timestamp: at, type: "session_meta", payload: { id: ancestorId, cwd: f.root, history_mode: "paginated" }, ordinal: 0 }];
    const addTurn = (key: string) => {
      for (const payload of [
        { type: "turn_started", turn_id: key },
        { type: "user_message", message: `q ${key}` },
        { type: "turn_complete", turn_id: key, last_agent_message: `a ${key}` },
      ]) rows.push({ timestamp: at, type: "event_msg", payload, ordinal: rows.length });
    };
    addTurn("a1");
    await writeFile(ancestorPath, rows.map(line).join(""));
    const endBytes = (await stat(ancestorPath)).size;
    const leafDir = join(home, "sessions", "2026", "09", "22");
    await mkdir(leafDir, { recursive: true });
    const leaf = (n: number) => join(leafDir, `rollout-2026-09-22T0${n}-00-00-${randomUUID()}.jsonl`);
    const goodLeaf = leaf(1), badLeaf = leaf(2);
    // Correct bound: the last ordinal is 3, so end_ordinal_exclusive is 4.
    await writeFile(goodLeaf, line({ type: "session_meta", payload: { id: randomUUID(), cwd: f.root, history_mode: "paginated", history_base: { thread_id: ancestorId, end_ordinal_exclusive: 4, end_byte_offset: endBytes } }, ordinal: 0 }));
    const transcript = await readNativeTranscript(goodLeaf, "codex");
    assert.equal(transcript.turns.length, 1);
    // A wrong ordinal must be rejected even when the byte bound is valid.
    await writeFile(badLeaf, line({ type: "session_meta", payload: { id: randomUUID(), cwd: f.root, history_mode: "paginated", history_base: { thread_id: ancestorId, end_ordinal_exclusive: 999, end_byte_offset: endBytes } }, ordinal: 0 }));
    await assert.rejects(readNativeTranscript(badLeaf, "codex"), /ordinal bound/);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await f.cleanup();
  }
});

test("a missing .zst rollout fails immediately instead of hanging", async () => {
  const f = await fixture();
  const previousHome = process.env.CODEX_HOME;
  const home = join(f.root, "codex-home");
  process.env.CODEX_HOME = home;
  try {
    const dir = join(home, "sessions", "2026", "09", "21");
    await mkdir(dir, { recursive: true });
    const missingPath = join(dir, `rollout-2026-09-21T00-00-00-${randomUUID()}.jsonl.zst`);
    // Only the header read is needed to trigger the source open; it must surface ENOENT.
    await assert.rejects(readNativeTranscriptHeader(missingPath, "codex"), /ENOENT/);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await f.cleanup();
  }
});

test("decompressing an oversized rollout stops at the local limit", async () => {
  const { zstdCompressSync } = await import("node:zlib");
  const f = await fixture();
  try {
    const compressed = join(f.root, "huge.jsonl.zst");
    await writeFile(compressed, zstdCompressSync(Buffer.alloc(64 * 1024, 97)));
    const cache = join(f.root, "cache");
    await assert.rejects(ensurePlainCodexRollout(compressed, cache, undefined, 1024), /local limit/);
    assert.deepEqual(await readdir(cache), [], "the failed temporary file is cleaned up");
    // The default bound passes and the plain file is cached once.
    const plain = await ensurePlainCodexRollout(compressed, cache);
    assert.equal((await stat(plain)).size, 64 * 1024);
  } finally { await f.cleanup(); }
});

test("a Codex header larger than one read chunk still parses exactly at its newline", async () => {
  const f = await fixture();
  const previousHome = process.env.CODEX_HOME;
  const home = join(f.root, "codex-home");
  process.env.CODEX_HOME = home;
  try {
    const dir = join(home, "sessions", "2026", "09", "21");
    await mkdir(dir, { recursive: true });
    const threadId = randomUUID();
    const path = join(dir, `rollout-2026-09-21T00-00-00-${threadId}.jsonl`);
    // base_instructions can be hundreds of KiB; the header spans many 64 KiB read chunks.
    const header = { type: "session_meta", payload: { id: threadId, cwd: f.root, history_mode: "paginated", base_instructions: "x".repeat(200 * 1024) } };
    await writeFile(path, `${JSON.stringify(header)}\n${[
      { timestamp: at, type: "event_msg", payload: { type: "turn_started", turn_id: "t1" } },
      { timestamp: at, type: "event_msg", payload: { type: "user_message", message: "q" } },
      { timestamp: at, type: "event_msg", payload: { type: "turn_complete", turn_id: "t1", last_agent_message: "a" } },
    ].map(line).join("")}`);
    const transcript = await readNativeTranscript(path, "codex");
    assert.equal(transcript.nativeSessionId, threadId);
    assert.equal(transcript.turns.length, 1);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await f.cleanup();
  }
});

test("a lineage crossing projects is rejected instead of importing foreign history", async () => {
  const f = await fixture();
  const previousHome = process.env.CODEX_HOME;
  const home = join(f.root, "codex-home");
  process.env.CODEX_HOME = home;
  const other = await mkdtemp(join(tmpdir(), "other-project-"));
  try {
    const day = (n: number) => join(home, "sessions", "2026", "09", `0${n}`);
    const rollout = (n: number, id: string) => join(day(n), `rollout-2026-09-0${n}T00-00-00-${id}.jsonl`);
    const turn = (key: string) => [
      { type: "event_msg", payload: { type: "turn_started", turn_id: key } },
      { type: "event_msg", payload: { type: "user_message", message: `q ${key}` } },
      { type: "event_msg", payload: { type: "turn_complete", turn_id: key, last_agent_message: `a ${key}` } },
    ];
    const threadId = randomUUID();
    const ancestorPath = rollout(1, threadId);
    await writeRollout(ancestorPath, { type: "session_meta", payload: { id: threadId, cwd: other, history_mode: "paginated" } }, turn("x1"));
    const ancestorEnd = (await stat(ancestorPath)).size;
    const leafPath = rollout(2, `${threadId}_${randomUUID()}`);
    await writeRollout(leafPath, { type: "session_meta", payload: { id: threadId, cwd: f.root, history_mode: "paginated", history_base: { thread_id: threadId, end_ordinal_exclusive: 4, end_byte_offset: ancestorEnd } } }, turn("l1"));

    await assert.rejects(readNativeTranscript(leafPath, "codex"), /crosses projects/);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await rm(other, { recursive: true, force: true });
    await f.cleanup();
  }
});
