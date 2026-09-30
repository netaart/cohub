import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context, Hono } from "hono";
import type { AuthUser } from "../lib/middleware.js";
import { createPushTargetsRouter } from "./push-targets-router.js";

type Target = { userUuid: string; token: string; environment: string; topic: string };

const TOKEN = "AB".repeat(32);

/** In-memory stand-in for user_push_targets with the same upsert/delete semantics. */
const createApp = (options: { topics?: readonly string[] | null; user?: string | null } = {}) => {
  const targets = new Map<string, Target>();
  const router = createPushTargetsRouter({
    getUser: (c: Context) => {
      const uuid = c.req.header("x-test-user") ?? options.user ?? null;
      return uuid ? ({ uuid } as AuthUser) : c.json({ message: "unauthorized" }, 401);
    },
    apnsTopics: () => (options.topics === undefined ? ["com.example.app"] : options.topics),
    upsertPushTarget: async (input) => {
      targets.set(input.token, { ...input });
    },
    deleteUserPushTarget: async ({ userUuid, token }) => {
      if (targets.get(token)?.userUuid === userUuid) targets.delete(token);
    },
  });
  return { router, targets };
};

const put = (router: Hono, token: string, body: unknown, user = "user-1") =>
  router.request(`/push-targets/${token}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-test-user": user },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const del = (router: Hono, token: string, user = "user-1") =>
  router.request(`/push-targets/${token}`, { method: "DELETE", headers: { "x-test-user": user } });

const validBody = { environment: "sandbox", topic: "com.example.app" };

describe("PUT /push-targets/:token", () => {
  it("registers a lowercase token for the current user", async () => {
    const { router, targets } = createApp();
    const response = await put(router, TOKEN, validBody);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual([...targets.values()], [{
      userUuid: "user-1",
      token: TOKEN.toLowerCase(),
      environment: "sandbox",
      topic: "com.example.app",
    }]);
  });

  it("moves a token registered by another user", async () => {
    const { router, targets } = createApp();
    await put(router, TOKEN, validBody, "user-1");
    await put(router, TOKEN, { ...validBody, environment: "production" }, "user-2");
    assert.equal(targets.size, 1);
    assert.equal(targets.get(TOKEN.toLowerCase())?.userUuid, "user-2");
    assert.equal(targets.get(TOKEN.toLowerCase())?.environment, "production");
  });

  for (const [label, token] of [
    ["non-hex", `${"a".repeat(62)}zz`],
    ["too short", "a".repeat(31)],
    ["too long", "a".repeat(201)],
  ] as const) {
    it(`rejects a ${label} token`, async () => {
      const { router, targets } = createApp();
      const response = await put(router, token, validBody);
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { code: string }).code, "invalid_push_token");
      assert.equal(targets.size, 0);
    });
  }

  it("accepts the 32 and 200 character bounds", async () => {
    const { router } = createApp();
    assert.equal((await put(router, "a".repeat(32), validBody)).status, 200);
    assert.equal((await put(router, "a".repeat(200), validBody)).status, 200);
  });

  for (const [label, body] of [
    ["invalid JSON", "{"],
    ["an unknown environment", { environment: "staging", topic: "com.example.app" }],
    ["a missing topic", { environment: "sandbox" }],
  ] as const) {
    it(`rejects ${label}`, async () => {
      const { router } = createApp();
      const response = await put(router, TOKEN, body);
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { code: string }).code, "invalid_push_target");
    });
  }

  it("rejects topics outside APNS_TOPICS", async () => {
    const { router, targets } = createApp();
    const response = await put(router, TOKEN, { environment: "sandbox", topic: "com.evil.app" });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { code: string }).code, "push_topic_not_allowed");
    assert.equal(targets.size, 0);
  });

  it("answers 503 when APNs is not configured", async () => {
    const { router } = createApp({ topics: null });
    const response = await put(router, TOKEN, validBody);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { message: "push notifications are not configured", code: "push_unavailable" });
  });

  it("requires a signed-in user", async () => {
    const { router } = createApp();
    const response = await router.request(`/push-targets/${TOKEN}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    assert.equal(response.status, 401);
  });
});

describe("DELETE /push-targets/:token", () => {
  it("removes the current user's target", async () => {
    const { router, targets } = createApp();
    await put(router, TOKEN, validBody);
    const response = await del(router, TOKEN.toLowerCase());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(targets.size, 0);
  });

  it("leaves another user's target alone but still answers ok", async () => {
    const { router, targets } = createApp();
    await put(router, TOKEN, validBody, "user-1");
    const response = await del(router, TOKEN, "user-2");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(targets.get(TOKEN.toLowerCase())?.userUuid, "user-1");
  });

  it("answers ok for unknown tokens", async () => {
    const { router } = createApp();
    assert.equal((await del(router, TOKEN)).status, 200);
  });

  it("validates the token and answers 503 when unconfigured", async () => {
    assert.equal((await del(createApp().router, "xyz")).status, 400);
    assert.equal((await del(createApp({ topics: null }).router, TOKEN)).status, 503);
  });
});
