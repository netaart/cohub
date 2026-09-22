import assert from "node:assert/strict";
import { TestRuntimeSessionStore } from "./fixtures/runtime-projection-source.js";
import { test } from "node:test";
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { RuntimeTurnInput, RuntimeExecutionEvent } from "@neta-art/cohub";
import { JsonLineDecoder } from "../src/runtime/json-rpc.js";
import { archiveStorageFixture } from "./fixtures/runtime-archive-storage.js";
import { discoverHarnesses, executePi, executeCodex } from "../src/runtime/harness.js";
import { Command } from "commander";
import { parseRuntimeHarnesses, registerRuntime } from "../src/commands/runtime.js";
import { codexArchiveTotals, codexTokenTotals, codexUsage, subtractCodexTokens } from "../src/runtime/codex-usage.js";

test("Runtime CLI exposes the complete lifecycle without legacy sandbox commands", () => {
  const program = new Command();
  registerRuntime(program);
  assert.deepEqual(program.commands[0]?.commands.map((command) => command.name()), ["up", "attach", "detach", "status", "down", "logs"]);
});

const spaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const turnId = "33333333-3333-4333-8333-333333333333";
const previousTurn = "44444444-4444-4444-8444-444444444444";
const input = (harness: "pi" | "codex"): RuntimeTurnInput => ({
  spaceId, sessionId, turnId, userMessageId: turnId, harness, messages: [{ turnId, userMessageId: turnId, userId: "author", content: [{ type: "text", text: "continue" }] }], accessMode: "full_access",
  context: { revision: "one", throughTurnId: previousTurn, messages: [{ id: "history", turnId: previousTurn, role: "user", content: [{ type: "text", text: "historical fact" }] }] },
});

test("strict JSONL decoding preserves fragmented UTF-8 and does not accept broken records", () => {
  const values: unknown[] = [];
  const decoder = new JsonLineDecoder((value) => values.push(value));
  for (const byte of Buffer.from('{"text":"你好\\nworld"}\n{"second":true}\n')) decoder.push(Buffer.from([byte]));
  decoder.end();
  assert.deepEqual(values, [{ text: "你好\nworld" }, { second: true }]);
  assert.throws(() => new JsonLineDecoder(() => {}).push(Buffer.from("broken\n")));
});

test("Codex usage does not count a prior turn again when interruption repeats old totals", () => {
  const baseline = codexArchiveTotals([{ type: "token_usage_record", payload: { thread_token_usage: { input_tokens: 200, cached_input_tokens: 80, output_tokens: 20, total_tokens: 220 } } }]);
  assert(baseline);
  assert.equal(codexUsage(subtractCodexTokens(baseline, baseline)).totalTokens, 0);
  assert.deepEqual(codexUsage(subtractCodexTokens(codexTokenTotals({ inputTokens: 260, cachedInputTokens: 100, outputTokens: 30, totalTokens: 290 }), baseline)), { input: 40, output: 10, cacheRead: 20, cacheWrite: 0, totalTokens: 70 });
});

test("Runtime harness flags accept repeated and comma-separated values", () => {
  assert.deepEqual(parseRuntimeHarnesses(["pi", "codex,pi"]), ["pi", "codex"]);
  assert.throws(() => parseRuntimeHarnesses(["unknown"]));
});

