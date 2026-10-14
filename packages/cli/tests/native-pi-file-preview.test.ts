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

const line = (value: unknown) => JSON.stringify(value) + "\n";
const assistant = () => line({ type: "message", id: "a1", parentId: "u1", timestamp: new Date().toISOString(), message: {
  role: "assistant", content: [{ type: "text", text: "Pi is still working" }], stopReason: "toolUse",
} });
async function until(check: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Pi file preview did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

for (const phase of ["connect", "growth"] as const) {
  test(`a running Pi turn without an extension previews its content on ${phase}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cohub-pi-preview-"));
    const previousDirectory = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "sessions");
    await mkdir(process.env.PI_CODING_AGENT_SESSION_DIR, { recursive: true });
    const id = randomUUID(), spaceId = randomUUID();
    const path = join(process.env.PI_CODING_AGENT_SESSION_DIR, `${id}.jsonl`);
    await writeFile(path, line({ type: "session", version: 3, id, cwd: root, timestamp: new Date().toISOString() })
      + line({ type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "Please investigate" } })
      + (phase === "connect" ? assistant() : ""));
    const runtime = await testNativeRuntime({ root, spaceId, harnesses: ["pi"], config: {
      version: 2, identity: "test", spaceId, root, harnesses: ["pi"], enabledAt: new Date(0).toISOString(), codexShared: false,
    } });
    const server = fakeNativeServer();
    const previews: Array<Extract<NativeRuntimeEvent, { type: "progress" }>> = [];
    const send = async (event: NativeRuntimeEvent) => {
      if (event.type === "progress") previews.push(event);
      return server.send(event);
    };
    runtime.native.connect(send);
    try {
      await until(() => server.turns.size === 1);
      if (phase === "growth") await appendFile(path, assistant());
      await until(() => previews.some((event) => event.progress.messages.some((message) => message.content.some((block) => block.type === "text" && block.text === "Pi is still working"))));
      assert.equal([...server.turns.values()][0].settled, false, "A parsed Pi result must not hide progress or settle an active tool turn");
      if (phase === "connect") {
        const count = previews.length;
        runtime.native.connect(null);
        runtime.native.connect(send);
        await until(() => previews.length > count);
        assert.equal(previews.at(-1)?.progress.from, 0);
        assert.deepEqual(previews.at(-1)?.progress.messages.flatMap((message) => message.content), [{ type: "text", text: "Pi is still working" }]);
      }
    } finally {
      await runtime.close();
      if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousDirectory;
      await rm(root, { recursive: true, force: true });
    }
  });
}
