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
  type ProviderConfig,
} from "./models.js";
import { resolveModelTasksConfig } from "./model-tasks.js";

function platformConfig(): ModelsConfig {
  return { providers: { cohub: {
    api: "openai-responses", baseUrl: "https://platform.example.test/v1", apiKey: "COMPAT_PLATFORM_KEY",
    headers: { "X-Platform": "cohub", "X-Route": "default" },
    compat: { supportsStore: false, routing: { region: "primary", tags: ["platform"] } },
    requestProfile: "codex", imageUrlInput: false,
    models: [
      { id: "chat", contextWindow: 100000, maxTokens: 8192, input: ["text", "image"] },
      {
        id: "vision", api: "anthropic-messages", baseUrl: "https://vision.example.test",
        headers: { "X-Route": "vision" }, compat: { supportsUsageInStreaming: true },
        requestProfile: "claude-code", imageUrlInput: true, input: ["text", "image"],
      },
      { id: "sibling", hidden: true },
    ],
  } } };
}

function platformKey(t: TestContext) {
  const previous = process.env.COMPAT_PLATFORM_KEY;
  process.env.COMPAT_PLATFORM_KEY = "resolved-platform-credential";
  t.after(() => {
    if (previous === undefined) delete process.env.COMPAT_PLATFORM_KEY;
    else process.env.COMPAT_PLATFORM_KEY = previous;
  });
}

function copiedProvider(platform: ModelsConfig): ProviderConfig {
  const provider = platform.providers.cohub;
  assert.ok(provider);
  return structuredClone(provider);
}

test("complete matching cohub declarations merge parameters using the platform connection", (t) => {
  platformKey(t);
  const platform = platformConfig();
  const userProvider = copiedProvider(platform);
  const chat = userProvider.models?.find((model) => model.id === "chat");
  assert.ok(chat);
  chat.contextWindow = 200000;
  userProvider.models = userProvider.models?.filter((model) => model.id !== "sibling");
  const user = { providers: { cohub: userProvider } };
  const before = structuredClone({ platform, user });
  const merged = mergeModelsConfigs(platform, user);
  assert.equal(merged.providers.cohub?.apiKey, "COMPAT_PLATFORM_KEY");
  assert.equal(merged.providers.cohub?.models?.[0]?.contextWindow, 200000);
  assert.deepEqual(flattenModelsCatalog(merged).map(({ id }) => id), ["chat", "vision", "sibling"]);
  assert.equal(isRuntimeModelAvailable([platform, user], "cohub", "vision"), true);
  const runtime = resolveRuntimeModelsConfig({ platform, user });
  assert.equal(runtime.providers.cohub?.apiKey, "resolved-platform-credential");
  assert.equal(runtime.providers.cohub?.headers, platform.providers.cohub?.headers);
  assert.equal(runtime.providers.cohub?.models?.[1]?.headers, platform.providers.cohub?.models?.[1]?.headers);
  assert.deepEqual({ platform, user }, before);
});

test("persisted catalog copies survive platform connection changes and model retirement", () => {
  const platform = platformConfig();
  const user = { providers: { cohub: copiedProvider(platform) } };
  const override = user.providers.cohub.models?.find((model) => model.id === "chat");
  assert.ok(override);
  override.contextWindow = 200000;
  const current = platform.providers.cohub;
  assert.ok(current);
  current.baseUrl = "https://updated.example.test/v1";
  current.apiKey = "updated-platform-key";
  current.headers = { "X-Route": "updated" };
  current.compat = { supportsStore: true };
  current.models = current.models?.filter((model) => model.id !== "sibling");
  const before = structuredClone({ platform, user });
  const cached = parseCachedModelsConfig(JSON.stringify(createCachedModelsConfig({ content: user })));
  const expected = mergeModelsConfigs(platform, { providers: { cohub: { models: [{ id: "chat", contextWindow: 200000 }] } } });
  assert.deepEqual(mergeModelsConfigs(platform, parseModelsConfig(JSON.stringify(user))), expected);
  assert.deepEqual(resolveRuntimeModelsConfig({ platform, user: cached?.content }), resolveRuntimeModelsConfig({ platform: expected }));
  assert.equal(isRuntimeModelAvailable([platform, user], "cohub", "chat"), true);
  assert.equal(isRuntimeModelAvailable([platform, user], "cohub", "sibling"), false);
  assert.deepEqual({ platform, user }, before);
});

test("matching declarations compare object values independently of property order", () => {
  const platform = platformConfig();
  const user = { providers: { cohub: {
    headers: { "X-Route": "default", "X-Platform": "cohub" },
    compat: { routing: { tags: ["platform"], region: "primary" }, supportsStore: false },
    models: [{ id: "chat", contextWindow: 200000 }],
  } } };
  assert.equal(mergeModelsConfigs(platform, user).providers.cohub?.models?.[0]?.contextWindow, 200000);
});

