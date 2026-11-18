import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateCost, type Usage } from "@earendil-works/pi-ai";
import { parseModelsConfig, resolveRuntimeModelsConfig, type ModelsConfig } from "@cohub/infra/config-runtime/models";
import { CompletionModelRegistry } from "./completion-registry.js";

const prices = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const platform: ModelsConfig = { providers: { cohub: {
  api: "openai-responses", baseUrl: "https://platform.example.test/v1", apiKey: "platform-key",
  models: [{ id: "chat", contextWindow: 100000, cost: prices }],
} } };

function usage(): Usage {
  return {
    input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 2000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

test("Pi SDK calculates the platform price after allowed user overrides and matching price declarations", () => {
  for (const model of [
    { id: "chat", contextWindow: 200000 },
    { id: "chat", contextWindow: 200000, cost: { ...prices } },
  ]) {
    const user = { providers: { cohub: { models: [model] } } };
    const registry = new CompletionModelRegistry([resolveRuntimeModelsConfig({ platform, user })]);
    const selected = registry.find("cohub", "chat");
    assert.ok(selected);
    assert.equal(selected.contextWindow, 100000);
    assert.equal(selected.baseUrl, "https://platform.example.test/v1");
    assert.equal(registry.getApiKey("cohub"), "platform-key");
    const billableUsage = usage();
    calculateCost(selected, billableUsage);
    assert.ok(Math.abs(billableUsage.cost.total - 0.018) < 1e-12);
    assert.ok(billableUsage.cost.total > 0);
  }
});

test("Pi SDK charges platform prices when a user catalog supplies zero prices", () => {
  const user = { providers: { cohub: { models: [{
    id: "chat", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }] } } };
  const registry = new CompletionModelRegistry([resolveRuntimeModelsConfig({ platform, user })]);
  const selected = registry.find("cohub", "chat");
  assert.ok(selected);
  assert.ok(Math.abs(calculateCost(selected, usage()).total - 0.018) < 1e-12);
  assert.equal(registry.getApiKey("cohub"), "platform-key");
});

test("Pi SDK uses configured prices for a user-owned connection", () => {
  const user: ModelsConfig = { providers: { custom: {
    api: "openai-responses", baseUrl: "https://user.example.test/v1", apiKey: "user-key",
    models: [{ id: "chat", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
  } } };
  const registry = new CompletionModelRegistry([resolveRuntimeModelsConfig({ platform, user })]);
  const selected = registry.find("custom", "chat");
  assert.ok(selected);
  assert.equal(registry.getApiKey("custom"), "user-key");
  assert.equal(calculateCost(selected, usage()).total, 0.003);
});

for (const [id, input, output, cacheRead, cacheWrite] of [
  ["gpt-6.2-astra", 8, 40, 0.4, 10],
  ["gpt-6.2-sol", 2, 10, 0.1, 2.5],
] as const) {
  test(`${id}: completion registry preserves official long-context prices and cache lifetime`, () => {
    const cost = {
      input, output, cacheRead, cacheWrite,
      tiers: [{ inputTokensAbove: 272_000, input: input * 2, output: output * 1.5, cacheRead: cacheRead * 2, cacheWrite: cacheWrite * 2 }],
    };
    const config = parseModelsConfig(JSON.stringify({ providers: { cohub: {
      api: "openai-responses", baseUrl: "https://api.openai.com/v1",
      models: [{ id, cost, promptCache: { short: 1800 } }],
    } } }));
    const selected = new CompletionModelRegistry([config]).find("cohub", id);
    assert.ok(selected);
    assert.deepEqual(selected.cost, cost);
    assert.deepEqual(selected.promptCache, { short: 1800 });
    for (const inputTokens of [272_000, 272_001]) {
      const billable = { ...usage(), input: inputTokens - 2000, cacheRead: 1000, cacheWrite: 1000 };
      calculateCost(selected, billable);
      const rates = inputTokens > 272_000 ? cost.tiers[0] : cost;
      assert.ok(rates);
      const expected = (billable.input * rates.input + billable.output * rates.output
        + billable.cacheRead * rates.cacheRead + billable.cacheWrite * rates.cacheWrite) / 1_000_000;
      assert.ok(Math.abs(billable.cost.total - expected) < 1e-12);
    }
  });
}
