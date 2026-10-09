import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_BRIDGE_ERROR } from "@cohub/protocol/host-bridge";
import {
  createHostBridge,
  HostBridgeErrorClass,
  type HostBridgeChannel,
} from "./host-bridge.js";

type Request = { type: string; method?: string; id?: string; params?: unknown };

function createFakeHost(options: { autoDescribe?: boolean } = {}) {
  let listener: ((event: { data: unknown }) => void) | null = null;
  const sent: Request[] = [];
  const description = {
    version: 1,
    platform: "android",
    hostId: "install-1",
    capabilities: ["auth.token", "auth.session", "share", "navigation"],
  };

  const deliver = (data: unknown) => listener?.({ data });
  const channel: HostBridgeChannel = {
    postMessage(message) {
      const parsed = JSON.parse(message) as Request;
      sent.push(parsed);
      if (options.autoDescribe !== false && parsed.method === "host.describe" && parsed.id) {
        deliver({ type: "response", id: parsed.id, result: description });
      }
    },
    addEventListener(_type, next) {
      listener = next;
    },
    removeEventListener() {
      listener = null;
    },
  };

  return {
    channel,
    sent,
    deliver,
    reply: (id: string, result: unknown) => deliver({ type: "response", id, result }),
    fail: (id: string, code: string, message: string) =>
      deliver({ type: "response", id, error: { code, message } }),
    event: (name: string) => deliver({ type: "event", name }),
    hello: () => deliver({ type: "hello", ...description }),
    requests: () => sent.filter((message) => message.type === "request"),
    lastRequestId: () => sent.at(-1)?.id as string,
  };
}

test("no channel: ready resolves null, calls are unsupported", async () => {
  const bridge = createHostBridge({ channel: null });
  assert.equal(await bridge.ready(), null);
  assert.equal(bridge.connected, false);
  assert.equal(bridge.supports("auth.token"), false);
  await assert.rejects(
    () => bridge.call("auth.getAccessToken"),
    (error: unknown) =>
      error instanceof HostBridgeErrorClass && error.code === HOST_BRIDGE_ERROR.unsupported,
  );
});

test("nothing is usable before the handshake", async () => {
  const host = createFakeHost();
  const bridge = createHostBridge({ channel: host.channel });
  assert.equal(bridge.connected, false);
  assert.equal(bridge.supports("auth.token"), false);

  const status = await bridge.ready();
  assert.equal(status?.platform, "android");
  assert.equal(bridge.connected, true);
  assert.equal(bridge.supports("auth.token"), true);
  assert.equal(bridge.supports("filePicker"), false);
});

test("the handshake runs once no matter how often ready is called", async () => {
  const host = createFakeHost();
  const bridge = createHostBridge({ channel: host.channel });
  await Promise.all([bridge.ready(), bridge.ready()]);
  await bridge.ready();
  assert.equal(host.requests().filter((r) => r.method === "host.describe").length, 1);
});

test("a silent host leaves the bridge disconnected", async () => {
  const host = createFakeHost({ autoDescribe: false });
  const bridge = createHostBridge({ channel: host.channel, handshakeTimeoutMs: 10 });
  assert.equal(await bridge.ready(), null);
  assert.equal(bridge.connected, false);
});

test("a pushed hello also connects, for older hosts", async () => {
  const host = createFakeHost({ autoDescribe: false });
  const bridge = createHostBridge({ channel: host.channel });
  host.hello();
  assert.equal(bridge.connected, true);
  assert.equal(bridge.supports("share"), true);
});

test("call round-trips and pairs the response by id", async () => {
  const host = createFakeHost();
  const bridge = createHostBridge({ channel: host.channel });
  await bridge.ready();

  const pending = bridge.call("auth.getAccessToken", { forceRefresh: true });
  const request = host.requests().find((m) => m.method === "auth.getAccessToken");
  assert.deepEqual(request?.params, { forceRefresh: true });

  host.reply(request?.id as string, "token-1");
  assert.equal(await pending, "token-1");
});

test("null means no session, not an error", async () => {
  const host = createFakeHost();
  const bridge = createHostBridge({ channel: host.channel });
  await bridge.ready();

  const pending = bridge.call("auth.getAccessToken");
  host.reply(host.lastRequestId(), null);
  assert.equal(await pending, null);
});

test("host errors surface as a typed error", async () => {
  const host = createFakeHost();
  const bridge = createHostBridge({ channel: host.channel });
  await bridge.ready();

  const pending = bridge.call("auth.signIn", {});
  host.fail(host.lastRequestId(), HOST_BRIDGE_ERROR.canceled, "user dismissed");
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof HostBridgeErrorClass);
    assert.equal(error.isCanceled, true);
    return true;
  });
});

test("an aborted call rejects and ignores a late reply", async () => {
  const host = createFakeHost();
  const bridge = createHostBridge({ channel: host.channel });
  await bridge.ready();

  const controller = new AbortController();
  const pending = bridge.call("share.text", { text: "hi" }, { signal: controller.signal });
  const id = host.lastRequestId();
  controller.abort();
  await assert.rejects(pending, (error: unknown) =>
    error instanceof HostBridgeErrorClass && error.isCanceled,
  );
  host.reply(id, true);
});

test("a silent host times out instead of hanging", async () => {
  const host = createFakeHost();
  const bridge = createHostBridge({ channel: host.channel });
  await bridge.ready();

  await assert.rejects(
    () => bridge.call("auth.getSessionVersion", undefined, { timeoutMs: 10 }),
    (error: unknown) =>
      error instanceof HostBridgeErrorClass && error.code === HOST_BRIDGE_ERROR.failed,
  );
});

test("events reach subscribers until they unsubscribe", async () => {
  const host = createFakeHost();
  const bridge = createHostBridge({ channel: host.channel });
  await bridge.ready();

  const seen: string[] = [];
  const unsubscribe = bridge.onEvent((event) => seen.push(event.name));
  host.event("auth.changed");
  unsubscribe();
  host.event("auth.signedOut");
  assert.deepEqual(seen, ["auth.changed"]);
});

test("dispose rejects in-flight calls and detaches", async () => {
  const host = createFakeHost();
  const bridge = createHostBridge({ channel: host.channel });
  await bridge.ready();

  const pending = bridge.call("auth.getAccessToken");
  bridge.dispose();
  await assert.rejects(pending, (error: unknown) => error instanceof HostBridgeErrorClass);
  assert.equal(bridge.connected, false);
});

test("malformed host messages are ignored", async () => {
  const host = createFakeHost({ autoDescribe: false });
  const bridge = createHostBridge({ channel: host.channel });

  host.deliver("not json");
  host.deliver({ type: "hello", version: 1, platform: "harmony", hostId: "x", capabilities: [] });
  assert.equal(bridge.connected, false);

  host.hello();
  assert.equal(bridge.connected, true);
});
