import assert from "node:assert/strict";
import { test } from "node:test";
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
import { resolveModelTasksConfig } from "./model-tasks.js";

const platform: ModelsConfig = { providers: { cohub: {
  api: "openai-responses",
  baseUrl: "https://platform.example.test/v1",
  apiKey: "platform-key",
  headers: { "X-Provider": "platform" },
  models: [
    {
      id: "chat", contextWindow: 100000, maxTokens: 4096, reasoning: true,
      input: ["text", "image"], cost: { input: 1, output: 2, cacheRead: 0.1 },
      thinkingLevelMap: { low: "low", high: "high" },
      headers: { "X-Model": "chat" }, requestProfile: "codex",
    },
    { id: "sibling", hidden: true, contextWindow: 64000 },
  ],
} } };

const user: ModelsConfig = { providers: { cohub: {
  models: [{ id: "chat", contextWindow: 200000 }],
} } };

test("a single parameter override keeps every other model and connection field", () => {
  const before = structuredClone(platform);
  const userBefore = structuredClone(user);
  const parsed = parseModelsConfig(JSON.stringify(user));
  const merged = mergeModelsConfigs(platform, parsed);
  assert.deepEqual(merged, { providers: { cohub: {
    ...platform.providers.cohub,
    models: [
      { ...platform.providers.cohub?.models?.[0], contextWindow: 200000 },
      platform.providers.cohub?.models?.[1],
    ],
  } } });
  assert.deepEqual(resolveRuntimeModelsConfig({ platform, user }), merged);
  assert.deepEqual(flattenModelsCatalog(merged).map(({ id }) => id), ["chat", "sibling"]);
  assert.equal(isRuntimeModelAvailable([platform, user], "cohub", "chat"), true);
  assert.equal(isRuntimeModelAvailable([platform, user], "cohub", "sibling"), true);
  assert.deepEqual(platform, before);
  assert.deepEqual(user, userBefore);
});

test("parameter merges preserve unspecified nested fields and explicit false or null values", () => {
  const overrides: ModelsConfig = { providers: { cohub: { models: [
    {
      id: "chat", reasoning: false, thinkingLevelMap: { high: null },
      cost: { input: 3, output: 4 }, input: ["text"], name: "My chat",
    },
    { id: "sibling", hidden: false },
  ] } } };
  const models = mergeModelsConfigs(platform, overrides).providers.cohub?.models;
  assert.deepEqual(models?.[0]?.thinkingLevelMap, { low: "low", high: null });
  assert.deepEqual(models?.[0]?.cost, { input: 3, output: 4, cacheRead: 0.1 });
  assert.deepEqual(models?.[0]?.input, ["text"]);
  assert.equal(models?.[0]?.reasoning, false);
  assert.equal(models?.[0]?.name, "My chat");
  assert.equal(models?.[1]?.hidden, false);
});

test("later parameter layers merge by ID without dropping earlier changes", () => {
  const later: ModelsConfig = { providers: { cohub: { models: [{ id: "chat", maxTokens: 8192 }] } } };
  const models = mergeModelsConfigs(platform, user, later).providers.cohub?.models;
  assert.equal(models?.[0]?.contextWindow, 200000);
  assert.equal(models?.[0]?.maxTokens, 8192);
  assert.equal(models?.[1]?.id, "sibling");
  assert.deepEqual(mergeModelsConfigs(platform, { providers: { cohub: { models: [] } } }), platform);
});

test("parameter-only layers retain trusted cloud adapters without requiring user credentials", () => {
  const cloud: ModelsConfig = { providers: { cloud: {
    api: "google-vertex", baseUrl: "https://cloud.example.test", models: [{ id: "chat" }],
  } } };
  const overrides: ModelsConfig = { providers: { cloud: { models: [{ id: "chat", contextWindow: 200000 }] } } };
  const result = resolveRuntimeModelsConfig({ platform: cloud, user: overrides });
  assert.equal(result.providers.cloud?.api, "google-vertex");
  assert.equal(result.providers.cloud?.apiKey, undefined);
  assert.equal(result.providers.cloud?.models?.[0]?.contextWindow, 200000);
});

test("model parameter overrides reject connection changes and unknown extensions", () => {
  for (const field of ["api", "baseUrl", "apiKey", "headers", "compat", "requestProfile", "imageUrlInput", "routingTier", "__proto__"]) {
    const overrides: ModelsConfig = { providers: { cohub: {
      models: [{ id: "chat", contextWindow: 200000, [field]: "user-value" }],
    } } };
    assert.throws(() => mergeModelsConfigs(platform, overrides), {
      message: `User model cohub/chat cannot override platform model connection or extension field: ${field}`,
    });
  }
});

test("cohub cannot be redefined even with a complete user-owned connection", () => {
  for (const base of [platform, null]) {
    for (const fields of [
      { apiKey: "user-key" },
      { baseUrl: "https://user.example.test" },
      { headers: {} },
      { extension: true },
      { api: "openai-responses", baseUrl: "https://user.example.test", apiKey: "user-key" },
    ]) {
      const overrides: ModelsConfig = { providers: { cohub: {
        ...fields, models: [{ id: "chat", contextWindow: 200000 }],
      } } };
      assert.throws(() => mergeModelsConfigs(base, overrides), base ? /cannot override platform model connection/ : /cohub requires a platform model catalog/);
    }
  }
});