test("matching empty header declarations are accepted", () => {
  const platform: ModelsConfig = { providers: { cohub: {
    api: "openai-responses", baseUrl: "https://platform.example.test", apiKey: "COMPAT_PLATFORM_KEY",
    headers: {}, models: [{ id: "chat", headers: {} }],
  } } };
  assert.deepEqual(mergeModelsConfigs(platform, structuredClone(platform)), platform);
});

test("model declarations may repeat inherited connection values without storing user connection fields", () => {
  const platform = platformConfig();
  const user = { providers: { cohub: { models: [{
    id: "chat", api: "openai-responses", baseUrl: "https://platform.example.test/v1",
    apiKey: "COMPAT_PLATFORM_KEY", headers: { "X-Platform": "cohub", "X-Route": "default" },
    requestProfile: "codex" as const, imageUrlInput: false, contextWindow: 200000,
  }] } } };
  const model = mergeModelsConfigs(platform, user).providers.cohub?.models?.[0];
  assert.equal(model?.contextWindow, 200000);
  for (const field of ["api", "baseUrl", "apiKey", "headers", "requestProfile", "imageUrlInput"]) {
    assert.equal(Object.hasOwn(model ?? {}, field), false);
  }
});

const changes = [
  { api: "openai-completions" },
  { baseUrl: "https://user.example.test/v1" },
  { apiKey: "OTHER_SERVICE_KEY" },
  { headers: { Host: "user.example.test" } },
  { compat: { routing: { region: "user", tags: ["platform"] } } },
  { requestProfile: "claude-code" as const },
  { imageUrlInput: true },
  { unknownConnection: "user" },
];

for (const change of changes) {
  const field = Object.keys(change)[0];
  test(`matching key aliases cannot authorize a changed provider ${field}`, (t) => {
    platformKey(t);
    const platform = platformConfig();
    const user = { providers: { cohub: { ...copiedProvider(platform), ...change } } };
    assert.deepEqual(mergeModelsConfigs(platform, user), platform);
    assert.deepEqual(resolveRuntimeModelsConfig({ platform, user }), resolveRuntimeModelsConfig({ platform }));
    assert.equal(isRuntimeModelAvailable([platform, user], "cohub", "chat"), true);
  });

  test(`matching provider connection cannot authorize a changed model ${field}`, (t) => {
    platformKey(t);
    const platform = platformConfig();
    const user = { providers: { cohub: {
      ...copiedProvider(platform), models: [{ id: "chat", ...change }],
    } } };
    assert.deepEqual(mergeModelsConfigs(platform, user), platform);
    assert.deepEqual(resolveRuntimeModelsConfig({ platform, user }), resolveRuntimeModelsConfig({ platform }));
  });
}

test("a model-specific endpoint cannot be replaced by its provider endpoint", () => {
  const platform = platformConfig();
  const user = { providers: { cohub: {
    apiKey: "COMPAT_PLATFORM_KEY", models: [{ id: "vision", baseUrl: "https://platform.example.test/v1" }],
  } } };
  assert.equal(resolveRuntimeModelsConfig({ platform, user }).providers.cohub?.models?.[1]?.baseUrl, "https://vision.example.test");
});

test("user catalog key declarations never participate in platform key resolution", (t) => {
  platformKey(t);
  const platform = platformConfig();
  for (const apiKey of ["resolved-platform-credential", " COMPAT_PLATFORM_KEY ", "OTHER_SERVICE_KEY"]) {
    const user = { providers: { cohub: { ...copiedProvider(platform), apiKey } } };
    assert.equal(resolveRuntimeModelsConfig({ platform, user }).providers.cohub?.apiKey, "resolved-platform-credential");
  }
});

test("custom providers never resolve a copied platform key alias", (t) => {
  platformKey(t);
  const platform = platformConfig();
  const user = { providers: { custom: {
    ...copiedProvider(platform), baseUrl: "https://user.example.test/v1",
  } } };
  const runtime = resolveRuntimeModelsConfig({ platform, user });
  assert.equal(runtime.providers.cohub?.apiKey, "resolved-platform-credential");
  assert.equal(runtime.providers.custom?.apiKey, "COMPAT_PLATFORM_KEY");
  const sameNamePlatform: ModelsConfig = { providers: { custom: copiedProvider(platform) } };
  assert.equal(resolveRuntimeModelsConfig({ platform: sameNamePlatform, user }).providers.custom?.apiKey, "COMPAT_PLATFORM_KEY");
});

