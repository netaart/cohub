import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyExecutionStats, type SessionStats } from "@cohub/protocol/model";
import { createHttpClient } from "../src/http.js";

const stats: SessionStats = { version: 1, revision: 1, updatedAt: "2026-09-30T00:00:00Z", own: emptyExecutionStats(), inherited: emptyExecutionStats(), auxiliaryUsage: null };
test("session stats uses one authorized summary request, not a turn traversal", async () => {
  const requests: string[] = [];
  const controller = new AbortController();
  const client = createHttpClient({ baseUrl: "https://api.example.test", fetch: async (url, init) => {
    requests.push(String(url));
    assert(init?.signal);
    return new Response(JSON.stringify({ stats }), { status: 200, headers: { "Content-Type": "application/json" } });
  } });
  assert.deepEqual(await client.space("space").session("session").stats({ signal: controller.signal }), { stats });
  assert.deepEqual(requests, ["https://api.example.test/api/sessions/session/stats"]);
});
