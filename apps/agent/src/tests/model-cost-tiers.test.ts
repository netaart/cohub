import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateCost, type Api, type Model, type ModelCostRates, type Usage } from "@earendil-works/pi-ai";
import { resolveModelTasksConfig } from "@cohub/infra/config-runtime/model-tasks";
import { parseModelsConfig, type ModelDef } from "@cohub/infra/config-runtime/models";
import { createModelsFromRegistry } from "../runtime/pi-models-adapter.js";
import { CohubModelRegistry } from "../runtime/model-registry.js";
import { toTaskRuntimeModel } from "../runtime/task-model.js";

const definitions = [
  {
    id: "gpt-6.2-astra", promptCache: { short: 1800 },
    cost: { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10,
      tiers: [{ inputTokensAbove: 272_000, input: 16, output: 60, cacheRead: 0.8, cacheWrite: 20 }] },
  },
  {
    id: "gpt-6.2-sol", promptCache: { short: 1800 },
    cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5,
      tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] },
  },
] satisfies ModelDef[];
const platform = parseModelsConfig(JSON.stringify({ providers: { cohub: {
  api: "openai-responses", baseUrl: "https://api.openai.com/v1", models: definitions,
} } }));

function assertUsagePrice(model: Model<Api>, totalInput: number, rates: ModelCostRates) {
  const usage: Usage = {
    input: totalInput - 70_000, output: 1_000, cacheRead: 50_000, cacheWrite: 20_000,
    totalTokens: totalInput + 1_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  assert.ok(Math.abs(usage.cost.input - rates.input / 1_000_000 * usage.input) < 1e-12);
  assert.ok(Math.abs(usage.cost.output - rates.output / 1_000_000 * usage.output) < 1e-12);
  assert.ok(Math.abs(usage.cost.cacheRead - rates.cacheRead / 1_000_000 * usage.cacheRead) < 1e-12);
  assert.ok(Math.abs(usage.cost.cacheWrite - rates.cacheWrite * usage.cacheWrite / 1_000_000) < 1e-12);
}

for (const definition of definitions) {
  test(`${definition.id}: session and task models charge official rates across the inclusive 272K boundary`, () => {
    const registry = new CohubModelRegistry({ configs: [platform] });
    const sessionModel = registry.find("cohub", definition.id);
    const task = resolveModelTasksConfig({
      platformModels: platform,
      platformTasks: { contextCompaction: { model: { provider: "cohub", id: definition.id } } },
    }).contextCompaction;
    const standard = definition.cost;
    const longContext = standard.tiers[0];
    assert.ok(sessionModel && task && longContext);
    const taskModel = toTaskRuntimeModel(task, { input: ["text"], contextWindow: 1_050_000, maxTokens: 128_000 });
    for (const model of [sessionModel, taskModel]) {
      assert.deepEqual(model.cost, definition.cost);
      assert.deepEqual(model.promptCache, definition.promptCache);
      assertUsagePrice(model, 271_999, standard);
      assertUsagePrice(model, 272_000, standard);
      assertUsagePrice(model, 272_001, longContext);
    }
  });
}

test("model collections refresh when pricing or prompt cache lifetimes change", () => {
  const config = structuredClone(platform);
  const registry = new CohubModelRegistry({ configs: [config] });
  const original = createModelsFromRegistry(registry);
  assert.equal(createModelsFromRegistry(registry), original);
  const definition = config.providers.cohub?.models?.[0];
  assert.ok(definition?.cost?.tiers?.[0]);
  definition.cost.tiers[0].input = 17;
  registry.refresh();
  const repriced = createModelsFromRegistry(registry);
  assert.notEqual(repriced, original);
  definition.promptCache = { short: 1800, long: 43200 };
  registry.refresh();
  assert.notEqual(createModelsFromRegistry(registry), repriced);
});
