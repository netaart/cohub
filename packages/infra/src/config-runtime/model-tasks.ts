import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertUserModelCredentials,
  createCachedModelsConfig,
  getUserModelsRedisKey,
  isModelDefinition,
  mergeHeaders,
  MODELS_CACHE_TTL_SEC,
  parseCachedModelsConfig,
  parseModelsConfig,
  PLATFORM_MODELS_REDIS_KEY,
  resolvePlatformModelApiKey,
  resolvePlatformModelsConfig,
  type CachedModelsConfig,
  type ModelCost,
  type ModelDef,
  type ModelsConfig,
} from "./models.js";

export const MODEL_TASKS_CONFIG_PATH = ".cohub/model-tasks.json";
export const MODEL_TASKS_CACHE_TTL_SEC = 24 * 60 * 60;
export const MODEL_TASKS_CACHE_REDIS_KEY_VERSION = "v1";
export const PLATFORM_MODEL_TASKS_REDIS_KEY = `configs:model-tasks:${MODEL_TASKS_CACHE_REDIS_KEY_VERSION}:platform`;
export const USER_MODEL_TASKS_REDIS_KEY_PREFIX = `configs:model-tasks:${MODEL_TASKS_CACHE_REDIS_KEY_VERSION}:user`;

const SAFE_REDIS_KEY_SEGMENT_REGEX = /^[0-9a-zA-Z_-]+$/;
const TASK_NAMES = ["sessionTitle", "imageToText"] as const;

export type ModelTaskName = typeof TASK_NAMES[number];

export type ModelTaskModelConfig = ModelDef & {
  provider: string;
  api: string;
  baseUrl: string;
  apiKey?: string;
};

export type ModelTaskConfig = {
  enabled?: boolean;
  model: ModelTaskModelConfig;
  prompt: string;
};

export type ModelTaskModelConfigOverride = {
  provider?: string;
  id?: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  apiKey?: string;
  reasoning?: boolean;
  defaultThinkingLevel?: ModelDef["defaultThinkingLevel"];
  thinkingLevelMap?: ModelDef["thinkingLevelMap"];
  hidden?: boolean;
  input?: Array<"text" | "image">;
  cost?: Partial<ModelCost>;
  contextWindow?: number;
  maxTokens?: number;
  requestProfile?: ModelDef["requestProfile"];
  imageUrlInput?: boolean;
  headers?: Record<string, string>;
  compat?: unknown;
};

export type ModelTaskConfigOverride = {
  enabled?: boolean;
  model?: ModelTaskModelConfigOverride;
  prompt?: string;
};

export type ModelTasksConfig = Partial<Record<ModelTaskName, ModelTaskConfig>>;
export type ModelTasksConfigOverride = Partial<Record<ModelTaskName, ModelTaskConfigOverride>>;

export type CachedModelTasksConfig = {
  rev: string;
  updatedAt: string;
  sourceCheckpointId?: string | null;
  content: ModelTasksConfigOverride | null;
};

export type ResolvedModelTasksConfig = ModelTasksConfig & {
  revision: string;
};

export type ImageToTextConfig = ModelTaskConfig;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isModelOverride(value: unknown): value is ModelTaskModelConfigOverride {
  if (!isRecord(value) || !isModelDefinition(value, { partial: true })) return false;
  return (value.provider === undefined || (typeof value.provider === "string" && Boolean(value.provider.trim())))
    && (value.apiKey === undefined || (typeof value.apiKey === "string" && Boolean(value.apiKey.trim())));
}

function isTaskOverride(value: unknown): value is ModelTaskConfigOverride {
  if (!isRecord(value)) return false;
  return (value.enabled === undefined || typeof value.enabled === "boolean")
    && (value.model === undefined || isModelOverride(value.model))
    && (value.prompt === undefined || (typeof value.prompt === "string" && Boolean(value.prompt.trim())));
}

export function isModelTasksConfigOverride(value: unknown): value is ModelTasksConfigOverride {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, task]) =>
    (TASK_NAMES as readonly string[]).includes(key) && isTaskOverride(task));
}

export function parseModelTasksConfigOverride(rawText: string): ModelTasksConfigOverride {
  const parsed = JSON.parse(rawText) as unknown;
  if (!isModelTasksConfigOverride(parsed)) throw new Error("Model tasks config file has invalid schema");
  return parsed;
}

