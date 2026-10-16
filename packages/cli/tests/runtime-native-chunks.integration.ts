import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { RUNTIME_MAX_FRAME_BYTES, type NativeRuntimeEvent } from "@neta-art/cohub";
import { serveRuntime } from "../src/runtime/connection.js";
import { idleExecutor } from "./fixtures/runtime-native.js";

const event = (): NativeRuntimeEvent => ({ type: "ingest", input: { harness: "codex", nativeSessionId: "large-session", turns: [{ turnId: randomUUID(), parentTurnId: null, userContent: [{ type: "text", text: "original request" }], startedAt: "2026-10-14T00:00:00.000Z", result: { status: "completed", completedAt: "2026-10-14T00:01:00.000Z", messages: [{ content: [{ type: "text", text: "汉🙂".repeat(5_000_000) }] }] } }] } });
async function exchange(support: boolean, badAck = false) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const controller = new AbortController(), original = event();
  let parts: Buffer[] = [], bytes = 0, chunks = 0, committed = 0;
  server.on("connection", socket => socket.on("message", raw => {
    assert(Buffer.byteLength(raw as Buffer) <= RUNTIME_MAX_FRAME_BYTES, "every on-wire frame fits");
    const frame = JSON.parse(raw.toString());
    if (frame.type === "runtime.hello") socket.send(JSON.stringify({ type: "runtime.ready", connectionId: randomUUID(), nativeChunkUpload: support }));
    else if (frame.type === "runtime.native.chunk") {
      assert.equal(frame.index, chunks++);
      const part = Buffer.from(frame.data, "base64"); assert(part.length <= 8 * 1024 * 1024);
      parts.push(part); bytes += part.length;
      socket.send(JSON.stringify({ type: "runtime.native.chunk.ack", requestId: frame.requestId, index: badAck ? frame.index + 1 : frame.index }));
      if (!badAck && bytes === frame.totalBytes) {
        const assembled = Buffer.concat(parts);
        assert.equal(createHash("sha256").update(assembled).digest("hex"), frame.sha256);
        assert.deepEqual(JSON.parse(assembled.toString("utf8")), original, "complete result and immutable identity survive byte-for-byte");
        committed++; parts = [];
        socket.send(JSON.stringify({ type: "runtime.native.result", requestId: frame.requestId, result: { committed: true } }));
      }
    }
  }));
  let resolve!: (value: unknown) => void, reject!: (reason: unknown) => void;
  const result = new Promise<unknown>((ok, fail) => { resolve = ok; reject = fail; });
  const running = serveRuntime({ url: `ws://127.0.0.1:${address.port}`, spaceId: randomUUID(), cwd: process.cwd(), capabilities: { harnesses: ["codex"], models: [] }, token: async () => "test", signal: controller.signal, executor: idleExecutor(randomUUID()), onReady: () => {}, onNativeChannel: send => { void send(original).then(resolve, reject); } });
  try {
    if (!support) await assert.rejects(result, /server upgrade.*chunk|chunk.*server upgrade/i);
    else if (badAck) await assert.rejects(result, /chunk acknowledgement.*(order|index)/i);
    else { assert.deepEqual(await result, { committed: true }); assert(chunks > 1); assert.equal(committed, 1); }
    if (!support || badAck) assert.equal(committed, 0, "failure never finalizes a partial result");
  } finally { controller.abort(); for (const socket of server.clients) socket.terminate(); await running; await new Promise<void>(resolve => server.close(() => resolve())); }
}

test("oversized native completion transfers losslessly with acknowledged chunks", { timeout: 15000 }, () => exchange(true));
test("older gateway explicitly requires an upgrade for oversized native completion", { timeout: 15000 }, () => exchange(false));
test("out-of-order chunk acknowledgements fail without sending the rest", { timeout: 15000 }, () => exchange(true, true));

test("a native request deadline disconnects before a queued request can reuse the stalled server queue", async (t) => {
  const realTimeout = setTimeout;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const controller = new AbortController();
  let observed!: () => void, result!: Promise<PromiseSettledResult<unknown>[]>;
  const received = new Promise<void>(resolve => { observed = resolve; });
  let requests = 0, closed!: () => void;
  const disconnected = new Promise<boolean>(resolve => { closed = () => resolve(true); });
  server.on("connection", socket => {
    socket.on("close", closed);
    socket.on("message", raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "runtime.hello") socket.send(JSON.stringify({ type: "runtime.ready", connectionId: randomUUID() }));
      if (frame.type === "runtime.native") { requests++; observed(); }
    });
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const running = serveRuntime({ url: `ws://127.0.0.1:${address.port}`, spaceId: randomUUID(), cwd: process.cwd(), capabilities: { harnesses: ["codex"], models: [] }, token: async () => "test", signal: controller.signal, executor: idleExecutor(randomUUID()), onReady: () => {}, onNativeChannel: send => {
    result = Promise.allSettled([send({ type: "known", input: { turnIds: [randomUUID()] } }), send({ type: "known", input: { turnIds: [randomUUID()] } })]);
  } });
  try {
    await received;
    t.mock.timers.tick(30_000);
    assert.equal(await Promise.race([disconnected, new Promise<boolean>(resolve => realTimeout(() => resolve(false), 2_000).unref())]), true);
    assert.equal(requests, 1);
    const outcomes = await result;
    assert(outcomes.every(outcome => outcome.status === "rejected"));
    assert(outcomes[0]?.status === "rejected" && /timed out/.test(String(outcomes[0].reason)));
  } finally {
    controller.abort();
    for (const socket of server.clients) socket.terminate();
    await running;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
