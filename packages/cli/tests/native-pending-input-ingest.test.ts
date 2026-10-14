import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { NativeIngest } from "../src/runtime/native/ingest.js";
import { RuntimeArchiveStore } from "../src/runtime/archive-store.js";
import { fakeNativeServer } from "./fixtures/native-server.js";
const row = (type: string, payload: unknown) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n";
async function until(check: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Pending native input did not register after rich content arrived");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
test("a pending legacy prompt is reread when rich content arrives without another boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-pending-input-"));
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, "codex");
  const directory = join(process.env.CODEX_HOME, "sessions");
  await mkdir(directory, { recursive: true });
  const id = randomUUID(), path = join(directory, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  const ingest = new NativeIngest({ spaceId: randomUUID(), cwd: root, root: join(root, "state"), harnesses: ["codex"], enabledAt: new Date(0).toISOString(), archives: new RuntimeArchiveStore(join(root, "archives"), null) });
  const server = fakeNativeServer();
  try {
    await writeFile(path, row("session_meta", { id, cwd: root })
      + row("event_msg", { type: "task_started", turn_id: "old" })
      + row("event_msg", { type: "user_message", message: "Previous" })
      + row("event_msg", { type: "task_complete", turn_id: "old", last_agent_message: "Done" })
      + row("event_msg", { type: "task_started", turn_id: "pending" })
      + row("event_msg", { type: "user_message", message: "Look", client_id: "original" }));
    ingest.connect(server.transport);
    await until(() => server.turns.size === 1 && ingest.status().live === 0);
    assert.equal(server.batches.length, 1, "The partial image prompt must not register yet");
    await appendFile(path, row("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Look" }, { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] })
      + row("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "I see it" }] }));
    await ingest.scan();
    await until(() => server.turns.size === 2);
    assert.deepEqual(server.batches.at(-1)!.turns[0].userContent, [{ type: "text", text: "Look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }]);
    assert.equal(server.batches.at(-1)!.turns[0].result, null, "The new task is synchronized while still running");
  } finally {
    await ingest.close(AbortSignal.timeout(2_000));
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