test("local projection verifies native data and refuses to overwrite external or unconfirmed history", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-runtime-store-"));
  try {
    const store = new TestRuntimeSessionStore(spaceId, root);
    const turn = input("pi");
    store.projectionSource.addTurn(sessionId, previousTurn, { userContent: [{ type: "text", text: "historical fact" }] });
    const first = await store.prepare(turn, root);
    assert.equal(first.resume, "handoff");
    await store.started(first.state, turnId);
    await assert.rejects(() => store.prepare(turn, root), /unconfirmed/);
    await assert.rejects(() => store.prepare({ ...turn, turnId: previousTurn, context: { ...turn.context, throughTurnId: turnId } }, root), /unconfirmed/);
    await store.acknowledge(first.state, turnId, "two");
    const next = { ...turn, context: { ...turn.context, throughTurnId: turnId, revision: "two" } };
    assert.equal((await store.prepare(next, root)).resume, "native");
    const before = await readFile(first.state.path, "utf8");
    await appendFile(first.state.path, "external modification\n");
    const rebuilt = await store.prepare(next, root);
    assert.notEqual(rebuilt.state.path, first.state.path);
    assert.equal(await readFile(first.state.path, "utf8"), `${before}external modification\n`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Runtime inventory streams every pending Session execution in bounded batches", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-runtime-inventory-"));
  try {
    const store = new TestRuntimeSessionStore(spaceId, root);
    assert.deepEqual(await Array.fromAsync(store.pendingExecutionBatches()), []);
    const expected = [];
    for (let index = 0; index < 65; index++) {
      const pending = { ...input("pi"), sessionId: crypto.randomUUID(), turnId: crypto.randomUUID() };
      const { state } = await store.prepare(pending, root);
      await store.started(state, pending.turnId);
      expected.push({ sessionId: pending.sessionId, turnId: pending.turnId, harness: "pi" });
    }
    const batches = await Array.fromAsync(store.pendingExecutionBatches());
    assert.deepEqual(batches.map((batch) => batch.length), [64, 1]);
    const bySession = (value: { sessionId: string }[]) => [...value].sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    assert.deepEqual(bySession(batches.flat()), bySession(expected));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("result receipts replay only the same execution and retain one snapshot per Session/Harness", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-runtime-receipt-"));
  try {
    const store = new TestRuntimeSessionStore(spaceId, root);
    const turn = input("pi");
    const { state } = await store.prepare(turn, root);
    const event: RuntimeExecutionEvent = { type: "turn.end", message: { ordinal: 0, content: [{ type: "text", text: "saved result" }], stopReason: "stop" }, resume: "new" };
    await store.started(state, turnId);
    await store.recordResult(state, previousTurn, [event]);
    assert.deepEqual((await store.recoverResult(turn, previousTurn))?.events, [event]);
    await assert.rejects(() => store.recoverResult(turn, turnId), /execution identity/);
    const next = { ...turn, turnId: previousTurn, context: { ...turn.context, revision: "two", throughTurnId: turnId } };
    const prepared = await store.prepare(next, root);
    assert.equal(prepared.resume, "native", "a terminal server head reconciles a completed result after lost ack");
    assert.equal(prepared.state.pendingTurnId, null);
    await store.started(prepared.state, next.turnId);
    await store.recordResult(prepared.state, turnId, [event]);
    assert.equal(await store.recoverResult(turn, previousTurn), null);
    assert(await store.recoverResult(next, turnId));
    assert.equal((await readdir(join(store.root, "results"))).length, 1);
    await rm(prepared.state.path);
    await store.acknowledge(prepared.state, next.turnId, "three");
    const rebuilt = await store.prepare({ ...next, context: { complete: false, revision: "three", throughTurnId: next.turnId, messages: [] } }, root);
    assert.notEqual(rebuilt.state.path, prepared.state.path);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("terminal local projections retire with or without a receipt, while active turns still block", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-runtime-round-trip-"));
  try {
    const store = new TestRuntimeSessionStore(spaceId, root);
    const turn = input("pi");
    store.projectionSource.addTurn(sessionId, turnId, { sequence: 1, assistantContent: [{ type: "text", text: "A complete" }] });
    store.projectionSource.addTurn(sessionId, previousTurn, { sequence: 2, assistantContent: [{ type: "text", text: "B complete" }] });
    const first = await store.prepare(turn, root);
    await store.started(first.state, turnId);
    const terminal: RuntimeExecutionEvent = { type: "turn.end", message: { ordinal: 0, content: [{ type: "text", text: "A complete" }] }, resume: "handoff" };
    await store.recordResult(first.state, crypto.randomUUID(), [terminal]);
    const messages = [
      { id: "a", turnId, role: "assistant" as const, content: [{ type: "text" as const, text: "A complete" }] },
      { id: "b", turnId: previousTurn, role: "assistant" as const, content: [{ type: "text" as const, text: "B complete" }] },
    ];
    // A completed turn discovered behind a newer head is archived and rebuilt.
    const settledWithReceipt = { ...turn, turnId: previousTurn, context: { complete: true, revision: "after-codex", throughTurnId: previousTurn, settledTurnIds: [turnId], messages } };
    const rebuilt = await store.prepare(settledWithReceipt, root);
    assert.equal(rebuilt.resume, "handoff");
    assert.notEqual(rebuilt.state.path, first.state.path);
    assert.equal((await readdir(join(store.root, "retired"))).length, 1);

    // A killed turn leaves only a started marker; the server still terminalizes it, so the
    // projection must retire instead of blocking this Harness forever.
    const orphanStore = new TestRuntimeSessionStore(crypto.randomUUID(), root);
    const orphanSession = crypto.randomUUID();
    const orphan = await orphanStore.prepare({ ...turn, sessionId: orphanSession }, root);
    await orphanStore.started(orphan.state, turnId);
    orphanStore.projectionSource.addTurn(orphanSession, turnId, { sequence: 1, assistantContent: [{ type: "text", text: "A complete" }] });
    orphanStore.projectionSource.addTurn(orphanSession, previousTurn, { sequence: 2, assistantContent: [{ type: "text", text: "B complete" }] });
    const orphanRebuilt = await orphanStore.prepare({ ...settledWithReceipt, sessionId: orphanSession }, root);
    assert.equal(orphanRebuilt.resume, "handoff");
    assert.notEqual(orphanRebuilt.state.path, orphan.state.path);
    assert.equal((await readdir(join(orphanStore.root, "retired"))).length, 1);

    // While the server still considers the turn active, nothing may silently continue.
    const activeStore = new TestRuntimeSessionStore(crypto.randomUUID(), root);
    const activeSession = crypto.randomUUID();
    const active = await activeStore.prepare({ ...turn, sessionId: activeSession }, root);
    await activeStore.started(active.state, turnId);
    const activeContext = { complete: true, revision: "active", throughTurnId: turnId, messages };
    await assert.rejects(() => activeStore.prepare({ ...turn, sessionId: activeSession, turnId: previousTurn, context: activeContext }, root), /unconfirmed/);
    await assert.rejects(() => activeStore.prepare({ ...turn, sessionId: activeSession, turnId: previousTurn, context: { ...activeContext, complete: false } }, root), /Server resolution is required/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed acknowledgement writes retain the pending in-memory state for retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-runtime-ack-write-"));
  try {
    const store = new TestRuntimeSessionStore(spaceId, root);
    const { state } = await store.prepare(input("pi"), root);
    await store.started(state, turnId);
    const before = structuredClone(state);
    const path = join(store.root, "pi", `${sessionId}.json`);
    await rename(path, `${path}.backup`);
    await mkdir(path);
    await assert.rejects(() => store.acknowledge(state, turnId, "completed"));
    assert.deepEqual(state, before);
    assert.deepEqual(JSON.parse(await readFile(`${path}.backup`, "utf8")), JSON.parse(JSON.stringify(before)));
    await rm(path, { recursive: true });
    await rename(`${path}.backup`, path);
    await store.acknowledge(state, turnId, "completed");
    assert.equal(state.pendingTurnId, null);
    assert.equal(JSON.parse(await readFile(path, "utf8")).revision, "completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("confirmed Runtime resolution preserves the old pending projection and materializes server history", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-runtime-resolved-"));
  try {
    const store = new TestRuntimeSessionStore(spaceId, root);
    const turn = input("pi");
    const { state } = await store.prepare(turn, root);
    await store.started(state, turnId);
    const original = await readFile(state.path, "utf8");
    const next = { ...turn, turnId: previousTurn, context: { complete: false, revision: "resolved", throughTurnId: turnId, messages: [] } };
    await assert.rejects(() => store.prepare(next, root), /resolution is required/);
    store.projectionSource.addTurn(sessionId, turnId, { assistantContent: [{ type: "system_note", note_type: "info", text: "Prior effects unknown; do not replay" }] });
    const restored = await store.prepare({ ...next, context: { ...next.context, complete: true, resolvedTurnIds: [turnId], messages: [{ id: "resolution", turnId, role: "system", content: [{ type: "system_note", note_type: "info", text: "Prior effects unknown; do not replay" }] }] } }, root);
    assert.equal(restored.resume, "handoff");
    assert.notEqual(restored.state.path, state.path);
    assert.equal(await readFile(state.path, "utf8"), original);
    const retired = await readdir(join(store.root, "retired"));
    assert.equal(retired.length, 1);
    assert.equal(JSON.parse(await readFile(join(store.root, "retired", retired[0] ?? ""), "utf8")).state.pendingTurnId, turnId);
    assert(!(await readFile(restored.state.path, "utf8")).includes("Prior effects unknown"), "durable platform notes are never rewritten into the native projection");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a confirmed stop overrides a completed local result and rebuilds from durable history", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-runtime-resolved-receipt-"));
  try {
    const store = new TestRuntimeSessionStore(spaceId, root);
    const turn = input("pi");
    const first = await store.prepare(turn, root);
    await store.started(first.state, turnId);
    const terminal: RuntimeExecutionEvent = { type: "turn.end", message: { ordinal: 0, content: [{ type: "text", text: "local result" }] }, resume: "handoff" };
    await store.recordResult(first.state, crypto.randomUUID(), [terminal]);
    // The server never durably recorded this outcome, so the native projection must not be resumed.
    const rebuilt = await store.prepare({ ...turn, turnId: previousTurn, context: { complete: true, revision: "resolved", throughTurnId: turnId, resolvedTurnIds: [turnId], messages: [] } }, root);
    assert.equal(rebuilt.resume, "handoff");
    assert.notEqual(rebuilt.state.path, first.state.path);
    const retired = await readdir(join(store.root, "retired"));
    assert.equal(retired.length, 1);
    const archived = JSON.parse(await readFile(join(store.root, "retired", retired[0] ?? ""), "utf8"));
    assert.equal(archived.state.pendingTurnId, turnId);
    assert(archived.receipt, "the local result receipt is archived, not discarded");
    assert.equal(JSON.parse(archived.receipt).events.at(-1).type, "turn.end");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("changing Workspace requires a fresh projection instead of running in an old cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-runtime-cwd-"));
  try {
    const store = new TestRuntimeSessionStore(spaceId, root);
    const turn = input("pi");
    const { state } = await store.prepare(turn, root);
    await store.started(state, turnId);
    await store.acknowledge(state, turnId, "two");
    const moved = await store.prepare({ ...turn, context: { complete: false, revision: "two", throughTurnId: turnId, messages: [] } }, join(root, "another-workspace"));
    assert.notEqual(moved.state.path, state.path);
    assert.equal(JSON.parse((await readFile(state.path, "utf8")).split("\n")[0]).cwd, root);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const harness of ["pi", "codex"] as const) {
  test(`${harness} RPC streams before completion, resumes natively and restores a missing native file`, async () => {
    const root = await mkdtemp(join(tmpdir(), `cohub-${harness}-rpc-`));
    const binary = fileURLToPath(new URL(`./fixtures/runtime-${harness}.mjs`, import.meta.url));
    await chmod(binary, 0o755);
    const storage = await archiveStorageFixture();
    try {
      const options = { [harness]: binary };
      const catalog = await discoverHarnesses([harness], options, root);
      assert.equal(catalog.models[0]?.id, "test");
      const store = new TestRuntimeSessionStore(spaceId, join(root, "state"), storage.transport);
      const turn = input(harness);
      store.projectionSource.addTurn(sessionId, previousTurn, { userContent: [{ type: "text", text: "historical fact" }] });
      const events: RuntimeExecutionEvent[] = [];
      const run = harness === "pi" ? executePi : executeCodex;
      const first = await run(turn, options, root, store, (event) => events.push(event), new AbortController().signal);
      assert(events.some((event) => event.type === "text.delta"));
      // Pi carries durable history in its native session file. Codex has no native history channel for a
      // handoff yet, so it starts without history instead of receiving a fabricated transcript.
      const expectedAnswer = harness === "pi" ? "history retained" : "native resumed";
      assert(first.event.message.content.some((block) => block.type === "text" && block.text.includes(expectedAnswer)));
      assert.equal(first.event.archive?.turnId, turnId);
      assert.equal("data" in (first.event.archive ?? {}), false);
      await store.archives.flush(new AbortController().signal);
      if (harness === "codex") {
        assert.deepEqual(events.filter((event) => event.type === "message.start").map((event) => event.ordinal), [0, 1]);
        assert.equal(first.event.message.ordinal, 1, "Repeated native item/started must keep its ordinal");
        assert.deepEqual(first.event.message.usage, { input: 125, output: 12, cacheRead: 15, cacheWrite: 0, totalTokens: 152 });
      }
      await store.acknowledge(first.state, turnId, "two");
      const next = { ...turn, turnId: previousTurn, context: { ...turn.context, throughTurnId: turnId, revision: "two" } };
      const second = await run(next, options, root, store, () => {}, new AbortController().signal);
      assert.equal(second.event.resume, "native");
      assert.equal(second.state.nativeSessionId, first.state.nativeSessionId);
      const original = await readFile(first.state.path, "utf8");
      const coldStore = new TestRuntimeSessionStore(spaceId, join(root, "cold"), storage.transport);
      const restored = await run({ ...next, context: { ...next.context, complete: false, messages: [], archive: first.event.archive } }, options, root, coldStore, () => {}, new AbortController().signal);
      assert.equal(restored.event.resume, "restored");
      if (harness === "pi") assert.equal(restored.state.nativeSessionId, first.state.nativeSessionId);
      else assert.notEqual(restored.state.nativeSessionId, first.state.nativeSessionId);
      assert.equal(await readFile(first.state.path, "utf8"), original, "restoration must not modify the source projection");
    } finally { await storage.close(); await rm(root, { recursive: true, force: true }); }
  });
}
