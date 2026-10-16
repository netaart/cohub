import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RuntimeTurnInput } from "@neta-art/cohub";
import { executeTurn } from "../src/runtime/native/execution.js";
import { nativeTurnId } from "../src/runtime/native/identity.js";
import { readTranscript } from "../src/runtime/native/adapters.js";
import { testNativeRuntime } from "./fixtures/runtime-native.js";

const line = (type: string, payload: unknown) => `${JSON.stringify({ timestamp: "2026-10-12T00:00:00.000Z", type, payload })}\n`;

async function setup(marked = false, foreignMarker = false) {
  const root = await mkdtemp(join(tmpdir(), "cohub-codex-fork-"));
  const spaceId = randomUUID(), parentSessionId = randomUUID(), nativeSessionId = randomUUID();
  const first = randomUUID(), later = randomUUID(), marker = marked ? randomUUID() : undefined;
  const boundary = marker && !foreignMarker ? marker : nativeTurnId(spaceId, "codex", nativeSessionId, first);
  const path = join(root, `native-${nativeSessionId}.jsonl`);
  const prefix = line("session_meta", { id: nativeSessionId, session_id: nativeSessionId, cwd: root, history_mode: "paginated" })
    + line("event_msg", { type: "turn_started", turn_id: first })
    + line("event_msg", { type: "user_message", message: "keep this history", ...(marker ? { client_id: marker } : {}) })
    + '{ "type": "response_item", "payload": { "type": "reasoning", "encrypted_content": "opaque-retained", "large": 9007199254740993 } }\n'
    + line("event_msg", { type: "turn_complete", turn_id: first, last_agent_message: "first answer" });
  const original = prefix + line("event_msg", { type: "turn_started", turn_id: later })
    + line("event_msg", { type: "user_message", message: "future must be excluded" })
    + line("event_msg", { type: "turn_complete", turn_id: later, last_agent_message: "future answer" });
  await writeFile(path, original);
  const runtime = await testNativeRuntime({ spaceId, root, harnesses: ["codex"] });
  runtime.native.executor.ingest.adopt({ path, cwd: root, harness: "codex", nativeSessionId }, parentSessionId,
    { turnKey: later, turnId: nativeTurnId(spaceId, "codex", nativeSessionId, later) });
  const turnId = randomUUID();
  const input: RuntimeTurnInput = { spaceId, sessionId: randomUUID(), turnId, userMessageId: randomUUID(), harness: "codex",
    messages: [{ turnId, userMessageId: randomUUID(), userId: null, content: [{ type: "text", text: "continue child" }] }],
    context: { complete: false, revision: "fork-boundary", throughTurnId: boundary, messages: [], fork: { sessionId: parentSessionId, turnId: boundary } },
    accessMode: "full_access" };
  return { root, path, prefix, original, runtime, input, first, parentSessionId, boundary, nativeSessionId, later,
    close: async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); } };
}

for (const [marked, foreignMarker] of [[false, false], [true, false], [true, true]]) test(`Codex fork retains the selected native boundary and opaque history (${marked ? foreignMarker ? "desktop client marker" : "Cohub" : "native"} turn)`, async () => {
  const w = await setup(marked, foreignMarker);
  try {
    const result = await executeTurn(w.runtime.native.executor, w.input, () => {}, new AbortController().signal, randomUUID());
    assert.notEqual(result.session.path, w.path);
    const child = await readFile(result.session.path, "utf8");
    assert(child.includes(w.prefix.slice(w.prefix.indexOf("\n") + 1)), "native records, including opaque bytes, must survive unchanged");
    assert(!child.includes("future must be excluded"));
    assert(child.includes("continue child"));
    assert.equal(await readFile(w.path, "utf8"), w.original, "fork must never mutate the parent");
    const transcript = await readTranscript(result.session.path, "codex");
    assert.equal(transcript.turns[0]?.key, w.first);
    assert.equal(transcript.turns.length, 2, "only the selected prefix and new child turn remain");
    const prepared = await w.runtime.native.executor.sessions.prepare({ ...w.input, cwd: w.root,
      context: { ...w.input.context, revision: "child-completed", throughTurnId: w.input.turnId }, resumable: () => true });
    assert.equal(prepared.session.path, result.session.path, "later turns resume the child rather than fork again");
    assert.equal(w.runtime.native.executor.ingest.transcriptFor(w.parentSessionId, "codex", nativeTurnId(w.input.spaceId, "codex", w.nativeSessionId, w.later))?.path, w.path);
  } finally { await w.close(); }
});

test("an older Codex ignoring the selected boundary is rejected before starting or adopting a turn", async () => {
  const w = await setup();
  try {
    const id = randomUUID(), path = join(w.root, "incorrect-fork.jsonl");
    await writeFile(path, w.original.replaceAll(w.nativeSessionId, id));
    const calls: string[] = [];
    w.runtime.native.executor.codex.get = async () => ({ shared: true, closed: false,
      request: async (method) => { calls.push(method); return { thread: { id, path } }; },
      refuse: () => {}, onEvent: () => () => {}, onClose: () => () => {}, close: async () => {},
    });
    await assert.rejects(executeTurn(w.runtime.native.executor, w.input, () => {}, new AbortController().signal, randomUUID()), /did not preserve the requested turn boundary/);
    assert.deepEqual(calls, ["thread/fork"], "no prompt can reach the wrong branch");
    assert.equal(w.runtime.native.executor.ingest.transcriptFor(w.input.sessionId, "codex", w.boundary), null);
    assert.equal(await readFile(w.path, "utf8"), w.original);
  } finally { await w.close(); }
});

test("a fork with unavailable child history never restarts from its parent or projected text", async () => {
  const w = await setup();
  try {
    w.input.context.throughTurnId = randomUUID();
    await assert.rejects(executeTurn(w.runtime.native.executor, w.input, () => {}, new AbortController().signal, randomUUID()), /fork continuation is unavailable/);
    assert.equal(await readFile(w.path, "utf8"), w.original);
  } finally { await w.close(); }
});

test("a missing native fork source fails instead of projecting cloud history", async () => {
  const w = await setup();
  try {
    assert(w.input.context.fork);
    w.input.context.fork.sessionId = randomUUID();
    await assert.rejects(executeTurn(w.runtime.native.executor, w.input, () => {}, new AbortController().signal, randomUUID()), /fork source.*unavailable/i);
    assert.equal(await readFile(w.path, "utf8"), w.original);
  } finally { await w.close(); }
});

test("a missing native fork boundary fails instead of choosing the latest turn", async () => {
  const w = await setup();
  try {
    assert(w.input.context.fork);
    w.input.context.throughTurnId = w.input.context.fork.turnId = randomUUID();
    await assert.rejects(executeTurn(w.runtime.native.executor, w.input, () => {}, new AbortController().signal, randomUUID()), /fork boundary.*(missing|unavailable)/i);
    assert.equal(await readFile(w.path, "utf8"), w.original);
  } finally { await w.close(); }
});
