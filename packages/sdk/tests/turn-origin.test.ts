import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpClient } from "../src/http.js";
import { readSessionTurnOrigin, type ReferenceKind } from "../src/index.js";

const caller = {
  spaceId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  turnId: "33333333-3333-4333-8333-333333333333",
  toolCallId: "call_review_1",
};

test("prompt target never replaces caller provenance, including cross-space review loops", async () => {
  const requests: Array<{ path: string; headers: Headers; body: Record<string, unknown> }> = [];
  const client = createHttpClient({
    baseUrl: "https://api.example.test",
    requestSource: caller,
    fetch: async (url, init) => {
      requests.push({ path: new URL(String(url)).pathname, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ mode: "immediate", session: { id: "review-session" }, turn: { meta: { origin: { ...caller, kind: "prompt", depth: 1 } } } }), { status: 200 });
    },
  });
  for (const space of [caller.spaceId, "44444444-4444-4444-8444-444444444444"]) {
    for (const sessionId of [undefined, "review-session", caller.sessionId]) {
      const result = await client.space(space).prompt({ sessionId, content: [{ type: "text", text: "Review changes" }] });
      assert.equal(result.mode, "immediate");
      if (result.mode !== "immediate") throw new Error("Expected an immediate prompt");
      assert.equal(readSessionTurnOrigin(result.turn.meta)?.turnId, caller.turnId);
    }
  }
  assert.equal(requests.length, 6);
  for (const { headers } of requests) {
    assert.equal(headers.get("X-Cohub-Source-Space"), caller.spaceId);
    assert.equal(headers.get("X-Cohub-Source-Session"), caller.sessionId);
    assert.equal(headers.get("X-Cohub-Source-Turn"), caller.turnId);
    assert.equal(headers.get("X-Cohub-Source-Tool-Call"), caller.toolCallId);
  }
  assert.equal(requests[4]?.body.sessionId, "review-session");
  assert.match(requests[4]?.path ?? "", /44444444-4444-4444-8444-444444444444\/prompt$/);
});

test("reference queries expose causal edges through the existing API", async () => {
  let requested = "";
  const client = createHttpClient({ baseUrl: "https://api.example.test", fetch: async (url) => {
    requested = String(url);
    return new Response(JSON.stringify({ references: [] }), { status: 200 });
  } });
  const kind: ReferenceKind = "turn_trigger";
  await client.references.query({ source: `turn:${caller.turnId}`, kinds: [kind], direction: "out" });
  const query = new URL(requested).searchParams;
  assert.equal(query.get("kinds"), "turn_trigger");
  assert.equal(query.get("source"), `turn:${caller.turnId}`);
  assert.equal(query.get("direction"), "out");
});
