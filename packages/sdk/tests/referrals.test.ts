import assert from "node:assert/strict";
import test from "node:test";
import { createHttpClient } from "../src/http.js";
import type { ReferralDashboard } from "../src/types.js";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

test("referrals API uses the public and account endpoints", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const claimedAt = "2026-10-28T00:00:00.000Z";
  const expiresAt = "2026-10-31T00:00:00.000Z";
  const dashboard: ReferralDashboard = {
    code: "abc_DEF123",
    reward: { inviterUsd: 5, inviteeUsd: 5 },
    received: {
      id: "received-referral",
      status: "qualified",
      claimedAt,
      expiresAt,
      qualifiedAt: claimedAt,
      inviteeRewardedAt: claimedAt,
    },
    quota: {
      limit: 5,
      cycleDays: 30,
      claimHours: 72,
      used: 0,
      reserved: 1,
      available: 4,
      cycleStartsAt: null,
      cycleEndsAt: null,
    },
    summary: { total: 1, pending: 1, qualified: 0, rewarded: 0, earnedUsd: 0 },
    items: [{
      id: "sent-referral",
      status: "pending",
      inCurrentCycle: true,
      claimedAt,
      expiresAt,
      qualifiedAt: null,
      rewardedAt: null,
      profile: null,
    }],
  };
  const client = createHttpClient({
    baseUrl: "https://api.example.test",
    fetch: async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? "GET" });
      return jsonResponse(String(input).endsWith("/api/me/referrals") ? dashboard : { code: "abc_DEF123" });
    },
  });

  await client.referrals.get("abc_DEF123");
  await client.referrals.claim("abc_DEF123");
  assert.deepEqual(await client.referrals.getMine(), dashboard);
  await client.referrals.rotateCode();

  assert.deepEqual(requests, [
    { url: "https://api.example.test/api/referrals/abc_DEF123", method: "GET" },
    { url: "https://api.example.test/api/referrals/abc_DEF123/claim", method: "POST" },
    { url: "https://api.example.test/api/me/referrals", method: "GET" },
    { url: "https://api.example.test/api/me/referrals/code/rotate", method: "POST" },
  ]);
});
