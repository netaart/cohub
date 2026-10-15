import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeTurnInput } from "@neta-art/cohub";
import { NativeRuntime } from "../src/runtime/native/daemon.js";
import { RuntimeArchiveStore } from "../src/runtime/archive-store.js";
import { RuntimeDiagnostics } from "../src/runtime/diagnostics.js";
import { executeTurn } from "../src/runtime/native/execution.js";
import { readTranscript } from "../src/runtime/native/adapters.js";
import { runtimeProjectionSource } from "./fixtures/runtime-projection-source.js";

async function setup(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cohub-workbuddy-execution-")));
  const previous = process.env.WORKBUDDY_HOME;
  process.env.WORKBUDDY_HOME = join(root, "home");
  const spaceId = randomUUID(), stateRoot = join(root, "state");
  const diagnostics = new RuntimeDiagnostics({ root: stateRoot, spaceId });
  const native = new NativeRuntime({ spaceId, root, stateRoot, harnesses: ["workbuddy"], executables: { workbuddy: new URL("./fixtures/runtime-workbuddy-execution.mjs", import.meta.url).pathname }, identity: "test", config: null, archives: new RuntimeArchiveStore(join(stateRoot, "archives"), null), projectionSource: runtimeProjectionSource(), diagnostics });
  t.after(async () => { await native.close(AbortSignal.timeout(2000)); await diagnostics.close(); if (previous === undefined) delete process.env.WORKBUDDY_HOME; else process.env.WORKBUDDY_HOME = previous; await rm(root, { recursive: true, force: true }); });
  const input = (text: string): RuntimeTurnInput => ({ spaceId, sessionId: randomUUID(), turnId: randomUUID(), userMessageId: randomUUID(), harness: "workbuddy", accessMode: "full_access", context: { complete: true, revision: "new", throughTurnId: null, messages: [] }, messages: [{ turnId: randomUUID(), userMessageId: randomUUID(), userId: "test", content: [{ type: "text", text }] }] });
  return { executor: native.executor, input };
}

test("WorkBuddy executes, persists the same cloud turn, and continues without changing the original", async (t) => {
  const { executor, input } = await setup(t);
  const first = input("hello");
  const result = await executeTurn(executor, first, () => {}, new AbortController().signal, randomUUID());
  assert.deepEqual(result.event.message.content, [{ type: "text", text: "echo:hello" }]);
  assert.equal(result.event.archive?.turnId, first.turnId);
  assert.equal((await readTranscript(result.session.path, "workbuddy")).turns[0]?.cloudTurnId, first.turnId);
  const original = await readFile(result.session.path, "utf8");
  assert.equal(await executor.results.recover(first), null, "completed messages do not prove execution success");
  await executor.results.record(result.session, first, null, [result.event]);
  assert.deepEqual(await executor.results.recover(first), { session: result.session, events: [result.event] });
  await executor.results.acknowledge(first.sessionId, first.turnId);
  const next = input("again"); next.sessionId = first.sessionId;
  next.context = { complete: true, revision: "next", throughTurnId: first.turnId, messages: [], archive: result.event.archive };
  const second = await executeTurn(executor, next, () => {}, new AbortController().signal, randomUUID());
  assert.notEqual(second.session.nativeSessionId, result.session.nativeSessionId);
  assert.equal(await readFile(result.session.path, "utf8"), original);
  assert.deepEqual(second.event.message.content, [{ type: "text", text: "echo:again" }]);
  const transcript = await readTranscript(second.session.path, "workbuddy");
  assert.equal(transcript.turns.length, 1, "recovered prefix is not reimported");
  assert.equal(transcript.turns[0]?.cloudTurnId, next.turnId);
});

test("WorkBuddy surfaces execution failure and stops only its own process", async (t) => {
  const { executor, input } = await setup(t);
  const failed = await executeTurn(executor, input("fail"), () => {}, new AbortController().signal, randomUUID());
  assert.equal(failed.event.message.stopReason, "error");
  assert.match(failed.event.message.errorMessage ?? "", /Fixture execution failed/);
  const controller = new AbortController();
  const stopped = await executeTurn(executor, input("wait"), (event) => { if (event.type === "text.delta") controller.abort(); }, controller.signal, randomUUID());
  assert.equal(stopped.event.message.stopReason, "aborted");
  assert.equal(stopped.uncertainCleanup, undefined);
});
