import { isDeepStrictEqual } from "node:util";

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

const MODEL_PARAMETER_FIELDS = new Set([
  "id", "name", "reasoning", "defaultThinkingLevel", "thinkingLevelMap",
  "hidden", "input", "contextWindow", "maxTokens",
]);

const PROTECTED_MODEL_FIELDS = new Set([
  "api", "baseUrl", "apiKey", "headers", "compat", "requestProfile", "imageUrlInput", "cost",
]);

function assertMatchingPlatformField(
  label: string,
  field: string,
  value: unknown,
  platform: Record<string, unknown>,
) {
  if (!PROTECTED_MODEL_FIELDS.has(field)
    || !Object.hasOwn(platform, field)
    || platform[field] === undefined
    || !isDeepStrictEqual(value, platform[field])) {
    if (field === "cost") throw new Error(`${label} cannot override platform model pricing: cost`);
    throw new Error(`${label} cannot override platform model connection or extension field: ${field}`);
  }
}

export function getProtectedModelFields(provider: ProviderConfig, model: ModelDef): Record<string, unknown> {
  return {
    api: model.api ?? provider.api,
    baseUrl: model.baseUrl ?? provider.baseUrl,
    apiKey: provider.apiKey,
    headers: mergeHeaders(provider.headers, model.headers) ?? model.headers ?? provider.headers,
    compat: model.compat ?? provider.compat,
    requestProfile: model.requestProfile ?? provider.requestProfile,
    imageUrlInput: model.imageUrlInput ?? provider.imageUrlInput,
    cost: model.cost,
  };
}

export function selectModelParameters<T extends { id?: string }>(
  provider: string,
  override: T,
  platformFields: Record<string, unknown>,
  providerHeaders?: Record<string, string>,
): T {
  for (const [field, value] of Object.entries(override)) {
    if (MODEL_PARAMETER_FIELDS.has(field)) continue;
    // 模型 headers 与 provider headers 合并后必须保持平台的有效值。
    const candidate = field === "headers" && isStringRecord(value)
      ? mergeHeaders(providerHeaders, value) ?? value
      : value;
    assertMatchingPlatformField(`User model ${provider}/${override.id}`, field, candidate, platformFields);
  }
  const parameters = { ...override };
  for (const field of Object.keys(parameters)) {
    if (!MODEL_PARAMETER_FIELDS.has(field)) Reflect.deleteProperty(parameters, field);
  }
  return parameters;
}

export function isPlatformModelOverride(provider: string, config: ProviderConfig): boolean {
  return provider === "cohub" || Object.keys(config).every((key) => key === "models");
}

export function mergeModelParameters<T extends { thinkingLevelMap?: ThinkingLevelMap }>(
  base: T,
  override: T,
): T {
  return {
    ...base,
    ...override,
    ...(override.thinkingLevelMap ? { thinkingLevelMap: { ...base.thinkingLevelMap, ...override.thinkingLevelMap } } : {}),
  };
}

export function mergeProviderModelParameters(
  provider: string,
  base: ProviderConfig,
  override: ProviderConfig,
): ProviderConfig {
  for (const [field, value] of Object.entries(override)) {
    if (field !== "models") assertMatchingPlatformField(`User provider ${provider}`, field, value, base);
  }
  const models = new Map((base.models ?? []).map((model) => [model.id, model]));
  for (const model of override.models ?? []) {
    const original = models.get(model.id);
    // Platform models can be retired while user overrides remain persisted.
    // An override must neither add a model nor disable the remaining catalog.
    if (!original) continue;
    const parameters = selectModelParameters(provider, model, getProtectedModelFields(base, original), base.headers);
    models.set(model.id, mergeModelParameters(original, parameters));
  }
  return { ...base, models: [...models.values()] };
}

export function mergeModelsConfigs(
  platform?: ModelsConfig | null,
  ...userConfigs: Array<ModelsConfig | null | undefined>
): ModelsConfig {
  const providers = new Map<string, ProviderConfig>(Object.entries(platform?.providers ?? {}));
  for (const config of userConfigs) {
    for (const [provider, providerConfig] of Object.entries(config?.providers ?? {})) {
      const base = providers.get(provider);
      if (provider === "cohub" && !base) {
        throw new Error("Provider cohub requires a platform model catalog");
      }
      if (base && isPlatformModelOverride(provider, providerConfig)) {
        providers.set(provider, mergeProviderModelParameters(provider, base, providerConfig));
        continue;
      }
      // 自定义连接必须使用自身凭据，参数覆盖则保留原有连接。
      for (const model of providerConfig.models ?? []) {
        assertUserModelCredentials({
          provider,
          id: model.id,
          api: model.api ?? providerConfig.api,
          apiKey: providerConfig.apiKey,
        });
      }
      providers.set(provider, providerConfig);
    }
  }
  return { providers: Object.fromEntries(providers) };
}

/** 仅解析经过来源校验的平台密钥声明。 */
export function resolvePlatformModelApiKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return process.env[value]?.trim() || value;
}

/** Runtime-only copy. Cache and discovery paths must keep the unresolved config. */
export function resolvePlatformModelsConfig(config: ModelsConfig | null | undefined): ModelsConfig {
  return {
    providers: Object.fromEntries(Object.entries(config?.providers ?? {}).map(([provider, value]) => [
      provider,
      { ...value, apiKey: resolvePlatformModelApiKey(value.apiKey) },
    ])),
  };
}

// These adapters use explicit API keys. Cloud adapters with ambient service
// credentials (for example Bedrock/Vertex) are platform-only.
const USER_MODEL_APIS = new Set([
  "anthropic-messages", "azure-openai-responses", "google-generative-ai",
  "mistral-conversations", "openai-codex-responses", "openai-completions",
  "openai-responses", "pi-messages",
]);

export function assertUserModelCredentials(model: {
  provider: string;
  id: string;
  api?: string;
  apiKey?: string;
}) {
  const label = `User model ${model.provider}/${model.id}`;
  if (!model.apiKey?.trim()) {
    throw new Error(`${label} requires an explicit API key`);
  }
  if (!model.api) {
    throw new Error(`${label} requires an API-key-based adapter`);
  }
  if (!USER_MODEL_APIS.has(model.api)) {
    throw new Error(`${label} uses an unsupported API adapter: ${model.api}`);
  }
}

export function resolveRuntimeModelsConfig(input: {
  platform?: ModelsConfig | null;
  user?: ModelsConfig | null;
}): ModelsConfig {
  const merged = mergeModelsConfigs(input.platform, input.user);
  return {
    providers: Object.fromEntries(Object.entries(merged.providers).map(([provider, config]) => {
      const user = Object.hasOwn(input.user?.providers ?? {}, provider) ? input.user?.providers[provider] : undefined;
      const usesPlatform = Object.hasOwn(input.platform?.providers ?? {}, provider)
        && (!user || isPlatformModelOverride(provider, user));
      return [provider, usesPlatform ? { ...config, apiKey: resolvePlatformModelApiKey(config.apiKey) } : config];
    })),
  };
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
