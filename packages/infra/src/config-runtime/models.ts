export const MODELS_REDIS_KEY_VERSION = "v2";
export const PLATFORM_MODELS_REDIS_KEY = `configs:models:${MODELS_REDIS_KEY_VERSION}:platform`;
export const USER_MODELS_REDIS_KEY_PREFIX = `configs:models:${MODELS_REDIS_KEY_VERSION}:user`;
export const MODELS_CACHE_TTL_SEC = 24 * 60 * 60;

const SAFE_REDIS_KEY_SEGMENT_REGEX = /^[0-9a-zA-Z_-]+$/;

export type ModelCost = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelRequestProfile = "codex" | "claude-code";
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;

export type ModelDef = {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  defaultThinkingLevel?: ModelThinkingLevel;
  thinkingLevelMap?: ThinkingLevelMap;
  /** Hide this model from UI pickers while keeping it available for runtime use. */
  hidden?: boolean;
  input?: Array<"text" | "image">;
  cost?: ModelCost;
  contextWindow?: number;
  maxTokens?: number;
  requestProfile?: ModelRequestProfile;
  /** `false` sends remote images inline instead of as URLs. */
  imageUrlInput?: boolean;
  headers?: Record<string, string>;
  compat?: unknown;
  [key: string]: unknown;
};

export type ProviderConfig = {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  requestProfile?: ModelRequestProfile;
  imageUrlInput?: boolean;
  headers?: Record<string, string>;
  compat?: unknown;
  models?: ModelDef[];
  [key: string]: unknown;
};

export type ModelsConfig = {
  providers: Record<string, ProviderConfig>;
};

