import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyExecutionStats, readSessionStats, sanitizeSessionStatsMeta } from "./src/model/metrics.js";

test("legacy costs stay readable without leaking charges or mutating source data", () => {
  const { modelCostUsd: _model, generationCostUsd: _generation, ...old } = emptyExecutionStats();
  const meta = { stats: {
    version: 1, revision: 1, updatedAt: "2026-10-01T00:00:00Z", auxiliaryUsage: null,
    own: { ...old, estimatedCostUsd: 0.75, providerCostUsd: 1, chargedCostUsd: 0.25 },
    inherited: { ...old, estimatedCostUsd: null, providerCostUsd: null, chargedCostUsd: 0.125 },
  } };
  const before = structuredClone(meta);
  const parsed = readSessionStats(meta);
  assert.equal(parsed?.own.modelCostUsd, 0.75);
  assert.equal(parsed?.own.generationCostUsd, 1);
  assert.equal(parsed?.own.chargedCostUsd, null);
  assert.equal(sanitizeSessionStatsMeta(meta).stats.inherited.chargedCostUsd, null);
  assert.deepEqual(meta, before);
});
