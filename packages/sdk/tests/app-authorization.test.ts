import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createAppBridgeCore } from "../src/app-bridge-core.js";
import { AppRuntimeApi, AppRuntimeError, type AppRuntimeTransport } from "../src/app-runtime.js";

const originalFetch = globalThis.fetch;
const originalSessionStorage = globalThis.sessionStorage;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.sessionStorage = originalSessionStorage; });

const grant = { id: "grant-1", spaceId: "viewer-space", scopes: ["file.view"], expiresAt: "2026-10-01T00:00:00.000Z" };
function setup(viewer: string | null = "viewer") {
  const replies: Record<string, unknown>[] = [];
  const requests: { url: string; body?: Record<string, unknown> }[] = [];
  let logins = 0;
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json(String(url).endsWith("/api/spaces")
      ? [{ id: "viewer-space", name: "My Space" }]
      : { token: "token", grant });
  }) as typeof fetch;
  const core = createAppBridgeCore({
    app: { id: "app", spaceId: "author-space", slug: "app", userUuid: "author", appScopes: [] },
    apiOrigin: "https://api.test", reply: (_id, payload) => replies.push(payload),
    getCheckoutState: () => ({ status: null, orderId: null }),
    getAccessToken: async () => viewer ? "user-token" : null,
    getViewerUuid: async () => viewer,
    requestSignIn: async () => { logins++; },
  });
  return { core, replies, requests, logins: () => logins };
}
const request = (extra = {}) => ({ data: { type: "cohub.app.authorize.v2", requestId: "r1", target: { kind: "space", spaceId: "unavailable" }, scopes: ["file.view"], ...extra } }) as MessageEvent;

test("login restores strict structured consent without storing credentials", async () => {
  const storage = new Map<string, string>();
  globalThis.sessionStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  } as Storage;
  await setup(null).core.handleMessage(request({ fallback: "none" }));
  assert.equal(storage.size, 1);
  assert.equal([...storage.values()][0].includes("user-token"), false);
  const { core, replies } = setup();
  await core.handleMessage({ data: { type: "cohub.app.context", requestId: "ctx" } } as MessageEvent);
  assert.equal(replies.at(-1)?.code, "space_inaccessible");
  assert.equal(storage.size, 0);
});

for (const outcome of ["success", "cancel", "transient", "newer-intent"] as const) {
  test(`resumed consent handles stored intent on ${outcome}`, async () => {
    const storage = new Map<string, string>();
    globalThis.sessionStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    } as Storage;
    await setup(null).core.handleMessage(request());
    const { core } = setup();
    const context = { data: { type: "cohub.app.context", requestId: "ctx" } } as MessageEvent;
    await core.handleMessage(context);
    assert.equal(core.getState().authOpen, true);
    assert.equal(storage.size, 1);
    if (outcome === "transient") {
      globalThis.fetch = (async () => Response.json({ message: "Retry" }, { status: 503 })) as typeof fetch;
      await core.confirmAuth();
      assert.equal(storage.size, 1);
      assert.equal(core.getState().authOpen, true);
      core.cancelAuth();
    } else if (outcome === "newer-intent") {
      const key = "cohub:app-login:app";
      const raw = storage.get(key);
      assert.ok(raw);
      const saved = JSON.parse(raw);
      saved.data.requestId = "newer";
      storage.set(key, JSON.stringify(saved));
      core.cancelAuth();
      assert.equal(storage.get(key), JSON.stringify(saved));
      return;
    } else if (outcome === "success") {
      await core.confirmAuth();
    } else {
      core.cancelAuth();
    }
    assert.equal(storage.size, 0);
    await core.handleMessage(context);
    assert.equal(core.getState().authOpen, false);
  });
}

test("cancel after creating a Space preserves the resource identity", async () => {
  const { core, replies } = setup();
  globalThis.fetch = (async (url) => String(url).endsWith("/api/spaces")
    ? Response.json({ space: { id: "created", name: "Created" } })
    : Response.json({ message: "Try again" }, { status: 503 })) as typeof fetch;
  await core.handleMessage({ data: { type: "cohub.app.authorize", requestId: "create", scopes: ["file.view"], createSpace: { name: "Created" } } } as MessageEvent);
  await core.confirmAuth();
  core.cancelAuth();
  assert.deepEqual(replies[0].space, { id: "created", name: "Created" });
  assert.equal(replies[0].stage, "authorization");
});

test("structured consent retains fallback and returns the authoritative grant", async () => {
  const { core, replies, requests } = setup();
  await core.handleMessage(request());
  assert.equal(core.getState().selectedSpaceId, "viewer-space");
  await core.confirmAuth();
  assert.deepEqual(replies[0].result, {
    status: "granted", requestedTarget: { kind: "space", spaceId: "unavailable" },
    target: { kind: "space", spaceId: "viewer-space", name: "My Space" },
    resolution: "fallback", grant,
  });
  assert.equal(requests.at(-1)?.body?.scopeMode, "extend");
});

