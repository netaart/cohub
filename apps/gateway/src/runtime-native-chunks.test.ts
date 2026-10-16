import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { WebSocket } from "ws";
import { createRuntimeRelay } from "./relay/runtime-relay.js";

const spaceId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sockets = new Set<FakeSocket>();
afterEach(() => { for (const socket of sockets) if (socket.readyState === 1) socket.close(); sockets.clear(); });
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<{ type?: string; nativeChunkUpload?: boolean; requestId?: string; index?: number; error?: string; result?: unknown }> = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code = 1000) { this.readyState = 3; this.emit("close", code, Buffer.alloc(0)); }
  terminate() { this.close(1006); }
  receive(frame: unknown) { this.emit("message", Buffer.from(JSON.stringify(frame))); return tick(); }
}
async function connect(registered = true, heartbeatMs?: number, commit?: () => Promise<unknown>) {
  const calls: unknown[][] = [];
  const relay = createRuntimeRelay({ secret: "secret", heartbeatMs, authorize: async () => ({ ok: true, userId: "owner" }), claim: async () => true, renew: async () => true, release: async () => undefined, endpoint: () => "ws://localhost/internal", nativeEvent: async (...args) => { calls.push(args); return commit ? await commit() : { accepted: true }; } });
  const socket = new FakeSocket(); sockets.add(socket);
  relay.control(socket as unknown as WebSocket);
  if (registered) await socket.receive({ type: "runtime.hello", version: 1, token: "token", spaceId, capabilities: { harnesses: ["pi"], models: [] } });
  return { socket, calls };
}
const bytesOf = (event: unknown) => Buffer.from(JSON.stringify(event));
function chunk(bytes: Buffer, index: number, data: Buffer, overrides = {}) {
  return { type: "runtime.native.chunk", requestId, index, totalBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), data: data.toString("base64"), ...overrides };
}
const errorOf = (socket: FakeSocket) => [...socket.sent].reverse().find((frame) => frame.type === "runtime.native.result")?.error;
const event = { type: "status", sessionId: requestId, turnId: requestId };

test("native chunks advertise support, acknowledge progress, and invoke the backend only after exact reassembly", async () => {
  const { socket, calls } = await connect();
  assert.equal(socket.sent[0]?.nativeChunkUpload, true);
  const large = { type: "ingest", input: { harness: "pi", nativeSessionId: "large", turns: [{ turnId: requestId, parentTurnId: null, userContent: [{ type: "text", text: "原😀".repeat(5_000_000) }], startedAt: "2026-10-14T00:00:00.000Z", result: null }] } };
  const bytes = bytesOf(large);
  assert(bytes.length > 32 * 1024 * 1024);
  const size = 8 * 1024 * 1024;
  for (let offset = 0, index = 0; offset < bytes.length; offset += size, index++) {
    await socket.receive(chunk(bytes, index, bytes.subarray(offset, offset + size)));
    assert.deepEqual([...socket.sent].reverse().find((frame) => frame.type === "runtime.native.chunk.ack"), { type: "runtime.native.chunk.ack", requestId, index });
    assert.equal(calls.length, offset + size >= bytes.length ? 1 : 0);
  }
  assert.deepEqual(calls, [[spaceId, "owner", requestId, large]]);
  assert.deepEqual(socket.sent.at(-1), { type: "runtime.native.result", requestId, result: { accepted: true } });
});

