import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isRuntimeModelAvailable,
  parseModelsConfig,
  type ModelsConfig,
} from "./models.js";

const platform: ModelsConfig = {
  providers: {
    cohub: {
      api: "openai-responses",
      baseUrl: "https://example.test",
      models: [{ id: "default" }, { id: "hidden", hidden: true }],
    },
    incomplete: {
      models: [{ id: "missing-runtime" }],
    },
  },
};

test("isRuntimeModelAvailable follows runtime provider defaults", () => {
  assert.equal(isRuntimeModelAvailable([platform], "cohub", "default"), true);
  assert.equal(isRuntimeModelAvailable([platform], "cohub", "hidden"), true);
  assert.equal(isRuntimeModelAvailable([platform], "cohub", "missing"), false);
  assert.equal(isRuntimeModelAvailable([platform], "incomplete", "missing-runtime"), false);
});

test("parseModelsConfig validates known provider and model fields", () => {
  const invalidProviders = [
    { api: "", models: [{ id: "model" }] },
    { baseUrl: "not-a-url", models: [{ id: "model" }] },
    { models: [{ id: "" }] },
    { models: [{ id: "model", reasoning: "yes" }] },
    { models: [{ id: "model", input: [] }] },
    { models: [{ id: "model", cost: { input: -1, output: 1 } }] },
    { models: [{ id: "model", cost: { input: 1 } }] },
    { models: [{ id: "model", contextWindow: 0 }] },
    { models: [{ id: "model", maxTokens: 1.5 }] },
    { models: [{ id: "model", compat: [] }] },
    { requestProfile: "claude", models: [{ id: "model" }] },
    { models: [{ id: "model", requestProfile: "claude" }] },
  ];

  for (const provider of invalidProviders) {
    assert.throws(
      () => parseModelsConfig(JSON.stringify({ providers: { cohub: provider } })),
      /invalid schema/,
    );
  }
});

test("parseModelsConfig keeps valid provider-specific extensions", () => {
  const parsed = parseModelsConfig(JSON.stringify({
    providers: {
      cohub: {
        api: "openai-responses",
        baseUrl: "https://example.test/v1",
        models: [{ id: "default", routingTier: "fast" }],
      },
    },
  }));
  assert.equal(parsed.providers.cohub?.models?.[0]?.routingTier, "fast");
});

test("parseModelsConfig accepts every request profile", () => {
  const parsed = parseModelsConfig(JSON.stringify({
    providers: {
      claude: { requestProfile: "claude-code", models: [{ id: "claude-opus-5-5" }] },
      codex: { models: [{ id: "gpt-5.6-sol", requestProfile: "codex" }] },
    },
  }));
  assert.equal(parsed.providers.claude?.requestProfile, "claude-code");
  assert.equal(parsed.providers.codex?.models?.[0]?.requestProfile, "codex");
});

test("isRuntimeModelAvailable honors user model overrides", () => {
  const user: ModelsConfig = {
    providers: {
      cohub: {
        models: [{ id: "default", baseUrl: "https://user.example.test" }],
      },
    },
  };
  assert.equal(isRuntimeModelAvailable([platform, user], "cohub", "default"), true);
});
