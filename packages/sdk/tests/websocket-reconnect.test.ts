import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { WebsocketClient, type WebSocketLike } from "../src/websocket.js";

type CloseSnapshot = { code: number; reason: string; willReconnect: boolean };

type AuthEnvelope = {
  id: string;
  timestamp: number;
  domain: "system";
  type: "system.auth.ok";
  payload: { connectionId: string; user: Record<string, unknown> };
};

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  readyState = WebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
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
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.onclose?.({ code, reason } as CloseEvent));
  }
}

const waitFor = async (predicate: () => boolean, message: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delay(1);
  }
  assert.fail(message);
};

const authOk = (connectionId: string): AuthEnvelope => ({
  id: `auth-${connectionId}`,
  timestamp: Date.now(),
  domain: "system",
  type: "system.auth.ok",
  payload: { connectionId, user: {} },
});

const authError = {
  id: "auth-error",
  timestamp: Date.now(),
  domain: "system",
  type: "system.request.error",
  payload: { code: "UNAUTHORIZED", message: "Unauthorized" },
};

const sentTypes = (socket: FakeWebSocket) =>
  socket.sent.map((raw) => (JSON.parse(raw) as { type: string }).type);

test("reconnects a stalled handshake without a close event and restores retained rooms", async (t) => {
  FakeWebSocket.instances = [];
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const closes: CloseSnapshot[] = [];
  const client = new WebsocketClient({
    url: "ws://localhost",
    reconnectBaseDelayMs: 1000,
    getAccessToken: () => "token",
    WebSocketImpl: FakeWebSocket,
  });
  t.after(() => client.disconnect());
  client.on("close", (snapshot) => closes.push(snapshot));

  const connecting = client.connect();
  const rejected = assert.rejects(connecting, /connect timeout/);
  const release = client.subscribeSpace("space-1");
  const releaseOther = client.subscribeSpace("space-2");
  releaseOther();
  const first = FakeWebSocket.instances[0];
  assert.ok(first);
  const lateClose = first.onclose;
  const lateOpen = first.onopen;
  const closeCalls: Array<{ code?: number; reason?: string }> = [];
  first.close = (code, reason) => {
    closeCalls.push({ code, reason });
    first.readyState = WebSocket.CLOSING;
  };

  t.mock.timers.tick(14_999);
  assert.equal(client.state, "connecting");
  assert.equal(closeCalls.length, 0);
  t.mock.timers.tick(1);
  assert.equal(client.state, "reconnecting");
  assert.equal(closeCalls.length, 1);
  assert.match(closeCalls[0].reason ?? "", /connect timeout/);
  assert.deepEqual(closes.map(({ willReconnect }) => willReconnect), [true]);
  await rejected;

  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(FakeWebSocket.instances.length, 2);
  const second = FakeWebSocket.instances[1];
  assert.ok(second);
  second.open();
  await waitFor(() => sentTypes(second).includes("auth"), "expected authentication after timeout");
  second.receive(authOk("connection-2"));
  await waitFor(() => sentTypes(second).includes("subscribe"), "expected retained rooms after timeout");
  assert.equal(client.state, "open");
  const subscription = second.sent.map((raw) => JSON.parse(raw)).find((event) => event.type === "subscribe");
  assert.deepEqual(subscription.payload.rooms, ["space:space-1"]);
  second.receive({
    id: "subscribe-connection-2",
    timestamp: Date.now(),
    domain: "system",
    type: "system.subscribe.ok",
    payload: { rooms: ["space:space-1"] },
  });

  lateClose?.({ code: 1006, reason: "late close" } as CloseEvent);
  lateOpen?.(new Event("open"));
  await Promise.resolve();
  assert.equal(client.state, "open");
  assert.equal(client.connectionId, "connection-2");
  assert.deepEqual(sentTypes(second), ["auth", "subscribe"]);
  assert.equal(closes.length, 1);

  release();
  assert.deepEqual(sentTypes(second), ["auth", "subscribe", "unsubscribe"]);
});

test("cancels the handshake timeout once the socket opens", async (t) => {
  FakeWebSocket.instances = [];
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const client = new WebsocketClient({
    url: "ws://localhost",
    getAccessToken: () => "token",
    WebSocketImpl: FakeWebSocket,
  });
  t.after(() => client.disconnect());
  const connecting = client.connect();
  const first = FakeWebSocket.instances[0];
  assert.ok(first);
  t.mock.timers.tick(14_999);
  first.open();
  await waitFor(() => sentTypes(first).includes("auth"), "expected authentication");
  first.receive(authOk("connection-1"));
  await connecting;

  t.mock.timers.tick(15_000);
  assert.equal(client.state, "open");
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(first.readyState, WebSocket.OPEN);
});

