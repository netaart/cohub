import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mergeModelsConfigs,
  MIN_MAX_CONTEXT,
  parseModelsConfig,
  resolveModelsConfigContext,
  resolveRuntimeModelsConfig,
  selectModModelMaxContextOverrides,
  type ModelsConfig,
} from "./models.js";

const platform: ModelsConfig = { providers: { cohub: {
  api: "openai-responses", baseUrl: "https://platform.example.test/v1", apiKey: "platform-key",
  models: [
    { id: "chat", contextWindow: 200_000 },
    { id: "small", contextWindow: 32_000 },
  ],
} } };

const mod = (maxContext: number): ModelsConfig => ({ providers: { cohub: {
  models: [{ id: "chat", maxContext }],
} } });

test("platform defaults are used when no override exists", () => {
  const models = resolveModelsConfigContext({ platform }).providers.cohub?.models;
  assert.equal(models?.[0]?.contextWindow, 200_000);
  assert.equal(models?.[0]?.maxContext, 200_000);
  assert.equal(models?.[0]?.maxContextSource, "platform");
});

test("mod overrides platform and user overrides mod", () => {
  const mods = [{ config: mod(120_000), ref: "studio" }];
  const modded = resolveModelsConfigContext({ platform, mods });
  assert.equal(modded.providers.cohub?.models?.[0]?.maxContext, 120_000);
  assert.equal(modded.providers.cohub?.models?.[0]?.maxContextSource, "mod");
  assert.equal(modded.providers.cohub?.models?.[0]?.maxContextSourceRef, "studio");

  const user: ModelsConfig = { providers: { cohub: { models: [{ id: "chat", maxContext: 160_000 }] } } };
  const resolved = resolveModelsConfigContext({ platform, mods, user });
  assert.equal(resolved.providers.cohub?.models?.[0]?.maxContext, 160_000);
  assert.equal(resolved.providers.cohub?.models?.[0]?.maxContextSource, "user");
});

test("later mods win in order and values clamp to the real context window", () => {
  const mods = [
    { config: mod(150_000), ref: "first" },
    { config: mod(500_000), ref: "second" },
  ];
  const resolved = resolveModelsConfigContext({ platform, mods });
  assert.equal(resolved.providers.cohub?.models?.[0]?.maxContext, 200_000);
  assert.equal(resolved.providers.cohub?.models?.[0]?.maxContextSourceRef, "second");
});

test("legacy user contextWindow is a threshold, not a new hard limit", () => {
  const user: ModelsConfig = { providers: { cohub: { models: [{ id: "chat", contextWindow: 80_000 }] } } };
  const resolved = resolveModelsConfigContext({ platform, user });
  assert.equal(resolved.providers.cohub?.models?.[0]?.contextWindow, 200_000);
  assert.equal(resolved.providers.cohub?.models?.[0]?.maxContext, 80_000);
  assert.equal(resolved.providers.cohub?.models?.[0]?.maxContextSource, "user");

  const mods = [{ config: mod(120_000), ref: "studio" }];
  for (const contextWindow of [200_000, 1_000_000]) {
    const legacy: ModelsConfig = { providers: { cohub: { models: [{ id: "chat", contextWindow }] } } };
    const model = resolveModelsConfigContext({ platform, mods, user: legacy }).providers.cohub?.models?.[0];
    assert.equal(model?.maxContext, 120_000);
    assert.equal(model?.maxContextSource, "mod");
  }
});

test("tiny thresholds are raised to the floor but never above the real window", () => {
  const user: ModelsConfig = { providers: { cohub: { models: [{ id: "chat", maxContext: 1 }, { id: "small", maxContext: 1 }] } } };
  const models = resolveModelsConfigContext({ platform, user }).providers.cohub?.models;
  assert.equal(models?.[0]?.maxContext, MIN_MAX_CONTEXT);
  assert.equal(models?.[1]?.maxContext, 32_000);
});

test("mods only contribute maxContext for models that already exist on the platform", () => {
  const overrides = selectModModelMaxContextOverrides(platform, { providers: {
    cohub: { models: [{ id: "chat", maxContext: 90_000, contextWindow: 999_999 }] },
    other: { api: "openai-responses", baseUrl: "https://other.example.test", apiKey: "key", models: [{ id: "x", maxContext: 1 }] },
  } });
  assert.deepEqual(overrides, { providers: { cohub: { models: [{ id: "chat", maxContext: 90_000 }] } } });
});

test("custom user providers clamp maxContext to their own contextWindow", () => {
  const user: ModelsConfig = { providers: { custom: {
    api: "openai-completions", baseUrl: "https://custom.example.test/v1", apiKey: "key",
    models: [{ id: "m", contextWindow: 64_000, maxContext: 128_000 }],
  } } };
  const runtime = resolveRuntimeModelsConfig({ platform: null, user });
  const model = runtime.providers.custom?.models?.[0];
  assert.equal(model?.contextWindow, 64_000);
  assert.equal(model?.maxContext, 64_000);
  assert.equal(model?.maxContextSource, "user");
});

test("invalid maxContext values fail schema validation", () => {
  assert.throws(() => parseModelsConfig(JSON.stringify({ providers: { cohub: { models: [{ id: "chat", maxContext: 0 }] } } })), /invalid schema/);
  assert.throws(() => parseModelsConfig(JSON.stringify({ providers: { cohub: { models: [{ id: "chat", maxContext: 1.5 }] } } })), /invalid schema/);
});

test("raw merges keep requested values while runtime resolution clamps them", () => {
  const user: ModelsConfig = { providers: { cohub: { models: [{ id: "chat", maxContext: 300_000 }] } } };
  assert.equal(mergeModelsConfigs(platform, user).providers.cohub?.models?.[0]?.maxContext, 300_000);
  assert.equal(resolveModelsConfigContext({ platform, user }).providers.cohub?.models?.[0]?.maxContext, 200_000);
});