test("raw file and cache declarations enforce identical compatibility checks", (t) => {
  platformKey(t);
  const platform = platformConfig();
  const user = { providers: { cohub: copiedProvider(platform) } };
  const cachedPlatform = createCachedModelsConfig({ content: platform });
  const cachedUser = createCachedModelsConfig({ content: user });
  const before = JSON.stringify({ cachedPlatform, cachedUser });
  const fromCache = resolveRuntimeModelsConfig({
    platform: parseCachedModelsConfig(JSON.stringify(cachedPlatform))?.content,
    user: parseCachedModelsConfig(JSON.stringify(cachedUser))?.content,
  });
  assert.deepEqual(fromCache, resolveRuntimeModelsConfig({
    platform: parseModelsConfig(JSON.stringify(platform)), user: parseModelsConfig(JSON.stringify(user)),
  }));
  assert.equal(JSON.stringify({ cachedPlatform, cachedUser }), before);
  user.providers.cohub.baseUrl = "https://user.example.test/v1";
  assert.deepEqual(resolveRuntimeModelsConfig({
    platform: parseCachedModelsConfig(JSON.stringify(cachedPlatform))?.content,
    user: parseCachedModelsConfig(JSON.stringify(cachedUser))?.content,
  }), fromCache);
});

test("stale model IDs and unknown catalog extensions leave platform models intact", () => {
  const platform = platformConfig();
  assert.deepEqual(mergeModelsConfigs(platform, { providers: { cohub: {
    ...copiedProvider(platform), models: [{ id: "new-model" }],
  } } }), platform);
  const user = { providers: { cohub: { ...copiedProvider(platform), privateRoute: "user" } } };
  platform.providers.cohub = { ...copiedProvider(platform), privateRoute: "platform" };
  assert.deepEqual(mergeModelsConfigs(platform, user), platform);
});

for (const name of ["sessionTitle", "imageToText"] as const) {
  test(`${name}: matching catalog and task declarations keep platform auth and user parameters`, (t) => {
    platformKey(t);
    const platform = platformConfig();
    const userProvider = copiedProvider(platform);
    const chat = userProvider.models?.[0];
    assert.ok(chat);
    chat.contextWindow = 200000;
    const task = resolveModelTasksConfig({
      platformModels: platform, userModels: { providers: { cohub: userProvider } },
      platformTasks: { [name]: { prompt: "Describe the input.", model: { provider: "cohub", id: "chat", apiKey: "task-specific-key" } } },
      userTasks: { [name]: { model: {
        provider: "cohub", id: "chat", api: "openai-responses", baseUrl: "https://platform.example.test/v1",
        apiKey: "COMPAT_PLATFORM_KEY", maxTokens: 4096, headers: { "X-Platform": "cohub", "X-Route": "default" },
      } } },
    })[name];
    assert.equal(task?.model.apiKey, "resolved-platform-credential");
    assert.equal(task?.model.contextWindow, 200000);
    assert.equal(task?.model.maxTokens, 4096);
    assert.equal(task?.model.baseUrl, "https://platform.example.test/v1");
  });

  test(`${name}: catalog filtering and explicit task validation prevent endpoint redirection`, (t) => {
    platformKey(t);
    const platform = platformConfig();
    for (const level of ["provider", "model", "task"]) {
      const provider = copiedProvider(platform);
      const taskModel = { provider: "cohub", id: "chat", apiKey: "COMPAT_PLATFORM_KEY", baseUrl: "https://platform.example.test/v1" };
      if (level === "provider") provider.baseUrl = "https://user.example.test";
      if (level === "model") provider.models = [{ id: "chat", apiKey: "COMPAT_PLATFORM_KEY", baseUrl: "https://user.example.test" }];
      if (level === "task") taskModel.baseUrl = "https://user.example.test";
      const resolve = () => resolveModelTasksConfig({
        platformModels: platform, userModels: { providers: { cohub: provider } },
        userTasks: { [name]: { prompt: "Describe the input.", model: taskModel } },
      });
      if (level === "task") {
        assert.throws(resolve, /cannot override platform model connection or extension field: baseUrl/);
      } else {
        const task = resolve()[name];
        assert.equal(task?.model.baseUrl, "https://platform.example.test/v1");
        assert.equal(task?.model.apiKey, "resolved-platform-credential");
      }
    }
  });

  test(`${name}: task key equality uses the raw platform alias`, (t) => {
    platformKey(t);
    assert.throws(() => resolveModelTasksConfig({
      platformModels: platformConfig(),
      userTasks: { [name]: { prompt: "Describe the input.", model: {
        provider: "cohub", id: "chat", apiKey: "resolved-platform-credential",
      } } },
    }), { message: "User model cohub/chat cannot override platform model connection or extension field: apiKey" });
  });
}
