import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { CohubModel } from "./model-registry.js";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function normalizeThinkingLevel(level: string | null | undefined): ThinkingLevel | undefined {
  return level && THINKING_LEVELS.has(level as ThinkingLevel) ? level as ThinkingLevel : undefined;
}

/** Requested level (or the model default) clamped to what the model supports. */
export function resolveThinkingLevelForModel(model: CohubModel, requested?: string | null): ThinkingLevel {
  const fallback = normalizeThinkingLevel(model.defaultThinkingLevel) ?? (model.reasoning ? "high" : "off");
  const level = normalizeThinkingLevel(requested) ?? fallback;
  if (!model.reasoning) return "off";
  return clampThinkingLevel(model, level) as ThinkingLevel;
}

/**
 * Initial thinking level when a session handle is (re)created.
 *
 * A brand-new session starts at the model default. A resumed session uses the
 * level recorded in its file; if that record was lost, it falls back to the
 * user's latest explicit selection, then to the lowest level the model supports.
 */
export async function resolveInitialThinkingLevel(model: CohubModel, input: {
  recorded: string | null;
  resumed: boolean;
  loadSelected?: () => Promise<string | null>;
}): Promise<ThinkingLevel> {
  if (normalizeThinkingLevel(input.recorded) || !input.resumed) return resolveThinkingLevelForModel(model, input.recorded);
  const selected = normalizeThinkingLevel(await input.loadSelected?.());
  return resolveThinkingLevelForModel(model, selected ?? getSupportedThinkingLevels(model)[0] ?? "off");
}
