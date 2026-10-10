import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createModelTasksConfigLoader,
  getUserModelTasksRedisKey,
  resolveModelTasksConfig,
  type ModelTasksConfigOverride,
} from "./model-tasks.js";
import { getUserModelsRedisKey, type ModelsConfig } from "./models.js";

const platformModels: ModelsConfig = {
  providers: {
    cohub: {
      api: "openai-completions",
      baseUrl: "https://platform.example.test/v1",
      apiKey: "synthetic-platform-key",
      headers: { Authorization: "synthetic-platform-header" },
      models: [{ id: "vision", input: ["text", "image"], headers: { "X-Key": "synthetic-model-header" } }],
    },
  },
};
const platformTasks: ModelTasksConfigOverride = {
  sessionTitle: { model: { provider: "cohub", id: "vision", apiKey: "synthetic-task-key" }, prompt: "Write a title." },
  imageToText: { model: { provider: "cohub", id: "vision" }, prompt: "Describe the image." },
};
const userModels: ModelsConfig = {
  providers: {
    custom: {
      api: "openai-completions", baseUrl: "https://user.example.test/v1",
      apiKey: "user-literal-key", models: [{ id: "vision", input: ["text", "image"] }],
    },
  },
};

for (const name of ["sessionTitle", "imageToText"] as const) {
  test(`${name}: prompt-only changes keep the trusted task destination and credentials together`, () => {
    const task = resolveModelTasksConfig({
      platformModels, platformTasks, userModels,
      userTasks: { [name]: { prompt: "User prompt." } },
    })[name];
    assert.ok(task);
    assert.equal(task.prompt, "User prompt.");
    assert.equal(task.model.baseUrl, "https://platform.example.test/v1");
    assert.equal(task.model.apiKey, name === "sessionTitle" ? "synthetic-task-key" : "synthetic-platform-key");
  });

  test(`${name}: selecting a user provider never inherits platform task secrets`, () => {
    const task = resolveModelTasksConfig({
      platformModels, platformTasks, userModels,
      userTasks: { [name]: { model: { provider: "custom", id: "vision" } } },
    })[name];
    assert.ok(task);
    assert.equal(task.model.baseUrl, "https://user.example.test/v1");
    assert.equal(task.model.apiKey, "user-literal-key");
    assert.equal(task.model.headers, undefined);
    assert.ok(!JSON.stringify(task).includes("synthetic-"));
  });

  test(`${name}: a user may select and tune a fixed platform catalog model`, () => {
    const task = resolveModelTasksConfig({
      platformModels, platformTasks,
      userTasks: { [name]: { model: { provider: "cohub", id: "vision", maxTokens: 42 } } },
    })[name];
    assert.ok(task);
    assert.equal(task.model.apiKey, "synthetic-platform-key");
    assert.equal(task.model.baseUrl, "https://platform.example.test/v1");
    assert.equal(task.model.maxTokens, 42);
  });

  test(`${name}: untrusted transport changes cannot carry a platform credential`, () => {
    for (const override of [
      { baseUrl: "https://user.example.test/v1" },
      { api: "openai-responses" },
      { apiKey: "USER_SERVICE_ENV" },
      { headers: { Host: "user.example.test" } },
      { compat: { endpoint: "https://user.example.test" } },
      { requestProfile: "codex" as const },
      { imageUrlInput: false },
    ]) {
      assert.throws(() => resolveModelTasksConfig({
        platformModels, platformTasks,
        userTasks: { [name]: { model: { provider: "cohub", id: "vision", ...override } } },
      }), /cannot override platform model connection/);
    }
  });

  test(`${name}: partial task models cannot inherit hidden platform task fields`, () => {
    assert.throws(() => resolveModelTasksConfig({
      platformModels, platformTasks,
      userTasks: { [name]: { model: { baseUrl: "https://user.example.test" } } },
    }), /incomplete/);
  });

  test(`${name}: platform credentials only apply to configured model IDs`, () => {
    assert.throws(() => resolveModelTasksConfig({
      platformModels, platformTasks,
      userTasks: { [name]: { model: { provider: "cohub", id: "unconfigured" } } },
    }), /configured platform model/);
  });
}

test("standalone user task keys remain literals; ambient adapters and missing keys are rejected", () => {
  const model = {
    provider: "custom", id: "custom", api: "openai-completions",
    baseUrl: "https://user.example.test/v1", apiKey: "SERVICE_ENV_NAME",
  };
  const task = resolveModelTasksConfig({
    platformModels, platformTasks,
    userTasks: { sessionTitle: { model } },
  }).sessionTitle;
  assert.equal(task?.model.apiKey, "SERVICE_ENV_NAME");
  assert.equal(task?.model.headers, undefined);
  for (const { model: unsafe, message } of [
    { model: { ...model, apiKey: undefined }, message: "User model custom/custom requires an explicit API key" },
    { model: { ...model, api: "google-vertex" }, message: "User model custom/custom uses an unsupported API adapter: google-vertex" },
    { model: { ...model, api: "bedrock-converse-stream" }, message: "User model custom/custom uses an unsupported API adapter: bedrock-converse-stream" },
  ]) {
    assert.throws(() => resolveModelTasksConfig({
      platformModels, platformTasks,
      userTasks: { sessionTitle: { model: unsafe } },
    }), { message });
  }
});

