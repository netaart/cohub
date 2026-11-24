import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mock, test } from "node:test";
import { Hono } from "hono";
import type { RequestPrincipal } from "../src/lib/middleware.js";

const appId = "11111111-1111-4111-8111-111111111111";
const shop = "33333333-3333-4333-8333-333333333333";
const orderId = "44444444-4444-4444-8444-444444444444";
const origin = "https://shop.example";
const bindings = new Map([[origin, appId]]);
const values = new Map<string, string>();
const order = { id: orderId, external_user_id: "buyer", status: "paid" };

mock.module("../src/redis.js", { namedExports: { redisCommandClient: {
  set: (k: string, v: string) => values.set(k, v),
  get: (k: string) => values.get(k),
  getdel: (k: string) => { const v = values.get(k); values.delete(k); return v; },
  del: (k: string) => values.delete(k),
  expire: () => 1,
} } });
mock.module("../src/permissions.js", { namedExports: { hasPermission: () => false } });
mock.module("../src/app-promotion-events.js", { namedExports: { recordResolvedAppPromotionEvent() {}, resolvePublishedAppPromotion() {} } });
const commerce = await import("../src/lib/space-commerce.js");
mock.module("../src/lib/space-commerce.js", { namedExports: {
  ...commerce,
  getAppCommerceContextById: () => ({ appStatus: "published", appVisibility: "public", spaceId: shop }),
  requireSpaceCommerceBusinessKey: () => "shop-business",
  createSpaceCommerceSdk: () => ({ admin: { orders: { get: () => order } } }),
} });
const { config } = await import("../src/config.js");
config.appEncryptionKey = "test-only-signing-key";
const { createAppBrowserSessionRouter } = await import("../src/routes/app-browser-session.route.js");
const { createAppCommerceRouter } = await import("../src/routes/app-commerce.route.js");
const { verifyAppSessionToken } = await import("../src/app-sessions.js");
const { isAppBrowserTokenLive, revokeAppBrowserSessions } = await import("../src/lib/app-browser-epoch.js");
const api = new Hono();
let principal: RequestPrincipal | null = null;
api.use("*", async (c, next) => { c.set("principal", principal); await next(); });
api.route("/apps", createAppBrowserSessionRouter(async (host, id) => bindings.get(host) === id ? { id, spaceId: shop, appScopes: [] } : null));
api.route("/", createAppCommerceRouter("apps"));

function account(uuid: string): RequestPrincipal { return { type: "user", user: { uuid } }; }
function action(viewerUserId: string | null, id = appId, spaceId = shop): RequestPrincipal {
  return { type: "execution", execution: {
    type: "execution", spaceId, source: "app_action", actorUserId: "host", viewerUserId,
    appId: id, appVersionId: null, action: "check", taskRunId: null, sessionId: null, turnId: null,
    scopes: ["space.commerce.view"], expiresAt: Date.now() + 10000,
  } };
}

test("an Action confirms only its bound buyer's order and direct buyer access still works", async () => {
  const path = `/apps/${appId}/commerce/orders/${orderId}`;
  for (const [caller, status] of [
    [action("buyer"), 200], [action("other"), 403], [action(null), 403], [action("buyer", shop), 403],
    [account("buyer"), 200], [account("host"), 403],
  ] as const) {
    principal = caller;
    assert.equal((await api.request(path)).status, status);
  }
});

test("browser sign-in binds a single-use code to the browser, App, origin and return path", async () => {
  const post = (method: string, data: object, id = appId) => api.request(`/apps/${id}/browser-session/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin, ...data }),
  });
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const returnTo = "/items?sort=new#/checkout";
  principal = account("buyer");
  const userUuid = "buyer";
  assert.equal((await post("code", { challenge, returnTo: "https://another.example/", userUuid })).status, 403);
  assert.equal((await post("code", { challenge, returnTo, userUuid: "other" })).status, 409);
  principal = action("buyer");
  assert.equal((await post("code", { challenge, returnTo, userUuid })).status, 403);
  principal = account("buyer");
  const authorized = await post("code", { challenge, returnTo, userUuid });
  assert.equal(authorized.status, 200);
  const { code } = await authorized.json();
  principal = null;
  assert.equal((await post("exchange", { code, verifier: challenge })).status, 401);
  const results = await Promise.all([post("exchange", { code, verifier }), post("exchange", { code, verifier })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
  const issued = await results.find((r) => r.ok)?.json();
  assert.equal(issued.returnTo, returnTo);
  const session = issued.session;
  const renewed = await post("token", { session });
  assert.equal(renewed.headers.get("Cache-Control"), "no-store");
  assert.equal(verifyAppSessionToken((await renewed.json()).token)?.userUuid, "buyer");
  assert.equal((await post("token", { session }, shop)).status, 401);
  bindings.clear();
  assert.equal((await post("token", { session })).status, 403);
  bindings.set(origin, appId);
  assert.equal((await post("logout", { session })).status, 204);
  assert.equal((await post("token", { session })).status, 401);
});

test("signing out of Cohub ends existing storefront sessions but not later ones", async () => {
  const confirm = async () => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    principal = account("buyer");
    const { code } = await (await api.request(`/apps/${appId}/browser-session/code`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin, challenge, returnTo: "/", userUuid: "buyer" }),
    })).json();
    principal = null;
    return () => api.request(`/apps/${appId}/browser-session/exchange`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin, code, verifier }),
    });
  };
  const signIn = async () => (await (await (await confirm())()).json()).session as string;
  const token = (session: string) => api.request(`/apps/${appId}/browser-session/token`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin, session }),
  });
  const before = await signIn();
  const issued = verifyAppSessionToken((await (await token(before)).json()).token);
  assert.ok(issued);
  assert.equal(await isAppBrowserTokenLive(issued), true);
  const pending = await confirm();
  await revokeAppBrowserSessions("buyer");
  assert.equal(await isAppBrowserTokenLive(issued), false);
  assert.equal((await token(before)).status, 401);
  assert.equal((await pending()).status, 401);
  const after = await signIn();
  assert.equal((await token(after)).status, 200);
});
