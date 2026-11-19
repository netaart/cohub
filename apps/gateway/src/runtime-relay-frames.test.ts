import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
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
  sent: Array<{ type?: string; error?: string; connectionId?: string }> = [];
  closeCode: number | null = null;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code: number) { this.closeCode = code; this.readyState = 3; this.emit("close", code, Buffer.alloc(0)); }
  terminate() { this.close(1006); }
  receive(frame: unknown) { this.emit("message", Buffer.from(typeof frame === "string" ? frame : JSON.stringify(frame))); return tick(); }
}

function relayFixture(deps: Partial<Parameters<typeof createRuntimeRelay>[0]> = {}) {
  return createRuntimeRelay({
    secret: "secret",
    authorize: async () => ({ ok: true, userId: "owner" }),
    claim: async () => true,
    renew: async () => true,
    release: async () => undefined,
    endpoint: () => "ws://127.0.0.1:1/internal",
    nativeEvent: async () => ({}),
    ...deps,
  });
}

async function connect(relay = relayFixture(), hello: Record<string, unknown> = {}) {
  const socket = new FakeSocket();
  sockets.add(socket);
  relay.control(socket as unknown as WebSocket);
  await socket.receive({ type: "runtime.hello", version: 1, token: "token", spaceId, capabilities: { harnesses: ["pi"], models: [] }, ...hello });
  return socket;
}

test("a replaced control connection routes and closes only its own peers", async () => {
  const relay = relayFixture();
  async function attach(control: FakeSocket) {
    const connection = control.sent[0]?.connectionId;
    assert.ok(connection);
    const peer = new FakeSocket();
    sockets.add(peer);
    const request = { headers: { "x-worker-secret": "secret" }, url: `/?connection=${connection}` };
    relay.peer(peer as unknown as WebSocket, request as unknown as IncomingMessage, spaceId);
    await peer.receive({ type: "turn.recover", requestId, execution: { spaceId, sessionId: spaceId, turnId: requestId, harness: "pi" } });
    assert.equal(control.sent.at(-1)?.type, "turn.recover");
    return peer;
  }
  const old = await connect(relay);
  const oldPeer = await attach(old);
  const replacement = await connect(relay);
  const newPeer = await attach(replacement);
  const event = { type: "runtime.event", requestId, event: { type: "message.start", ordinal: 0 } };
  await old.receive(event);
  old.terminate();
  assert.equal(oldPeer.closeCode, 1011);
  assert.deepEqual(oldPeer.sent.at(-1), event);
  assert.equal(newPeer.closeCode, null);
  assert.equal(newPeer.sent.length, 1);
  await replacement.receive(event);
  assert.deepEqual(newPeer.sent.at(-1), event);
  assert.ok(relay.stop({ spaceId, sessionId: spaceId, turnId: requestId }));
});

const nativeError = (socket: FakeSocket) => socket.sent.find((frame) => frame.type === "runtime.native.result")?.error;

test("a bad native request is answered on its channel; the connection stays", async () => {
  const invalid = await connect();
  await invalid.receive({ type: "runtime.native", requestId, event: { type: "status", sessionId: "", turnId: requestId } });
  assert.match(nativeError(invalid) ?? "", /event\.sessionId/);
  assert.equal(invalid.closeCode, null);

  const unsupported = await connect(relayFixture({ nativeEvent: undefined }));
  await unsupported.receive({ type: "runtime.native", requestId, event: { type: "status", sessionId: requestId, turnId: requestId } });
  assert.match(nativeError(unsupported) ?? "", /unavailable/);
  assert.equal(unsupported.closeCode, null);
});

test("registration keeps the client a Runtime reports; older Runtimes omit it", async () => {
  const records: unknown[] = [];
  const claim = async (_spaceId: string, record: { client?: unknown }) => { records.push(record.client); return true; };
  await connect(relayFixture({ claim }), { client: { name: "cli", version: "10.21.0" } });
  await connect(relayFixture({ claim }));
  assert.deepEqual(records, [{ name: "cli", version: "10.21.0" }, undefined]);
});

test("protocol errors close with 4400, server faults with 1011", async () => {
  for (const frame of ["not json", { type: "runtime.native", requestId: "not-a-uuid", event: {} }]) {
    const socket = await connect();
    await socket.receive(frame);
    assert.equal(socket.closeCode, 4400);
  }
  const faulty = await connect(relayFixture({ authorize: async () => { throw new Error("database unavailable"); } }));
  assert.equal(faulty.closeCode, 1011);
});
