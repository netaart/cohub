import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { RuntimeExecutionEvent, RuntimeTurnInput } from "@neta-art/cohub";
import { Command } from "commander";
import { JsonLineDecoder } from "../src/runtime/json-rpc.js";
import { discoverHarnesses } from "../src/runtime/harness.js";
import { nativeSyncSatisfied } from "../src/runtime/native/attach.js";
import type { NativeConfig } from "../src/runtime/native/config.js";
import type { NativeStatus } from "../src/runtime/native/daemon.js";
import { executeTurn } from "../src/runtime/native/execution.js";
import { LiveProgress } from "../src/runtime/native/translate.js";
import { ContextRequiredError, ExecutionResults } from "../src/runtime/native/results.js";
import { formatImportProgress, formatNativeSync } from "../src/runtime/presentation.js";
import { parseRuntimeHarnesses, registerRuntime } from "../src/commands/runtime.js";
import { codexTokenTotals, codexUsage, subtractCodexTokens } from "../src/runtime/codex-usage.js";
import { archiveStorageFixture } from "./fixtures/runtime-archive-storage.js";
import { fixture, testNativeRuntime } from "./fixtures/runtime-native.js";

const jsonl = (value: unknown) => `${JSON.stringify(value)}\n`;
const spaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const turnId = "33333333-3333-4333-8333-333333333333";
const previousTurn = "44444444-4444-4444-8444-444444444444";
const input = (harness: "pi" | "codex"): RuntimeTurnInput => ({
  spaceId, sessionId, turnId, userMessageId: turnId, harness, messages: [{ turnId, userMessageId: turnId, userId: "author", content: [{ type: "text", text: "continue" }] }], accessMode: "full_access",
  context: { revision: "one", throughTurnId: previousTurn, messages: [{ id: "history", turnId: previousTurn, role: "user", content: [{ type: "text", text: "historical fact" }] }] },
});
const config = (harnesses: NativeConfig["harnesses"]): NativeConfig => ({ version: 2, identity: "i", spaceId: "s", root: "/a", harnesses, enabledAt: "2026-01-01T00:00:00.000Z", codexShared: false });
const collect = async <T>(values: AsyncIterable<T>) => { const items: T[] = []; for await (const value of values) items.push(value); return items; };
const session = (root: string, harness: "pi" | "codex" = "codex") => ({ harness, nativeSessionId: crypto.randomUUID(), path: join(root, `${harness}.jsonl`), cwd: root });

test("Runtime CLI exposes the complete lifecycle without legacy sandbox commands", () => {
  const program = new Command();
  registerRuntime(program);
  assert.deepEqual(program.commands[0]?.commands.map((command) => command.name()), ["up", "attach", "detach", "import", "status", "down", "logs"]);
});

test("native sync consent is idempotent per directory and harness", () => {
  assert.equal(nativeSyncSatisfied({ ...config(["pi"]), root: "/a" }, { spaceId: "s", root: "/a", harnesses: ["pi"] }), true);
  assert.equal(nativeSyncSatisfied(config([]), { spaceId: "s", root: "/a", harnesses: ["pi"] }), false);
  assert.equal(nativeSyncSatisfied(null, { spaceId: "s", root: "/a", harnesses: ["pi"] }), false);
  assert.equal(nativeSyncSatisfied({ ...config(["pi"]), root: "/b" }, { spaceId: "s", root: "/a", harnesses: ["pi"] }), false);
});

