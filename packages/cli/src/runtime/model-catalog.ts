import { isModelThinkingLevel, MODEL_THINKING_LEVELS as thinkingLevels, RUNTIME_MAX_SERVICE_TIERS, runtimeServiceTierSchema, thinkingLevelMapFor, type RuntimeModel as Model } from "@neta-art/cohub";
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

function codexThinking(model: JsonRecord, configuredEffort: unknown): Pick<Model, "reasoning" | "defaultThinkingLevel" | "thinkingLevelMap"> {
  if (!Array.isArray(model.supportedReasoningEfforts)) return {};
  const efforts = new Set(model.supportedReasoningEfforts.map((entry) => record(entry).reasoningEffort));
  const thinkingLevelMap = thinkingLevelMapFor((level) => {
    const effort = level === "off" ? "none" : level;
    return efforts.has(effort) ? effort : null;
  });
  const normalize = (value: unknown) => thinkingLevel(value === "none" ? "off" : value);
  const configured = normalize(configuredEffort);
  const fallback = normalize(model.defaultReasoningEffort);
  const defaultThinkingLevel = [configured, fallback].find((level) => level && thinkingLevelMap[level] != null);
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
  const defaultServiceTier = typeof model.defaultServiceTier === "string" && tiers.some((tier) => tier.id === model.defaultServiceTier) ? model.defaultServiceTier : undefined;
  return { ...(tiers.length ? { serviceTiers: tiers } : {}), ...(defaultServiceTier ? { defaultServiceTier } : {}) };
}

/** Use Codex's picker-visible model/list for every provider, including custom providers. */
export function codexModelCatalog(configResponse: JsonRecord, entries: unknown[]): Model[] {
  const config = record(configResponse.config);
  const provider = typeof config.model_provider === "string" ? config.model_provider : "openai";
  const configuredModel = typeof config.model === "string" ? config.model : null;
  const models: Model[] = entries.flatMap((value) => {
    const model = record(value);
    const id = typeof model.model === "string" ? model.model : typeof model.id === "string" ? model.id : null;
    if (!id || model.hidden) return [];
    // A configured model replaces the catalog's own default.
    const isDefault = configuredModel ? id === configuredModel : model.isDefault === true;
    return [{ harness: "codex", provider, id, name: typeof model.displayName === "string" ? model.displayName : id, ...(isDefault ? { isDefault } : {}), ...codexThinking(model, config.model_reasoning_effort), ...codexServiceTiers(model) }];
  });
  if (configuredModel && !models.some((model) => model.id === configuredModel)) models.unshift({ harness: "codex", provider, id: configuredModel, name: configuredModel, isDefault: true });
  return models;
}
