import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  createCachedModelsConfig,
  flattenModelsCatalog,
  isRuntimeModelAvailable,
  mergeModelsConfigs,
  parseCachedModelsConfig,
  parseModelsConfig,
  resolveRuntimeModelsConfig,
  type ModelsConfig,
} from "./models.js";

function withEnv(t: TestContext, name: string, value: string) {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

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

test("user providers cannot inherit platform connection defaults", () => {
  const user: ModelsConfig = {
    providers: {
      cohub: {
        models: [{ id: "default", baseUrl: "https://user.example.test" }],
      },
    },
  };
  assert.throws(() => isRuntimeModelAvailable([platform, user], "cohub", "default"), {
    message: "User model cohub/default requires an explicit API key",
  });
});

test("platform environment references resolve only in a runtime copy", (t) => {
  withEnv(t, "R02_PLATFORM_MODEL_KEY", "  synthetic-platform-key  ");
  const source: ModelsConfig = {
    providers: { cohub: { ...platform.providers.cohub, apiKey: "R02_PLATFORM_MODEL_KEY" } },
  };
  const cached = createCachedModelsConfig({ content: source });
  const runtime = resolveRuntimeModelsConfig({ platform: source });
  assert.equal(runtime.providers.cohub?.apiKey, "synthetic-platform-key");
  assert.equal(source.providers.cohub?.apiKey, "R02_PLATFORM_MODEL_KEY");
  assert.equal(parseCachedModelsConfig(JSON.stringify(cached))?.content?.providers.cohub?.apiKey, "R02_PLATFORM_MODEL_KEY");
  assert.ok(!JSON.stringify(cached).includes("synthetic-platform-key"));
});

test("user key literals that name service variables are never dereferenced", (t) => {
  withEnv(t, "R02_SERVICE_SECRET", "synthetic-service-secret");
  const user = parseModelsConfig(JSON.stringify({
    providers: {
      custom: {
        api: "openai-completions", baseUrl: "https://user.example.test/v1",
        apiKey: "R02_SERVICE_SECRET", models: [{ id: "custom" }],
      },
    },
  }));
  assert.equal(resolveRuntimeModelsConfig({ platform, user }).providers.custom?.apiKey, "R02_SERVICE_SECRET");
});

test("a same-name user provider replaces credentials, headers, extensions and models together", (t) => {
  withEnv(t, "R02_PLATFORM_MODEL_KEY", "synthetic-platform-key");
  const trusted: ModelsConfig = {
    providers: {
      cohub: {
        ...platform.providers.cohub,
        apiKey: "R02_PLATFORM_MODEL_KEY",
        headers: { Authorization: "synthetic-header-secret" },
        compat: { privateRouting: "synthetic-route-secret" },
        credentialExtension: "synthetic-extension-secret",
        models: [{ id: "default", headers: { "X-Key": "synthetic-model-secret" } }],
      },
    },
  };
  const user: ModelsConfig = {
    providers: {
      cohub: {
        api: "openai-completions", baseUrl: "https://user.example.test/v1",
        apiKey: "user-literal-key", models: [{ id: "custom" }],
      },
    },
  };
  const result = resolveRuntimeModelsConfig({ platform: trusted, user });
  assert.deepEqual(result.providers.cohub, user.providers.cohub);
  assert.ok(!JSON.stringify(result).includes("synthetic-"));
  assert.deepEqual(mergeModelsConfigs(trusted, user).providers.cohub, user.providers.cohub);
  assert.equal(isRuntimeModelAvailable([trusted, user], "cohub", "default"), false);
  assert.equal(isRuntimeModelAvailable([trusted, user], "cohub", "custom"), true);
});

test("invalid user credentials fail catalog resolution with the provider, model and reason", () => {
  const cases = [
    {
      provider: { api: "openai-completions", models: [{ id: "custom" }] },
      message: "User model custom/custom requires an explicit API key",
    },
    {
      provider: { api: "openai-completions", apiKey: "  ", models: [{ id: "custom" }] },
      message: "User model custom/custom requires an explicit API key",
    },
    {
      provider: { apiKey: "user-key", models: [{ id: "custom" }] },
      message: "User model custom/custom requires an API-key-based adapter",
    },
    {
      provider: { api: "bedrock-converse-stream", apiKey: "user-key", models: [{ id: "custom" }] },
      message: "User model custom/custom uses an unsupported API adapter: bedrock-converse-stream",
    },
    {
      provider: { api: "google-vertex", apiKey: "user-key", models: [{ id: "custom" }] },
      message: "User model custom/custom uses an unsupported API adapter: google-vertex",
    },
    {
      provider: { api: "openai-completions", apiKey: "user-key", models: [{ id: "custom", api: "google-vertex" }] },
      message: "User model custom/custom uses an unsupported API adapter: google-vertex",
    },
  ];
  for (const { provider, message } of cases) {
    const user: ModelsConfig = { providers: { custom: provider } };
    assert.throws(() => mergeModelsConfigs(platform, user), { message });
    assert.throws(() => resolveRuntimeModelsConfig({ platform, user }), { message });
    assert.throws(() => isRuntimeModelAvailable([platform, user], "custom", "custom"), { message });
    assert.deepEqual(user.providers.custom?.models, provider.models);
  }
});

test("an invalid user model rejects a mixed catalog without a platform catalog", () => {
  const user: ModelsConfig = { providers: {
    custom: {
      api: "openai-completions", baseUrl: "https://user.example.test", apiKey: "user-key",
      models: [{ id: "usable" }, { id: "ambient", api: "google-vertex" }],
    },
  } };
  const expected = { message: "User model custom/ambient uses an unsupported API adapter: google-vertex" };
  assert.throws(() => mergeModelsConfigs(null, user), expected);
  assert.throws(() => resolveRuntimeModelsConfig({ user }), expected);
  assert.deepEqual(user.providers.custom?.models?.map((model) => model.id), ["usable", "ambient"]);
});

test("valid user models and platform cloud adapters remain available", () => {
  const user: ModelsConfig = { providers: {
    custom: {
      api: "openai-completions", baseUrl: "https://user.example.test", apiKey: "user-key",
      models: [{ id: "first" }, { id: "second", api: "anthropic-messages" }],
    },
  } };
  assert.deepEqual(flattenModelsCatalog(mergeModelsConfigs(null, user)).map((model) => model.id), ["first", "second"]);
  const trusted: ModelsConfig = { providers: {
    cloud: { api: "google-vertex", baseUrl: "https://platform.example.test", models: [{ id: "platform-cloud" }] },
  } };
  const runtime = resolveRuntimeModelsConfig({ platform: trusted, user });
  assert.equal(isRuntimeModelAvailable([runtime], "cloud", "platform-cloud"), true);
  assert.equal(isRuntimeModelAvailable([runtime], "custom", "first"), true);
  assert.equal(isRuntimeModelAvailable([runtime], "custom", "second"), true);
});

test("an invalid same-name user provider fails without exposing platform credentials", () => {
  const user: ModelsConfig = {
    providers: { cohub: { api: "openai-responses", baseUrl: "https://user.example.test", models: [{ id: "default" }] } },
  };
  const trusted: ModelsConfig = {
    providers: { cohub: { ...platform.providers.cohub, apiKey: "synthetic-platform-secret" } },
  };
  assert.throws(() => resolveRuntimeModelsConfig({ platform: trusted, user }), {
    message: "User model cohub/default requires an explicit API key",
  });
  assert.equal(user.providers.cohub?.apiKey, undefined);
  assert.equal(trusted.providers.cohub?.apiKey, "synthetic-platform-secret");
});

test("provider names cannot inherit or alter object prototypes", () => {
  const source = parseModelsConfig('{"providers":{"__proto__":{"api":"openai-completions","baseUrl":"https://user.example.test","apiKey":"user-key","models":[{"id":"custom"}]}}}');
  const merged = mergeModelsConfigs(platform, source);
  assert.equal(Object.getPrototypeOf(merged.providers), Object.prototype);
  assert.equal(Object.hasOwn(merged.providers, "__proto__"), true);
  assert.equal(isRuntimeModelAvailable([source], "__proto__", "custom"), true);
});
