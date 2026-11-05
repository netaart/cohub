import assert from "node:assert/strict";
import { test } from "node:test";
import { planGenerationSettlement } from "./index.js";

test("generation settlement plans refunds and additional charges", () => {
  assert.deepEqual(planGenerationSettlement(10, 6), { refundUsd: 4, extraUsd: 0 });
  assert.deepEqual(planGenerationSettlement(10, 10), { refundUsd: 0, extraUsd: 0 });
  assert.deepEqual(planGenerationSettlement(10, 12.5), { refundUsd: 0, extraUsd: 2.5 });
  assert.deepEqual(planGenerationSettlement(10, 0), { refundUsd: 10, extraUsd: 0 });
});
