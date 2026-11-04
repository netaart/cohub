import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseGenerationBillingConfig,
  resolveGenerationBillingReserve,
} from "./generation-billing.js";

test("generation billing config parses reserve caps and rejects invalid values", () => {
  const config = parseGenerationBillingConfig(`
schema: cohub.generation.billing.v1
models:
  seedance-2-0:
    reserveUsd: 12.5
  seedance-2-5:
    reserveUsd: 20
`);
  assert.equal(resolveGenerationBillingReserve(config, "seedance-2-0"), 12.5);
  assert.equal(resolveGenerationBillingReserve(config, "seedance-2-5"), 20);
  assert.equal(resolveGenerationBillingReserve(config, "other"), null);
  assert.throws(() => parseGenerationBillingConfig("models: { seedance: { reserveUsd: 0 } }"));
  assert.throws(() => parseGenerationBillingConfig("models: { seedance: { reserveUsd: 'x' } }"));
  assert.equal(parseGenerationBillingConfig("models: {}").reserves.size, 0);
});
