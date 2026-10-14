import "./fixtures/native-home.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { NativeRuntimeEvent } from "@neta-art/cohub";
import { readNativeTranscript } from "../src/runtime/native/transcript.js";
import { nativeTurnId } from "../src/runtime/native/identity.js";
import { testNativeRuntime } from "./fixtures/runtime-native.js";
import { fakeNativeServer } from "./fixtures/native-server.js";

const row = (type: string, payload: unknown) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n";
const start = (key: string, resume = false) => row("event_msg", { type: "task_started", turn_id: key, ...(resume ? { turn_attribution: { turn_id: key, turn_trigger: "app_update_resume" } } : {}) });
const answer = (text: string) => row("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] });
async function until(check: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Resumed Codex turn did not sync");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("Codex update resumes have final empty input while ordinary unfinished prompts remain pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-codex-resume-"));
  const path = join(root, "session.jsonl");
  const header = row("session_meta", { id: randomUUID(), cwd: root });
  try {
    await writeFile(path, header + start("ordinary"));
    assert.deepEqual((await readNativeTranscript(path, "codex")).turns, []);
    await appendFile(path, row("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Partial prompt" }] }));
    const partial = (await readNativeTranscript(path, "codex")).turns[0];
    assert.notEqual(partial?.userFinal, true, "Normal input still waits for its final marker");
    await writeFile(path, header + start("resumed", true));
    const resumed = (await readNativeTranscript(path, "codex")).turns[0];
    assert.equal(resumed?.key, "resumed");
    assert.equal(resumed?.userFinal, true);
    assert.deepEqual(resumed?.userContent, [], "An update resume does not fabricate a user prompt");
    assert.equal(resumed?.result, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a new Codex update resume syncs progress and completion with one stable identity and no new prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-codex-resume-live-"));
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, "codex");
  const directory = join(process.env.CODEX_HOME, "sessions");
  await mkdir(directory, { recursive: true });
  const id = randomUUID(), spaceId = randomUUID();
  const path = join(directory, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  await writeFile(path, row("session_meta", { id, cwd: root }) + start("before-update")
    + row("event_msg", { type: "user_message", message: "Original task" })
    + row("event_msg", { type: "turn_aborted", turn_id: "before-update" }));
  const runtime = await testNativeRuntime({ root, spaceId, harnesses: ["codex"], config: {
    version: 2, identity: "test", spaceId, root, harnesses: ["codex"], enabledAt: new Date(0).toISOString(), codexShared: false,
  } });
  const server = fakeNativeServer();
  const previews: Array<Extract<NativeRuntimeEvent, { type: "progress" }>> = [];
  runtime.native.connect(async (event) => { if (event.type === "progress") previews.push(event); return server.send(event); });
  try {
    await until(() => server.turns.size === 1);
    await appendFile(path, start("resumed", true));
    const resumedId = nativeTurnId(spaceId, "codex", id, "resumed");
    await until(() => server.turns.has(resumedId));
    assert.equal(server.turns.get(resumedId)?.settled, false);
    await appendFile(path, answer("Work continued after the update"));
    await until(() => previews.some((event) => event.turnId === resumedId && event.progress.messages.some((message) => message.content.some((block) => block.type === "text" && block.text === "Work continued after the update"))));
    await appendFile(path, row("event_msg", { type: "user_message", message: "Additional instructions", client_id: randomUUID() })
      + answer("Using the additional instructions")
      + row("event_msg", { type: "task_complete", turn_id: "resumed" }));
    await until(() => server.turns.get(resumedId)?.settled === true);
    assert.equal(server.turns.size, 2, "The resumed execution must not fork after steering or completion");
    const versions = server.batches.flatMap((batch) => batch.turns).filter((turn) => turn.turnId === resumedId);
    assert.deepEqual(versions.map((turn) => turn.userContent), [[], []]);
    assert.deepEqual(versions.map((turn) => turn.result?.status ?? null), [null, "completed"]);
    assert.deepEqual(versions.at(-1)?.result?.messages.flatMap((message) => message.content), [
      { type: "text", text: "Work continued after the update" },
      { type: "text", text: "Additional instructions", _meta: { nativeUserMessage: true } },
      { type: "text", text: "Using the additional instructions" },
    ]);
  } finally {
    await runtime.close();
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
