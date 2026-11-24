import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "@cohub/db";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import type { RequestPrincipal } from "../src/lib/middleware.js";

process.env.LOG_LEVEL = "silent";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../drizzle/v2");
const client = new PGlite({ extensions: { pg_trgm } });
const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
for (const entry of journal.entries) {
  await client.exec(readFileSync(join(migrations, `${entry.tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
}
mock.module("../src/db/index.js", { exports: { db: drizzle(client, { schema }) } });
mock.module("../src/redis.js", { exports: {
  redisCommandClient: {}, redisBestEffortCommandClient: {}, isRedisReady: async () => false,
  getAgentInstanceInputQueueKey: () => "", getGatewayNodeOutboundStreamKey: () => "", REALTIME_OUTBOUND_CHANNEL: "", xaddWithMaxlen: async () => null,
} });

const { config } = await import("../src/config.js");
config.appEncryptionKey = "test-only-signing-key";
const { createAppsRouter } = await import("../src/routes/apps.route.js");
const { hasMemberPermission, hasPermission, resolvePermissionAccess } = await import("../src/permissions.js");
const { default: appAccessRouter } = await import("../src/routes/spaces/app-access.route.js");

const insert = async (sql: string) => (await client.query<{ id: string }>(sql)).rows[0]?.id ?? "";
const home = await insert(`INSERT INTO v2.spaces (user_uuid, name) VALUES ('publisher', 'Home') RETURNING id`);
const shop = await insert(`INSERT INTO v2.spaces (user_uuid, name) VALUES ('owner', 'Shop') RETURNING id`);
await client.exec(`INSERT INTO v2.space_members (space_id, user_id, role, created_by, updated_by) VALUES ('${home}', 'publisher', 'host', 'publisher', 'publisher'), ('${shop}', 'owner', 'host', 'owner', 'owner')`);
const appId = await insert(`INSERT INTO v2.apps (space_id, user_uuid, slug, status, target_type, target_ref)
  VALUES ('${home}', 'publisher', 'ops', 'published', 'directory', 'ops') RETURNING id`);

const api = new Hono();
let principal: RequestPrincipal | null = null;
api.use("*", async (c, next) => { c.set("principal", principal); await next(); });
api.route("/apps", createAppsRouter("canonical"));
api.route("/spaces/:id/app-access", appAccessRouter);

const authorize = (body: object) => {
  principal = { type: "user", user: { uuid: "owner" } };
  return api.request(`/apps/${appId}/authorize`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spaceId: shop, ...body }),
  });
};
const action = (id = appId, source = "app_action", spaceId = home, uuid = "publisher") => ({
  uuid,
  execution: { spaceId, scopes: [], source, appId: id },
});
const canRead = (subject = action()) => hasPermission(subject, "space.commerce.view", { spaceId: shop });

test("an App's Actions use offline access on another Space until it is revoked", async () => {
  assert.equal(await canRead(), false);
  const granted = await authorize({ scopes: ["space.commerce.view"], offline: true });
  assert.equal(granted.status, 200);
  const { grant } = await granted.json() as { grant: { id: string; offlineScopes: string[] } };
  assert.deepEqual(grant.offlineScopes, ["space.commerce.view"]);

  assert.equal(await canRead(), true);
  assert.deepEqual((await resolvePermissionAccess(action(), { spaceId: shop })).permissions, ["space.commerce.view"]);
  assert.equal(await hasPermission(action(), "space.edit", { spaceId: shop }), false);
  assert.equal(await canRead(action(home)), false, "another App");
  assert.equal(await canRead(action(appId, "cron")), false, "not an App Action");
  assert.equal(await canRead(action(appId, "app_action", shop)), false, "a Space Hook running the Action elsewhere");
  assert.equal(await hasPermission(action(), "space.commerce.view", { spaceId: shop }, { offlineAccess: false }), false, "cannot mint lasting credentials");

  assert.equal((await authorize({ scopes: ["space.view"], scopeMode: "extend" })).status, 200);
  assert.equal(await canRead(), true, "a later interactive consent keeps offline access");

  await client.exec(`UPDATE v2.space_members SET role = 'guest' WHERE space_id = '${shop}' AND user_id = 'owner'`);
  assert.equal(await canRead(), false, "capped by what the viewer can still do");
  await client.exec(`UPDATE v2.space_members SET role = 'host' WHERE space_id = '${shop}' AND user_id = 'owner'`);
  assert.equal(await canRead(), true);

  principal = { type: "user", user: { uuid: "owner" } };
  assert.equal((await api.request(`/apps/${appId}/grants/${grant.id}`, { method: "DELETE" })).status, 200);
  assert.equal(await canRead(), false);
});

test("offline access needs explicit consent for permissions the viewer holds", async () => {
  assert.equal((await authorize({ scopes: ["space.commerce.view"], offline: true, silent: true })).status, 403);
  principal = { type: "execution", execution: { type: "execution", spaceId: shop, source: "agent", actorUserId: "owner", viewerUserId: null, appId: null, appVersionId: null, action: null, taskRunId: null, sessionId: null, turnId: null, scopes: [], expiresAt: Date.now() + 10000 } } as unknown as RequestPrincipal;
  const delegated = await api.request(`/apps/${appId}/authorize`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spaceId: shop, scopes: ["space.commerce.view"], offline: true }),
  });
  assert.equal(delegated.status, 403, "a delegated execution cannot consent for its actor");
  assert.equal((await authorize({ scopes: ["space.commerce.view"], offline: true, consent: "host" })).status, 400);
  principal = { type: "user", user: { uuid: "stranger" } };
  const denied = await api.request(`/apps/${appId}/authorize`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spaceId: shop, scopes: ["space.commerce.view"], offline: true }),
  });
  assert.equal(denied.status, 403);
});

test("Space members see offline access and the granter or a host can end it", async () => {
  assert.equal((await authorize({ scopes: ["space.commerce.view"], offline: true })).status, 200);
  const as = (uuid: string) => { principal = { type: "user", user: { uuid } }; };
  as("stranger");
  assert.deepEqual(await (await api.request(`/spaces/${shop}/app-access`)).json(), { items: [] });
  as("owner");
  const { items } = await (await api.request(`/spaces/${shop}/app-access`)).json() as { items: Array<{ grantId: string; app: { id: string }; scopes: string[] }> };
  assert.deepEqual(items.map((item) => [item.app.id, item.scopes]), [[appId, ["space.commerce.view"]]]);
  const end = () => api.request(`/spaces/${shop}/app-access/${items[0]?.grantId}`, { method: "DELETE" });
  as("stranger");
  assert.equal((await end()).status, 403);
  as("owner");
  assert.equal((await end()).status, 204);
  assert.equal(await canRead(), false);
  assert.equal((await end()).status, 404);
});

test("an App published by a builder uses a host's offline access on its own Space", async () => {
  await client.exec(`INSERT INTO v2.space_members (space_id, user_id, role, created_by, updated_by) VALUES ('${shop}', 'builder', 'builder', 'owner', 'owner')`);
  const shopApp = await insert(`INSERT INTO v2.apps (space_id, user_uuid, slug, status, target_type, target_ref)
    VALUES ('${shop}', 'builder', 'shop-sync', 'published', 'directory', 'shop-sync') RETURNING id`);
  const run = () => action(shopApp, "app_action", shop, "builder");
  assert.equal(await canRead(run()), false);
  principal = { type: "user", user: { uuid: "owner" } };
  const granted = await api.request(`/apps/${shopApp}/authorize`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spaceId: shop, scopes: ["space.commerce.view"], offline: true }),
  });
  assert.equal(granted.status, 200);
  assert.equal(await canRead(run()), true);
});

test("member-only reads need one grant that covers them from a member", async () => {
  const report = await insert(`INSERT INTO v2.apps (space_id, user_uuid, slug, status, target_type, target_ref)
    VALUES ('${home}', 'publisher', 'report', 'published', 'directory', 'report') RETURNING id`);
  const grant = (scopes: string[]) => {
    principal = { type: "user", user: { uuid: "owner" } };
    return api.request(`/apps/${report}/authorize`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spaceId: shop, scopes, offline: true }),
    });
  };
  const listCheckpoints = () => hasMemberPermission(action(report), "checkpoint.view", shop);
  // The publisher already reads checkpoints as a signed-in guest, but is not a member.
  await client.exec(`INSERT INTO v2.access_policies (resource_type, resource_id, signed_in_user_role, created_by, updated_by) VALUES ('space', '${shop}', 'guest', 'owner', 'owner')`);
  assert.equal(await hasPermission(action(report), "checkpoint.view", { spaceId: shop }), true);
  assert.equal((await grant(["file.view"])).status, 200);
  assert.equal(await listCheckpoints(), false, "an unrelated grant does not unlock it");
  assert.equal((await grant(["checkpoint.view"])).status, 200);
  assert.equal(await listCheckpoints(), true);
});