test("bad chunk sequences, sizes, checksums, encoding, and events fail explicitly without calling the backend", async () => {
  const bytes = bytesOf(event);
  const cases: Array<[unknown[], RegExp]> = [
    [[chunk(bytes, 1, bytes)], /sequence/],
    [[chunk(bytes, 0, bytes, { sha256: "0".repeat(64) })], /checksum/],
    [[chunk(bytes, 0, bytes, { data: "!!!" })], /encoding|data/],
    [[chunk(bytes, 0, bytes, { totalBytes: 256 * 1024 * 1024 + 1 })], /totalBytes|limit/],
    [[chunk(bytes, 0, Buffer.alloc(8 * 1024 * 1024 + 1), { totalBytes: 9 * 1024 * 1024 })], /size|bytes/],
    [[chunk(bytes, 0, bytes.subarray(0, 4)), chunk(bytes, 0, bytes.subarray(4))], /sequence/],
    [[chunk(bytes, 0, bytes.subarray(0, 4)), chunk(bytes, 1, bytes.subarray(4), { requestId: otherId })], /already in progress/],
    [[chunk(bytes, 0, bytes.subarray(0, 4)), chunk(bytes, 1, bytes.subarray(4), { sha256: "0".repeat(64) })], /metadata/],
    [[chunk(bytes, 0, bytes, { totalBytes: bytes.length - 1 })], /total bytes/],
    [[chunk(bytesOf({ type: "status", sessionId: "bad" }), 0, bytesOf({ type: "status", sessionId: "bad" }))], /sessionId/],
    [[chunk(Buffer.from([0xff]), 0, Buffer.from([0xff]))], /encoded data|encoding/i],
  ];
  for (const [frames, message] of cases) {
    const { socket, calls } = await connect();
    for (const frame of frames) await socket.receive(frame);
    assert.equal(calls.length, 0);
    assert.match(errorOf(socket) ?? "", message);
    assert.equal(socket.readyState, 1);
  }
});

test("disconnect discards unfinished chunks and a new connection cannot finish them", async () => {
  const bytes = bytesOf(event);
  const first = await connect();
  await first.socket.receive(chunk(bytes, 0, bytes.subarray(0, 4)));
  assert.equal(first.socket.sent.at(-1)?.type, "runtime.native.chunk.ack");
  first.socket.close();
  const second = await connect();
  await second.socket.receive(chunk(bytes, 1, bytes.subarray(4)));
  assert.equal(first.calls.length + second.calls.length, 0);
  assert.match(errorOf(second.socket) ?? "", /sequence|index/i);
});

test("chunk uploads require the existing authorized registration", async () => {
  const { socket, calls } = await connect(false);
  const bytes = bytesOf(event);
  await socket.receive(chunk(bytes, 0, bytes));
  assert.equal(socket.readyState, 3);
  assert.equal(calls.length, 0);
  assert.equal(socket.sent.length, 0);
});

test("failed uploads do not block a fresh complete upload and every upload is delivered once", async () => {
  const { socket, calls } = await connect();
  const bytes = bytesOf(event);
  await socket.receive(chunk(bytes, 0, bytes, { sha256: "0".repeat(64) }));
  assert.match(errorOf(socket) ?? "", /checksum/);
  assert.equal(calls.length, 0);
  await socket.receive(chunk(bytes, 0, bytes, { requestId: otherId }));
  assert.deepEqual(calls, [[spaceId, "owner", otherId, event]]);
  assert.deepEqual(socket.sent.at(-1), { type: "runtime.native.result", requestId: otherId, result: { accepted: true } });
});

test("an incomplete upload expires while the connection remains alive and releases the upload slot", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const { socket, calls } = await connect(true, 20);
  const bytes = bytesOf(event);
  await socket.receive(chunk(bytes, 0, bytes.subarray(0, 4)));
  assert.equal(socket.sent.at(-1)?.type, "runtime.native.chunk.ack");
  assert.equal(calls.length, 0);
  now += 30_001;
  await socket.receive({ type: "runtime.heartbeat" });
  await delay(40);
  assert.equal(socket.readyState, 1);
  assert.match(errorOf(socket) ?? "", /upload.*timed out/i);
  assert.equal(calls.length, 0);
  await socket.receive(chunk(bytes, 0, bytes, { requestId: otherId }));
  assert.deepEqual(calls, [[spaceId, "owner", otherId, event]]);
});

test("heartbeats received during a slow durable write keep the upload connected without acknowledging success early", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000 });
  let finish!: () => void;
  const durable = new Promise<void>(resolve => { finish = resolve; });
  const { socket, calls } = await connect(true, 10, async () => { await durable; return { committed: true }; });
  const bytes = bytesOf(event);
  try {
    await socket.receive(chunk(bytes, 0, bytes));
    assert.equal(calls.length, 1);
    for (let n = 0; n < 8; n++) {
      await socket.receive({ type: "runtime.heartbeat" });
      t.mock.timers.tick(10);
      await tick();
      assert.equal(socket.readyState, 1);
      assert.equal(socket.sent.some(frame => frame.type === "runtime.native.result"), false);
    }
  } finally { finish(); await tick(); }
  assert.deepEqual(socket.sent.at(-1), { type: "runtime.native.result", requestId, result: { committed: true } });
});
