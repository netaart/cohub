import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { createSandboxRelay } from "./relay/sandbox.js";

const spaceId = "11111111-1111-4111-8111-111111111111";
const runtimeId = "22222222-2222-4222-8222-222222222222";
const workerSecret = "worker-secret";
const runnerToken = "runner-token";

/**
 * In-memory socket. Incoming frames are injected by emitting "message" (the
 * gateway's listener fires); outgoing sends are recorded in `sent`. For the
 * pod-to-pod forward wire, `pair` links two sockets so a send on either
 * delivers a message on the other, like a real connection's two ends.
 */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1; // WebSocket.OPEN
  bufferedAmount = 0;
  readonly sent: Buffer[] = [];
  closeCode: number | null = null;
  private peer: FakeSocket | null = null;

  send(data: Buffer) {
    if (this.readyState !== this.OPEN) throw new Error("send on closed socket");
    this.sent.push(Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as string));
    this.peer?.deliver(data);
  }
  /** Pairs the two ends of one connection: send on either arrives at the other. */
  static pair(a: FakeSocket, b: FakeSocket) { a.peer = b; b.peer = a; }
  private deliver(data: Buffer) {
    if (this.readyState !== this.OPEN) return;
    this.emit("message", Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as string), false);
  }
  close(code?: number) {
    if (this.readyState === 3) return;
    this.closeCode = code ?? this.closeCode;
    this.readyState = 3;
    this.emit("close", this.closeCode ?? 1006, Buffer.from(""));
  }
  terminate() { this.close(); }
  frames<T = { type?: string; channel?: string }>(): T[] { return this.sent.map((data) => JSON.parse(data.toString()) as T); }
  text() { return this.sent.map((data) => data.toString()).filter((value) => !value.startsWith("{")); }
}

const fakeRequest = (headers: Record<string, string | undefined>, url: string) => ({ headers, url }) as IncomingMessage;
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Relay instances ("pods") sharing one in-memory hint registry (stand-in for Redis). */
function clusterFixture() {
  const hints = new Map<string, string>();
  const sockets: FakeSocket[] = [];
  const pods: Array<{ relay: ReturnType<typeof createSandboxRelay>; endpoint: string }> = [];
  const track = (socket: FakeSocket) => { sockets.push(socket); return socket; };

  const pod = (endpoint: string) => {
    const relay = createSandboxRelay({
      workerSecret,
      nodeId: endpoint,
      selfEndpoint: endpoint,
      peerEndpoint: (id: string) => `ws://${endpoint}/internal/sandbox-relay/${id}`,
      authorize: async () => ({ ok: true, userId: "owner" }),
      renewWorkspace: async () => true,
      releaseWorkspace: async () => undefined,
      reportStatus: async () => undefined,
      runtimeChanged: async () => undefined,
      publishWatcherEvent: async () => undefined,
      storeWatcherStatus: async () => undefined,
      publishChannelHint: async (channelId: string, owner: string) => { hints.set(channelId, owner); },
      readChannelHint: async (channelId: string) => hints.get(channelId) ?? null,
      clearChannelHint: async (channelId: string) => { hints.delete(channelId); },
      dialForward: async (target: string, channelId: string, authorization: string) => {
        assert.notEqual(target, endpoint, "a pod must never forward to itself");
        const local = track(new FakeSocket()); // this pod's client end of the forward wire
        const remote = track(new FakeSocket()); // the owner pod's accepted end
        FakeSocket.pair(local, remote);
        const owner = pods.find((candidate) => candidate.endpoint === target);
        assert.ok(owner, `forward target ${target} must be a known pod`);
        owner.relay.handleDataForwardConnection(remote as unknown as WebSocket, fakeRequest({ authorization, "x-worker-secret": workerSecret }, `/internal/sandbox-relay-forward/${channelId}`));
        return local as unknown as WebSocket;
      },
    });
    const created = { relay, endpoint };
    pods.push(created);
    return created;
  };

  /** Closes every tracked socket so heartbeat intervals and pairing timers clear. */
  const teardown = () => { for (const socket of sockets) socket.close(); };
  return { pod, hints, track, teardown };
}

/** Registers a runner control connection on a pod and returns its socket. */
async function registerRunner(fixture: { track: (socket: FakeSocket) => FakeSocket }, relay: ReturnType<typeof createSandboxRelay>) {
  const runner = fixture.track(new FakeSocket());
  await relay.handleControlConnection(runner as unknown as WebSocket, fakeRequest({ authorization: `Bearer ${runnerToken}` }, "/sandbox/relay"));
  runner.emit("message", Buffer.from(JSON.stringify({ type: "register", spaceId, runtimeId })));
  await settle();
  assert.ok(runner.frames().some((frame) => frame.type === "registered"), "runner must register");
  return runner;
}

