import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
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

/** The extension in memory: a Pi that starts a run a moment after a prompt, like the real one. */
async function harness(t: TestContext, options: { modelDelayMs?: number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cohub-pi-extension-")));
  const previousState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  const socketPath = controlSocketPath(root);
  await mkdir(dirname(socketPath), { recursive: true });
  await writeFile(socketPath, "pipe");

  const handlers = new Map<string, Array<(event: unknown, context: typeof context) => unknown>>();
  const emit = (name: string) => { for (const handler of handlers.get(name) ?? []) handler({}, context); };
  const state = { idle: true, pending: false, failNextSend: false };
  const sent: string[] = [];
  const dropped: string[] = [];
  const markers: unknown[] = [];
  const models: string[] = [];
  const thinking: string[] = [];
  const context = {
    cwd: root,
    sessionManager: { getSessionId: () => "pi-session", getSessionFile: () => undefined },
    isIdle: () => state.idle,
    abort() {},
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
  };
  const socket = new FakeSocket();
  cohub({
    on: (name, handler) => { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    appendEntry: (_type, data) => { markers.push(data); },
    setModel: async (model) => {
      models.push(`${(model as { provider: string }).provider}/${(model as { id: string }).id}`);
      await new Promise((resolve) => setTimeout(resolve, options.modelDelayMs ?? 0));
      return true;
    },
    setThinkingLevel: (level) => { thinking.push(level); },
    sendUserMessage: (content, sendOptions) => {
      if (state.failNextSend) { state.failNextSend = false; throw new Error("stale extension context"); }
      if (state.pending && !sendOptions?.deliverAs) { dropped.push(String(content)); return; }
      sent.push(String(content));
      state.pending = true;
      setTimeout(() => { state.pending = false; state.idle = false; emit("agent_start"); }, 20);
    },
  }, () => socket as unknown as Socket);
  emit("session_start");
  socket.emit("connect");
  t.after(async () => {
    emit("session_shutdown");
    if (previousState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previousState;
    await rm(root, { recursive: true, force: true });
  });
  return { socket, state, sent, dropped, markers, models, thinking, emit };
}

const prompt = (id: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ type: "prompt", id, turnId: `turn-${id}`, content: id, ...extra })}\n`;

test("a second Turn sent before the first run starts is refused, not dropped", async (t) => {
  const { socket, sent, dropped, markers, state } = await harness(t);
  socket.emit("data", Buffer.from(prompt("a") + prompt("b")));
  await waitFor(() => socket.replies.has("a") && socket.replies.has("b"));
  assert.equal(socket.replies.get("a")?.accepted, true);
  assert.equal(socket.replies.get("b")?.accepted, false);

  // Once the run has started and settled, the next Turn goes through.
  await waitFor(() => !state.idle);
  state.idle = true;
  socket.emit("data", Buffer.from(prompt("c")));
  await waitFor(() => socket.replies.has("c"));
  assert.equal(socket.replies.get("c")?.accepted, true);
  assert.deepEqual(sent, ["a", "c"]);
  assert.deepEqual(dropped, []);
  assert.deepEqual(markers, [{ turnId: "turn-a" }, { turnId: "turn-c" }]);
});

test("a refused Turn cannot switch the accepted Turn's model", async (t) => {
  const { socket, sent, models, thinking } = await harness(t, { modelDelayMs: 20 });
  const first = prompt("a", { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "low" });
  const second = prompt("b", { model: { provider: "faux", id: "faux-2" }, thinkingLevel: "high" });
  socket.emit("data", Buffer.from(first + second));
  await waitFor(() => socket.replies.has("a") && socket.replies.has("b"));
  assert.equal(socket.replies.get("a")?.accepted, true);
  assert.equal(socket.replies.get("b")?.accepted, false);
  assert.deepEqual(sent, ["a"]);
  assert.deepEqual(models, ["faux/faux-1"]);
  assert.deepEqual(thinking, ["low"]);
});

test("a prompt that fails to send releases the session at once", async (t) => {
  const { socket, state, sent } = await harness(t);
  state.failNextSend = true;
  socket.emit("data", Buffer.from(prompt("a")));
  await waitFor(() => socket.replies.has("a"));
  assert.equal(socket.replies.get("a")?.type, "error");
  socket.emit("data", Buffer.from(prompt("b")));
  await waitFor(() => socket.replies.has("b"));
  assert.equal(socket.replies.get("b")?.accepted, true);
  assert.deepEqual(sent, ["b"]);
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
