import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { createRuntimeRelay } from "./relay/runtime-relay.js";

const spaceId = "11111111-1111-4111-8111-111111111111";
const hello = () => JSON.stringify({ type: "runtime.hello", version: 1, token: "token", spaceId, capabilities: { harnesses: ["pi"], models: [] } });

/** In-memory control socket: no network, just the WebSocket surface the relay uses. */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 1; // WebSocket.OPEN
  bufferedAmount = 0;
  sent: string[] = [];
  closeCode: number | null = null;
  terminated = false;
  send(data: string) { this.sent.push(data); }
  close(code?: number) { this.closeCode = code ?? this.closeCode; this.emitClose(); }
  terminate() { this.terminated = true; this.emitClose(); }
  emitClose() {
    this.readyState = 3; // CLOSED
    this.emit("close", this.closeCode ?? 1006, Buffer.from(""));
  }
  /** Server-to-client frames parsed for assertions. */
  frames<T = { type?: string }>(): T[] { return this.sent.map((data) => JSON.parse(data) as T); }
}

function relayFixture(renew: () => Promise<boolean>) {
  const socket = new FakeSocket();
  const relay = createRuntimeRelay({
    secret: "worker-secret",
    authorize: async () => ({ ok: true, userId: "owner" }),
    claim: async () => true,
    renew,
    release: async () => undefined,
    heartbeatMs: 20,
    endpoint: () => "ws://127.0.0.1:1/internal",
  });
  relay.control(socket as unknown as WebSocket);
  return { socket, relay };
}

test("heartbeats keep flowing while a lease renew hangs, and the connection survives", { timeout: 10_000 }, async () => {
  const { socket } = relayFixture(() => new Promise<boolean>(() => {}));
  // Simulate the real client: every server heartbeat is answered, refreshing liveness.
  const originalSend = socket.send.bind(socket);
  socket.send = (data: string) => {
    originalSend(data);
    const frame = JSON.parse(data) as { type?: string };
    if (frame.type === "runtime.heartbeat") setImmediate(() => socket.emit("message", Buffer.from(JSON.stringify({ type: "runtime.heartbeat" }))));
  };
  socket.emit("message", Buffer.from(hello()));
  const enough = new Promise<void>((resolve) => {
    const check = () => { if (socket.frames().filter((frame) => frame.type === "runtime.heartbeat").length >= 4) resolve(); };
    const timer = setInterval(check, 5);
    socket.on("close", () => clearInterval(timer));
  });
  await enough;
  assert.equal(socket.terminated, false, "the connection must survive a hung renew");
  assert.equal(socket.closeCode, null, "no lease verdict was delivered");
  socket.terminate(); // Release the heartbeat and lease intervals for teardown.
});

test("a failing renew still closes the connection after heartbeats had time to flow", { timeout: 10_000 }, async () => {
  const { socket } = relayFixture(async () => false);
  socket.emit("message", Buffer.from(hello()));
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await closed;
  const frames = socket.frames();
  assert.ok(frames.some((frame) => frame.type === "runtime.heartbeat"), "at least one heartbeat flowed before the lease verdict");
  assert.equal(socket.closeCode, 4409, "lease loss closes with 4409");
});

test("a renew that loses to an in-flight catalog update keeps the connection", { timeout: 10_000 }, async () => {
  const socket = new FakeSocket();
  let stored: unknown = null;
  let finishUpdate = () => {};
  let renewed = 0;
  createRuntimeRelay({
    secret: "worker-secret",
    authorize: async () => ({ ok: true, userId: "owner" }),
    claim: async (_space, record) => { stored = record; return true; },
    renew: async (_space, record) => { renewed++; return stored === record; },
    // The registration is replaced at once; the update itself resolves only later, after a renew failed.
    update: (_space, _previous, next) => { stored = next; return new Promise<boolean>((resolve) => { finishUpdate = () => resolve(true); }); },
    release: async () => undefined,
    heartbeatMs: 20,
    endpoint: () => "ws://127.0.0.1:1/internal",
  }).control(socket as unknown as WebSocket);
  const heartbeat = setInterval(() => socket.emit("message", Buffer.from(JSON.stringify({ type: "runtime.heartbeat" }))), 10);
  socket.emit("message", Buffer.from(hello()));
  await new Promise((resolve) => setTimeout(resolve, 10));
  socket.emit("message", Buffer.from(JSON.stringify({ type: "runtime.capabilities", capabilities: { harnesses: ["pi"], models: [] } })));
  const failed = renewed + 1;
  while (renewed < failed) await new Promise((resolve) => setTimeout(resolve, 5));
  finishUpdate();
  await new Promise((resolve) => setTimeout(resolve, 60));
  clearInterval(heartbeat);
  assert.equal(socket.terminated, false);
  assert.equal(socket.closeCode, null, "the renew failure belongs to the update");
  socket.terminate();
});

function updatingFixture() {
  const socket = new FakeSocket();
  let stored: unknown = null;
  let finishUpdate = () => {};
  const updates: unknown[] = [];
  createRuntimeRelay({
    secret: "worker-secret",
    authorize: async () => ({ ok: true, userId: "owner" }),
    claim: async (_space, record) => { stored = record; return true; },
    renew: async (_space, record) => stored === record,
    update: (_space, previous, next) => {
      if (stored !== previous) return Promise.resolve(false);
      stored = next;
      updates.push(next.capabilities);
      return new Promise<boolean>((resolve) => { finishUpdate = () => resolve(true); });
    },
    release: async (_space, record) => { if (stored === record) stored = null; },
    heartbeatMs: 20,
    endpoint: () => "ws://127.0.0.1:1/internal",
  }).control(socket as unknown as WebSocket);
  const heartbeat = setInterval(() => socket.emit("message", Buffer.from(JSON.stringify({ type: "runtime.heartbeat" }))), 10);
  socket.on("close", () => clearInterval(heartbeat));
  socket.emit("message", Buffer.from(hello()));
  socket.emit("message", Buffer.from(JSON.stringify({ type: "runtime.capabilities", capabilities: { harnesses: ["pi"], models: [] } })));
  const capabilities = (models: number) => socket.emit("message", Buffer.from(JSON.stringify({ type: "runtime.capabilities", capabilities: { harnesses: ["pi"], models: Array.from({ length: models }, (_, index) => ({ harness: "pi", provider: "p", id: `m${index}`, name: "M" })) } })));
  return { socket, updates, capabilities, stored: () => stored, finish: () => finishUpdate() };
}

test("heartbeats keep the connection alive while a catalog update is slow", { timeout: 10_000 }, async () => {
  const { socket, finish } = updatingFixture();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(socket.terminated, false);
  finish();
  socket.terminate();
});

test("a close during a catalog update releases the record that update stored", { timeout: 10_000 }, async () => {
  const { socket, stored, finish } = updatingFixture();
  await new Promise((resolve) => setTimeout(resolve, 10));
  socket.terminate();
  assert.notEqual(stored(), null);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stored(), null);
});

test("catalogs sent during a slow update collapse into the latest one", { timeout: 10_000 }, async () => {
  const { socket, updates, capabilities, finish } = updatingFixture();
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (let models = 1; models <= 5; models++) capabilities(models);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(updates.length, 1);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 10));
  finish();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(updates.map((update) => (update as { models: unknown[] }).models.length), [0, 5]);
  assert.equal(socket.closeCode, null);
  socket.terminate();
});