test("parameter overrides cannot add model IDs or create a platform provider", () => {
  assert.throws(() => mergeModelsConfigs(platform, { providers: { cohub: { models: [{ id: "new" }] } } }), /cohub\/new must select a configured model/);
  assert.throws(() => mergeModelsConfigs(null, user), /cohub requires a platform model catalog/);
  assert.throws(() => mergeModelsConfigs(platform, { providers: { custom: { models: [{ id: "new" }] } } }), /requires an explicit API key/);
});

test("file and cached parameter overrides resolve identically without mutating raw values", (t) => {
  const previous = process.env.MODEL_PARAMETER_TEST_KEY;
  process.env.MODEL_PARAMETER_TEST_KEY = "resolved-platform-key";
  t.after(() => {
    if (previous === undefined) delete process.env.MODEL_PARAMETER_TEST_KEY;
    else process.env.MODEL_PARAMETER_TEST_KEY = previous;
  });
  const source: ModelsConfig = { providers: { cohub: {
    ...platform.providers.cohub, apiKey: "MODEL_PARAMETER_TEST_KEY",
  } } };
  const cachedPlatform = parseCachedModelsConfig(JSON.stringify(createCachedModelsConfig({ content: source })));
  const cachedUser = parseCachedModelsConfig(JSON.stringify(createCachedModelsConfig({ content: user })));
  const runtime = resolveRuntimeModelsConfig({ platform: cachedPlatform?.content, user: cachedUser?.content });
  assert.deepEqual(runtime, resolveRuntimeModelsConfig({ platform: parseModelsConfig(JSON.stringify(source)), user: parseModelsConfig(JSON.stringify(user)) }));
  assert.equal(runtime.providers.cohub?.apiKey, "resolved-platform-key");
  assert.equal(cachedPlatform?.content?.providers.cohub?.apiKey, "MODEL_PARAMETER_TEST_KEY");
  assert.equal(cachedUser?.content?.providers.cohub?.apiKey, undefined);
});

for (const name of ["sessionTitle", "imageToText"] as const) {
  const platformTasks = { [name]: {
    prompt: "Describe the input.",
    model: { provider: "cohub", id: "chat", apiKey: "platform-task-key", contextWindow: 120000 },
  } };

  test(`${name}: explicit model selection uses catalog parameters followed by task parameters`, () => {
    const task = resolveModelTasksConfig({
      platformModels: platform, platformTasks, userModels: user,
      userTasks: { [name]: { model: { provider: "cohub", id: "chat", maxTokens: 8192, thinkingLevelMap: { high: null } } } },
    })[name];
    assert.equal(task?.model.contextWindow, 200000);
    assert.equal(task?.model.maxTokens, 8192);
    assert.deepEqual(task?.model.thinkingLevelMap, { low: "low", high: null });
    assert.equal(task?.model.apiKey, "platform-key");
    assert.equal(task?.model.baseUrl, "https://platform.example.test/v1");
    assert.deepEqual(task?.model.headers, { "X-Provider": "platform", "X-Model": "chat" });
  });

  test(`${name}: prompt-only changes keep the complete platform task model`, () => {
    const task = resolveModelTasksConfig({
      platformModels: platform, platformTasks, userModels: user,
      userTasks: { [name]: { prompt: "User prompt." } },
    })[name];
    assert.equal(task?.model.contextWindow, 120000);
    assert.equal(task?.model.apiKey, "platform-task-key");
  });

  test(`${name}: unrelated parameter entries do not disable the selected task model`, () => {
    const task = resolveModelTasksConfig({
      platformModels: platform, platformTasks,
      userModels: { providers: { cohub: { models: [
        { id: "chat", contextWindow: 200000 },
        { id: "unavailable", contextWindow: 1000 },
        { id: "sibling", baseUrl: "https://user.example.test" },
      ] } } },
      userTasks: { [name]: { model: { provider: "cohub", id: "chat" } } },
    })[name];
    assert.equal(task?.model.contextWindow, 200000);
    assert.equal(task?.model.apiKey, "platform-key");
  });

  test(`${name}: reserved provider and transport restrictions also apply with catalog overrides`, () => {
    assert.throws(() => resolveModelTasksConfig({
      platformModels: platform, platformTasks, userModels: user,
      userTasks: { [name]: { model: { provider: "cohub", id: "chat", baseUrl: "https://user.example.test" } } },
    }), /cannot override platform model connection/);
    assert.throws(() => resolveModelTasksConfig({
      platformModels: platform, platformTasks,
      userModels: { providers: { cohub: { apiKey: "user-key", api: "openai-responses", models: [{ id: "chat" }] } } },
      userTasks: { [name]: { model: { provider: "cohub", id: "chat" } } },
    }), /User provider cohub cannot override platform model connection or extension field: apiKey/);
    assert.throws(() => resolveModelTasksConfig({
      platformTasks,
      userTasks: { [name]: { model: { provider: "cohub", id: "chat" } } },
    }), /configured platform model/);
  });
}
