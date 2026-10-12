import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCachedModelsConfig,
  isRuntimeModelAvailable,
  mergeModelsConfigs,
  parseCachedModelsConfig,
  resolveRuntimeModelsConfig,
  type ModelCost,
  type ModelsConfig,
} from "./models.js";
import { resolveModelTasksConfig } from "./model-tasks.js";

const cost: ModelCost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const zero: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const provider = {
  api: "openai-responses", baseUrl: "https://platform.example.test", apiKey: "platform-key",
  models: [{ id: "chat", input: ["text", "image"] as Array<"text" | "image">, cost }],
};
const platform: ModelsConfig = { providers: { cohub: provider, otherPlatform: provider } };

for (const name of ["cohub", "otherPlatform"]) {
  test(`${name}: users cannot change any platform price through catalog overrides`, () => {
    for (const price of [zero, ...Object.keys(cost).map((field) => ({ ...cost, [field]: 0 }))]) {
      const user: ModelsConfig = { providers: { [name]: { models: [{ id: "chat", cost: price }] } } };
      const expected = { message: `User model ${name}/chat cannot override platform model pricing: cost` };
      assert.throws(() => mergeModelsConfigs(platform, user), expected);
      assert.throws(() => resolveRuntimeModelsConfig({ platform, user }), expected);
      assert.throws(() => isRuntimeModelAvailable([platform, user], name, "chat"), expected);
      assert.throws(() => resolveRuntimeModelsConfig({
        platform,
        user: parseCachedModelsConfig(JSON.stringify(createCachedModelsConfig({ content: user })))?.content,
      }), expected);
    }
  });

  test(`${name}: omitted or matching prices always retain the platform price object`, () => {
    for (const model of [{ id: "chat", contextWindow: 200000 }, { id: "chat", cost: { ...cost }, contextWindow: 200000 }]) {
      const user = { providers: { [name]: { models: [model] } } };
      const runtime = resolveRuntimeModelsConfig({ platform, user });
      assert.equal(runtime.providers[name]?.models?.[0]?.cost, cost);
      assert.equal(runtime.providers[name]?.models?.[0]?.contextWindow, 200000);
    }
  });

  for (const taskName of ["sessionTitle", "imageToText"] as const) {
    test(`${name}/${taskName}: catalog and task price changes are rejected`, () => {
      for (const fromCatalog of [false, true]) {
        assert.throws(() => resolveModelTasksConfig({
          platformModels: platform,
          userModels: fromCatalog ? { providers: { [name]: { models: [{ id: "chat", cost: zero }] } } } : null,
          userTasks: { [taskName]: {
            prompt: "Describe the input.",
            model: { provider: name, id: "chat", ...(fromCatalog ? {} : { cost: zero }) },
          } },
        }), /cannot override platform model pricing: cost/);
      }
      assert.throws(() => resolveModelTasksConfig({
        platformModels: platform,
        userTasks: { [taskName]: { prompt: "Describe the input.", model: { provider: name, id: "chat", cost: { input: 0 } } } },
      }), /cannot override platform model pricing: cost/);
    });

    test(`${name}/${taskName}: matching prices are accepted and platform task prices remain trusted`, () => {
      const selected = resolveModelTasksConfig({
        platformModels: platform,
        userTasks: { [taskName]: { prompt: "Describe the input.", model: { provider: name, id: "chat", cost: { ...cost } } } },
      })[taskName];
      assert.deepEqual(selected?.model.cost, cost);
      const platformTask = resolveModelTasksConfig({
        platformModels: platform,
        platformTasks: { [taskName]: { prompt: "Describe the input.", model: { provider: name, id: "chat", cost: zero } } },
        userTasks: { [taskName]: { prompt: "User prompt." } },
      })[taskName];
      assert.deepEqual(platformTask?.model.cost, zero);
    });
  }
}

test("custom connections retain their own catalog and task prices", () => {
  const user: ModelsConfig = { providers: { custom: {
    ...provider, baseUrl: "https://user.example.test", apiKey: "user-key",
    models: [{ id: "chat", input: ["text", "image"], cost: zero }],
  } } };
  assert.deepEqual(resolveRuntimeModelsConfig({ platform, user }).providers.custom?.models?.[0]?.cost, zero);
  for (const name of ["sessionTitle", "imageToText"] as const) {
    const task = resolveModelTasksConfig({
      platformModels: platform, userModels: user,
      userTasks: { [name]: { prompt: "Describe the input.", model: { provider: "custom", id: "chat", cost: { input: 2 } } } },
    })[name];
    assert.deepEqual(task?.model.cost, { ...zero, input: 2 });
    assert.equal(task?.model.apiKey, "user-key");
    assert.equal(task?.model.baseUrl, "https://user.example.test");
  }
});

test("matching complete cohub catalogs keep platform prices while connection changes fail", () => {
  const user = structuredClone({ providers: { cohub: provider } });
  assert.equal(resolveRuntimeModelsConfig({ platform, user }).providers.cohub?.models?.[0]?.cost, cost);
  const model = user.providers.cohub.models[0];
  assert.ok(model);
  model.cost = zero;
  assert.throws(() => resolveRuntimeModelsConfig({ platform, user }), /cannot override platform model pricing/);
});
