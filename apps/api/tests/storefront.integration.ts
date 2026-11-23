import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mock, test } from "node:test";
import { Hono } from "hono";
import type { RequestPrincipal } from "../src/lib/middleware.js";

const appId = "11111111-1111-4111-8111-111111111111";
const operations = "22222222-2222-4222-8222-222222222222";
const shop = "33333333-3333-4333-8333-333333333333";
const orderId = "44444444-4444-4444-8444-444444444444";
const origin = "https://shop.example";
const bindings = new Map([[origin, appId]]);
const values = new Map<string, string>();
const permission = (user: { uuid: string }, _permission: string, target: { spaceId: string }) =>
  user.uuid === "host" && target.spaceId === operations;
const order = { id: orderId, external_user_id: "buyer", status: "paid" };
const lists: unknown[] = [];

mock.module("../src/redis.js", { namedExports: { redisCommandClient: {
  set: (k: string, v: string) => values.set(k, v),
  get: (k: string) => values.get(k),
  getdel: (k: string) => { const v = values.get(k); values.delete(k); return v; },
  del: (k: string) => values.delete(k),
} } });
mock.module("../src/permissions.js", { namedExports: { hasPermission: permission } });
mock.module("../src/app-promotion-events.js", { namedExports: { recordResolvedAppPromotionEvent() {}, resolvePublishedAppPromotion() {} } });
const commerce = await import("../src/lib/space-commerce.js");
mock.module("../src/lib/space-commerce.js", { namedExports: {
  ...commerce,
  getAppCommerceContextById: () => ({ appStatus: "published", appVisibility: "public", spaceId: shop }),
  requireSpaceCommerceBusinessKey: () => "shop-business",
  requireSpaceCommerceBusiness: (id: string) => ({ billingBusinessKey: id }),
  createSpaceCommerceSdk: () => ({ admin: { orders: {
    get: () => order,
    list: (input: unknown) => { lists.push(input); return { items: [], pagination: { has_more: true } }; },
  } } }),
} });
const { config } = await import("../src/config.js");
config.appEncryptionKey = "test-only-signing-key";
config.commerceOrderReports = new Map([[operations, [shop]]]);
const { createAppBrowserSessionRouter } = await import("../src/routes/app-browser-session.route.js");
const { createAppCommerceRouter } = await import("../src/routes/app-commerce.route.js");
const { default: shopRouter } = await import("../src/routes/spaces/commerce.route.js");
const { verifyAppSessionToken } = await import("../src/app-sessions.js");
const api = new Hono();
let principal: RequestPrincipal | null = null;
api.use("*", async (c, next) => { c.set("principal", principal); await next(); });
api.route("/apps", createAppBrowserSessionRouter(async (host, id) => bindings.get(host) === id ? { id, spaceId: shop, appScopes: [] } : null));
api.route("/", createAppCommerceRouter("apps"));
api.route("/spaces", shopRouter);

function account(uuid: string): RequestPrincipal { return { type: "user", user: { uuid } }; }
function action(viewerUserId: string | null, id = appId): RequestPrincipal {
  return { type: "execution", execution: {
    type: "execution", spaceId: operations, source: "app_action", actorUserId: "host", viewerUserId,
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

test("the operations report checks the shop and the Action visitor on every page", async () => {
  const path = `/spaces/${operations}/commerce/orders?shopSpaceId=`;
  principal = account("host");
  const page = await api.request(path + shop + "&page=2");
  assert.equal(page.status, 200);
  assert.equal((await page.json()).pagination.nextPage, 3);
  assert.deepEqual(lists.at(-1), { business_key: shop, include_count: false, page: 2, limit: 20, sorting: "-created_at" });
  assert.equal((await api.request(path + appId)).status, 403);
  principal = action("buyer");
  assert.equal((await api.request(path + shop)).status, 403);
  principal = account("buyer");
  assert.deepEqual(await (await api.request(`/spaces/${operations}/commerce/report-shops`)).json(), { shops: [] });
  assert.equal(lists.length, 1);
});

test("browser sign-in binds a single-use code to the browser, App, origin and return path", async () => {
  const post = (method: string, data: object, id = appId) => api.request(`/apps/${id}/browser-session/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin, ...data }),
  });
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const returnTo = "/items?sort=new#/checkout";
  principal = account("buyer");
  assert.equal((await post("code", { challenge, returnTo: "https://another.example/" })).status, 403);
  principal = action("buyer");
  assert.equal((await post("code", { challenge, returnTo })).status, 403);
  principal = account("buyer");
  const authorized = await post("code", { challenge, returnTo });
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
