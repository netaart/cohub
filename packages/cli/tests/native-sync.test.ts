import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, readdir, mkdir, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readNativeTranscript } from "../src/runtime/native-transcript.js";
import { NativeSyncStore, nativeStableId, type NativeSyncTransport } from "../src/runtime/native-sync-store.js";
import { RuntimeArchiveStore } from "../src/runtime/archive-store.js";
import { codexNativeHookBlock } from "../src/runtime/native-install.js";
import { archiveStorageFixture } from "./fixtures/runtime-archive-storage.js";
import { TestRuntimeSessionStore } from "./fixtures/runtime-projection-source.js";
import type { RuntimeTurnInput } from "@neta-art/cohub";
import type { NativeTurnBinding, NativeTurnComplete, NativeTurnStart } from "@neta-art/cohub";

const at = "2026-09-21T00:00:00.000Z";
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
function piHeader(id: string, cwd: string) { return line({ type: "session", version: 3, id, cwd, timestamp: at }); }
function piMessage(id: string, parentId: string | null, role: string, content: unknown, extra: Record<string, unknown> = {}) {
  return line({ type: "message", id, parentId, timestamp: at, message: { role, content, timestamp: Date.parse(at), ...extra } });
}
function piTurn(n: number) {
  return piMessage(`u${n}`, n > 1 ? `a${n - 1}` : null, "user", `question ${n}`)
    + piMessage(`a${n}`, `u${n}`, "assistant", [{ type: "text", text: `answer ${n}` }], { stopReason: "stop", model: "native-model", provider: "native" });
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cohub-native-sync-"));
  const nativeSessionId = randomUUID(), spaceId = randomUUID();
  const path = join(root, "session.jsonl");
  const options = { runtimeRoot: join(root, "state"), spaceId, identity: "test:owner", harness: "pi" as const, nativeSessionId };
  return { root, path, nativeSessionId, options, header: piHeader(nativeSessionId, root), cleanup: () => rm(root, { recursive: true, force: true }) };
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
    const { createHash } = await import("node:crypto");
    assert.deepEqual(turn?.userContent, [{ type: "text", text }]);
    assert.equal(turn?.endBytes, Buffer.byteLength(raw));
    assert.equal(turn?.sha256, createHash("sha256").update(raw).digest("hex"));
  } finally { await f.cleanup(); }
});

test("offline Turns survive restart; lost start/result ACKs replay receipts, not model work", async () => {
  const f = await fixture();
  const storage = await archiveStorageFixture();
  const starts = new Map<string, NativeTurnBinding>(), results = new Map<string, NativeTurnComplete>();
  const requests: NativeTurnStart[] = [];
  let loseStart = true, loseComplete = true;
  const transport: NativeSyncTransport = { ...storage.transport,
    startNativeTurn: async (request) => {
      requests.push(request);
      let binding = starts.get(request.turnId);
      if (!binding) { binding = { sessionId: request.sessionId ?? request.branchSessionId, turnId: request.turnId, forked: false }; starts.set(request.turnId, binding); }
      if (loseStart) { loseStart = false; throw new Error("lost start ACK"); }
      return binding;
    },
    completeNativeTurn: async (_session, turnId, result) => {
      if (results.has(turnId)) assert.deepEqual(result, results.get(turnId));
      results.set(turnId, result);
      if (loseComplete) { loseComplete = false; throw new Error("lost result ACK"); }
      return { completed: true };
    },
  };
  try {
    const bytes = f.header + piTurn(1) + piTurn(2);
    await writeFile(f.path, bytes);
    const local = new NativeSyncStore(f.options);
    await local.capture(f.path, await readNativeTranscript(f.path, "pi", { settled: true }));
    assert.equal((await local.receipts()).length, 2);
    const signal = new AbortController().signal;
    const reconnect = () => new NativeSyncStore({ ...f.options, transport }).flush(signal);
    await assert.rejects(reconnect(), /lost start ACK/);
    await assert.rejects(reconnect(), /lost result ACK/);
    await reconnect();
    assert.equal(starts.size, 2); assert.equal(results.size, 2);
    assert.deepEqual(requests[0], requests[1]);
    assert.equal(requests.at(-1)?.parentTurnId, requests[0]?.turnId);
    const receipts = await local.receipts();
    const second = receipts[1]; assert(second);
    const binding = starts.get(second.turnId); assert(binding);
    assert.equal(storage.versions.size, 2);
    const target = join(f.root, "restored.jsonl");
    await new RuntimeArchiveStore(join(f.root, "restore"), storage.transport).restore({ ...binding, harness: "pi" }, target);
    assert.equal(await readFile(target, "utf8"), bytes);
    await reconnect();
    assert.equal(requests.length, 3);
    assert.equal((await readdir(join(local.root, "turns"))).length, 2, "ACK never removes original receipts");
  } finally { await storage.close(); await f.cleanup(); }
});

