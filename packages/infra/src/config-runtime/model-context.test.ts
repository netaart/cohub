import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveModelsConfigContext,
  resolveRuntimeModelsConfig,
  selectModContextWindowOverrides,
  type ModelsConfig,
} from "./models.js";

const platform: ModelsConfig = { providers: { cohub: {
  api: "openai-responses", baseUrl: "https://platform.example.test/v1", apiKey: "platform-key",
  models: [
    { id: "chat", contextWindow: 200_000 },
    { id: "small", contextWindow: 32_000 },
  ],
} } };

const window = (contextWindow: number): ModelsConfig => ({ providers: { cohub: {
  models: [{ id: "chat", contextWindow }],
} } });

const chat = (config: ModelsConfig) => config.providers.cohub?.models?.[0];

test("platform value applies when nothing overrides it", () => {
  const model = chat(resolveModelsConfigContext({ platform }));
  assert.equal(model?.contextWindow, 200_000);
  assert.equal(model?.contextWindowSource, "platform");
});

test("priority is platform < mod < user, and later mods win", () => {
  const mods = [{ config: window(150_000), ref: "first" }, { config: window(120_000), ref: "studio" }];
  const modded = chat(resolveModelsConfigContext({ platform, mods }));
  assert.equal(modded?.contextWindow, 120_000);
  assert.equal(modded?.contextWindowSource, "mod");
  assert.equal(modded?.contextWindowSourceRef, "studio");

  const user = chat(resolveModelsConfigContext({ platform, mods, user: window(160_000) }));
  assert.equal(user?.contextWindow, 160_000);
  assert.equal(user?.contextWindowSource, "user");
});

test("a user value copied from the platform catalog does not shadow a mod", () => {
  const model = chat(resolveModelsConfigContext({ platform, mods: [{ config: window(120_000), ref: "studio" }], user: window(200_000) }));
  assert.equal(model?.contextWindow, 120_000);
  assert.equal(model?.contextWindowSource, "mod");
});

test("overrides are capped at the platform value", () => {
  const user = chat(resolveModelsConfigContext({ platform, user: window(1_000_000) }));
  assert.equal(user?.contextWindow, 200_000);
  assert.equal(user?.contextWindowLimit, 200_000);
  const modded = chat(resolveModelsConfigContext({ platform, mods: [{ config: window(500_000), ref: "studio" }] }));
  assert.equal(modded?.contextWindow, 200_000);
});

test("mods only contribute contextWindow for models that already exist on the platform", () => {
  const overrides = selectModContextWindowOverrides(platform, { providers: {
    cohub: { models: [{ id: "chat", contextWindow: 90_000, maxTokens: 1 }, { id: "unknown", contextWindow: 1 }] },
    other: { api: "openai-responses", baseUrl: "https://other.example.test", apiKey: "key", models: [{ id: "x", contextWindow: 1 }] },
  } });
  assert.deepEqual(overrides, { providers: { cohub: { models: [{ id: "chat", contextWindow: 90_000 }] } } });
});

test("custom user providers keep their own contextWindow", () => {
  const user: ModelsConfig = { providers: { custom: {
    api: "openai-completions", baseUrl: "https://custom.example.test/v1", apiKey: "key",
    models: [{ id: "m", contextWindow: 64_000 }],
  } } };
  const model = resolveRuntimeModelsConfig({ platform: null, user }).providers.custom?.models?.[0];
  assert.equal(model?.contextWindow, 64_000);
  assert.equal(model?.contextWindowSource, "user");
});
