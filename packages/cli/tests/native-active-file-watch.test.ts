import "./fixtures/native-home.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { NativeRuntimeEvent } from "@neta-art/cohub";
import { testNativeRuntime } from "./fixtures/runtime-native.js";
import { fakeNativeServer } from "./fixtures/native-server.js";

const row = (type: string, payload: unknown) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n";
const answer = (text: string) => row("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] });
async function until(check: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Active transcript change did not sync");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("observed sessions sync open-file writes and subsequent turns, survive replacement, and release watchers on pause or shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-active-watch-"));
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, "codex");
  const directory = join(process.env.CODEX_HOME, "sessions");
  await mkdir(directory, { recursive: true });
  const id = randomUUID(), spaceId = randomUUID();
  const path = join(directory, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  let contents = row("session_meta", { id, cwd: root })
    + row("event_msg", { type: "task_started", turn_id: "first" })
    + row("event_msg", { type: "user_message", message: "Original question" }) + answer("Initial progress");
  await writeFile(path, contents);
  const runtime = await testNativeRuntime({ root, spaceId, harnesses: ["codex"], config: {
    version: 2, identity: "test", spaceId, root, harnesses: ["codex"], enabledAt: new Date(0).toISOString(), codexShared: false,
  } });
  const internals = runtime.native.ingest as unknown as { watchers: Array<{ close(): void }>; sessionWatchers: Map<string, { close(): void }> };
  let writer = await open(path, "a");
  const server = fakeNativeServer();
  const previews: Array<Extract<NativeRuntimeEvent, { type: "progress" }>> = [];
  const hasText = (text: string) => previews.some((event) => event.progress.messages.some((message) => message.content.some((block) => block.type === "text" && block.text === text)));
  runtime.native.connect(async (event) => { if (event.type === "progress") previews.push(event); return server.send(event); });
  try {
    await until(() => hasText("Initial progress"));
    // Reproduce the observed OS behavior: discovery emits no further change notifications.
    for (const watcher of internals.watchers) watcher.close();
    const next = answer("Later progress");
    contents += next;
    await writer.write(next);
    await until(() => hasText("Later progress"));
    assert.equal(server.batches.length, 1, "Content-only changes use the existing preview path, not another ingest");
    await writer.close();
    contents += answer("Progress after replacement");
    await writeFile(`${path}.replacement`, contents);
    await rename(`${path}.replacement`, path);
    await until(() => hasText("Progress after replacement"));
    writer = await open(path, "a");
    await writer.write(row("event_msg", { type: "task_complete", turn_id: "first" }));
    await until(() => [...server.turns.values()][0]?.settled === true);

    await writer.write(row("event_msg", { type: "task_started", turn_id: "second" })
      + row("event_msg", { type: "user_message", message: "Next task" }) + answer("Second task"));
    await until(() => hasText("Second task"));
    assert.equal(server.turns.size, 2, "A subsequent turn on the same open file must be discovered without a recursive event");
    assert.equal(internals.sessionWatchers.size, 1);
    runtime.native.ingest.configure([], new Date(0).toISOString());
    assert.equal(internals.sessionWatchers.size, 0, "Pausing sync releases session watchers");
    const discoveryWatchers = internals.watchers.length;
    runtime.native.ingest.configure(["codex"], new Date(0).toISOString());
    assert.equal(internals.sessionWatchers.size, 1, "Resuming sync reattaches to the running task");
    await until(() => internals.watchers.length === discoveryWatchers * 2);
  } finally {
    await writer.close();
    await runtime.close();
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(internals.sessionWatchers.size, 0, "Shutdown releases watchers for previously active sessions");
});

test("macOS startup observes open idle transcripts without watching closed history", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-idle-watch-"));
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, "codex");
  const directory = join(process.env.CODEX_HOME, "sessions");
  await mkdir(directory, { recursive: true });
  const id = randomUUID(), spaceId = randomUUID();
  const path = join(directory, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  const closedId = randomUUID();
  const closedPath = join(directory, `rollout-2026-01-01T00-00-00-${closedId}.jsonl`);
  const settled = (nativeId: string) => row("session_meta", { id: nativeId, cwd: root })
    + row("event_msg", { type: "task_started", turn_id: `old-${nativeId}` })
    + row("event_msg", { type: "user_message", message: "Old question" })
    + row("event_msg", { type: "task_complete", turn_id: `old-${nativeId}`, last_agent_message: "Finished" });
  await writeFile(path, settled(id));
  await writeFile(closedPath, settled(closedId));
  // These are existing historical files, not creation notifications still waiting in FSEvents.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const writer = await open(path, "a");
  const runtime = await testNativeRuntime({ root, spaceId, harnesses: ["codex"], config: {
    version: 2, identity: "test", spaceId, root, harnesses: ["codex"], enabledAt: new Date(0).toISOString(), codexShared: false,
  } });
  const internals = runtime.native.ingest as unknown as { sessionWatchers: Map<string, { close(): void }> };
  const server = fakeNativeServer();
  const previews: Array<Extract<NativeRuntimeEvent, { type: "progress" }>> = [];
  runtime.native.connect(async (event) => { if (event.type === "progress") previews.push(event); return server.send(event); });
  try {
    await until(() => server.turns.size === 2);
    // Let startup discovery events drain, then append without closing the existing writer.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await writer.write(row("event_msg", { type: "task_started", turn_id: "resumed" })
      + row("event_msg", { type: "user_message", message: "Continue" }) + answer("Resumed progress"));
    await until(() => previews.some((event) => event.progress.messages.some((message) => message.content.some((block) => block.type === "text" && block.text === "Resumed progress"))));
    assert.equal(server.turns.size, 3);
    assert.equal(internals.sessionWatchers.has(path), true);
    assert.equal(internals.sessionWatchers.has(closedPath), false, "Closed history must not acquire a direct watcher");
  } finally {
    await writer.close();
    await runtime.close();
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("macOS discovers a previously closed session opened later and pauses discovery with sync", { skip: process.platform !== "darwin" }, async (context) => {
  const setTimer = setTimeout;
  context.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) => setTimer(callback, milliseconds === 15_000 ? 50 : milliseconds, ...args));
  const root = await mkdtemp(join(tmpdir(), "cohub-reopened-watch-"));
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, "codex");
  const directory = join(process.env.CODEX_HOME, "sessions");
  await mkdir(directory, { recursive: true });
  const id = randomUUID(), spaceId = randomUUID();
  const path = join(directory, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  await writeFile(path, row("session_meta", { id, cwd: root })
    + row("event_msg", { type: "task_started", turn_id: "old" })
    + row("event_msg", { type: "user_message", message: "Old question" })
    + row("event_msg", { type: "task_complete", turn_id: "old", last_agent_message: "Done" }));
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const runtime = await testNativeRuntime({ root, spaceId, harnesses: ["codex"], config: {
    version: 2, identity: "test", spaceId, root, harnesses: ["codex"], enabledAt: new Date(0).toISOString(), codexShared: false,
  } });
  const internals = runtime.native.ingest as unknown as { sessionWatchers: Map<string, unknown>; openSessionsTimer: ReturnType<typeof setTimeout> | null; openSessionsTask: Promise<void> | null };
  const server = fakeNativeServer();
  runtime.native.connect(server.send);
  let writer: Awaited<ReturnType<typeof open>> | null = null;
  try {
    await until(() => server.turns.size === 1);
    assert.equal(internals.sessionWatchers.has(path), false);
    writer = await open(path, "a");
    await writer.write(row("event_msg", { type: "task_started", turn_id: "reopened" })
      + row("event_msg", { type: "user_message", message: "New question" }) + answer("New progress"));
    await until(() => server.turns.size === 2);
    assert.equal(internals.sessionWatchers.has(path), true);
    runtime.native.ingest.configure([], new Date(0).toISOString());
    await until(() => internals.openSessionsTask === null);
    assert.equal(internals.openSessionsTimer, null, "Pausing cancels periodic discovery");
    assert.equal(internals.sessionWatchers.size, 0);
  } finally {
    await writer?.close();
    await runtime.close();
    assert.equal(internals.openSessionsTimer ?? null, null, "Shutdown releases the discovery timer");
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