test("rejects a stalled handshake without reconnecting when autoReconnect is disabled", async (t) => {
  FakeWebSocket.instances = [];
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const client = new WebsocketClient({
    url: "ws://localhost",
    autoReconnect: false,
    connectTimeoutMs: 1234,
    getAccessToken: () => "token",
    WebSocketImpl: FakeWebSocket,
  });
  t.after(() => client.disconnect());
  const rejected = assert.rejects(client.connect(), /connect timeout/);
  t.mock.timers.tick(1233);
  assert.equal(client.state, "connecting");
  t.mock.timers.tick(1);
  assert.equal(client.state, "closed");
  await rejected;
  t.mock.timers.tick(60_000);
  assert.equal(FakeWebSocket.instances.length, 1);
});

test("disconnect cancels and settles a pending handshake without waiting for close", async (t) => {
  FakeWebSocket.instances = [];
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const client = new WebsocketClient({
    url: "ws://localhost",
    getAccessToken: () => "token",
    WebSocketImpl: FakeWebSocket,
  });
  t.after(() => client.disconnect());
  const closes: CloseSnapshot[] = [];
  client.on("close", (snapshot) => closes.push(snapshot));
  const connecting = client.connect();
  const rejected = assert.rejects(connecting, /manual/);
  const first = FakeWebSocket.instances[0];
  assert.ok(first);
  first.close = () => { first.readyState = WebSocket.CLOSING; };

  await client.disconnect();
  await rejected;
  assert.deepEqual(closes, [{ code: 1000, reason: "manual", willReconnect: false }]);
  t.mock.timers.tick(60_000);
  assert.equal(client.state, "closed");
  assert.equal(FakeWebSocket.instances.length, 1);
});

test("rejects invalid handshake timeout values", () => {
  for (const connectTimeoutMs of [0, -1, 0.5, NaN, Infinity, 2_147_483_648]) {
    assert.throws(
      () => new WebsocketClient({ connectTimeoutMs, WebSocketImpl: FakeWebSocket }),
      /connectTimeoutMs must be an integer between 1 and 2147483647/,
    );
  }
});

test("retries authentication with a forced token refresh and restores rooms", async () => {
  FakeWebSocket.instances = [];
  const tokenOptions: Array<{ forceRefresh?: boolean } | undefined> = [];
  const closes: CloseSnapshot[] = [];
  const client = new WebsocketClient({
    url: "ws://localhost",
    reconnectBaseDelayMs: 0,
    reconnectMaxDelayMs: 0,
    getAccessToken: (options) => {
      tokenOptions.push(options);
      return options?.forceRefresh ? "fresh-token" : "stale-token";
    },
    WebSocketImpl: FakeWebSocket,
  });
  client.on("close", (snapshot) => closes.push(snapshot));

  void client.connect().catch(() => undefined);
  const first = FakeWebSocket.instances[0];
  assert.ok(first);
  first.open();
  await waitFor(() => sentTypes(first).includes("auth"), "expected the initial auth request");

  const release = client.subscribeSpace("space-1");
  assert.deepEqual(sentTypes(first), ["auth"]);
  first.receive(authError);

  await waitFor(() => FakeWebSocket.instances.length === 2, "expected an auth reconnect");
  const second = FakeWebSocket.instances[1];
  assert.ok(second);
  second.open();
  await waitFor(() => sentTypes(second).includes("auth"), "expected the refreshed auth request");
  assert.deepEqual(sentTypes(second), ["auth"]);
  second.receive(authOk("connection-2"));
  await waitFor(() => sentTypes(second).includes("subscribe"), "expected room restoration");

  assert.deepEqual(tokenOptions, [undefined, { forceRefresh: true }]);
  assert.deepEqual(closes.map(({ willReconnect }) => willReconnect), [true]);
  assert.equal(client.state, "open");

  release();
  await client.disconnect();
});