test("automatic fork rebinds subsequent Turns; archive starts a valid baseline instead of a cross-Session parent", async () => {
  const f = await fixture();
  const storage = await archiveStorageFixture();
  const requests: NativeTurnStart[] = [];
  const forks = new Map<string, NativeTurnBinding>();
  try {
    let count = 0;
    const transport: NativeSyncTransport = { ...storage.transport,
      startNativeTurn: async (input) => {
        requests.push(input);
        const binding = { turnId: input.turnId, sessionId: ++count === 2 ? input.branchSessionId : input.sessionId ?? input.branchSessionId, forked: count === 2 };
        forks.set(input.turnId, binding); return binding;
      }, completeNativeTurn: async () => ({ completed: true }),
    };
    const bytes = f.header + piTurn(1) + piTurn(2) + piTurn(3);
    await writeFile(f.path, bytes);
    const store = new NativeSyncStore({ ...f.options, transport });
    await store.capture(f.path, await readNativeTranscript(f.path, "pi", { settled: true }));
    await store.flush(new AbortController().signal);
    const [first, second, third] = requests; assert(first && second && third);
    assert.equal(third.sessionId, second.branchSessionId);
    assert.notEqual(third.sessionId, first.branchSessionId);
    const index = storage.versions.get(second.turnId); assert(index);
    assert.equal(index.parentTurnId, null);
    assert.equal(index.sessionId, second.branchSessionId);
    assert.equal(storage.versions.get(third.turnId)?.parentTurnId, second.turnId);
    const restored = join(f.root, "fork.jsonl");
    await new RuntimeArchiveStore(join(f.root, "restore"), storage.transport).restore({ turnId: third.turnId, sessionId: third.sessionId as string, harness: "pi" }, restored);
    assert.equal(await readFile(restored, "utf8"), bytes);
  } finally { await storage.close(); await f.cleanup(); }
});

test("an orphan pending pointer from a crash window is dropped instead of blocking flush", async () => {
  const f = await fixture();
  try {
    const store = new NativeSyncStore(f.options);
    const orphanId = nativeStableId(`orphan-${randomUUID()}`);
    await mkdir(join(store.root, "pending"), { recursive: true });
    await writeFile(join(store.root, "pending", `${orphanId}.json`), JSON.stringify({ turnId: orphanId }));
    // The orphan is silently removed; flush of other receipts is not blocked.
    assert.equal((await store.receipts(true)).length, 0);
    assert.equal((await readdir(join(store.root, "pending"))).length, 0, "orphan pointer removed");
  } finally { await f.cleanup(); }
});

test("a fork archive does not wait for an unrelated parent's failed upload", async () => {
  const f = await fixture(), storage = await archiveStorageFixture();
  try {
    let firstTurn: string | null = null;
    const transport: NativeSyncTransport = { ...storage.transport,
      startNativeTurn: async (request) => {
        firstTurn ??= request.turnId;
        return { sessionId: request.branchSessionId, turnId: request.turnId, forked: request.sessionId !== null };
      },
      completeNativeTurn: async () => ({ completed: true }),
      prepareRuntimeArchive: async (index, options) => {
        if (index.turnId === firstTurn) throw new Error("parent upload unavailable");
        return storage.transport.prepareRuntimeArchive(index, options);
      },
    };
    await writeFile(f.path, f.header + piTurn(1) + piTurn(2));
    const store = new NativeSyncStore({ ...f.options, transport });
    await store.capture(f.path, await readNativeTranscript(f.path, "pi", { settled: true }));
    await assert.rejects(store.flush(new AbortController().signal), /parent upload unavailable/);
    const child = (await store.receipts())[1]; assert(child);
    assert.equal(storage.versions.get(child.turnId)?.parentTurnId, null);
    assert.equal(storage.versions.size, 1);
  } finally { await storage.close(); await f.cleanup(); }
});

