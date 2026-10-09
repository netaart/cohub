import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRuntimeModelsConfig, type ModelsConfig } from "@cohub/infra/config-runtime/models";
import { CompletionModelRegistry } from "./completion-registry.js";

function catalog(models: ModelsConfig["providers"][string]["models"]): ModelsConfig {
  return {
    providers: {
      cohub: { api: "openai-responses", baseUrl: "https://example.test", models },
    },
  };
}

test("hidden models stay resolvable by explicit id", () => {
  const registry = new CompletionModelRegistry([catalog([{ id: "visible" }, { id: "hidden", hidden: true }])]);

  assert.deepEqual(registry.getAvailable().map((model) => model.id), ["visible", "hidden"]);
  assert.equal(registry.find("cohub", "hidden")?.id, "hidden");
});

test("hidden models never become implicit defaults", () => {
  const registry = new CompletionModelRegistry([catalog([{ id: "hidden", hidden: true }, { id: "visible" }])]);

  assert.deepEqual(registry.getDiscoverable().map((model) => model.id), ["visible"]);
  assert.equal(registry.getDefault()?.id, "visible");
});

test("default falls back to hidden only when nothing else is available", () => {
  const registry = new CompletionModelRegistry([catalog([{ id: "hidden", hidden: true }])]);

  assert.deepEqual(registry.getDiscoverable(), []);
  assert.equal(registry.getDefault()?.id, "hidden");
});

test("completion registry never resolves user key literals from the service environment", (t) => {
  const previous = process.env.R02_COMPLETION_SECRET;
  process.env.R02_COMPLETION_SECRET = "synthetic-completion-secret";
  t.after(() => {
    if (previous === undefined) delete process.env.R02_COMPLETION_SECRET;
    else process.env.R02_COMPLETION_SECRET = previous;
  });
  const user: ModelsConfig = {
    providers: {
      custom: { api: "openai-completions", baseUrl: "https://user.example.test", apiKey: "R02_COMPLETION_SECRET", models: [{ id: "custom" }] },
    },
  };
  const registry = new CompletionModelRegistry([resolveRuntimeModelsConfig({ user })]);
  assert.equal(registry.getApiKey("custom"), "R02_COMPLETION_SECRET");
  assert.equal(registry.find("custom", "custom")?.baseUrl, "https://user.example.test");
});

test("completion registry cannot combine a user destination with platform auth", () => {
  const platform: ModelsConfig = {
    providers: {
      cohub: { api: "openai-responses", baseUrl: "https://platform.example.test", apiKey: "synthetic-platform-key", headers: { "X-Key": "synthetic-header" }, models: [{ id: "platform" }] },
    },
  };
  const user: ModelsConfig = {
    providers: {
      cohub: { api: "openai-completions", baseUrl: "https://user.example.test", apiKey: "user-key", models: [{ id: "custom" }] },
    },
  };
  assert.throws(() => new CompletionModelRegistry([resolveRuntimeModelsConfig({ platform, user })]), /cohub is reserved/);
});

test("completion registry merges model parameters and preserves platform defaults", () => {
  const platform = catalog([
    { id: "visible", contextWindow: 100000, maxTokens: 4096 },
    { id: "hidden", hidden: true },
  ]);
  const user: ModelsConfig = { providers: { cohub: { models: [{ id: "visible", contextWindow: 200000 }] } } };
  const registry = new CompletionModelRegistry([resolveRuntimeModelsConfig({ platform, user })]);
  assert.equal(registry.find("cohub", "visible")?.contextWindow, 200000);
  assert.equal(registry.find("cohub", "visible")?.maxTokens, 4096);
  assert.equal(registry.find("cohub", "visible")?.baseUrl, "https://example.test");
  assert.equal(registry.find("cohub", "hidden")?.hidden, true);
  assert.deepEqual(registry.getDiscoverable().map((model) => model.id), ["visible"]);
  assert.equal(registry.getDefault()?.id, "visible");
});
