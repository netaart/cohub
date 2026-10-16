import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { WebsocketClient, type WebSocketLike } from "../src/websocket.js";

class FakeWebSocket implements WebSocketLike {
  static instance: FakeWebSocket | null = null;
  readonly sent: string[] = [];
  readyState = WebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instance = this;
  }

  open() {
    this.readyState = WebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(payload: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delay(1);
  }
  assert.fail("condition was not met");
};

test("emits desktop command envelopes as user events", async () => {
  FakeWebSocket.instance = null;
  const client = new WebsocketClient({
    url: "ws://localhost",
    autoReconnect: false,
    WebSocketImpl: FakeWebSocket,
    getAccessToken: () => "token",
  });
  const events: Array<{ type: string }> = [];
  client.on("event", (event) => events.push(event));

  const connecting = client.connect();
  const socket = FakeWebSocket.instance;
  assert.ok(socket);
  socket.open();
  await waitFor(() => socket.sent.length > 0);
  socket.receive({
    id: "auth-1",
    timestamp: Date.now(),
    domain: "system",
    type: "system.auth.ok",
    payload: { connectionId: "connection-1", user: {} },
  });
  await connecting;
  events.length = 0;

  socket.receive({
    id: "desktop-event-1",
    timestamp: Date.now(),
    domain: "desktop",
    type: "desktop.command.dispatched",
    payload: {
      commandId: "command-1",
      targetClientId: "client-1",
      command: {
        type: "desktop.open",
        target: {
          kind: "app",
          appId: "123e4567-e89b-42d3-a456-426614174000",
        },
      },
      source: null,
    },
  });

  assert.deepEqual(events.map((event) => event.type), ["desktop.command.dispatched"]);
  await client.disconnect();
});

test("Codex messages serialize explicit Fast on and off while omission stays absent", async () => {
  FakeWebSocket.instance = null;
  const client = new WebsocketClient({ url: "ws://localhost", autoReconnect: false, WebSocketImpl: FakeWebSocket, getAccessToken: () => "token" });
  const connecting = client.connect();
  const socket = FakeWebSocket.instance;
  assert.ok(socket);
  socket.open();
  await waitFor(() => socket.sent.length > 0);
  socket.receive({ id: "auth", timestamp: Date.now(), domain: "system", type: "system.auth.ok", payload: { connectionId: "connection", user: {} } });
  await connecting;
  try {
    for (const patch of [{}, { serviceTier: null }, { serviceTier: "priority" as const }]) {
      await client.sendMessage({ spaceId: "space", sessionId: "session", harness: "codex", content: [{ type: "text", text: "Hello" }], ...patch });
      const frame = JSON.parse(socket.sent.at(-1)!);
      assert.equal(frame.type, "session.message.create");
      assert.equal(frame.payload.harness, "codex");
      assert.deepEqual(Object.fromEntries(Object.entries(frame.payload).filter(([key]) => key === "serviceTier")), patch);
    }
  } finally { await client.disconnect(); }
});
