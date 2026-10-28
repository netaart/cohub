import assert from "node:assert/strict";
import test from "node:test";
import { createHttpClient } from "../src/http.js";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

test("referrals API uses the public and account endpoints", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const client = createHttpClient({
    baseUrl: "https://api.example.test",
    fetch: async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? "GET" });
      return jsonResponse({ code: "abc_DEF123" });
    },
  });

  await client.referrals.get("abc_DEF123");
  await client.referrals.claim("abc_DEF123");
  await client.referrals.getMine();
  await client.referrals.rotateCode();

  assert.deepEqual(requests, [
    { url: "https://api.example.test/api/referrals/abc_DEF123", method: "GET" },
    { url: "https://api.example.test/api/referrals/abc_DEF123/claim", method: "POST" },
    { url: "https://api.example.test/api/me/referrals", method: "GET" },
    { url: "https://api.example.test/api/me/referrals/code/rotate", method: "POST" },
  ]);
});
