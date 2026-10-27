import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mock, test } from "node:test";

process.env.LOG_LEVEL = "silent";

class FakeWebSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readonly raw = { bytesRead: 0 };
  pings = 0;
  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string, readonly options?: { headers?: Record<string, string> }) {
    super();
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.emit("upgrade", { socket: this.raw });
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  receive(message: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }

  send(data: string) {
    this.sent.push(data);
  }

  ping() {
    this.pings += 1;
  }

  fail(error: Error) {
    this.emit("error", error);
    this.finishClose(1006, "");
  }

  close(code = 1000, reason = "") {
    this.finishClose(code, reason);
  }

  terminate() {
    this.finishClose(1006, "");
  }

  private finishClose(code: number, reason: string) {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => this.emit("close", code, Buffer.from(reason)));
  }
}

mock.module("ws", { exports: { default: FakeWebSocket } });

const {
  disconnectSandboxWsClient,
  getSandboxClientConnection,
  startSandboxWsClient,
  waitForSandboxConnection,
} = await import("./ws-client.js");

function beginAttach(socket: FakeWebSocket, spaceId: string) {
  socket.open();
  socket.receive({
    version: "1",
    type: "sandbox.heartbeat",
    spaceId,
    sandboxId: "sandbox-test",
    timestamp: Date.now(),
    status: "ready",
  });
  const attachRequest = socket.sent
    .map((value) => JSON.parse(value) as { type: string; requestId: string })
    .find((message) => message.type === "session.attach");
  assert.ok(attachRequest);
  return attachRequest.requestId;
}

function finishAttach(socket: FakeWebSocket, spaceId: string, requestId: string, connectionId: string) {
  socket.receive({
    version: "1",
    type: "session.attach.ok",
    spaceId,
    sandboxId: "sandbox-test",
    timestamp: Date.now(),
    requestId,
    connectionId,
    identity: "agent-test",
  });
}

function attach(socket: FakeWebSocket, spaceId: string, connectionId: string) {
  finishAttach(socket, spaceId, beginAttach(socket, spaceId), connectionId);
}

