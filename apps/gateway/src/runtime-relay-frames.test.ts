import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, test } from "node:test";
import type { WebSocket } from "ws";
import { createRuntimeRelay } from "./relay/runtime-relay.js";

const spaceId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sockets = new Set<FakeSocket>();
afterEach(() => { for (const socket of sockets) if (socket.closeCode === null) socket.terminate(); sockets.clear(); });

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<{ type?: string; error?: string }> = [];
  closeCode: number | null = null;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code: number) { this.closeCode = code; this.readyState = 3; this.emit("close", code, Buffer.alloc(0)); }
  terminate() { this.close(1006); }
  receive(frame: unknown) { this.emit("message", Buffer.from(typeof frame === "string" ? frame : JSON.stringify(frame))); return tick(); }
}

async function connect(deps: Partial<Parameters<typeof createRuntimeRelay>[0]> = {}) {
  const socket = new FakeSocket();
  sockets.add(socket);
  createRuntimeRelay({
    secret: "secret",
    authorize: async () => ({ ok: true, userId: "owner" }),
    claim: async () => true,
    renew: async () => true,
    release: async () => undefined,
    endpoint: () => "ws://127.0.0.1:1/internal",
    nativeEvent: async () => ({}),
    ...deps,
  }).control(socket as unknown as WebSocket);
  await socket.receive({ type: "runtime.hello", version: 1, token: "token", spaceId, capabilities: { harnesses: ["pi"], models: [] } });
  return socket;
}

const nativeError = (socket: FakeSocket) => socket.sent.find((frame) => frame.type === "runtime.native.result")?.error;

test("a bad native request is answered on its channel; the connection stays", async () => {
  const invalid = await connect();
  await invalid.receive({ type: "runtime.native", requestId, event: { type: "status", sessionId: "", turnId: requestId } });
  assert.match(nativeError(invalid) ?? "", /event\.sessionId/);
  assert.equal(invalid.closeCode, null);

  const unsupported = await connect({ nativeEvent: undefined });
  await unsupported.receive({ type: "runtime.native", requestId, event: { type: "status", sessionId: requestId, turnId: requestId } });
  assert.match(nativeError(unsupported) ?? "", /unavailable/);
  assert.equal(unsupported.closeCode, null);
});

test("protocol errors close with 4400, server faults with 1011", async () => {
  for (const frame of ["not json", { type: "runtime.native", requestId: "not-a-uuid", event: {} }]) {
    const socket = await connect();
    await socket.receive(frame);
    assert.equal(socket.closeCode, 4400);
  }
  const faulty = await connect({ authorize: async () => { throw new Error("database unavailable"); } });
  assert.equal(faulty.closeCode, 1011);
});
