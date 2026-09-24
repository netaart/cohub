import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, readdir, mkdir, stat, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readNativeTranscript, readNativeTranscriptHeader, ensurePlainCodexRollout } from "../src/runtime/native-transcript.js";
import { discoverNativeImportCandidates, NATIVE_SYNC_SESSION_CONCURRENCY, runNativeSyncPool, summarizeNativeSyncErrors } from "../src/runtime/native-sync.js";
import { NativeSyncStore, nativeStableId, type NativeSyncTransport } from "../src/runtime/native-sync-store.js";
import { RuntimeArchiveStore } from "../src/runtime/archive-store.js";
import { codexNativeHookBlock } from "../src/runtime/native-install.js";
import { archiveStorageFixture } from "./fixtures/runtime-archive-storage.js";
import { TestRuntimeSessionStore } from "./fixtures/runtime-projection-source.js";
import type { RuntimeTurnInput } from "@neta-art/cohub";
import type { NativeTurnBinding, NativeTurnComplete, NativeTurnStart } from "@neta-art/cohub";

const at = "2026-09-21T00:00:00.000Z";

test("native sync processes independent sessions with bounded concurrency", async () => {
  const activeByItem = new Map<number, number>();
  let active = 0;
  let maximum = 0;
  await runNativeSyncPool(Array.from({ length: 16 }, (_, index) => index), NATIVE_SYNC_SESSION_CONCURRENCY, new AbortController().signal, async (item) => {
    active += 1;
    maximum = Math.max(maximum, active);
    activeByItem.set(item, (activeByItem.get(item) ?? 0) + 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  });
  assert.equal(maximum, NATIVE_SYNC_SESSION_CONCURRENCY);
  assert.equal(activeByItem.size, 16);
  assert.ok([...activeByItem.values()].every((count) => count === 1));
});

test("native sync cancellation stops new sessions and waits for active sessions", async () => {
  const controller = new AbortController();
  let active = 0;
  let started = 0;
  let resolveStarted = () => {};
  let release: (() => void) | undefined;
  const bothStarted = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const flush = runNativeSyncPool([1, 2, 3, 4], 2, controller.signal, async () => {
    active += 1;
    started += 1;
    if (active === 2) resolveStarted();
    await gate;
    active -= 1;
  });
  await bothStarted;
  controller.abort();
  release?.();
  await flush;
  assert.equal(started, 2);
  assert.equal(active, 0);
});

test("native sync diagnostics group repeated errors without retaining stack traces", () => {
  const timeout = Object.assign(new Error("Native Runtime event timed out"), { code: "ETIMEDOUT" });
  const grouped = summarizeNativeSyncErrors([timeout, timeout, new Error("connection closed")]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped.find((item) => item.code === "ETIMEDOUT")?.count, 2);
  assert.equal(grouped.find((item) => item.message === "connection closed")?.count, 1);
  assert.equal(Object.hasOwn(grouped[0] ?? {}, "stack"), false);
});
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

test("native import discovery stays scoped to the bound project and reports invalid files", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-native-discovery-"));
  const other = await mkdtemp(join(tmpdir(), "cohub-native-discovery-other-"));
  const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "sessions");
  try {
    const currentPath = join(root, "sessions", "current.jsonl");
    const otherPath = join(root, "sessions", "other.jsonl");
    await mkdir(dirname(currentPath), { recursive: true });
    await writeFile(currentPath, piHeader(randomUUID(), root) + piTurn(1));
    await writeFile(otherPath, piHeader(randomUUID(), other) + piTurn(1));
    await writeFile(join(root, "sessions", "invalid.jsonl"), "not json\n");
    const result = await discoverNativeImportCandidates(root, ["pi"]);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]?.path, currentPath);
    assert.equal(result.candidates[0]?.turnCount, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.path, join(root, "sessions", "invalid.jsonl"));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

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
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await assert.rejects(reconnect(), /lost result ACK/);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
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