test("strict requests cannot fall back", async () => {
  const { core, replies, requests } = setup();
  await core.handleMessage(request({ fallback: "none" }));
  assert.equal(replies[0].code, "space_inaccessible");
  assert.equal(core.getState().authOpen, false);
  assert.equal(requests.some(({ url }) => url.endsWith("/authorize")), false);
});

test("structured cancellation is not an error or denial", async () => {
  const { core, replies } = setup();
  await core.handleMessage(request());
  core.cancelAuth();
  assert.deepEqual(replies[0].result, { status: "cancelled" });
});

test("unknown scopes and account/space mismatches fail before consent", async () => {
  for (const input of [{ scopes: ["file.view", "unknown"] }, { target: { kind: "account" } }]) {
    const { core, replies, requests } = setup();
    await core.handleMessage(request(input));
    assert.equal(replies[0].code, "invalid_request");
    assert.equal(requests.length, 0);
  }
});

test("logged-out authorization starts login without showing an empty picker or error", async () => {
  const { core, replies, requests, logins } = setup(null);
  await core.handleMessage(request());
  assert.equal(logins(), 1);
  assert.equal(core.getState().authOpen, false);
  assert.equal(replies.length, 0);
  assert.equal(requests.length, 0);
});

test("modern token refresh never requests consent", async () => {
  const calls: string[] = [];
  const transport: AppRuntimeTransport = {
    async request<T>(message: Record<string, unknown>) {
      calls.push(String(message.type));
      return (message.type === "cohub.app.context"
        ? { context: { capabilities: { authorization: 2, serverGrants: true } } }
        : { token: "fresh" }) as T;
    },
  };
  const runtime = new AppRuntimeApi(transport);
  await runtime.context();
  assert.equal(await runtime.getAccessToken({ forceRefresh: true }), "fresh");
  assert.deepEqual(calls, ["cohub.app.context", "cohub.app.token"]);
});

test("account changes invalidate the SDK token cache", async () => {
  let listener: ((context: import("../src/app-runtime.js").AppRuntimeContext) => void) | undefined;
  let minted = 0;
  const runtime = new AppRuntimeApi({
    subscribeContextChanged: (callback) => { listener = callback; return () => { listener = undefined; }; },
    async request<T>(message: Record<string, unknown>) {
      return (message.type === "cohub.app.context"
        ? { context: { app: { id: "app" }, viewer: { userUuid: "alice" } } }
        : { token: `token-${++minted}` }) as T;
    },
  });
  await runtime.context();
  assert.equal(await runtime.getAccessToken(), "token-1");
  listener?.({ app: { id: "app", slug: "app" }, space: { id: "home" }, viewer: { userUuid: "bob" } });
  assert.equal(await runtime.getAccessToken(), "token-2");
  runtime.dispose();
  assert.equal(listener, undefined);
});

test("a late token response cannot restore a previous account", async () => {
  let listener: ((context: import("../src/app-runtime.js").AppRuntimeContext) => void) | undefined;
  let release: (() => void) | undefined;
  let requests = 0;
  const runtime = new AppRuntimeApi({
    subscribeContextChanged: (callback) => { listener = callback; return () => {}; },
    async request<T>(message: Record<string, unknown>) {
      if (message.type === "cohub.app.context") return { context: { viewer: { userUuid: "alice" } } } as T;
      if (++requests === 1) return new Promise<T>((resolve) => { release = () => resolve({ token: "alice" } as T); });
      return { token: "bob" } as T;
    },
  });
  await runtime.context();
  const stale = runtime.getAccessToken();
  await Promise.resolve();
  listener?.({ app: { id: "app", slug: "app" }, space: { id: "home" }, viewer: { userUuid: "bob" } });
  assert.equal(await runtime.getAccessToken(), "bob");
  release?.();
  assert.equal(await stale, null);
  assert.equal(await runtime.getAccessToken(), "bob");
  runtime.dispose();
});

test("new SDK fails explicitly on old hosts without sending an authorization", async () => {
  const calls: string[] = [];
  const runtime = new AppRuntimeApi({ async request<T>(message: Record<string, unknown>) {
    calls.push(String(message.type));
    return { context: { app: { id: "app" } } } as T;
  } });
  await assert.rejects(runtime.authorize({ target: { kind: "account" }, scopes: ["user.space.list"] }),
    (error: unknown) => error instanceof AppRuntimeError && error.code === "unsupported");
  assert.deepEqual(calls, ["cohub.app.context"]);
});
