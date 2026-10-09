import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateCost, type Usage } from "@earendil-works/pi-ai";
import { resolveRuntimeModelsConfig, type ModelsConfig } from "@cohub/infra/config-runtime/models";
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
    assert.equal(selected.contextWindow, 200000);
    assert.equal(selected.baseUrl, "https://platform.example.test/v1");
    assert.equal(registry.getApiKey("cohub"), "platform-key");
    const billableUsage = usage();
    calculateCost(selected, billableUsage);
    assert.ok(Math.abs(billableUsage.cost.total - 0.018) < 1e-12);
    assert.ok(billableUsage.cost.total > 0);
  }
});

test("user zero prices are rejected before a platform completion model is constructed", () => {
  const user = { providers: { cohub: { models: [{
    id: "chat", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }] } } };
  assert.throws(() => new CompletionModelRegistry([resolveRuntimeModelsConfig({ platform, user })]), {
    message: "User model cohub/chat cannot override platform model pricing: cost",
  });
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
