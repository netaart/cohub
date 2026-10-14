import "./fixtures/native-home.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import type { NativeRuntimeEvent } from "@neta-art/cohub";
import { NativeRuntime } from "../src/runtime/native/daemon.js";

const settle = async () => { for (let index = 0; index < 4; index += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };
const message = (text: string) => ({ content: [{ type: "text" as const, text }], provider: null, model: null });
const transcript = (text: string) => [
  { type: "session_meta", payload: { id: "native", cwd: "/project" } },
  { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
  { type: "event_msg", payload: { type: "user_message", message: "Question" } },
  { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } },
].map((entry) => JSON.stringify({ timestamp: "2026-10-12T00:00:00.000Z", ...entry })).join("\n") + "\n";

for (const update of ["snapshot", "growth"] as const) {
  test(`a ${update} arriving during a file preview read is not lost`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const path = "/project/preview-race.jsonl";
    const original = fs.createReadStream;
    const pending = new PassThrough();
    let streams = 0;
    let latest = "Older progress";
    // Codex first reads a header, then its full transcript. Hold the first full read
    // after it has consumed the old bytes to reproduce a concurrent newer update.
    const read = context.mock.method(fs, "createReadStream", ((file: fs.PathLike, options: unknown) => {
      if (file !== path) return original(file, options as never);
      streams += 1;
      if (streams === 2) { pending.write(transcript(latest)); return pending; }
      return Readable.from([Buffer.from(transcript(latest))]);
    }) as typeof fs.createReadStream);
    syncBuiltinESMExports();
    context.after(() => { pending.destroy(); read.mock.restore(); syncBuiltinESMExports(); });

    const runtime: any = new NativeRuntime({
      spaceId: "space", root: "/project", stateRoot: "/unused", harnesses: [], executables: {}, identity: "test", config: null,
      archives: {} as never, projectionSource: {} as never, diagnostics: { log: () => {} } as never,
    });
    const state = { path, harness: "codex", nativeSessionId: "native", sessionId: "session", runningTurnId: "cloud-turn", runningTurnKey: "turn" };
    runtime.ingest.alive = () => {};
    runtime.ingest.running = () => state;
    const sent: Array<Extract<NativeRuntimeEvent, { type: "progress" }>> = [];
    runtime.send = async (event: Extract<NativeRuntimeEvent, { type: "progress" }>) => { sent.push(event); return { accepted: true }; };
    context.after(() => runtime.endFilePreview(path));

    runtime.onGrowth(state);
    context.mock.timers.tick(2_000);
    await settle();
    assert.equal(streams, 2, "the first full preview read is still pending");
    latest = "Latest progress";
    if (update === "snapshot") {
      runtime.onGrowth(state, { key: "turn", messages: [message(latest)] });
      context.mock.timers.tick(0);
      await settle();
      assert.deepEqual(sent.at(-1)?.progress.messages, [message(latest)]);
    } else {
      runtime.onGrowth(state);
      runtime.onGrowth(state);
    }
    pending.end();
    await settle();
    context.mock.timers.tick(60_000);
    await settle();
    context.mock.timers.tick(0);
    await settle();

    assert.deepEqual(sent.at(-1)?.progress.messages, [message(latest)], "the cloud must finish with the latest content");
    assert.equal(streams, update === "snapshot" ? 2 : 4, "only unresolved growth needs one follow-up read");
    if (update === "snapshot") assert.equal(sent.length, 1, "an obsolete read must never overwrite the newer snapshot");
  });
}
