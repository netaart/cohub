import assert from "node:assert/strict";
import { test } from "node:test";
import { AppsApi, CohubClient } from "@neta-art/cohub";
import type { AppRecord, AppVersionRecord } from "@neta-art/cohub";
import type { HttpTransport } from "../src/transport.js";

test("AppsApi.getStats requests the fixed analytics range", async () => {
  const transport = {
    request: async (path: string) => {
      assert.equal(path, "/api/apps/work-1/stats");
      return {};
    },
  } as unknown as HttpTransport;

  await new AppsApi(transport).getStats("work-1");
});

test("AppsApi creates and records Work promotions", async () => {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const transport = {
    request: async (path: string, init?: RequestInit) => {
      requests.push({ path, init });
      return {};
    },
  } as unknown as HttpTransport;
  const api = new AppsApi(transport);

  await api.createPromotion("work-1", {
    name: "Launch",
    provider: "generic",
    parameters: { utm_source: "newsletter" },
  });
  await api.recordPromotionEvent("work-1", "promotion-1", {
    eventKey: "ready",
    eventId: "event-1",
  });
  await api.recordPromotionRegistration("work-1", "promotion-1", {
    fbp: "fbp-1",
  });

  assert.equal(requests[0]?.path, "/api/apps/work-1/promotions");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal(requests[1]?.path, "/api/apps/work-1/promotions/promotion-1/events");
  assert.equal(requests[1]?.init?.method, "POST");
  assert.equal(requests[2]?.path, "/api/apps/work-1/promotions/promotion-1/registration");
  assert.equal(requests[2]?.init?.method, "POST");
});

test("AppsApi authorize and grants hit the app-scoped paths", async () => {
	const requests: Array<{ path: string; init?: RequestInit }> = [];
	const transport = {
		request: async (path: string, init?: RequestInit) => {
			requests.push({ path, init });
			return {};
		},
	} as unknown as HttpTransport;
	const api = new AppsApi(transport);

	await api.authorize("app-1", { scopes: ["file.view"], spaceId: "space-2" });
	await api.listMyGrants("app-1");
	await api.revokeMyGrant("app-1", "grant-1");

	assert.deepEqual(
		requests.map((entry) => `${entry.init?.method ?? "GET"} ${entry.path}`),
		[
			"POST /api/apps/app-1/authorize",
			"GET /api/apps/app-1/grants",
			"DELETE /api/apps/app-1/grants/grant-1",
		],
	);
	assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
		scopes: ["file.view"],
		spaceId: "space-2",
	});
});

test("AppsApi.runAction posts structured input to the app action route", async () => {
  const transport = {
    request: async (path: string, init?: RequestInit) => {
      assert.equal(path, "/api/apps/app-1/actions/summarize/run");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { input: { text: "Hello" } });
      return { taskRunId: "task-1", action: "summarize", status: "pending" };
    },
  } as unknown as HttpTransport;

  await new AppsApi(transport).runAction("app-1", "summarize", { text: "Hello" });
});