test("task disable and image capability checks still apply", () => {
  const result = resolveModelTasksConfig({ platformTasks, platformModels, userTasks: { imageToText: { enabled: false } } });
  assert.ok(result.sessionTitle);
  assert.equal(result.imageToText, undefined);
  assert.throws(() => resolveModelTasksConfig({
    platformTasks, platformModels,
    userTasks: { imageToText: { model: { provider: "cohub", id: "vision", input: ["text"] } } },
  }), /image-capable/);
});

test("unused user catalog entries cannot disable platform or explicitly disabled tasks", () => {
  const unrelatedModels: ModelsConfig = {
    providers: {
      unused: { api: "google-vertex", models: [{ id: "unused" }] },
      cohub: { api: "openai-completions", baseUrl: "https://user.example.test", models: [{ id: "vision" }] },
    },
  };
  const platformOnly = resolveModelTasksConfig({ platformTasks, platformModels, userModels: unrelatedModels });
  assert.equal(platformOnly.sessionTitle?.model.apiKey, "synthetic-task-key");
  assert.equal(platformOnly.imageToText?.model.baseUrl, "https://platform.example.test/v1");
  assert.deepEqual(resolveModelTasksConfig({
    platformTasks, platformModels, userModels: unrelatedModels,
    userTasks: { sessionTitle: { enabled: false }, imageToText: { enabled: false } },
  }), {});
});

test("user tasks validate the selected final model, allowing their own explicit key override", () => {
  const task = resolveModelTasksConfig({
    platformTasks, platformModels,
    userModels: { providers: {
      custom: { api: "openai-completions", baseUrl: "https://user.example.test", models: [{ id: "title" }] },
      unrelated: { api: "google-vertex", models: [{ id: "unused" }] },
    } },
    userTasks: { sessionTitle: { model: { provider: "custom", id: "title", apiKey: "user-task-key" } } },
  }).sessionTitle;
  assert.equal(task?.model.apiKey, "user-task-key");
  assert.equal(task?.model.baseUrl, "https://user.example.test");
  assert.equal(task?.model.headers, undefined);
});

test("file and Redis-cache loads enforce the same boundary without persisting resolved platform secrets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cohub-r02-model-tasks-"));
  const previous = process.env.R02_MODEL_TASK_KEY;
  process.env.R02_MODEL_TASK_KEY = "synthetic-env-secret";
  t.after(async () => {
    if (previous === undefined) delete process.env.R02_MODEL_TASK_KEY;
    else process.env.R02_MODEL_TASK_KEY = previous;
    await rm(root, { recursive: true, force: true });
  });
  const platformDir = join(root, "platform", ".cohub");
  const userDir = join(root, "users", "test-user", ".cohub");
  await mkdir(platformDir, { recursive: true });
  await mkdir(userDir, { recursive: true });
  const trusted = {
    providers: { cohub: { ...platformModels.providers.cohub, apiKey: "R02_MODEL_TASK_KEY" } },
  };
  const tasks = {
    ...platformTasks,
    sessionTitle: { ...platformTasks.sessionTitle, model: { provider: "cohub", id: "vision", apiKey: "R02_MODEL_TASK_KEY" } },
  };
  const custom = {
    providers: { custom: { ...userModels.providers.custom, apiKey: "R02_MODEL_TASK_KEY" } },
  };
  await writeFile(join(platformDir, "models.json"), JSON.stringify(trusted));
  await writeFile(join(platformDir, "model-tasks.json"), JSON.stringify(tasks));
  await writeFile(join(userDir, "models.json"), JSON.stringify(custom));
  await writeFile(join(userDir, "model-tasks.json"), JSON.stringify({
    imageToText: { model: { provider: "custom", id: "vision" } },
  }));
  const cache = new Map<string, string>();
  const load = createModelTasksConfigLoader({
    platformConfigRoot: root,
    redis: {
      get: async (key) => cache.get(key) ?? null,
      set: async (key, value) => { cache.set(key, value); },
    },
  });
  const cold = await load("test-user");
  assert.equal(cold.sessionTitle?.model.apiKey, "synthetic-env-secret");
  assert.equal(cold.imageToText?.model.apiKey, "R02_MODEL_TASK_KEY");
  assert.equal(cold.imageToText?.model.baseUrl, "https://user.example.test/v1");
  assert.ok(!JSON.stringify([...cache.values()]).includes("synthetic-env-secret"));
  assert.ok(!(await readFile(join(platformDir, "models.json"), "utf8")).includes("synthetic-env-secret"));
  await rm(root, { recursive: true });
  assert.deepEqual(await load("test-user"), cold);

  // A pre-existing user cache entry cannot mark itself as a trusted config.
  cache.set(getUserModelsRedisKey("test-user"), JSON.stringify({ content: null }));
  cache.set(getUserModelTasksRedisKey("test-user"), JSON.stringify({
    trusted: true, scope: "platform", content: {
      imageToText: { model: { provider: "cohub", id: "vision", baseUrl: "https://user.example.test" } },
    },
  }));
  await assert.rejects(load("test-user"), /cannot override platform model connection/);
});
