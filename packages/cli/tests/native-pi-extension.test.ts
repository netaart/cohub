import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import cohub, { controlSocketPath } from "../src/runtime/native/pi-extension.js";

class FakeSocket extends EventEmitter {
  destroyed = false;
  replies = new Map<string, Record<string, unknown>>();
  write(line: string) {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message.type === "result" || message.type === "error") this.replies.set(String(message.id), message);
    return true;
  }
  end() { this.destroyed = true; }
}

test("a second Turn sent before the first run starts is refused, not dropped", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cohub-pi-extension-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  t.after(() => { if (previousState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previousState; });
  const socketPath = controlSocketPath(root);
  await mkdir(dirname(socketPath), { recursive: true });
  await writeFile(socketPath, "pipe");

  // Like Pi, a prompt starts its run a moment later, and one arriving meanwhile without `deliverAs` is lost.
  const handlers = new Map<string, Array<(event: unknown, context: typeof context) => unknown>>();
  const emit = (name: string) => { for (const handler of handlers.get(name) ?? []) handler({}, context); };
  let idle = true;
  let pending = false;
  const sent: string[] = [];
  const dropped: string[] = [];
  const markers: unknown[] = [];
  const context = { cwd: root, sessionManager: { getSessionId: () => "pi-session", getSessionFile: () => undefined }, isIdle: () => idle, abort() {} };
  const socket = new FakeSocket();
  cohub({
    on: (name, handler) => { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    appendEntry: (_type, data) => { markers.push(data); },
    sendUserMessage: (content, options) => {
      if (pending && !options?.deliverAs) { dropped.push(String(content)); return; }
      sent.push(String(content));
      pending = true;
      setTimeout(() => { pending = false; idle = false; emit("agent_start"); }, 20);
    },
  }, () => socket as unknown as Socket);
  t.after(() => emit("session_shutdown"));
  emit("session_start");
  socket.emit("connect");

  const prompt = (id: string) => `${JSON.stringify({ type: "prompt", id, turnId: `turn-${id}`, content: id })}\n`;
  socket.emit("data", Buffer.from(prompt("a") + prompt("b")));
  await waitFor(() => socket.replies.has("a") && socket.replies.has("b"));
  assert.equal(socket.replies.get("a")?.accepted, true);
  assert.equal(socket.replies.get("b")?.accepted, false);

  // Once the run has started and settled, the next Turn goes through.
  await waitFor(() => !idle);
  idle = true;
  socket.emit("data", Buffer.from(prompt("c")));
  await waitFor(() => socket.replies.has("c"));
  assert.equal(socket.replies.get("c")?.accepted, true);
  assert.deepEqual(sent, ["a", "c"]);
  assert.deepEqual(dropped, []);
  assert.deepEqual(markers, [{ turnId: "turn-a" }, { turnId: "turn-c" }]);
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
