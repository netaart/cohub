import { isModelThinkingLevel, MODEL_THINKING_LEVELS as thinkingLevels, RUNTIME_MAX_SERVICE_TIERS, runtimeServiceTierSchema, STANDARD_SERVICE_TIER, thinkingLevelMapFor, type RuntimeModel as Model } from "@neta-art/cohub";
import { record, type JsonRecord } from "./json-rpc.js";

const thinkingLevel = (value: unknown) => isModelThinkingLevel(value) ? value : undefined;

/**
 * Publish only picker metadata, never provider credentials or request configuration.
 * `state` is a fresh Pi's `get_state`: its model is what Pi runs when Cohub requests
 * nothing, and its level is resolved and clamped for that model only. Pi's levels for
 * other models live in its settings, which RPC does not expose; those models fall back
 * to the picker's rule, and Cohub always sends the chosen level explicitly.
 */
export function piModelCatalog(entries: unknown[], state: JsonRecord): Model[] {
  const current = record(state.model);
  const currentLevel = thinkingLevel(state.thinkingLevel);
  return entries.flatMap((value) => {
    const model = record(value);
    if (typeof model.id !== "string" || !model.id || typeof model.provider !== "string" || !model.provider) return [];
    const map = record(model.thinkingLevelMap);
    const thinkingLevelMap = thinkingLevelMapFor((level) => map[level] === null || typeof map[level] === "string" ? map[level] : undefined);
    const isDefault = current.provider === model.provider && current.id === model.id;
    return [{
      harness: "pi", id: model.id, provider: model.provider, name: typeof model.name === "string" ? model.name : model.id,
      ...(isDefault ? { isDefault } : {}),
      ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
      ...(isDefault && currentLevel ? { defaultThinkingLevel: currentLevel } : {}),
      ...(Object.keys(thinkingLevelMap).length ? { thinkingLevelMap } : {}),
    }];
  });
}

const codexLevel = (value: unknown) => thinkingLevel(value === "none" ? "off" : value);

function codexThinking(model: JsonRecord): Pick<Model, "reasoning" | "defaultThinkingLevel" | "thinkingLevelMap"> {
  if (!Array.isArray(model.supportedReasoningEfforts)) return {};
  const efforts = new Set(model.supportedReasoningEfforts.map((entry) => record(entry).reasoningEffort));
  const thinkingLevelMap = thinkingLevelMapFor((level) => {
    const effort = level === "off" ? "none" : level;
    return efforts.has(effort) ? effort : null;
  });
  const level = codexLevel(model.defaultReasoningEffort);
  const defaultThinkingLevel = level && thinkingLevelMap[level] != null ? level : undefined;
  return {
    reasoning: thinkingLevels.some((level) => level !== "off" && thinkingLevelMap[level] != null),
    thinkingLevelMap,
    ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
  };
}

/** `serviceTiers` supersedes the deprecated `additionalSpeedTiers`, which only names tier ids. */
function codexServiceTiers(model: JsonRecord): Pick<Model, "serviceTiers" | "defaultServiceTier"> {
  const candidates = Array.isArray(model.serviceTiers)
    ? model.serviceTiers.map((entry) => {
      const tier = record(entry);
      return { id: tier.id, name: tier.name, ...(typeof tier.description === "string" && tier.description ? { description: tier.description } : {}) };
    })
    : Array.isArray(model.additionalSpeedTiers) ? model.additionalSpeedTiers.map((id) => ({ id, name: id })) : [];
  // An entry outside the protocol's bounds is dropped rather than invalidating the whole catalog.
  const tiers = candidates.flatMap((tier) => {
    const parsed = runtimeServiceTierSchema.safeParse(tier);
    return parsed.success ? [parsed.data] : [];
  }).slice(0, RUNTIME_MAX_SERVICE_TIERS);
  const defaultServiceTier = tiers.find((tier) => tier.id === model.defaultServiceTier)?.id;
  return { ...(tiers.length ? { serviceTiers: tiers } : {}), ...(defaultServiceTier ? { defaultServiceTier } : {}) };
}

// Private to one Runtime (including its preflight → worker handoff); never sent to the Gateway.
export type CatalogCache = { codex?: { provider: string; configuredModel: string | null; models: Model[] } };

function codexListedModels(provider: string, entries: unknown[]): Model[] {
  return entries.flatMap((value) => {
    const model = record(value);
    const id = typeof model.model === "string" ? model.model : typeof model.id === "string" ? model.id : null;
    if (!id || model.hidden) return [];
    return [{ harness: "codex", provider, id, name: typeof model.displayName === "string" ? model.displayName : id, ...(model.isDefault === true ? { isDefault: true } : {}), ...codexThinking(model), ...codexServiceTiers(model) }];
  });
}

export function codexModelCatalog(configResponse: JsonRecord, entries: unknown[], cache?: CatalogCache): Model[] {
  const config = record(configResponse.config);
  const provider = typeof config.model_provider === "string" ? config.model_provider : "openai";
  const configuredModel = typeof config.model === "string" ? config.model : null;
  const previous = cache?.codex;
  const listed = !entries.length && previous?.provider === provider && previous.configuredModel === configuredModel
    ? previous.models : codexListedModels(provider, entries);
  if (cache) cache.codex = { provider, configuredModel, models: listed };

  const effort = codexLevel(config.model_reasoning_effort);
  const tier = config.service_tier === "fast" ? "priority" : config.service_tier;
  const models = listed.map(({ isDefault, defaultServiceTier, ...model }) => {
    const preferred = typeof tier === "string" && tier ? tier : defaultServiceTier;
    const selectedTier = tier !== STANDARD_SERVICE_TIER && model.serviceTiers?.find((item) => item.id === preferred)?.id;
    const selectedDefault = configuredModel ? model.id === configuredModel : isDefault;
    return { ...model, ...(selectedDefault ? { isDefault: true } : {}),
      ...(effort && model.thinkingLevelMap?.[effort] != null ? { defaultThinkingLevel: effort } : {}),
      ...(selectedTier ? { defaultServiceTier: selectedTier } : {}) };
  });
  if (configuredModel && !models.some((model) => model.id === configuredModel)) models.unshift({ harness: "codex", provider, id: configuredModel, name: configuredModel, isDefault: true });
  return models;
}
