import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { createRuntimeRelay } from "./relay/runtime-relay.js";

const spaceId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
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

async function registeredSocket() {
  const socket = new FakeSocket();
  const relay = createRuntimeRelay({
    secret: "worker-secret",
    authorize: async () => ({ ok: true, userId: "owner" }),
    claim: async () => true,
    renew: async () => true,
    release: async () => undefined,
    endpoint: () => "ws://127.0.0.1:1/internal",
    nativeEvent: async () => ({}),
  });
  relay.control(socket as unknown as WebSocket);
  socket.emit("message", Buffer.from(hello()));
  await new Promise((resolve) => setImmediate(resolve));
  return socket;
}

test("an invalid native event is answered on its channel; the Runtime connection survives", async () => {
  const socket = await registeredSocket();
  // The residue that once took down a production Runtime: a tool_use with an empty id and name.
  const native = {
    type: "runtime.native",
    requestId,
    event: {
      type: "ingest",
      input: {
        harness: "pi",
        nativeSessionId: "33333333-3333-4333-8333-333333333333",
        turns: [{
          turnId: "44444444-4444-4444-8444-444444444444",
          parentTurnId: null,
          userContent: [],
          startedAt: "2026-09-24T17:00:00.000Z",
          result: {
            status: "interrupted",
            completedAt: "2026-09-24T17:00:01.000Z",
            messages: [{ content: [{ type: "tool_use", id: "", name: "", input: {} }], provider: null, model: null, usage: null, stopReason: "aborted", errorMessage: null }],
          },
        }],
      },
    },
  };
  socket.emit("message", Buffer.from(JSON.stringify(native)));
  await new Promise((resolve) => setImmediate(resolve));
  const answered = socket.frames().find((frame) => frame.type === "runtime.native.result");
  assert.ok(answered, "the rejected request is answered on its own channel");
  assert.match((answered as { error?: string }).error ?? "", /turns\.0\.result\.messages\.0\.content\.0\.id/, "the answer names the offending field");
  assert.equal(socket.closeCode, null, "the connection survives one bad conversation");
  assert.equal(socket.terminated, false);
  socket.terminate();
});

test("an unparseable frame without a native channel still closes with 4400", async () => {
  const socket = await registeredSocket();
  socket.emit("message", Buffer.from("not json"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.closeCode, 4400);
});