function createFastContentHash(rawText: string): string {
  let hash = 2166136261;
  for (let index = 0; index < rawText.length; index += 1) {
    hash ^= rawText.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16)}:${rawText.length}`;
}

export function createCachedModelTasksConfig(input: {
  rawText?: string;
  content: ModelTasksConfigOverride | null;
  sourceCheckpointId?: string | null;
  updatedAt?: string;
}): CachedModelTasksConfig {
  return {
    rev: input.rawText ? createFastContentHash(input.rawText) : `missing:${input.sourceCheckpointId ?? "model-tasks"}`,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    sourceCheckpointId: input.sourceCheckpointId ?? null,
    content: input.content,
  };
}

export function parseCachedModelTasksConfig(rawText: string): CachedModelTasksConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const content = parsed.content;
  if (content !== null && !isModelTasksConfigOverride(content)) return null;
  return {
    rev: typeof parsed.rev === "string" ? parsed.rev : "unknown",
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    sourceCheckpointId: typeof parsed.sourceCheckpointId === "string" ? parsed.sourceCheckpointId : null,
    content,
  };
}

export function getUserModelTasksRedisKey(userId: string): string {
  const trimmed = userId.trim();
  if (!SAFE_REDIS_KEY_SEGMENT_REGEX.test(trimmed)) throw new Error("Invalid userId for Redis key");
  return `${USER_MODEL_TASKS_REDIS_KEY_PREFIX}:${trimmed}`;
}

const USER_PLATFORM_MODEL_FIELDS = new Set([
  "provider", "id", "name", "reasoning", "defaultThinkingLevel", "thinkingLevelMap",
  "hidden", "input", "cost", "contextWindow", "maxTokens",
]);

/** Select platform models without allowing user input to redirect their credentials. */
export function resolveModelTasksConfig(input: {
  platformTasks?: ModelTasksConfigOverride | null;
  userTasks?: ModelTasksConfigOverride | null;
  platformModels?: ModelsConfig | null;
  userModels?: ModelsConfig | null;
}): ModelTasksConfig {
  const platformModels = resolvePlatformModelsConfig(input.platformModels);
  const result: ModelTasksConfig = {};
  for (const name of TASK_NAMES) {
    const platform = input.platformTasks?.[name];
    const user = input.userTasks?.[name];
    if ((!platform && !user) || (user?.enabled ?? platform?.enabled) === false) continue;

    let task: ModelTaskConfig;
    if (user?.model) {
      // Replacing the task model also replaces platform task credentials,
      // headers and endpoint overrides. Users may select a trusted catalog
      // model, but must define their own provider for a different transport.
      const provider = user.model.provider?.trim() ?? "";
      const usesPlatformProvider = Object.hasOwn(platformModels.providers, provider)
        && !Object.hasOwn(input.userModels?.providers ?? {}, provider);
      if (usesPlatformProvider) {
        if (Object.keys(user.model).some((key) => !USER_PLATFORM_MODEL_FIELDS.has(key))) {
          throw new Error("User model tasks cannot override platform model connection settings");
        }
        if (!platformModels.providers[provider]?.models?.some((model) => model.id === user.model?.id?.trim())) {
          throw new Error("User model tasks must select a configured platform model");
        }
      }
      const models = usesPlatformProvider ? platformModels : input.userModels ?? { providers: {} };
      task = resolveTask(name, { ...platform, ...user, model: user.model }, models);
      if (!usesPlatformProvider) assertUserModelCredentials(task.model);
    } else {
      // Prompt/enabled overrides retain the platform model as one trusted unit,
      // even if a user catalog shadows the same provider name.
      const model = platform?.model && {
        ...platform.model,
        apiKey: resolvePlatformModelApiKey(platform.model.apiKey),
      };
      task = resolveTask(name, { ...platform, ...user, model }, platformModels);
    }
    result[name] = task;
  }
  return result;
}

function resolveTask(
  name: ModelTaskName,
  task: ModelTaskConfigOverride,
  models: ModelsConfig,
): ModelTaskConfig {
  const provider = task.model?.provider?.trim();
  const id = task.model?.id?.trim();
  const prompt = task.prompt?.trim();
  if (!provider || !id || !prompt) throw new Error("Model task config is incomplete");

  const providerConfig = models.providers[provider];
  const catalogModel = providerConfig?.models?.find((model) => model.id === id);
  const mergedCost = catalogModel?.cost || task.model?.cost
    ? { ...(catalogModel?.cost ?? {}), ...(task.model?.cost ?? {}) }
    : undefined;
  const cost = typeof mergedCost?.input === "number" && typeof mergedCost.output === "number"
    ? mergedCost as ModelCost
    : undefined;
  const model = {
    ...(catalogModel ?? {}),
    ...(task.model ?? {}),
    provider,
    id,
    api: task.model?.api ?? catalogModel?.api ?? providerConfig?.api,
    baseUrl: task.model?.baseUrl ?? catalogModel?.baseUrl ?? providerConfig?.baseUrl,
    apiKey: task.model?.apiKey ?? providerConfig?.apiKey,
    headers: mergeHeaders(providerConfig?.headers, catalogModel?.headers, task.model?.headers),
    cost,
    compat: task.model?.compat ?? catalogModel?.compat ?? providerConfig?.compat,
    requestProfile: task.model?.requestProfile ?? catalogModel?.requestProfile ?? providerConfig?.requestProfile,
    imageUrlInput: task.model?.imageUrlInput ?? catalogModel?.imageUrlInput ?? providerConfig?.imageUrlInput,
  };

  if (typeof model.api !== "string" || typeof model.baseUrl !== "string") {
    throw new Error(`Model task model is unavailable: ${provider}/${id}`);
  }
  if (name === "imageToText" && !model.input?.includes("image")) {
    throw new Error("Image-to-text task requires an image-capable model");
  }
  return { enabled: true, model: { ...model, api: model.api, baseUrl: model.baseUrl }, prompt };
}

type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown>;
};

export function createModelTasksConfigLoader(input: {
  platformConfigRoot: string;
  redis: RedisLike;
}) {
  const taskInflight = new Map<string, Promise<CachedModelTasksConfig>>();
  const modelsInflight = new Map<string, Promise<CachedModelsConfig>>();

  async function loadTasks(path: string, redisKey: string): Promise<CachedModelTasksConfig> {
    const inflight = taskInflight.get(redisKey);
    if (inflight) return inflight;
    const promise = (async () => {
      const cached = await input.redis.get(redisKey).catch(() => null);
      const parsedCached = cached ? parseCachedModelTasksConfig(cached) : null;
      if (parsedCached) return parsedCached;
      try {
        const rawText = await readFile(path, "utf-8");
        const value = createCachedModelTasksConfig({ rawText, content: parseModelTasksConfigOverride(rawText) });
        await input.redis.set(redisKey, JSON.stringify(value), "EX", MODEL_TASKS_CACHE_TTL_SEC).catch(() => undefined);
        return value;
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
        const value = createCachedModelTasksConfig({ content: null });
        await input.redis.set(redisKey, JSON.stringify(value), "EX", MODEL_TASKS_CACHE_TTL_SEC).catch(() => undefined);
        return value;
      }
    })();
    taskInflight.set(redisKey, promise);
    try {
      return await promise;
    } finally {
      taskInflight.delete(redisKey);
    }
  }

  async function loadModels(path: string, redisKey: string): Promise<CachedModelsConfig> {
    const inflight = modelsInflight.get(redisKey);
    if (inflight) return inflight;
    const promise = (async () => {
      const cached = await input.redis.get(redisKey).catch(() => null);
      const parsedCached = cached ? parseCachedModelsConfig(cached) : null;
      if (parsedCached) return parsedCached;
      try {
        const rawText = await readFile(path, "utf-8");
        const value = createCachedModelsConfig({ rawText, content: parseModelsConfig(rawText) });
        await input.redis.set(redisKey, JSON.stringify(value), "EX", MODELS_CACHE_TTL_SEC).catch(() => undefined);
        return value;
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
        return createCachedModelsConfig({ content: null });
      }
    })();
    modelsInflight.set(redisKey, promise);
    try {
      return await promise;
    } finally {
      modelsInflight.delete(redisKey);
    }
  }

  return async function loadModelTasksConfig(userId?: string | null): Promise<ResolvedModelTasksConfig> {
    const normalizedUserId = userId?.trim() || null;
    const [platformTasks, userTasks, platformModels, userModels] = await Promise.all([
      loadTasks(join(input.platformConfigRoot, "platform", MODEL_TASKS_CONFIG_PATH), PLATFORM_MODEL_TASKS_REDIS_KEY),
      normalizedUserId
        ? loadTasks(join(input.platformConfigRoot, "users", normalizedUserId, MODEL_TASKS_CONFIG_PATH), getUserModelTasksRedisKey(normalizedUserId))
        : null,
      loadModels(join(input.platformConfigRoot, "platform", ".cohub/models.json"), PLATFORM_MODELS_REDIS_KEY),
      normalizedUserId
        ? loadModels(join(input.platformConfigRoot, "users", normalizedUserId, ".cohub/models.json"), getUserModelsRedisKey(normalizedUserId))
        : null,
    ]);
    return {
      ...resolveModelTasksConfig({
        platformTasks: platformTasks.content,
        userTasks: userTasks?.content,
        platformModels: platformModels.content,
        userModels: userModels?.content,
      }),
      revision: [platformTasks.rev, userTasks?.rev, platformModels.rev, userModels?.rev].filter(Boolean).join("/"),
    };
  };
}