/** Connects a cloud peer and waits for the runner to receive its open frame. */
async function openChannel(fixture: { track: (socket: FakeSocket) => FakeSocket }, relay: ReturnType<typeof createSandboxRelay>, runner: FakeSocket) {
  const peer = fixture.track(new FakeSocket());
  relay.handlePeerConnection(peer as unknown as WebSocket, fakeRequest({ "x-worker-secret": workerSecret }, `/internal/sandbox-relay/${spaceId}`), spaceId);
  await settle();
  const channelId = runner.frames<{ type: string; channel?: string }>().find((frame) => frame.type === "open")?.channel;
  assert.ok(channelId, "runner must receive the open frame");
  return { peer, channelId };
}

test("data dial landing on the owner pod pairs locally and clears the hint", async (t) => {
  const { pod, hints, track, teardown } = clusterFixture();
  t.after(teardown);
  const { relay } = pod("10.0.0.1:8788");
  const runner = await registerRunner({ track }, relay);
  const { peer, channelId } = await openChannel({ track }, relay, runner);
  assert.equal(hints.get(channelId), "10.0.0.1:8788");

  const dial = track(new FakeSocket());
  relay.handleDataConnection(dial as unknown as WebSocket, fakeRequest({ authorization: `Bearer ${runnerToken}` }, `/sandbox/relay/data?channel=${channelId}`));
  await settle();

  assert.equal(hints.has(channelId), false, "hint must be cleared on successful pairing");
  peer.emit("message", Buffer.from("peer-to-runner"), false);
  dial.emit("message", Buffer.from("runner-to-peer"), false);
  await settle();
  assert.deepEqual(dial.text(), ["peer-to-runner"]);
  assert.deepEqual(peer.text(), ["runner-to-peer"]);
});

test("data dial landing on the wrong pod is forwarded and pairs with the owner", async (t) => {
  const { pod, hints, track, teardown } = clusterFixture();
  t.after(teardown);
  const owner = pod("10.0.0.1:8788");
  const other = pod("10.0.0.2:8788");
  const runner = await registerRunner({ track }, owner.relay);
  const { peer, channelId } = await openChannel({ track }, owner.relay, runner);

  const dial = track(new FakeSocket());
  other.relay.handleDataConnection(dial as unknown as WebSocket, fakeRequest({ authorization: `Bearer ${runnerToken}` }, `/sandbox/relay/data?channel=${channelId}`));
  await settle();
  await settle();

  assert.equal(hints.has(channelId), false, "pairing must clear the hint");
  peer.emit("message", Buffer.from("hello-from-peer"), false);
  dial.emit("message", Buffer.from("hello-from-runner"), false);
  await settle();
  await settle();
  assert.deepEqual(dial.text(), ["hello-from-peer"], "peer frames must reach the runner through the forward wire");
  assert.deepEqual(peer.text(), ["hello-from-runner"], "runner frames must reach the peer through the forward wire");
});

test("forward dials without the worker secret are rejected", async (t) => {
  const { pod, track, teardown } = clusterFixture();
  t.after(teardown);
  const { relay } = pod("10.0.0.1:8788");
  const runner = await registerRunner({ track }, relay);
  const { channelId } = await openChannel({ track }, relay, runner);

  const forward = track(new FakeSocket());
  relay.handleDataForwardConnection(forward as unknown as WebSocket, fakeRequest({ "x-worker-secret": "wrong" }, `/internal/sandbox-relay-forward/${channelId}`));
  assert.equal(forward.closeCode, 4401);
});

test("a dial without any hint degrades to the pre-forward unknown-channel behavior", async (t) => {
  const { pod, hints, track, teardown } = clusterFixture();
  t.after(teardown);
  const owner = pod("10.0.0.1:8788");
  const other = pod("10.0.0.2:8788");
  await registerRunner({ track }, owner.relay);

  const channelId = crypto.randomUUID();
  hints.delete(channelId);
  const dial = track(new FakeSocket());
  other.relay.handleDataConnection(dial as unknown as WebSocket, fakeRequest({ authorization: `Bearer ${runnerToken}` }, `/sandbox/relay/data?channel=${channelId}`));
  await settle();
  await settle();
  assert.equal(dial.closeCode, 4404, "no hint falls back to unknown channel");
});

test("data dial with a wrong token is rejected even with a valid channel", async (t) => {
  const { pod, track, teardown } = clusterFixture();
  t.after(teardown);
  const { relay } = pod("10.0.0.1:8788");
  const runner = await registerRunner({ track }, relay);
  const { channelId } = await openChannel({ track }, relay, runner);

  const dial = track(new FakeSocket());
  relay.handleDataConnection(dial as unknown as WebSocket, fakeRequest({ authorization: "Bearer wrong-token" }, `/sandbox/relay/data?channel=${channelId}`));
  await settle();
  assert.equal(dial.closeCode, 4401);
});
