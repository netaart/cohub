import type { RuntimeCapabilities } from "@neta-art/cohub";
import { record, type JsonRecord } from "./json-rpc.js";

type Model = RuntimeCapabilities["models"][number];
type ThinkingLevel = NonNullable<Model["defaultThinkingLevel"]>;
const thinkingLevels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const thinkingLevel = (value: unknown): ThinkingLevel | undefined =>
  thinkingLevels.includes(value as ThinkingLevel) ? value as ThinkingLevel : undefined;

/** Publish only picker metadata, never provider credentials or request configuration. */
export function piModelCatalog(entries: unknown[]): Model[] {
  return entries.flatMap((value) => {
    const model = record(value);
    if (typeof model.id !== "string" || !model.id || typeof model.provider !== "string" || !model.provider) return [];
    const map = record(model.thinkingLevelMap);
    const thinkingLevelMap = Object.fromEntries(thinkingLevels.flatMap((level) =>
      map[level] === null || typeof map[level] === "string" ? [[level, map[level]]] : []));
    const defaultThinkingLevel = thinkingLevel(model.defaultThinkingLevel);
    return [{
      harness: "pi", id: model.id, provider: model.provider, name: typeof model.name === "string" ? model.name : model.id,
      ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
      ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
      ...(Object.keys(thinkingLevelMap).length ? { thinkingLevelMap } : {}),
    }];
  });
}

function codexThinking(model: JsonRecord, configuredEffort: unknown): Pick<Model, "reasoning" | "defaultThinkingLevel" | "thinkingLevelMap"> {
  if (!Array.isArray(model.supportedReasoningEfforts)) return {};
  const efforts = new Set(model.supportedReasoningEfforts.map((entry) => record(entry).reasoningEffort));
  const thinkingLevelMap = Object.fromEntries(thinkingLevels.map((level) => {
    const effort = level === "off" ? "none" : level;
    return [level, efforts.has(effort) ? effort : null];
  }));
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

/** Codex's built-in catalog is not authoritative for an arbitrary custom provider. */
export function codexModelCatalog(configResponse: JsonRecord, entries: unknown[]): Model[] {
  const config = record(configResponse.config);
  const provider = typeof config.model_provider === "string" ? config.model_provider : "openai";
  const configuredModel = typeof config.model === "string" ? config.model : null;
  const customCatalog = typeof config.model_catalog_json === "string";
  const catalog = provider !== "openai" && !customCatalog ? [] : entries;
  const models: Model[] = catalog.flatMap((value) => {
    const model = record(value);
    const id = typeof model.model === "string" ? model.model : typeof model.id === "string" ? model.id : null;
    if (!id || model.hidden) return [];
    return [{ harness: "codex", provider, id, name: typeof model.displayName === "string" ? model.displayName : id, ...codexThinking(model, config.model_reasoning_effort) }];
  });
  if (configuredModel && !models.some((model) => model.id === configuredModel)) models.unshift({ harness: "codex", provider, id: configuredModel, name: configuredModel });
  return models;
}