test("existing Runtime Session/Turn binding is reused; original native file is never overwritten", async () => {
  const f = await fixture();
  try {
    const sessionId = randomUUID(), throughTurnId = randomUUID();
    const bytes = f.header + piTurn(1);
    await writeFile(f.path, bytes);
    await mkdir(join(f.options.runtimeRoot, "pi"), { recursive: true });
    const { createHash } = await import("node:crypto");
    await writeFile(join(f.options.runtimeRoot, "pi", `${sessionId}.json`), JSON.stringify({ version: 1, harness: "pi", sessionId, nativeSessionId: f.nativeSessionId, path: f.path, throughTurnId, pendingTurnId: null, checksum: createHash("sha256").update(bytes).digest("hex") }));
    const copyPath = join(f.root, "managed-copy.jsonl"), copySessionId = randomUUID(), copyTurnId = randomUUID();
    await writeFile(copyPath, bytes);
    await writeFile(join(f.options.runtimeRoot, "pi", `${copySessionId}.json`), JSON.stringify({ version: 1, harness: "pi", sessionId: copySessionId, nativeSessionId: f.nativeSessionId, path: copyPath, throughTurnId: copyTurnId, pendingTurnId: null, checksum: createHash("sha256").update(bytes).digest("hex") }));
    const store = new NativeSyncStore(f.options);
    await store.capture(f.path, await readNativeTranscript(f.path, "pi", { settled: true }));
    assert.equal((await store.binding()).sessionId, sessionId);
    assert.equal((await store.binding()).throughTurnId, throughTurnId);
    assert.equal((await store.receipts()).length, 0);
    await writeFile(f.path, bytes + piTurn(2));
    await store.capture(f.path, await readNativeTranscript(f.path, "pi", { settled: true }));
    assert.equal((await store.receipts())[0]?.parentCloudTurnId, throughTurnId);
    assert.equal(await readFile(f.path, "utf8"), bytes + piTurn(2));
    const copy = new NativeSyncStore({ ...f.options, instanceKey: copyPath });
    await copy.capture(copyPath, await readNativeTranscript(copyPath, "pi", { settled: true }));
    assert.equal((await copy.binding()).sessionId, copySessionId);
    await writeFile(copyPath, bytes + piTurn(2));
    await copy.capture(copyPath, await readNativeTranscript(copyPath, "pi", { settled: true }));
    assert.equal((await copy.receipts())[0]?.parentCloudTurnId, copyTurnId);
    assert.notEqual((await copy.receipts())[0]?.turnId, (await store.receipts())[0]?.turnId);
  } finally { await f.cleanup(); }
});

test("managed archive checkpoints resolve whole-Turn rewinds and tolerate trailing native metadata", async () => {
  const f = await fixture();
  try {
    const sessionId = randomUUID(), first = randomUUID(), second = randomUUID();
    const raw1 = f.header + piTurn(1), raw2 = raw1 + piTurn(2);
    const archives = new RuntimeArchiveStore(join(f.options.runtimeRoot, "archives"));
    const source = { sessionId, harness: "pi" as const, nativeSessionId: f.nativeSessionId, path: f.path };
    await writeFile(f.path, raw1); await archives.stage(source, first);
    await writeFile(f.path, raw2); await archives.stage(source, second);
    const { createHash } = await import("node:crypto");
    await mkdir(join(f.options.runtimeRoot, "pi"), { recursive: true });
    await writeFile(join(f.options.runtimeRoot, "pi", `${sessionId}.json`), JSON.stringify({ version: 1, harness: "pi", sessionId, nativeSessionId: f.nativeSessionId, path: f.path, throughTurnId: second, pendingTurnId: null, checksum: createHash("sha256").update(raw2).digest("hex") }));
    const store = new NativeSyncStore(f.options);
    await store.capture(f.path, await readNativeTranscript(f.path, "pi", { settled: true }));
    const metadata = line({ type: "custom", id: "metadata", parentId: "a2", timestamp: at, customType: "extension-state", data: {} });
    await writeFile(f.path, raw2 + metadata);
    await store.capture(f.path, await readNativeTranscript(f.path, "pi", { settled: true }));
    assert.equal((await store.receipts()).length, 0, "metadata is not a new Turn");
    const branch = piMessage("u3", "a1", "user", "branch from first Turn") + piMessage("a3", "u3", "assistant", [{ type: "text", text: "new branch" }], { stopReason: "stop" });
    await writeFile(f.path, raw2 + metadata + branch);
    await store.capture(f.path, await readNativeTranscript(f.path, "pi", { settled: true }));
    assert.equal((await store.receipts())[0]?.parentCloudTurnId, first);
    const partial = piMessage("u4", "u1", "user", "branch inside first Turn") + piMessage("a4", "u4", "assistant", [{ type: "text", text: "partial branch" }], { stopReason: "stop" });
    await writeFile(f.path, raw2 + metadata + branch + partial);
    await assert.rejects(store.capture(f.path, await readNativeTranscript(f.path, "pi", { settled: true })), /complete Runtime Turn boundary/);
    assert.equal((await store.receipts()).length, 1);
  } finally { await f.cleanup(); }
});

