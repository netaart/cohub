import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCachedModelsConfig,
  isModelDefinition,
  mergeModelsConfigs,
  normalizeModelCost,
  parseCachedModelsConfig,
  parseModelsConfig,
  type ModelCost,
} from "./models.js";

const cost: ModelCost = {
  input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10,
  tiers: [{ inputTokensAbove: 272_000, input: 16, output: 60, cacheRead: 0.8, cacheWrite: 20 }],
};
const model = { id: "gpt-6.2-astra", cost, promptCache: { short: 1800 } };
const platform = { providers: { cohub: { models: [model] } } };

test("official GPT-6.2 price tiers survive catalog parsing, caching and normalization", () => {
  const parsed = parseModelsConfig(JSON.stringify(platform));
  const cached = parseCachedModelsConfig(JSON.stringify(createCachedModelsConfig({ content: parsed })));
  assert.deepEqual(cached?.content, platform);
  assert.deepEqual(normalizeModelCost(parsed.providers.cohub?.models?.[0]?.cost), cost);
  assert.deepEqual(normalizeModelCost({ input: 2, output: 10 }), { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 });
});

test("price tiers require complete finite rates and distinct nonnegative integer thresholds", () => {
  const tier = cost.tiers?.[0];
  assert.ok(tier);
  for (const tiers of [
    null, {}, [null], [{ ...tier, inputTokensAbove: -1 }], [{ ...tier, inputTokensAbove: 0.5 }],
    [{ ...tier, inputTokensAbove: Number.MAX_SAFE_INTEGER + 1 }], [{ ...tier, input: -1 }],
    [{ ...tier, output: Number.NaN }], [{ ...tier, cacheRead: undefined }],
    [{ ...tier, cacheWrite: Number.POSITIVE_INFINITY }], [{ ...tier, unknown: 1 }], [tier, tier],
  ]) {
    assert.equal(isModelDefinition({ ...model, cost: { ...cost, tiers } }), false);
  }
  assert.equal(isModelDefinition({ ...model, cost: { ...cost, tiers: [] } }), true);
  assert.equal(isModelDefinition({ id: model.id, cost: { tiers: [tier] } }, { partial: true }), true);
});

test("user model overrides cannot replace platform price tiers", () => {
  const user = { providers: { cohub: { models: [{ id: model.id, cost: { ...cost, tiers: [] } }] } } };
  assert.deepEqual(mergeModelsConfigs(platform, user).providers.cohub?.models?.[0]?.cost, cost);
});