test("authentication rejection refreshes the endpoint and credentials together", async () => {
  for (const nextWsUrl of ["ws://old.test/sandbox", "ws://new.test/sandbox"]) {
    const spaceId = `space-auth-refresh-${nextWsUrl}`;
    FakeWebSocket.instances = [];
    try {
      await startSandboxWsClient({
        spaceId,
        wsUrl: "ws://old.test/sandbox",
        identity: "agent-test",
        headers: { "x-worker-secret": "old-relay-secret" },
        hooks: {
          onRefreshConnection: () => ({ wsUrl: nextWsUrl, headers: { authorization: "Bearer new-instance-token" } }),
        },
      });
      const rejected = FakeWebSocket.instances[0];
      assert.ok(rejected);
      rejected.fail(new Error("Unexpected server response: 401"));
      await delay(400);
      const replacement = FakeWebSocket.instances[1];
      assert.ok(replacement);
      assert.equal(replacement.url, nextWsUrl);
      assert.deepEqual(replacement.options?.headers, { authorization: "Bearer new-instance-token" });
      attach(replacement, spaceId, "connection-authenticated");
      await waitForSandboxConnection(spaceId, 100);
    } finally {
      disconnectSandboxWsClient(spaceId, "test cleanup");
      for (const socket of FakeWebSocket.instances) socket.terminate();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
});

test("a superseded connection attempt cannot replace the current connection", async () => {
  const spaceId = "space-stale-attach";
  FakeWebSocket.instances = [];

  try {
    await startSandboxWsClient({
      spaceId,
      wsUrl: "ws://stale.test/sandbox",
      identity: "agent-test",
    });
    const staleSocket = FakeWebSocket.instances[0];
    assert.ok(staleSocket);
    const staleAttachRequestId = beginAttach(staleSocket, spaceId);

    disconnectSandboxWsClient(spaceId, "endpoint replaced");
    await startSandboxWsClient({
      spaceId,
      wsUrl: "ws://ready.test/sandbox",
      identity: "agent-test",
    });
    const replacementSocket = FakeWebSocket.instances[1];
    assert.ok(replacementSocket);
    attach(replacementSocket, spaceId, "connection-current");
    const currentConnection = await waitForSandboxConnection(spaceId, 100);

    finishAttach(staleSocket, spaceId, staleAttachRequestId, "connection-stale");
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(getSandboxClientConnection(spaceId), currentConnection);
    assert.equal(replacementSocket.readyState, FakeWebSocket.OPEN);
  } finally {
    disconnectSandboxWsClient(spaceId, "test cleanup");
    for (const socket of FakeWebSocket.instances) socket.terminate();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
});

test("disconnect and restart cannot revive a run loop waiting in reconnect backoff", async () => {
  const spaceId = "space-run-generation";
  FakeWebSocket.instances = [];

  let resolveConnectionError: (() => void) | undefined;
  const connectionError = new Promise<void>((resolve) => {
    resolveConnectionError = resolve;
  });

  try {
    await startSandboxWsClient({
      spaceId,
      wsUrl: "ws://stale.test/sandbox",
      identity: "agent-test",
      hooks: {
        onConnectionError: () => resolveConnectionError?.(),
      },
    });
    const staleSocket = FakeWebSocket.instances[0];
    assert.ok(staleSocket);
    staleSocket.fail(new Error("connect ECONNREFUSED 10.0.0.1:8788"));
    await connectionError;
    await new Promise<void>((resolve) => setImmediate(resolve));

    disconnectSandboxWsClient(spaceId, "endpoint replaced");
    await startSandboxWsClient({
      spaceId,
      wsUrl: "ws://ready.test/sandbox",
      identity: "agent-test",
    });
    const replacementSocket = FakeWebSocket.instances[1];
    assert.ok(replacementSocket);
    attach(replacementSocket, spaceId, "connection-current");
    await waitForSandboxConnection(spaceId, 100);

    await delay(500);
    assert.equal(
      FakeWebSocket.instances.length,
      2,
      "the superseded run loop must not reconnect after its backoff finishes",
    );
  } finally {
    disconnectSandboxWsClient(spaceId, "test cleanup");
    for (const socket of FakeWebSocket.instances) socket.terminate();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
});

async function withAttachedConnection(spaceId: string, run: (socket: FakeWebSocket, advance: (ms: number) => void) => Promise<void>) {
  FakeWebSocket.instances = [];
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    await startSandboxWsClient({ spaceId, wsUrl: "ws://relay.test/sandbox", identity: "agent-test" });
    const socket = FakeWebSocket.instances[0];
    assert.ok(socket);
    attach(socket, spaceId, `connection-${spaceId}`);
    await run(socket, (ms) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 5_000) mock.timers.tick(5_000);
    });
  } finally {
    mock.timers.reset();
    disconnectSandboxWsClient(spaceId, "test cleanup");
    for (const socket of FakeWebSocket.instances) socket.terminate();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("a half-open connection is pinged, then terminated, and its in-flight rpc fails instead of hanging", async () => {
  const spaceId = "space-half-open";
  await withAttachedConnection(spaceId, async (socket, advance) => {
    const connection = getSandboxClientConnection(spaceId);
    assert.ok(connection);
    const pending = connection.request("fs.tree", { path: "." }, { spaceId, sandboxId: "sandbox-test" });
    const sent = socket.sent.at(-1);
    assert.ok(sent);
    const request = JSON.parse(sent) as { requestId: string };
    socket.receive({ version: "1", type: "rpc.accepted", spaceId, sandboxId: "sandbox-test", timestamp: Date.now(), requestId: request.requestId, opId: "op-1" });

    advance(15_000);
    assert.equal(socket.readyState, FakeWebSocket.OPEN);
    assert.ok(socket.pings > 0, "silence triggers a ping before giving up");

    advance(10_000);
    assert.equal(socket.readyState, FakeWebSocket.CLOSED);
    await new Promise<void>((resolve) => setImmediate(resolve));
    mock.timers.tick(3_000);
    await assert.rejects(pending, /connection/i);
  });
});

test("byte progress and pongs keep a healthy connection alive", async () => {
  await withAttachedConnection("space-slow-frame", async (socket, advance) => {
    for (let elapsed = 0; elapsed < 60_000; elapsed += 5_000) {
      socket.raw.bytesRead += 64 * 1024;
      advance(5_000);
    }
    assert.equal(socket.pings, 0);
    for (let elapsed = 0; elapsed < 60_000; elapsed += 5_000) {
      const pings = socket.pings;
      advance(5_000);
      if (socket.pings > pings) socket.emit("pong");
    }
    assert.equal(socket.readyState, FakeWebSocket.OPEN);
  });
});
