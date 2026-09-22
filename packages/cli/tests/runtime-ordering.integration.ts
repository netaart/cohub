import assert from "node:assert/strict";
import { TestRuntimeSessionStore } from "./fixtures/runtime-projection-source.js";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import type { RuntimeTurnInput } from "@cohub/protocol";
import { exchangeRuntimeTurn } from "../../../apps/agent/src/runtime/exchange.js";
import { serveRuntime } from "../src/runtime/connection.js";

const input = (): RuntimeTurnInput => {
  const turnId = crypto.randomUUID(), userMessageId = crypto.randomUUID();
  return { spaceId: crypto.randomUUID(), sessionId: crypto.randomUUID(), turnId, userMessageId, harness: "pi", accessMode: "full_access",
    messages: [{ turnId, userMessageId, userId: "author", content: [] }], context: { complete: true, revision: "initial", throughTurnId: null, messages: [] } };
};
async function listen() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  return { server, url: `ws://127.0.0.1:${address.port}` };
}
async function close(server: WebSocketServer) {
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

for (const persistent of [false, true]) test(`Runtime retries lease conflict without taking over (${persistent})`, { timeout: 8000 }, async () => {
  const { server, url } = await listen();
  const controller = new AbortController();
  let attempts = 0, ready = 0;
  server.on("connection", (socket) => {
    attempts++;
    socket.once("message", () => {
      if (persistent || attempts === 1) socket.close(4409, "Lease remains");
      else socket.send(JSON.stringify({ type: "runtime.ready", connectionId: crypto.randomUUID() }));
    });
  });
  const turn = input();
  try {
    const running = serveRuntime({ url, spaceId: turn.spaceId, cwd: process.cwd(), capabilities: { harnesses: ["pi"], models: [] }, harnesses: {}, token: async () => "fixture", signal: controller.signal, store: new TestRuntimeSessionStore(turn.spaceId), leaseConflictTimeoutMs: 400,
      onReady: () => { ready++; controller.abort(); },
    });
    if (persistent) await assert.rejects(running, /already connected/); else await running;
    if (persistent) assert(attempts >= 2 && attempts <= 3, "jittered retries remain bounded by the lease conflict deadline");
    else assert.equal(attempts, 2);
    assert.equal(ready, persistent ? 0 : 1);
  } finally { controller.abort(); await close(server); }
});

for (const retryPersistence of [false, true]) test(`terminal events are serialized and retryable after persistence failure (${retryPersistence})`, { timeout: 10_000 }, async () => {
  const { server, url } = await listen();
  const connectionId = crypto.randomUUID();
  const starts: boolean[] = [];
  server.on("connection", (socket) => {
    const send = (frame: unknown) => socket.send(JSON.stringify(frame));
    send({ type: "runtime.ready", connectionId });
    send({ type: "runtime.ready", connectionId });
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "turn.start") {
        starts.push(frame.resumeOnly);
        for (let i = 0; i < 3; i++) send({ type: "runtime.event", requestId: frame.requestId, event: { type: "turn.end", resume: "new", message: { ordinal: 0, content: [{ type: "text", text: "saved answer" }], stopReason: "stop" } } });
      }
      if (frame.type === "turn.ack") send({ type: "runtime.event", requestId: frame.requestId, event: { type: "turn.acknowledged" } });
    });
  });
  const turn = input();
  let active = 0, peak = 0, ends = 0, persisted = 0;
  let finalRevision: string | null = null;
  try {
    await exchangeRuntimeTurn({ input: turn, signal: AbortSignal.timeout(8000), endpoint: async () => `${url}?connection=${connectionId}`, reconnectMs: 4000,
      event: async (event, send, requestId) => {
        if (event.type !== "turn.end") return;
        active++; peak = Math.max(peak, active); ends++;
        try {
          if (!finalRevision) {
            await delay(15);
            if (retryPersistence && ends === 1) throw new Error("Temporary persistence failure");
            persisted++; finalRevision = "persisted";
          }
          send({ type: "turn.ack", requestId, turnId: turn.turnId, revision: finalRevision });
        } finally { active--; }
      },
    });
    assert.equal(peak, 1, "callbacks must not overlap");
    assert.equal(persisted, 1);
    assert.equal(ends, retryPersistence ? 4 : 3);
    assert.deepEqual(starts, retryPersistence ? [false, true] : [false], "duplicate ready never dispatches another execution");
  } finally { await close(server); }
});

test("Agent refuses a ready frame for a different registered connection before dispatch", { timeout: 5000 }, async () => {
  const { server, url } = await listen();
  let dispatched = 0;
  server.on("connection", (socket) => {
    socket.on("message", () => { dispatched++; });
    socket.send(JSON.stringify({ type: "runtime.ready", connectionId: crypto.randomUUID() }));
  });
  try {
    await assert.rejects(() => exchangeRuntimeTurn({ input: input(), signal: AbortSignal.timeout(3000), endpoint: async () => `${url}?connection=${crypto.randomUUID()}`, event: async () => {} }), /connection identity mismatch/);
    assert.equal(dispatched, 0);
  } finally { await close(server); }
});

for (const kind of ["missing", "invalid", "changed"]) test(`CLI refuses ${kind} handshake identity without another onReady`, { timeout: 5000 }, async () => {
  const { server, url } = await listen();
  const controller = new AbortController();
  let ready = 0;
  server.on("connection", (socket) => {
    socket.on("close", () => controller.abort());
    socket.once("message", () => {
      const send = (frame: unknown) => socket.send(JSON.stringify(frame));
      if (kind === "changed") {
        const connectionId = crypto.randomUUID();
        send({ type: "runtime.ready", connectionId });
        send({ type: "runtime.ready", connectionId });
        send({ type: "runtime.ready", connectionId: crypto.randomUUID() });
      } else send({ type: "runtime.ready", ...(kind === "invalid" ? { connectionId: "invalid" } : {}) });
    });
  });
  const turn = input();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    await serveRuntime({ url, spaceId: turn.spaceId, cwd: process.cwd(), capabilities: { harnesses: ["pi"], models: [] }, harnesses: {}, token: async () => "fixture", signal: controller.signal, store: new TestRuntimeSessionStore(turn.spaceId), onReady: () => { ready++; } });
    assert.equal(ready, kind === "changed" ? 1 : 0);
  } finally { clearTimeout(timeout); controller.abort(); await close(server); }
});