test("runtime status shows what syncs, what can be driven, and import progress", () => {
  const job = { state: "idle" as const, filter: {}, concurrency: 4, files: 0, done: 0, turns: 0, bytes: 0, totalBytes: 0, startedAt: null, failed: [], queued: 0, running: 0 };
  const status: NativeStatus = { synced: ["pi", "codex"], transcripts: 3, running: 1, pi: { extension: "installed", connected: 2 }, codex: { control: "private", watching: 0 }, import: job };
  assert.equal(formatNativeSync(null, undefined), "Native sync  off · run cohub runtime up to enable\n");
  assert.equal(formatNativeSync(config([]), status), "Native sync  off · run cohub runtime up to enable\n");
  assert.equal(formatNativeSync(config(["pi"]), undefined), "Native sync  Pi · Runtime not running\n");
  const full = formatNativeSync(config(["pi", "codex"]), status);
  assert.match(full, /Pi\s+2 sessions connected/);
  assert.match(full, /Codex\s+read-only in the terminal/);
  assert.match(full, /3 transcripts · 1 Turn running/);
  assert.match(formatNativeSync(config(["pi"]), { ...status, pi: { extension: "missing", connected: 0 } }), /read-only · install the extension with cohub runtime attach --harness pi/);
  assert.match(formatNativeSync(config(["pi"]), { ...status, import: { ...job, state: "paused", files: 10, done: 4 } }), /Import paused at 4\/10/);
  assert.equal(formatNativeSync(null, undefined, "Unexpected token in JSON"), "Native sync  unknown — Unexpected token in JSON · fix or remove the config, then runtime up\n");
  const startedAt = new Date(Date.now() - 10_000).toISOString();
  assert.match(formatImportProgress({ ...job, state: "running", files: 20, done: 5, turns: 42, bytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024, startedAt }), /^5\/20 conversations · 42 Turns · 1\.0 MB\/4\.0 MB · about 30s left$/);
});

test("strict JSONL decoding preserves fragmented UTF-8 and does not accept broken records", () => {
  const values: unknown[] = [];
  const decoder = new JsonLineDecoder((value) => values.push(value));
  for (const byte of Buffer.from('{"text":"你好\\nworld"}\n{"second":true}\n')) decoder.push(Buffer.from([byte]));
  decoder.end();
  assert.deepEqual(values, [{ text: "你好\nworld" }, { second: true }]);
  assert.throws(() => new JsonLineDecoder(() => {}).push(Buffer.from("broken\n")));
});

test("Codex usage counts only the current Turn against the thread total", () => {
  const baseline = codexTokenTotals({ inputTokens: 200, cachedInputTokens: 80, outputTokens: 20, totalTokens: 220 });
  assert.equal(codexUsage(subtractCodexTokens(baseline, baseline)).totalTokens, 0);
  assert.deepEqual(codexUsage(subtractCodexTokens(codexTokenTotals({ inputTokens: 260, cachedInputTokens: 100, outputTokens: 30, totalTokens: 290 }), baseline)), { input: 40, output: 10, cacheRead: 20, cacheWrite: 0, totalTokens: 70 });
});

test("Runtime harness flags accept repeated and comma-separated values", () => {
  assert.deepEqual(parseRuntimeHarnesses(["pi", "codex,pi"]), ["pi", "codex"]);
  assert.throws(() => parseRuntimeHarnesses(["unknown"]));
});