test("failed native receipts keep a durable backoff across immediate flushes", async () => {
  const f = await fixture();
  const storage = await archiveStorageFixture();
  let starts = 0;
  try {
    await writeFile(f.path, f.header + piTurn(1));
    const store = new NativeSyncStore({ ...f.options, transport: {
      ...storage.transport,
      startNativeTurn: async () => { starts++; throw new Error("temporary native failure"); },
    } });
    await store.capture(f.path, await readNativeTranscript(f.path, "pi", { settled: true }));
    await assert.rejects(store.flush(new AbortController().signal), /temporary native failure/);
    await store.flush(new AbortController().signal);
    assert.equal(starts, 1);
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

test("Codex lineage stitches a rollout chain with exact history bases; hook commands quote paths without disabling trust", async () => {
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

    const block = codexNativeHookBlock("/a b/node", "/a'b/hook.js");
    assert.match(block, /\[\[hooks.Stop\]\]/);
    assert.match(block, /\[\[hooks.UserPromptSubmit\]\]/);
    assert(!block.includes("bypass_hook_trust"));
    assert(block.includes("'/a b/node'"));
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await f.cleanup();
  }
});

test("Codex rollover follows the leaf rollout: one conversation, archives track their source files", async () => {
  const f = await fixture();
  const previousHome = process.env.CODEX_HOME;
  const home = join(f.root, "codex-home");
  process.env.CODEX_HOME = home;
  try {
    const storage = await archiveStorageFixture();
    const transport: NativeSyncTransport = { ...storage.transport,
      startNativeTurn: async (request) => ({ sessionId: request.sessionId ?? request.branchSessionId, turnId: request.turnId, forked: false }),
      completeNativeTurn: async () => ({ completed: true }),
    };
    const day = (n: number) => join(home, "sessions", "2026", "09", n < 10 ? `0${n}` : `${n}`);
    const rollout = (n: number, id: string) => join(day(n), `rollout-2026-09-${n < 10 ? `0${n}` : n}T00-00-00-${id}.jsonl`);
    const turn = (key: string, question: string, answer: string) => [
      { type: "event_msg", payload: { type: "turn_started", turn_id: key } },
      { type: "event_msg", payload: { type: "user_message", message: question } },
      { type: "event_msg", payload: { type: "turn_complete", turn_id: key, last_agent_message: answer } },
    ];
    // Root rollout holds two Turns, then Codex rolls over to a fresh leaf referencing it.
    const threadId = randomUUID();
    const rootPath = rollout(21, threadId);
    await writeRollout(rootPath, { type: "session_meta", payload: { id: threadId, cwd: f.root, history_mode: "paginated" } }, turn("r1", "q1", "a1"), turn("r2", "q2", "a2"));
    const rootEnd = (await stat(rootPath)).size;
    const leafId = `${threadId}_${randomUUID()}`;
    const leafPath = rollout(22, leafId);
    const leafHeader = { type: "session_meta", payload: { id: threadId, cwd: f.root, history_mode: "paginated", history_base: { thread_id: threadId, end_ordinal_exclusive: 7, end_byte_offset: rootEnd } } };
    await writeRollout(leafPath, leafHeader, turn("l1", "q3", "a3"));

    const options = { ...f.options, harness: "codex" as const, nativeSessionId: threadId };
    const store = new NativeSyncStore({ ...options, transport });
    await store.capture(leafPath, await readNativeTranscript(leafPath, "codex"));
    const receipts = await store.receipts();
    assert.deepEqual(receipts.map((receipt) => receipt.key), ["r1", "r2", "l1"], "one conversation across both files");
    assert.equal((await store.binding()).path, leafPath);
    // Ancestor Turn bytes are archived from the ancestor file, the leaf Turn from the leaf file.
    const versions = join(store.archives.root, "versions");
    const indexes = await Promise.all(receipts.map((receipt) => readFile(join(versions, `${receipt.turnId}.json`), "utf8").then((raw) => JSON.parse(raw))));
    assert.deepEqual(indexes.map((index) => index.nativeSessionId), [threadId, threadId, threadId]);
    const ancestorBytes = await readFile(rootPath);
    // header + the three rows of the first Turn = the first four lines.
    const lines = ancestorBytes.toString().split("\n").filter(Boolean);
    const r1Bytes = Buffer.byteLength(lines.slice(0, 4).map((l) => `${l}\n`).join(""));
    assert.equal(indexes[0]?.sizeBytes, r1Bytes, "the ancestor Turn archives exactly its own bytes");
    await store.flush(new AbortController().signal);
    // Continuing in the leaf appends Turns without re-importing the ancestor.
    await writeRollout(leafPath, leafHeader, turn("l1", "q3", "a3"), turn("l2", "q4", "a4"));
    await store.capture(leafPath, await readNativeTranscript(leafPath, "codex"));
    assert.deepEqual((await store.receipts()).map((receipt) => receipt.key), ["r1", "r2", "l1", "l2"]);
    await store.flush(new AbortController().signal);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await f.cleanup();
  }
});

test("Codex import discovery skips lineage ancestors and counts the stitched conversation once", async () => {
  const f = await fixture();
  const previousHome = process.env.CODEX_HOME;
  const home = join(f.root, "codex-home");
  process.env.CODEX_HOME = home;
  try {
    const day = (n: number) => join(home, "sessions", "2026", "09", n < 10 ? `0${n}` : `${n}`);
    const rollout = (n: number, id: string) => join(day(n), `rollout-2026-09-${n < 10 ? `0${n}` : n}T00-00-00-${id}.jsonl`);
    const turn = (key: string) => [
      { type: "event_msg", payload: { type: "turn_started", turn_id: key } },
      { type: "event_msg", payload: { type: "user_message", message: `q ${key}` } },
      { type: "event_msg", payload: { type: "turn_complete", turn_id: key, last_agent_message: `a ${key}` } },
    ];
    const threadId = randomUUID();
    const rootPath = rollout(21, threadId);
    await writeRollout(rootPath, { type: "session_meta", payload: { id: threadId, cwd: f.root, history_mode: "paginated" } }, turn("r1"));
    const rootEnd = (await stat(rootPath)).size;
    const leafPath = rollout(22, `${threadId}_${randomUUID()}`);
    await writeRollout(leafPath, { type: "session_meta", payload: { id: threadId, cwd: f.root, history_mode: "paginated", history_base: { thread_id: threadId, end_ordinal_exclusive: 4, end_byte_offset: rootEnd } } }, turn("l1"));

    const result = await discoverNativeImportCandidates(f.root, ["codex"]);
    assert.equal(result.candidates.length, 1, "only the leaf rollout is a candidate");
    assert.equal(result.candidates[0]?.path, leafPath);
    assert.equal(result.candidates[0]?.turnCount, 2, "the stitched conversation includes ancestor Turns");
    assert.equal(result.errors.length, 0);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await f.cleanup();
  }
});

test("managed Runtime rollover keeps settled cloud Turns; no duplicate receipts after the binding moves", async () => {
  const f = await fixture();
  const previousHome = process.env.CODEX_HOME;
  const home = join(f.root, "codex-home");
  process.env.CODEX_HOME = home;
  try {
    // A managed Runtime session: turns already archived and acknowledged in the cloud.
    const day = (n: number) => join(home, "sessions", "2026", "09", `0${n}`);
    const rollout = (n: number, id: string) => join(day(n), `rollout-2026-09-0${n}T00-00-00-${id}.jsonl`);
    const turn = (key: string) => [
      { type: "event_msg", payload: { type: "turn_started", turn_id: key } },
      { type: "event_msg", payload: { type: "user_message", message: `q ${key}` } },
      { type: "event_msg", payload: { type: "turn_complete", turn_id: key, last_agent_message: `a ${key}` } },
    ];
    const threadId = randomUUID(), sessionId = randomUUID(), cloudTurn1 = randomUUID(), cloudTurn2 = randomUUID();
    const rootPath = rollout(1, threadId);
    // Managed Runtime state: projected Turns carry their cloud Turn ids (r1, r2).
    const projectedTurn = (key: string, cloudTurnId: string) => [
      { type: "event_msg", payload: { type: "turn_started", turn_id: key } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `q ${key}` }] }, metadata: { cohub: { turnId: cloudTurnId } } },
      { type: "event_msg", payload: { type: "turn_complete", turn_id: key, last_agent_message: `a ${key}` } },
    ];
    await writeRollout(rootPath, { type: "session_meta", payload: { id: threadId, cwd: f.root, history_mode: "paginated" } }, projectedTurn("r1", cloudTurn1), projectedTurn("r2", cloudTurn2));
    const rootContent = await readFile(rootPath);
    await mkdir(join(f.options.runtimeRoot, "codex"), { recursive: true });
    await writeFile(join(f.options.runtimeRoot, "codex", `${sessionId}.json`), JSON.stringify({ version: 1, harness: "codex", sessionId, nativeSessionId: threadId, path: rootPath, throughTurnId: cloudTurn2, pendingTurnId: null, checksum: createHash("sha256").update(rootContent).digest("hex") }));
    const rootEnd = rootContent.length;

    const options = { ...f.options, harness: "codex" as const, nativeSessionId: threadId };
    const store = new NativeSyncStore(options);
    await store.capture(rootPath, await readNativeTranscript(rootPath, "codex"));
    assert.deepEqual((await store.receipts()).map((receipt) => receipt.key), [], "projected cloud Turns produce no receipts");

    // Codex rolls over: the native client continues in a fresh leaf referencing the root rollout.
    const leafPath = rollout(2, `${threadId}_${randomUUID()}`);
    await writeRollout(leafPath, { type: "session_meta", payload: { id: threadId, cwd: f.root, history_mode: "paginated", history_base: { thread_id: threadId, end_ordinal_exclusive: 7, end_byte_offset: rootEnd } } }, turn("l1"));
    await store.capture(leafPath, await readNativeTranscript(leafPath, "codex"));
    const receipts = await store.receipts();
    assert.deepEqual(receipts.map((receipt) => receipt.key), ["l1"], "only the post-rollover Turn becomes a receipt");
    assert.equal(receipts[0]?.parentCloudTurnId, cloudTurn2, "the new Turn continues the settled cloud Turn");
    assert.equal((await store.binding()).path, leafPath, "the binding follows the leaf");
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await f.cleanup();
  }
});