test("stops after a forced authentication retry is rejected", async () => {
  FakeWebSocket.instances = [];
  const tokenOptions: Array<{ forceRefresh?: boolean } | undefined> = [];
  const closes: CloseSnapshot[] = [];
  const client = new WebsocketClient({
    url: "ws://localhost",
    reconnectBaseDelayMs: 0,
    reconnectMaxDelayMs: 0,
    getAccessToken: (options) => {
      tokenOptions.push(options);
      return options?.forceRefresh ? "fresh-invalid-token" : "stale-token";
    },
    WebSocketImpl: FakeWebSocket,
  });
  client.on("close", (snapshot) => closes.push(snapshot));

  const release = client.subscribeSpace("space-1");
  const first = FakeWebSocket.instances[0];
  assert.ok(first);
  first.open();
  await waitFor(() => sentTypes(first).includes("auth"), "expected the initial auth request");
  first.receive(authError);

  await waitFor(() => FakeWebSocket.instances.length === 2, "expected one forced auth retry");
  const second = FakeWebSocket.instances[1];
  assert.ok(second);
  second.open();
  await waitFor(() => sentTypes(second).includes("auth"), "expected the forced auth request");
  second.receive(authError);
  await waitFor(() => closes.length === 2, "expected the terminal auth close");
  await delay(5);

  assert.deepEqual(tokenOptions, [undefined, { forceRefresh: true }]);
  assert.deepEqual(closes.map(({ willReconnect }) => willReconnect), [true, false]);
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(client.state, "closed");

  release();
  await client.disconnect();
});

test("retains and retries a room while authorization is unavailable", async (t) => {
  FakeWebSocket.instances = [];
  const client = new WebsocketClient({
    url: "ws://localhost", getAccessToken: () => "token", WebSocketImpl: FakeWebSocket,
    reconnectBaseDelayMs: 1, reconnectMaxDelayMs: 1,
  });
  t.after(() => client.disconnect());
  const release = client.subscribeSpace("space-1");
  t.after(release);
  const socket = FakeWebSocket.instances[0];
  assert.ok(socket);
  socket.open();
  await waitFor(() => sentTypes(socket).includes("auth"), "expected authentication");
  socket.receive(authOk("connection-1"));
  await waitFor(() => sentTypes(socket).includes("subscribe"), "expected subscription");
  socket.receive({
    id: "subscribe-error", timestamp: Date.now(), domain: "system",
    type: "system.subscribe.error",
    payload: { rejected: [{ room: "space:space-1", code: "UNAVAILABLE", message: "" }] },
  });
  await waitFor(() => sentTypes(socket).filter((type) => type === "subscribe").length === 2, "expected retry");
  socket.receive({
    id: "subscribe-ok", timestamp: Date.now(), domain: "system",
    type: "system.subscribe.ok", payload: { rooms: ["space:space-1"] },
  });
  assert.equal(client.isRoomLive("space:space-1"), true);
});

test("reconnects with a refreshed token when room authorization is unauthorized", async (t) => {
  FakeWebSocket.instances = [];
  const tokenOptions: Array<{ forceRefresh?: boolean } | undefined> = [];
  const client = new WebsocketClient({
    url: "ws://localhost",
    reconnectBaseDelayMs: 0,
    reconnectMaxDelayMs: 0,
    getAccessToken: (options) => {
      tokenOptions.push(options);
      return options?.forceRefresh ? "fresh-token" : "stale-token";
    },
    WebSocketImpl: FakeWebSocket,
  });
  t.after(() => client.disconnect());
  const release = client.subscribeSpace("space-1");
  t.after(release);
  const first = FakeWebSocket.instances[0];
  assert.ok(first);
  first.open();
  await waitFor(() => sentTypes(first).includes("auth"), "expected authentication");
  first.receive(authOk("connection-1"));
  await waitFor(() => sentTypes(first).includes("subscribe"), "expected subscription");
  first.receive({
    id: "subscribe-error", timestamp: Date.now(), domain: "system",
    type: "system.subscribe.error",
    payload: { rejected: [{ room: "space:space-1", code: "UNAUTHORIZED", message: "" }] },
  });

  await waitFor(() => FakeWebSocket.instances.length === 2, "expected a reauth reconnect");
  const second = FakeWebSocket.instances[1];
  assert.ok(second);
  second.open();
  await waitFor(() => sentTypes(second).includes("auth"), "expected refreshed authentication");
  second.receive(authOk("connection-2"));
  await waitFor(() => sentTypes(second).includes("subscribe"), "expected room restoration");
  second.receive({
    id: "subscribe-ok", timestamp: Date.now(), domain: "system",
    type: "system.subscribe.ok", payload: { rooms: ["space:space-1"] },
  });

  assert.deepEqual(tokenOptions, [undefined, { forceRefresh: true }]);
  assert.equal(client.isRoomLive("space:space-1"), true);
});