test("capture freezes exactly the observed Turn prefix and refuses a rewritten source", async () => {
  const f = await fixture();
  try {
    const raw = f.header + piTurn(1);
    await writeFile(f.path, raw);
    const observed = await readNativeTranscript(f.path, "pi", { settled: true });
    await writeFile(f.path, raw + piTurn(2));
    const store = new NativeSyncStore(f.options);
    await store.capture(f.path, observed);
    const [receipt] = await store.receipts(); assert(receipt);
    const index = JSON.parse(await readFile(join(store.archives.root, "versions", `${receipt.turnId}.json`), "utf8"));
    assert.equal(index.sizeBytes, Buffer.byteLength(raw));
    const observedNext = await readNativeTranscript(f.path, "pi", { settled: true });
    await writeFile(f.path, (raw + piTurn(2)).replace("answer 2", "changed!"));
    await assert.rejects(store.capture(f.path, observedNext), /changed during capture/);
    assert.equal((await store.receipts()).length, 1);
  } finally { await f.cleanup(); }
});

test("native intra-Turn rewinds never masquerade as whole-Turn forks", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, f.header + piMessage("u1", null, "user", "question") + piMessage("a1", "u1", "assistant", [{ type: "text", text: "first" }], { stopReason: "toolUse" }) + piMessage("a2", "a1", "assistant", [{ type: "text", text: "last" }], { stopReason: "stop" }));
    const store = new NativeSyncStore(f.options);
    await store.capture(f.path, await readNativeTranscript(f.path, "pi", { settled: true }));
    const original = await store.receipts();
    await assert.rejects(store.capture(f.path, await readNativeTranscript(f.path, "pi", { settled: true, leafId: "a1" })), /whole-Turn/);
    assert.deepEqual(await store.receipts(), original);
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

test("Runtime continuation preserves an interactive native file even through a symlink alias", async () => {
  const f = await fixture();
  const previousDirectory = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = join(f.root, "pi");
  try {
    const store = new TestRuntimeSessionStore(f.options.spaceId, f.root);
    const sessionId = randomUUID(), previousTurnId = randomUUID(), turnId = randomUUID();
    store.projectionSource.addTurn(sessionId, previousTurnId, { userContent: [{ type: "text", text: "prior context" }] });
    const input: RuntimeTurnInput = { spaceId: f.options.spaceId, sessionId, turnId, harness: "pi", userMessageId: turnId,
      messages: [{ turnId, userMessageId: turnId, userId: "owner", content: [{ type: "text", text: "continue" }] }], accessMode: "full_access",
      context: { revision: "r1", throughTurnId: previousTurnId, messages: [] } };
    const first = await store.prepare(input, f.root);
    const original = await readFile(first.state.path, "utf8");
    const alias = join(f.root, "native-link.jsonl");
    await symlink(first.state.path, alias);
    await mkdir(join(store.root, "pi"), { recursive: true });
    await writeFile(join(store.root, "pi", `${sessionId}.json`), JSON.stringify({ ...first.state, path: alias }));
    const { createHash } = await import("node:crypto");
    const marker = createHash("sha256").update(await realpath(first.state.path)).digest("hex");
    await mkdir(join(store.root, "native-owners"), { recursive: true });
    await writeFile(join(store.root, "native-owners", `${marker}.json`), "{}");
    const next = await store.prepare(input, f.root);
    assert.notEqual(next.state.path, alias);
    assert.notEqual(next.state.path, first.state.path);
    assert.equal(await readFile(alias, "utf8"), original);
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousDirectory;
    await f.cleanup();
  }
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

test("Codex referenced history fails explicitly; hook commands quote paths without disabling trust", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, line({ type: "session_meta", payload: { id: f.nativeSessionId, cwd: f.root, history_base: { rollout_id: "parent" } } }));
    await assert.rejects(readNativeTranscript(f.path, "codex"), /references another rollout/);
    const block = codexNativeHookBlock("/a b/node", "/a'b/hook.js");
    assert.match(block, /\[\[hooks.Stop\]\]/);
    assert.match(block, /\[\[hooks.UserPromptSubmit\]\]/);
    assert(!block.includes("bypass_hook_trust"));
    assert(block.includes("'/a b/node'"));
  } finally { await f.cleanup(); }
});