const THINKING_LEVELS = new Set<ModelThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const REQUEST_PROFILES = new Set<ModelRequestProfile>(["codex", "claude-code"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function isHttpUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isThinkingLevelMap(value: unknown): value is ThinkingLevelMap {
  return isRecord(value) && Object.entries(value).every(([level, mapped]) =>
    THINKING_LEVELS.has(level as ModelThinkingLevel) && (mapped === null || typeof mapped === "string"));
}

function isModelCost(value: unknown, partial: boolean): boolean {
  if (!isRecord(value)) return false;
  const keys = ["input", "output", "cacheRead", "cacheWrite"] as const;
  if (!Object.keys(value).every((key) => (keys as readonly string[]).includes(key))) return false;
  if (!keys.every((key) => value[key] === undefined || isFiniteNonNegative(value[key]))) return false;
  return partial || (isFiniteNonNegative(value.input) && isFiniteNonNegative(value.output));
}

export function isModelDefinition(value: unknown, options: { partial?: boolean } = {}): boolean {
  if (!isRecord(value)) return false;
  const partial = options.partial === true;
  return (partial ? value.id === undefined || isNonEmptyString(value.id) : isNonEmptyString(value.id))
    && (value.name === undefined || typeof value.name === "string")
    && (value.api === undefined || isNonEmptyString(value.api))
    && (value.baseUrl === undefined || isHttpUrl(value.baseUrl))
    && (value.reasoning === undefined || typeof value.reasoning === "boolean")
    && (value.defaultThinkingLevel === undefined || THINKING_LEVELS.has(value.defaultThinkingLevel as ModelThinkingLevel))
    && (value.thinkingLevelMap === undefined || isThinkingLevelMap(value.thinkingLevelMap))
    && (value.hidden === undefined || typeof value.hidden === "boolean")
    && (value.input === undefined || (Array.isArray(value.input) && value.input.length > 0 && value.input.every((item) => item === "text" || item === "image")))
    && (value.cost === undefined || isModelCost(value.cost, partial))
    && (value.contextWindow === undefined || isPositiveInteger(value.contextWindow))
    && (value.maxTokens === undefined || isPositiveInteger(value.maxTokens))
    && (value.requestProfile === undefined || REQUEST_PROFILES.has(value.requestProfile as ModelRequestProfile))
    && (value.imageUrlInput === undefined || typeof value.imageUrlInput === "boolean")
    && (value.headers === undefined || isStringRecord(value.headers))
    && (value.compat === undefined || isRecord(value.compat));
}

function isProviderConfig(value: unknown): value is ProviderConfig {
  if (!isRecord(value)) return false;
  return (value.baseUrl === undefined || isHttpUrl(value.baseUrl))
    && (value.apiKey === undefined || isNonEmptyString(value.apiKey))
    && (value.api === undefined || isNonEmptyString(value.api))
    && (value.requestProfile === undefined || REQUEST_PROFILES.has(value.requestProfile as ModelRequestProfile))
    && (value.imageUrlInput === undefined || typeof value.imageUrlInput === "boolean")
    && (value.headers === undefined || isStringRecord(value.headers))
    && (value.compat === undefined || isRecord(value.compat))
    && (value.models === undefined || (Array.isArray(value.models) && value.models.every((model) => isModelDefinition(model))));
}

export function mergeHeaders<T extends string | null = string>(
  ...sources: Array<Record<string, T> | null | undefined>
): Record<string, T> | undefined {
  const merged: Record<string, T> = {};
  const names = new Map<string, string>();

  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      const normalized = name.toLowerCase();
      const previousName = names.get(normalized);
      if (previousName) delete merged[previousName];
      merged[name] = value;
      names.set(normalized, name);
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export type CachedModelsConfig = {
  rev: string;
  updatedAt: string;
  sourceCheckpointId?: string | null;
  content: ModelsConfig | null;
};

export type ModelCatalogEntry = {
  provider: string;
  id: string;
  model: Record<string, unknown>;
};

export function assertSafeRedisKeySegment(value: string, label = "value"): string {
  const trimmed = value.trim();
  if (!SAFE_REDIS_KEY_SEGMENT_REGEX.test(trimmed)) {
    throw new Error(`Invalid ${label} for Redis key`);
  }
  return trimmed;
}

export function getUserModelsRedisKey(userId: string): string {
  return `${USER_MODELS_REDIS_KEY_PREFIX}:${assertSafeRedisKeySegment(userId, "userId")}`;
}

export function isModelsConfig(value: unknown): value is ModelsConfig {
  if (!isRecord(value) || !isRecord(value.providers)) return false;
  return Object.entries(value.providers).every(([provider, config]) =>
    Boolean(provider.trim()) && isProviderConfig(config));
}

export function parseModelsConfig(rawText: string): ModelsConfig {
  const parsed = JSON.parse(rawText) as unknown;
  if (!isModelsConfig(parsed)) {
    throw new Error("Models catalog file has invalid schema");
  }
  return parsed;
}

function createFastContentHash(rawText: string): string {
  let hash = 2166136261;
  for (let i = 0; i < rawText.length; i++) {
    hash ^= rawText.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16)}:${rawText.length}`;
}

export function createCachedModelsConfig(input: {
  rawText?: string;
  content: ModelsConfig | null;
  sourceCheckpointId?: string | null;
  rev?: string;
  updatedAt?: string;
}): CachedModelsConfig {
  return {
    rev: input.rev ?? (input.rawText ? createFastContentHash(input.rawText) : `missing:${input.sourceCheckpointId ?? "unknown"}`),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    sourceCheckpointId: input.sourceCheckpointId ?? null,
    content: input.content,
  };
}

export function parseCachedModelsConfig(rawText: string): CachedModelsConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const content = record.content;
  if (content !== null && !isModelsConfig(content)) return null;
  return {
    rev: typeof record.rev === "string" ? record.rev : "unknown",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
    sourceCheckpointId: typeof record.sourceCheckpointId === "string" ? record.sourceCheckpointId : null,
    content,
  };
}

export function mergeModelsConfigs(...configs: Array<ModelsConfig | null | undefined>): ModelsConfig {
  const providers: Record<string, ProviderConfig> = {};

  for (const config of configs) {
    if (!config) continue;
    for (const [provider, providerConfig] of Object.entries(config.providers ?? {})) {
      const existing = providers[provider] ?? {};
      const mergedModels = new Map<string, ModelDef>();

      for (const model of existing.models ?? []) {
        if (model.id) mergedModels.set(model.id, model);
      }
      for (const model of providerConfig.models ?? []) {
        if (model.id) mergedModels.set(model.id, model);
      }

      providers[provider] = {
        ...existing,
        ...providerConfig,
        headers: {
          ...(existing.headers ?? {}),
          ...(providerConfig.headers ?? {}),
        },
        models: [...mergedModels.values()],
      };
    }
  }

  return { providers };
}

export function flattenModelsCatalog(config: ModelsConfig | null | undefined): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [];
  for (const [provider, providerConfig] of Object.entries(config?.providers ?? {})) {
    for (const model of providerConfig.models ?? []) {
      entries.push({ provider, id: String(model.id), model: model as Record<string, unknown> });
    }
  }
  return entries;
}

export function isRuntimeModelAvailable(
  configs: Array<ModelsConfig | null | undefined>,
  provider: string,
  modelId: string,
): boolean {
  const providerConfig = mergeModelsConfigs(...configs).providers[provider];
  const model = providerConfig?.models?.find((entry) => entry.id === modelId);
  return Boolean(
    model &&
    (model.api ?? providerConfig?.api) &&
    (model.baseUrl ?? providerConfig?.baseUrl),
  );
}
