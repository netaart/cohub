import assert from "node:assert/strict";
import { test } from "node:test";
import { CohubHttpClient } from "../src/http.js";

test("Runtime status carries component availability and accepts cancellation", async () => {
  const controller = new AbortController();
  const expected = { kind: "local", online: true, runtimeId: crypto.randomUUID(), capabilities: null, fileWatcher: null, workspace: { online: false, observedAt: null }, observedAt: new Date().toISOString() };
  const client = new CohubHttpClient({ baseUrl: "https://api.example.test", fetch: async (url, init) => {
    assert.equal(String(url), "https://api.example.test/api/spaces/space/runtime");
    assert(init?.signal);
    return new Response(JSON.stringify(expected), { headers: { "Content-Type": "application/json" } });
  } });
  assert.deepEqual(await client.space("space").getRuntime(undefined, { signal: controller.signal }), expected);
});