test("CohubClient reuses App Action execution identity and context", async () => {
  const previous = process.env.COHUB_EXECUTION_TOKEN;
  const payload = Buffer.from(JSON.stringify({ appId: "app-1" })).toString("base64url");
  process.env.COHUB_EXECUTION_TOKEN = `header.${payload}.signature`;
  try {
    const client = new CohubClient({
      fetch: async (request, init) => {
        assert.equal(String(request), "https://api.cohub.live/api/apps/app-1/commerce/entitlements");
        assert.equal(new Headers(init?.headers).get("authorization"), `Bearer header.${payload}.signature`);
        return new Response(JSON.stringify({ entitlements: [], credits: { available: 0, net: 0 }, businessKey: "business-1" }), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    await client.app.commerce.getEntitlements();
  } finally {
    if (previous === undefined) delete process.env.COHUB_EXECUTION_TOKEN;
    else process.env.COHUB_EXECUTION_TOKEN = previous;
  }
});

test("AppsApi.getBySlug forwards the abort signal", async () => {
  const controller = new AbortController();
  const transport = {
    request: async (path: string, init?: RequestInit) => {
      assert.equal(path, "/api/apps/by-slug/alice/studio/launch");
      assert.equal(init?.signal, controller.signal);
      return {};
    },
  } as unknown as HttpTransport;

  await new AppsApi(transport).getBySlug("alice", "studio", "launch", {
    signal: controller.signal,
  });
});

test("apps REST wire uses the canonical app vocabulary", () => {
	// `/api/apps` responses speak the canonical vocabulary (`appScopes`,
	// `appId`); the server serves the work-era field names only at the legacy
	// `/api/works` mount for older consumers.
	const record: AppRecord = {
		id: "app-1",
		spaceId: "space-1",
		userUuid: "user-1",
		slug: "launch",
		status: "published",
		visibility: "public",
		targetType: "directory",
		targetRef: "dist",
		assetKey: "w/space-1/launch/abc/index.html",
		currentVersionId: "v-1",
		latestVersion: 1,
		publishedAt: null,
		appScopes: ["space.view"],
		allowedViewerScopes: [],
		meta: null,
		createdAt: null,
		updatedAt: null,
	};
	assert.deepEqual(Object.keys(record).sort(), [
		"allowedViewerScopes",
		"appScopes",
		"assetKey",
		"createdAt",
		"currentVersionId",
		"id",
		"latestVersion",
		"meta",
		"publishedAt",
		"slug",
		"spaceId",
		"status",
		"targetRef",
		"targetType",
		"updatedAt",
		"userUuid",
		"visibility",
	]);

	const version: AppVersionRecord = {
		id: "v-1",
		appId: "app-1",
		version: 1,
		targetType: "directory",
		targetRef: "dist",
		assetKey: null,
		contentKind: "web",
		artifact: null,
		meta: null,
		createdAt: null,
	};
	assert.ok("appId" in version, "version records use appId");
});

test("client.apps and client.works point at the same API instance", () => {
	const client = new CohubClient({ getAccessToken: async () => null });
	assert.equal(client.apps, client.works);
	assert.equal(client.desktop, client.ui);
	assert.equal(client.appCommerce, client.workCommerce);
});

test("apps REST request paths use the canonical /api/apps mount", async () => {
  const requests: string[] = [];
  const transport = {
    request: async (path: string, init?: RequestInit) => {
      requests.push(`${(init as { method?: string })?.method ?? "GET"} ${path}`);
      return {};
    },
  } as unknown as HttpTransport;
  const api = new AppsApi(transport);
  const id = "123e4567-e89b-42d3-a456-426614174000";

  await api.listBySpace("space-1");
  await api.get(id);
  await api.getPublicById(id);
  await api.getBySlug("alice", "studio", "launch");
  await api.create({ spaceId: "space-1", slug: "launch" });
  await api.update(id, { slug: "launch-2" });
  await api.delete(id);
  await api.listVersions(id);
  await api.publishVersion(id);
  await api.createSession(id);

  assert.deepEqual(requests, [
    "GET /api/apps/space/space-1",
    `GET /api/apps/${id}`,
    `GET /api/apps/${id}/public`,
    "GET /api/apps/by-slug/alice/studio/launch",
    "POST /api/apps",
    `PATCH /api/apps/${id}`,
    `DELETE /api/apps/${id}`,
    `GET /api/apps/${id}/versions`,
    `POST /api/apps/${id}/versions`,
    `POST /api/apps/${id}/session`,
  ]);
});

test("AppsApi.authorize only reports offline access the API confirmed", async () => {
  let offlineScopes: string[] | undefined;
  const transport = {
    request: async () => ({ token: "t", expiresIn: 60, grant: { id: "g", spaceId: "s", scopes: ["file.view"], expiresAt: "", ...(offlineScopes ? { offlineScopes } : {}) } }),
  } as unknown as HttpTransport;
  const api = new AppsApi(transport);
  await assert.rejects(api.authorize("app", { scopes: ["file.view"], spaceId: "s", offline: true }), /Offline access was not granted/);
  assert.equal((await api.authorize("app", { scopes: ["file.view"], spaceId: "s" })).grant.offlineScopes, undefined);
  offlineScopes = ["file.view"];
  assert.equal((await api.authorize("app", { scopes: ["file.view.filtered"], spaceId: "s", offline: true })).grant.id, "g", "implied scopes count");
});