test("a forked parent rollout stays importable; only same-thread rollovers are skipped", async () => {
  const f = await fixture();
  const previousHome = process.env.CODEX_HOME;
  const home = join(f.root, "codex-home");
  process.env.CODEX_HOME = home;
  try {
    const day = (n: number) => join(home, "sessions", "2026", "09", `0${n}`);
    const rollout = (n: number, id: string) => join(day(n), `rollout-2026-09-0${n}T00-00-00-${id}.jsonl`);
    const turn = (key: string) => [
      { type: "event_msg", payload: { type: "turn_started", turn_id: key } },
      { type: "event_msg", payload: { type: "user_message", message: `q ${key}` } },
      { type: "event_msg", payload: { type: "turn_complete", turn_id: key, last_agent_message: `a ${key}` } },
    ];

    // Parent A keeps growing after B forked from its middle: a partial history_base reference.
    const parentThread = randomUUID();
    const parentPath = rollout(1, parentThread);
    await writeRollout(parentPath, { type: "session_meta", payload: { id: parentThread, cwd: f.root, history_mode: "paginated" } }, turn("p1"), turn("p2"), turn("p3"));
    // The fork references the parent through its first two Turns: header + 6 rows = 7 lines.
    const parentLines = (await readFile(parentPath)).toString().split("\n").filter(Boolean);
    const forkOffset = Buffer.byteLength(parentLines.slice(0, 7).map((l) => `${l}\n`).join(""));

    const forkThread = randomUUID();
    const forkPath = rollout(2, `${forkThread}_${randomUUID()}`);
    // Fork references the parent's rollout id, covering only its first two Turns.
    await writeRollout(forkPath, { type: "session_meta", payload: { id: forkThread, cwd: f.root, history_mode: "paginated", history_base: { thread_id: parentThread, end_ordinal_exclusive: 7, end_byte_offset: forkOffset } } }, turn("f1"));

    const result = await discoverNativeImportCandidates(f.root, ["codex"]);
    // Both conversations import: the fork stitched with its inherited prefix (p1, p2, f1), and the parent in full.
    assert.deepEqual(result.candidates.map((candidate) => candidate.turnCount).sort(), [3, 3]);
    assert.equal(result.candidates.filter((candidate) => candidate.path === parentPath).length, 1, "the partially referenced parent stays a candidate");
    assert.equal(result.errors.length, 0);
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

test("a pending ancestor Turn completes before the rollover; the leaf continues cleanly", async () => {
  const f = await fixture();
  const previousHome = process.env.CODEX_HOME;
  const home = join(f.root, "codex-home");
  process.env.CODEX_HOME = home;
  try {
    const day = (n: number) => join(home, "sessions", "2026", "09", `0${n}`);
    const rollout = (n: number, id: string) => join(day(n), `rollout-2026-09-0${n}T00-00-00-${id}.jsonl`);
    const turnRows = (key: string, complete: boolean) => [
      { type: "event_msg", payload: { type: "turn_started", turn_id: key } },
      { type: "event_msg", payload: { type: "user_message", message: `q ${key}` } },
      ...(complete ? [{ type: "event_msg", payload: { type: "turn_complete", turn_id: key, last_agent_message: `a ${key}` } }] : []),
    ];
    const threadId = randomUUID();
    const rootPath = rollout(1, threadId);
    const rootBytes = (...groups: Array<Array<Record<string, unknown>>>) => writeRollout(rootPath, { type: "session_meta", payload: { id: threadId, cwd: f.root, history_mode: "paginated" } }, ...groups);
    // Mid-turn hook snapshot: r2 has started but not completed, so its receipt stays pending.
    await rootBytes(turnRows("r1", true), turnRows("r2", false));
    const store = new NativeSyncStore({ ...f.options, harness: "codex" as const, nativeSessionId: threadId });
    await store.capture(rootPath, await readNativeTranscript(rootPath, "codex"));
    const pending = (await store.receipts()).find((receipt) => receipt.key === "r2");
    assert.ok(pending?.result == null, "r2's receipt is pending (no result)");

    // The Turn finishes in the same file, then Codex rolls over. The settled ancestor prefix
    // keeps the whole conversation importable and the pending receipt completes first.
    await rootBytes(turnRows("r1", true), turnRows("r2", true));
    await store.capture(rootPath, await readNativeTranscript(rootPath, "codex"));
    assert.equal((await store.receipts()).find((receipt) => receipt.key === "r2")?.result?.status, "completed", "the pending receipt completes in place");

    const rootEnd = (await stat(rootPath)).size;
    const leafPath = rollout(2, `${threadId}_${randomUUID()}`);
    await writeRollout(leafPath, { type: "session_meta", payload: { id: threadId, cwd: f.root, history_mode: "paginated", history_base: { thread_id: threadId, end_ordinal_exclusive: 7, end_byte_offset: rootEnd } } }, turnRows("l1", true));
    await store.capture(leafPath, await readNativeTranscript(leafPath, "codex"));
    assert.deepEqual((await store.receipts()).map((receipt) => receipt.key), ["r1", "r2", "l1"]);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await f.cleanup();
  }
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

test("two sibling rollouts of one thread import only the newest; the loser is reported", async () => {
  const f = await fixture();
  const previousHome = process.env.CODEX_HOME;
  const home = join(f.root, "codex-home");
  process.env.CODEX_HOME = home;
  try {
    const day = (n: number) => join(home, "sessions", "2026", "09", `0${n}`);
    const rollout = (n: number, h: number, id: string) => join(day(n), `rollout-2026-09-0${n}T0${h}-00-00-${id}.jsonl`);
    const turn = (key: string) => [
      { type: "event_msg", payload: { type: "turn_started", turn_id: key } },
      { type: "event_msg", payload: { type: "user_message", message: `q ${key}` } },
      { type: "event_msg", payload: { type: "turn_complete", turn_id: key, last_agent_message: `a ${key}` } },
    ];
    // A is the shared parent; B and C both revert from A and survive absorption.
    const threadId = randomUUID();
    const a = rollout(1, 0, threadId);
    await writeRollout(a, { type: "session_meta", payload: { id: threadId, cwd: f.root, history_mode: "paginated" } }, turn("a1"));
    const aEnd = (await stat(a)).size;
    const b = rollout(2, 0, `${threadId}_${randomUUID()}`);
    await writeRollout(b, { type: "session_meta", payload: { id: threadId, cwd: f.root, history_mode: "paginated", history_base: { thread_id: threadId, end_ordinal_exclusive: 4, end_byte_offset: aEnd } } }, turn("b1"));
    const c = rollout(3, 0, `${threadId}_${randomUUID()}`);
    await writeRollout(c, { type: "session_meta", payload: { id: threadId, cwd: f.root, history_mode: "paginated", history_base: { thread_id: threadId, end_ordinal_exclusive: 4, end_byte_offset: aEnd } } }, turn("c1"));
    const result = await discoverNativeImportCandidates(f.root, ["codex"]);
    assert.equal(result.candidates.length, 1, "only the newest sibling imports");
    assert.equal(result.candidates[0]?.path, c);
    assert.ok(result.superseded.some((skip) => skip.path === b && /Superseded/.test(skip.message)), "the older sibling is reported as superseded");
    assert.equal(result.errors.length, 0, "superseded siblings are not errors");
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await f.cleanup();
  }
});

test("header prescan discovers every rollout beyond the concurrency limit", async () => {
  const f = await fixture();
  const previousHome = process.env.CODEX_HOME;
  const home = join(f.root, "codex-home");
  process.env.CODEX_HOME = home;
  try {
    const day = (n: number) => join(home, "sessions", "2026", "09", `0${n}`);
    const threads = Array.from({ length: 20 }, () => randomUUID());
    let ordinal = 0;
    for (const threadId of threads) {
      const path = join(day(1 + ordinal % 3), `rollout-2026-09-0${1 + ordinal % 3}T00-00-${String(ordinal).padStart(2, "0")}-${threadId}.jsonl`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, line({ type: "session_meta", payload: { id: threadId, cwd: f.root, history_mode: "paginated" } })
        + [
          { timestamp: at, type: "event_msg", payload: { type: "turn_started", turn_id: "t1" } },
          { timestamp: at, type: "event_msg", payload: { type: "user_message", message: "q" } },
          { timestamp: at, type: "event_msg", payload: { type: "turn_complete", turn_id: "t1", last_agent_message: "a" } },
        ].map(line).join(""));
      ordinal += 1;
    }
    const result = await discoverNativeImportCandidates(f.root, ["codex"]);
    assert.equal(result.candidates.length, 20, "every file beyond the 16-worker prescan is found");
    assert.equal(result.errors.length, 0);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await f.cleanup();
  }
});

test("a compressed ancestor archives every Turn through the plain-copy cache", async () => {
  const f = await fixture();
  const previousHome = process.env.CODEX_HOME;
  const home = join(f.root, "codex-home");
  process.env.CODEX_HOME = home;
  try {
    const { zstdCompressSync } = await import("node:zlib");
    const storage = await archiveStorageFixture();
    const transport: NativeSyncTransport = { ...storage.transport,
      startNativeTurn: async (request) => ({ sessionId: request.sessionId ?? request.branchSessionId, turnId: request.turnId, forked: false }),
      completeNativeTurn: async () => ({ completed: true }),
    };
    const day = (n: number) => join(home, "sessions", "2026", "09", `0${n}`);
    const rollout = (n: number, id: string) => join(day(n), `rollout-2026-09-0${n}T00-00-00-${id}.jsonl`);
    const turn = (key: string) => [
      { type: "event_msg", payload: { type: "turn_started", turn_id: key } },
      { type: "event_msg", payload: { type: "user_message", message: `q ${key}` } },
      { type: "event_msg", payload: { type: "turn_complete", turn_id: key, last_agent_message: `a ${key}` } },
    ];
    // The ancestor lives in archived storage, compressed cold by Codex's worker.
    const threadId = randomUUID();
    const ancestorPath = join(home, "archived_sessions", "2026", "09", "01", `rollout-2026-09-01T00-00-00-${threadId}.jsonl`);
    const plainAncestor = join(f.root, "ancestor-plain.jsonl");
    await writeRollout(plainAncestor, { type: "session_meta", payload: { id: threadId, cwd: f.root, history_mode: "paginated" } }, turn("r1"), turn("r2"));
    const ancestorContent = await readFile(plainAncestor);
    await mkdir(dirname(ancestorPath), { recursive: true });
    await writeFile(`${ancestorPath}.zst`, zstdCompressSync(ancestorContent));
    const ancestorEnd = ancestorContent.length;
    const leafPath = rollout(2, `${threadId}_${randomUUID()}`);
    await writeRollout(leafPath, { type: "session_meta", payload: { id: threadId, cwd: f.root, history_mode: "paginated", history_base: { thread_id: threadId, end_ordinal_exclusive: 7, end_byte_offset: ancestorEnd } } }, turn("l1"));

    const store = new NativeSyncStore({ ...f.options, harness: "codex" as const, nativeSessionId: threadId, transport });
    await store.capture(leafPath, await readNativeTranscript(leafPath, "codex"));
    const receipts = await store.receipts();
    assert.deepEqual(receipts.map((receipt) => receipt.key), ["r1", "r2", "l1"], "every ancestor Turn archives from the compressed source");
    const versions = join(store.archives.root, "versions");
    for (const receipt of receipts.slice(0, 2)) {
      const index = JSON.parse(await readFile(join(versions, `${receipt.turnId}.json`), "utf8"));
      const prefix = ancestorContent.subarray(0, index.sizeBytes);
      assert.equal(createHash("sha256").update(prefix).digest("hex"), index.sha256, "archived bytes match the logical ancestor prefix");
    }
    await store.flush(new AbortController().signal);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await f.cleanup();
  }
});

test("a damaged .zst cache copy heals itself during capture", async () => {
  const f = await fixture();
  const previousHome = process.env.CODEX_HOME;
  const home = join(f.root, "codex-home");
  process.env.CODEX_HOME = home;
  try {
    const { zstdCompressSync } = await import("node:zlib");
    const storage = await archiveStorageFixture();
    const transport: NativeSyncTransport = { ...storage.transport,
      startNativeTurn: async (request) => ({ sessionId: request.sessionId ?? request.branchSessionId, turnId: request.turnId, forked: false }),
      completeNativeTurn: async () => ({ completed: true }),
    };
    const day = (n: number) => join(home, "sessions", "2026", "09", `0${n}`);
    const rollout = (n: number, id: string) => join(day(n), `rollout-2026-09-0${n}T00-00-00-${id}.jsonl`);
    const turn = (key: string) => [
      { type: "event_msg", payload: { type: "turn_started", turn_id: key } },
      { type: "event_msg", payload: { type: "user_message", message: `q ${key}` } },
      { type: "event_msg", payload: { type: "turn_complete", turn_id: key, last_agent_message: `a ${key}` } },
    ];
    const threadId = randomUUID();
    const ancestorPath = join(home, "archived_sessions", "2026", "09", "01", `rollout-2026-09-01T00-00-00-${threadId}.jsonl`);
    const plainAncestor = join(f.root, "ancestor-plain.jsonl");
    await writeRollout(plainAncestor, { type: "session_meta", payload: { id: threadId, cwd: f.root, history_mode: "paginated" } }, turn("r1"), turn("r2"));
    const ancestorContent = await readFile(plainAncestor);
    await mkdir(dirname(ancestorPath), { recursive: true });
    await writeFile(`${ancestorPath}.zst`, zstdCompressSync(ancestorContent));
    const leafPath = rollout(2, `${threadId}_${randomUUID()}`);
    await writeRollout(leafPath, { type: "session_meta", payload: { id: threadId, cwd: f.root, history_mode: "paginated", history_base: { thread_id: threadId, end_ordinal_exclusive: 7, end_byte_offset: ancestorContent.length } } }, turn("l1"));

    // Seed a truncated cache copy, as a power loss would leave behind.
    const store = new NativeSyncStore({ ...f.options, harness: "codex" as const, nativeSessionId: threadId, transport });
    const cache = join(f.options.runtimeRoot, "native", "cache", "rollouts");
    const cached = join(cache, `${createHash("sha256").update(`${ancestorPath}.zst`).digest("hex")}.jsonl`);
    await mkdir(cache, { recursive: true });
    await writeFile(cached, ancestorContent.subarray(0, ancestorContent.length - 30));
    await store.capture(leafPath, await readNativeTranscript(leafPath, "codex"));
    assert.deepEqual((await store.receipts()).map((receipt) => receipt.key), ["r1", "r2", "l1"], "a truncated cache rebuilds and archives every Turn");
    await store.flush(new AbortController().signal);

    // A cache whose bytes were corrupted in place heals the same way. A fresh CODEX_HOME avoids
    // the process-wide rollout index's short TTL hiding the newly written files.
    const home2 = join(f.root, "codex-home-2");
    process.env.CODEX_HOME = home2;
    const other = randomUUID();
    const ancestor2 = join(home2, "archived_sessions", "2026", "09", "03", `rollout-2026-09-03T00-00-00-${other}.jsonl`);
    const plain2 = join(f.root, "ancestor2-plain.jsonl");
    await writeRollout(plain2, { type: "session_meta", payload: { id: other, cwd: f.root, history_mode: "paginated" } }, turn("x1"));
    const content2 = await readFile(plain2);
    await mkdir(dirname(ancestor2), { recursive: true });
    await writeFile(`${ancestor2}.zst`, zstdCompressSync(content2));
    const cached2 = join(cache, `${createHash("sha256").update(`${ancestor2}.zst`).digest("hex")}.jsonl`);
    await writeFile(cached2, Buffer.from("garbage that parses as no header at all"));
    const leaf2 = join(home2, "sessions", "2026", "09", "04", `rollout-2026-09-04T00-00-00-${other}_${randomUUID()}.jsonl`);
    await writeRollout(leaf2, { type: "session_meta", payload: { id: other, cwd: f.root, history_mode: "paginated", history_base: { thread_id: other, end_ordinal_exclusive: 4, end_byte_offset: content2.length } } }, turn("y1"));
    const store2 = new NativeSyncStore({ ...f.options, harness: "codex" as const, nativeSessionId: other, transport });
    await store2.capture(leaf2, await readNativeTranscript(leaf2, "codex"));
    assert.deepEqual((await store2.receipts()).map((receipt) => receipt.key), ["x1", "y1"], "a corrupted cache rebuilds and archives every Turn");
    await store2.flush(new AbortController().signal);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await f.cleanup();
  }
});

test("import discovery finds archived and compressed rollouts", async () => {
  const f = await fixture();
  const previousHome = process.env.CODEX_HOME;
  const home = join(f.root, "codex-home");
  process.env.CODEX_HOME = home;
  try {
    const { zstdCompressSync } = await import("node:zlib");
    const turn = (key: string) => [
      { type: "event_msg", payload: { type: "turn_started", turn_id: key } },
      { type: "event_msg", payload: { type: "user_message", message: `q ${key}` } },
      { type: "event_msg", payload: { type: "turn_complete", turn_id: key, last_agent_message: `a ${key}` } },
    ];
    // A compressed rollout still under sessions/ and a plain one in archived_sessions/.
    const activeThread = randomUUID();
    const activeZst = join(home, "sessions", "2026", "09", "01", `rollout-2026-09-01T00-00-00-${activeThread}.jsonl.zst`);
    const plainActive = join(f.root, "active-plain.jsonl");
    await writeRollout(plainActive, { type: "session_meta", payload: { id: activeThread, cwd: f.root, history_mode: "paginated" } }, turn("z1"));
    await mkdir(dirname(activeZst), { recursive: true });
    await writeFile(activeZst, zstdCompressSync(await readFile(plainActive)));
    const archivedThread = randomUUID();
    const archived = join(home, "archived_sessions", "2026", "09", "02", `rollout-2026-09-02T00-00-00-${archivedThread}.jsonl`);
    await writeRollout(archived, { type: "session_meta", payload: { id: archivedThread, cwd: f.root, history_mode: "paginated" } }, turn("a1"));

    const result = await discoverNativeImportCandidates(f.root, ["codex"]);
    assert.deepEqual(result.candidates.map((candidate) => candidate.path).sort(), [archived, activeZst].sort());
    assert.equal(result.errors.length, 0);
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
    const result = await discoverNativeImportCandidates(f.root, ["codex"]);
    assert.equal(result.candidates.length, 0, "the foreign-history leaf is not importable");
    assert.ok(result.errors.some((error) => error.path === leafPath && /crosses projects/.test(error.message)));
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await rm(other, { recursive: true, force: true });
    await f.cleanup();
  }
});