test("execution receipts stream in bounded batches and replay only the same execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-runtime-receipts-"));
  try {
    const results = new ExecutionResults(root);
    assert.deepEqual(await collect(results.pendingBatches()), []);
    const expected = [];
    for (let index = 0; index < 65; index++) {
      const pending = { sessionId: crypto.randomUUID(), turnId: crypto.randomUUID() };
      await results.start(session(root, "pi"), pending, null);
      expected.push({ ...pending, harness: "pi" });
    }
    const batches = await collect(results.pendingBatches());
    assert.deepEqual(batches.map((batch) => batch.length), [64, 1]);
    const bySession = (value: { sessionId: string }[]) => [...value].sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    assert.deepEqual(bySession(batches.flat()), bySession(expected));

    const turn = input("codex");
    const event: RuntimeExecutionEvent = { type: "turn.end", message: { ordinal: 0, content: [{ type: "text", text: "saved result" }], stopReason: "stop" }, resume: "new" };
    await results.start(session(root), turn, "request");
    await results.record(session(root), turn, "request", [event]);
    assert.deepEqual((await results.recover(turn, "request"))?.events, [event]);
    await assert.rejects(() => results.recover(turn, "another request"), /execution identity/);
    assert.equal(await results.recover({ ...turn, turnId: previousTurn }), null, "another Turn of the Session is not this result");
    assert.deepEqual(await results.pendingTurnIds(sessionId), [turnId]);
    await assert.rejects(() => results.acknowledge(sessionId, previousTurn), /identity/);
    await results.acknowledge(sessionId, turnId);
    assert.equal(await results.recover(turn), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an unacknowledged Turn blocks the next one until the server settles or resolves it", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-runtime-admit-"));
  try {
    const results = new ExecutionResults(root);
    const first = input("pi");
    const native = session(root, "pi");
    await results.start(native, first, null);
    assert.equal(await results.admit(first), null, "the same Turn may resume");
    const next = { ...first, turnId: previousTurn, context: { ...first.context, throughTurnId: turnId } };
    await assert.rejects(() => results.admit(next), /unconfirmed results/);
    await assert.rejects(() => results.admit({ ...next, context: { ...next.context, complete: false } }), ContextRequiredError);
    assert.equal(await results.admit({ ...next, context: { ...next.context, settledTurnIds: [turnId] } }), null, "a settled Turn releases its receipt");
    assert.deepEqual(await results.pendingTurnIds(sessionId), []);
    await results.start(native, first, null);
    assert.equal(await results.admit({ ...next, context: { ...next.context, resolvedTurnIds: [turnId] } }), native.path, "a resolved Turn's file diverged from the Session");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a receipt without a result recovers a finished Turn from the native file by its marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-runtime-reconstruct-"));
  try {
    const results = new ExecutionResults(join(root, "state"));
    const nativeSessionId = crypto.randomUUID();
    const path = join(root, "codex", `${nativeSessionId}.jsonl`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, [
      { type: "session_meta", payload: { id: nativeSessionId, cwd: root } },
      { type: "event_msg", payload: { type: "turn_started", turn_id: "prior" } },
      { type: "event_msg", payload: { type: "turn_complete", turn_id: "prior", last_agent_message: "prior answer" } },
    ].map(jsonl).join(""));
    const turn = input("codex");
    const native = { harness: "codex" as const, nativeSessionId, path, cwd: root };
    await results.start(native, turn, null);
    await appendFile(path, jsonl({ type: "event_msg", payload: { type: "turn_started", turn_id: "current" } }));
    await appendFile(path, jsonl({ type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", client_id: turnId, content: [{ type: "input_text", text: "question" }] } } }));
    assert.equal(await results.recover(turn), null, "a Turn that has not ended may still be running");
    await appendFile(path, [
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "native answer" }] } },
      { type: "event_msg", payload: { type: "turn_complete", turn_id: "current" } },
    ].map(jsonl).join(""));
    const recovered = await results.recover(turn);
    assert(recovered, "a finished Turn is found by the id Cohub gave it");
    const final = recovered.events.at(-1);
    assert.equal(final?.type, "turn.end");
    assert(final.message.content.some((block) => block.type === "text" && block.text === "native answer"));
    assert.deepEqual((await results.recover(turn))?.events, recovered.events, "the recovered result is kept and replays identically");

    const aborted = { ...turn, sessionId: crypto.randomUUID(), turnId: crypto.randomUUID() };
    await results.start(native, aborted, null);
    await appendFile(path, [
      { type: "event_msg", payload: { type: "turn_started", turn_id: "stopped" } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", client_id: aborted.turnId, content: [] } } },
      { type: "event_msg", payload: { type: "turn_aborted", turn_id: "stopped" } },
    ].map(jsonl).join(""));
    assert.equal(await results.recover(aborted), null, "an interrupted Turn is never guessed complete");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const harness of ["pi", "codex"] as const) {
  test(`${harness}: streams before completion, resumes natively and restores a missing native file`, async () => {
    const root = await mkdtemp(join(tmpdir(), `cohub-${harness}-rpc-`));
    const storage = await archiveStorageFixture();
    const runtime = await testNativeRuntime({ spaceId, root, harnesses: [harness], transport: storage.transport });
    let cold: Awaited<ReturnType<typeof testNativeRuntime>> | null = null;
    try {
      const catalog = await discoverHarnesses([harness], { [harness]: fixture(harness) }, root);
      assert.equal(catalog.models[0]?.id, "test");
      const { executor } = runtime.native;
      const turn = input(harness);
      runtime.source.addTurn(sessionId, previousTurn, { userContent: [{ type: "text", text: "historical fact" }] });
      const events: RuntimeExecutionEvent[] = [];
      const first = await executeTurn(executor, turn, (event) => events.push(event), new AbortController().signal, "first");
      assert(events.some((event) => event.type === "text.delta"));
      // Pi carries durable history in its native session file. Codex has no native history channel for a
      // handoff yet, so it starts without history instead of receiving a fabricated transcript.
      const expectedAnswer = harness === "pi" ? "history retained" : "native resumed";
      assert(first.event.message.content.some((block) => block.type === "text" && block.text.includes(expectedAnswer)));
      assert.equal(first.event.archive?.turnId, turnId);
      await runtime.archives.flush(new AbortController().signal);
      if (harness === "codex") {
        assert.deepEqual(events.filter((event) => event.type === "message.start").map((event) => event.ordinal), [0, 1]);
        assert.equal(first.event.message.ordinal, 1, "Repeated native item/started must keep its ordinal");
        assert.deepEqual(first.event.message.usage, { input: 125, output: 12, cacheRead: 15, cacheWrite: 0, totalTokens: 152 });
      }
      await executor.results.record(first.session, turn, "first", [first.event]);
      await executor.results.acknowledge(sessionId, turnId);
      const next = { ...turn, turnId: previousTurn, context: { ...turn.context, throughTurnId: turnId, revision: "two" } };
      const second = await executeTurn(executor, next, () => {}, new AbortController().signal, "second");
      assert.equal(second.event.resume, "native");
      assert.equal(second.session.nativeSessionId, first.session.nativeSessionId);
      const original = await readFile(first.session.path, "utf8");
      cold = await testNativeRuntime({ spaceId, root, stateRoot: join(root, "cold"), harnesses: [harness], transport: storage.transport });
      const restored = await executeTurn(cold.native.executor, { ...next, sessionId, context: { ...next.context, complete: false, messages: [], archive: first.event.archive } }, () => {}, new AbortController().signal, "third");
      assert.equal(restored.event.resume, "restored");
      if (harness === "pi") assert.equal(restored.session.nativeSessionId, first.session.nativeSessionId);
      else assert.notEqual(restored.session.nativeSessionId, first.session.nativeSessionId);
      assert.equal(await readFile(first.session.path, "utf8"), original, "restoration must not modify the source file");
    } finally { await cold?.close(); await runtime.close(); await storage.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("pi: a stop reaches the harness through its extension and ends the Turn as aborted", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-pi-abort-"));
  const runtime = await testNativeRuntime({ spaceId, root, harnesses: ["pi"] });
  try {
    const controller = new AbortController();
    const turn = { ...input("pi"), messages: [{ turnId, userMessageId: turnId, userId: "author", content: [{ type: "text" as const, text: "wait for abort" }] }] };
    const running = executeTurn(runtime.native.executor, turn, (event) => { if (event.type === "text.delta") controller.abort(); }, controller.signal, "abort");
    const result = await running;
    assert.equal(result.event.message.stopReason, "aborted");
    const rows = (await readFile(result.session.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.at(-1).message.stopReason, "aborted", "Pi itself recorded the stop");
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("a live preview sends at most once per interval, and only from the first message that changed", async () => {
  const sent: Array<{ from?: number; messages: number }> = [];
  let recorded = false;
  const progress = new LiveProgress((update) => {
    if (!recorded) return null;
    sent.push({ from: update.from, messages: update.messages.length });
    return Promise.resolve({ accepted: true });
  }, 20);
  const wait = () => new Promise((resolve) => setTimeout(resolve, 40));
  progress.apply({ type: "message.start", ordinal: 0 });
  progress.apply({ type: "text.delta", ordinal: 0, index: 0, kind: "text", delta: "a" });
  await wait();
  assert.deepEqual(sent, [], "nothing is sent before the server records the Turn");
  recorded = true;
  progress.apply({ type: "message.start", ordinal: 1 });
  for (const delta of ["b", "c", "d"]) progress.apply({ type: "text.delta", ordinal: 1, index: 0, kind: "text", delta });
  await wait();
  assert.deepEqual(sent, [{ from: 0, messages: 2 }], "the first send carries everything, once");
  progress.apply({ type: "text.delta", ordinal: 1, index: 0, kind: "text", delta: "e" });
  await wait();
  assert.deepEqual(sent.at(-1), { from: 1, messages: 1 }, "later sends carry only the changed tail");
  progress.dispose();
});
