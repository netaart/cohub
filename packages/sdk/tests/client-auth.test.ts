import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { CohubClient } from "../src/client.js";
import { ParentBridgeTransport } from "../src/app-runtime.js";

let executionToken: string | undefined;
beforeEach(() => {
  executionToken = process.env.COHUB_EXECUTION_TOKEN;
  delete process.env.COHUB_EXECUTION_TOKEN;
});
afterEach(() => {
  if (executionToken === undefined) delete process.env.COHUB_EXECUTION_TOKEN;
  else process.env.COHUB_EXECUTION_TOKEN = executionToken;
});

test("public token access shares authorization and refresh state with HTTP requests", async (t) => {
  const tokenRequests: boolean[] = [];
  const headers: Array<string | null> = [];
  t.mock.method(ParentBridgeTransport.prototype, "request", async (message: Record<string, unknown>) => {
    if (message.type === "cohub.app.context") {
      return { context: { capabilities: { authorization: 2, serverGrants: true } } };
    }
    if (message.type === "cohub.app.authorize.v2") {
      return {
        token: "authorized-token",
        result: {
          status: "granted",
          requestedTarget: { kind: "account" },
          target: { kind: "account" },
          resolution: "requested",
          grant: { id: "grant", spaceId: "home", scopes: ["user.space.list"], expiresAt: null },
        },
      };
    }
    assert.equal(message.type, "cohub.app.token");
    tokenRequests.push(Boolean(message.forceRefresh));
    return { token: "refreshed-token" };
  });
  const client = new CohubClient({
    app: { mode: "bridge" },
    fetch: async (_input, init) => {
      headers.push(new Headers(init?.headers).get("Authorization"));
      return Response.json({ uuid: "viewer" });
    },
  });
  t.after(() => client.dispose());

  await client.auth.authorize({ target: { kind: "account" }, scopes: ["user.space.list"] });
  assert.equal(await client.auth.getAccessToken(), "authorized-token");
  await client.user.getMe();
  assert.deepEqual(tokenRequests, []);

  assert.equal(await client.auth.getAccessToken({ forceRefresh: true }), "refreshed-token");
  await client.user.getMe();
  assert.deepEqual(tokenRequests, [true]);
  assert.deepEqual(headers, ["Bearer authorized-token", "Bearer refreshed-token"]);
});

test("public token access uses the configured provider and HTTP credential sanitization", async (t) => {
  const calls: Array<{ forceRefresh?: boolean } | undefined> = [];
  const client = new CohubClient({
    getAccessToken: (options) => {
      calls.push(options);
      return options?.forceRefresh ? " refreshed\r\n-token " : " current-token ";
    },
  });
  t.after(() => client.dispose());
  assert.equal(await client.auth.getAccessToken(), "current-token");
  assert.equal(await client.auth.getAccessToken({ forceRefresh: true }), "refreshed-token");
  assert.deepEqual(calls, [undefined, { forceRefresh: true }]);
});

test("public token access preserves anonymous results and provider errors", async (t) => {
  const failure = new Error("Credential provider unavailable");
  const client = new CohubClient({
    getAccessToken: async (options) => {
      if (options?.forceRefresh) throw failure;
      return null;
    },
  });
  t.after(() => client.dispose());
  assert.equal(await client.auth.getAccessToken(), null);
  await assert.rejects(client.auth.getAccessToken({ forceRefresh: true }), failure);
});

test("public token access follows the existing execution-token fallback", async (t) => {
  process.env.COHUB_EXECUTION_TOKEN = "execution-token";
  const client = new CohubClient();
  t.after(() => client.dispose());
  assert.equal(await client.auth.getAccessToken(), "execution-token");
});
