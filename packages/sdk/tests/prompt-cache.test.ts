import assert from "node:assert/strict";
import { test } from "node:test";
import { type ColdResendTurn, estimateColdResend } from "../src/index.js";

test("cold resend honors the USD threshold without treating cumulative usage as context", () => {
  const cached: ColdResendTurn = {
    id: "cached",
    sequence: 1,
    status: "completed",
    completedAt: "2026-11-20T00:00:00Z",
    provider: "cohub",
    model: "example",
    finalUsage: { input: 100_000 },
  };
  const selected = {
    provider: "cohub",
    id: "example",
    model: { cost: { cacheWrite: 5 }, promptCache: { short: 300 } },
  };
  const options = { minCostUsd: 0.5 };
  assert.equal(estimateColdResend([cached], selected), null);
  assert.equal(estimateColdResend([cached], selected, options)?.costUsd, 0.5);

  const failed: ColdResendTurn = { ...cached, id: "failed", sequence: 2, status: "failed" };
  assert.equal(estimateColdResend([cached, failed, { ...failed, finalUsageIsTotal: true }], selected, options), null);
});
