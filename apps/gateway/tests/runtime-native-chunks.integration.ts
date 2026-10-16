import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { type NativeRuntimeEvent, RUNTIME_MAX_FRAME_BYTES } from "@cohub/protocol";
import { serveRuntime } from "../../../packages/cli/src/runtime/connection.js";
import { idleExecutor } from "../../../packages/cli/tests/fixtures/runtime-native.js";
import { createRuntimeRelay } from "../src/relay/runtime-relay.js";

async function exchange(rejectFirst = false, smallFirst = false) {
  const spaceId = randomUUID();
  const text = "汉🙂".repeat(5_300_000);
  const original = (id: string): NativeRuntimeEvent => ({ type: "ingest", input: { harness: "codex", nativeSessionId: id, turns: [{ turnId: id, parentTurnId: null, userContent: [{ type: "text", text: "question" }], startedAt: "2026-10-14T00:00:00.000Z", result: { status: "completed", completedAt: "2026-10-14T00:01:00.000Z", messages: [{ content: [{ type: "text", text }] }] } }] } });
  const first: NativeRuntimeEvent = smallFirst ? { type: "known", input: { turnIds: [randomUUID()] } } : original(randomUUID());
  const second = original(randomUUID());
  assert(Buffer.byteLength(JSON.stringify(second)) > 35 * 1024 * 1024);
  const calls: Array<{ spaceId: string; owner: string; requestId: string; event: NativeRuntimeEvent }> = [];
  const chunkRequests: string[] = [];
  const indices = new Map<string, number>();
  const relay = createRuntimeRelay({
    secret: "test-secret", endpoint: () => "ws://localhost/internal",
    authorize: async (token, requestedSpace) => { assert.equal(token, "test-token"); assert.equal(requestedSpace, spaceId); return { ok: true, userId: "test-owner" }; },
    claim: async () => true, renew: async () => true, release: async () => undefined,
    nativeEvent: async (receivedSpace, owner, requestId, event) => {
      calls.push({ spaceId: receivedSpace, owner, requestId, event });
      if (smallFirst && calls.length === 1) {
        await delay(50);
        assert.deepEqual(chunkRequests, [], "a queued upload must not start its ACK deadline behind an unfinished ordinary request");
      }
      return { committed: true, ordinal: calls.length };
    },
  });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: RUNTIME_MAX_FRAME_BYTES });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const controller = new AbortController();
  let resolve!: (result: PromiseSettledResult<unknown>[]) => void, reject!: (error: unknown) => void;
  const completed = new Promise<PromiseSettledResult<unknown>[]>((ok, fail) => { resolve = ok; reject = fail; });
  let failedRequestId: string | null = null;
  let lateAckSent = false;
  server.on("connection", (socket, request) => {
    // This observer records on-wire sequencing; the production relay handles every frame.
    socket.on("message", (raw) => {
      try {
        assert(Buffer.byteLength(raw as Buffer) <= RUNTIME_MAX_FRAME_BYTES);
        const frame = JSON.parse(raw.toString());
        if (frame.type !== "runtime.native.chunk") return;
        assert.equal(frame.index, indices.get(frame.requestId) ?? 0);
        indices.set(frame.requestId, frame.index + 1);
        if (chunkRequests.at(-1) !== frame.requestId) chunkRequests.push(frame.requestId);
        if (rejectFirst && !failedRequestId) {
          failedRequestId = frame.requestId;
          // Damage the first sequence number before the production relay reads this same Buffer.
          assert(Buffer.isBuffer(raw));
          const position = raw.indexOf('"index":0'); assert(position >= 0);
          raw[position + '"index":'.length] = "1".charCodeAt(0);
          // A late acknowledgement from the failed request must not affect the queued upload.
          setTimeout(() => {
            if (socket.readyState === socket.OPEN) { socket.send(JSON.stringify({ type: "runtime.native.chunk.ack", requestId: failedRequestId, index: 0 })); lateAckSent = true; }
          }, 10);
        }
      } catch (error) { reject(error); }
    });
    relay.control(socket, request);
  });
  const running = serveRuntime({
    url: `ws://127.0.0.1:${address.port}`, spaceId, cwd: process.cwd(), capabilities: { harnesses: ["codex"], models: [] },
    token: async () => "test-token", signal: controller.signal, executor: idleExecutor(spaceId), onReady: () => {},
    onNativeChannel: (send) => { void Promise.allSettled([send(first), send(second)]).then(resolve, reject); },
  });
  try {
    const results = await completed;
    if (rejectFirst) {
      assert.equal(results[0]?.status, "rejected");
      if (results[0]?.status === "rejected") assert.match(String(results[0].reason), /sequence/);
      assert.deepEqual(results[1], { status: "fulfilled", value: { committed: true, ordinal: 1 } });
      assert.deepEqual(calls.map((call) => call.event), [second]);
      assert.equal(indices.get(failedRequestId ?? ""), 1, "early failure stops the failed upload despite its late ACK");
      assert.equal(lateAckSent, true);
    } else {
      assert.deepEqual(results, [{ status: "fulfilled", value: { committed: true, ordinal: 1 } }, { status: "fulfilled", value: { committed: true, ordinal: 2 } }]);
      assert.deepEqual(calls.map((call) => call.event), [first, second]);
      assert([...indices.values()].every((count) => count > 1));
    }
    assert(calls.every((call) => call.spaceId === spaceId && call.owner === "test-owner"));
    assert.equal(new Set(calls.map((call) => call.requestId)).size, rejectFirst ? 1 : 2);
    assert.deepEqual(chunkRequests, [...(rejectFirst ? [failedRequestId] : []), ...calls.slice(smallFirst ? 1 : 0).map((call) => call.requestId)], "the second upload never interrupts the first");
    assert.equal(calls.length, rejectFirst ? 1 : 2);
  } finally {
    controller.abort();
    for (const socket of server.clients) socket.terminate();
    await running;
    await new Promise<void>((ok) => server.close(() => ok()));
  }
}

test("real Runtime client and gateway deliver concurrent oversized native results exactly once without interleaving", { timeout: 30_000 }, () => exchange());
test("an early gateway error and late ACK leave the queued oversized upload intact", { timeout: 30_000 }, () => exchange(true));
test("an oversized upload waits for a preceding ordinary request to finish before sending chunks", { timeout: 30_000 }, () => exchange(false, true));
