import "./fixtures/native-home.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { NativeRuntimeEvent } from "@neta-art/cohub";
import { testNativeRuntime } from "./fixtures/runtime-native.js";
import { fakeNativeServer } from "./fixtures/native-server.js";

const row = (type: string, payload: unknown) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n";
const message = (text: string) => row("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] });
async function until(check: () => boolean) {
  const until = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > until) throw new Error("Live file preview did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("existing running content is previewed on connect and boundary reads without waiting for another write", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-file-preview-"));
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, "codex");
  const id = randomUUID(), spaceId = randomUUID();
  const directory = join(process.env.CODEX_HOME, "sessions");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  await writeFile(path, row("session_meta", { id, cwd: root })
    + row("event_msg", { type: "task_started", turn_id: "t1" })
    + row("event_msg", { type: "user_message", message: "Original question" }) + message("Already working"));
  const runtime = await testNativeRuntime({ root, spaceId, harnesses: ["codex"], config: { version: 2, identity: "test", spaceId, root, harnesses: ["codex"], enabledAt: new Date(0).toISOString(), codexShared: false } });
  const server = fakeNativeServer();
  const previews: Array<Extract<NativeRuntimeEvent, { type: "progress" }>> = [];
  runtime.native.connect(async (event) => { if (event.type === "progress") previews.push(event); return server.send(event); });
  try {
    await until(() => previews.length > 0);
    assert.deepEqual(previews[0].progress.messages.flatMap((m) => m.content), [{ type: "text", text: "Already working" }]);
    await appendFile(path, row("event_msg", { type: "user_message", message: "Additional instructions" }) + message("Using the new instructions"));
    await until(() => previews.some((p) => p.progress.messages.some((m) => m.content.some((b) => b.type === "text" && b.text === "Using the new instructions"))));
    assert.equal(server.turns.size, 1, "Steering must not create another turn");
    assert.equal([...server.turns.values()][0].settled, false, "Live preview must not finish the running task");
    const count = previews.length;
    runtime.native.connect(null);
    runtime.native.connect(async (event) => { if (event.type === "progress") previews.push(event); return server.send(event); });
    await until(() => previews.length > count);
    assert.equal(previews.at(-1)?.progress.from, 0, "A reconnect must restore the full preview even when the file did not change");
  } finally {
    await runtime.close();
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
