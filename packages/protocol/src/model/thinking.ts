import { z } from "zod";

/** Every thinking level a Harness or model can declare, in ascending order. */
export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ModelThinkingLevel = (typeof MODEL_THINKING_LEVELS)[number];

/** Offered only when the model's `thinkingLevelMap` names them. */
const OPT_IN_THINKING_LEVELS: ReadonlySet<ModelThinkingLevel> = new Set(["xhigh", "max", "ultra"]);

export const modelThinkingLevelSchema = z.enum(MODEL_THINKING_LEVELS);

type ThinkingModel = { reasoning?: unknown; thinkingLevelMap?: unknown; [key: string]: unknown };

/**
 * A `thinkingLevelMap` from a Harness's native value per level: `null` when unsupported, `undefined` to leave
 * the level out. An unsupported opt-in level is left out too: absent already means unsupported, and readers
 * that predate the level accept the map.
 */
export function thinkingLevelMapFor(native: (level: ModelThinkingLevel) => string | null | undefined): Partial<Record<ModelThinkingLevel, string | null>> {
  return Object.fromEntries(MODEL_THINKING_LEVELS.flatMap((level) => {
    const value = native(level);
    return value === undefined || (value === null && OPT_IN_THINKING_LEVELS.has(level)) ? [] : [[level, value]];
  }));
}

export const isModelThinkingLevel = (value: unknown): value is ModelThinkingLevel =>
  typeof value === "string" && (MODEL_THINKING_LEVELS as readonly string[]).includes(value);

/** Mirrors pi-ai's rule: non-reasoning models only run `off`; a `null` entry removes a level. */
export function supportedThinkingLevels(model: ThinkingModel): ModelThinkingLevel[] {
  if (model.reasoning !== true) return ["off"];
  const map = model.thinkingLevelMap && typeof model.thinkingLevelMap === "object"
    ? model.thinkingLevelMap as Partial<Record<string, unknown>>
    : undefined;
  return MODEL_THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    return !OPT_IN_THINKING_LEVELS.has(level) || mapped !== undefined;
  });
}

/** Mirrors pi-ai's clamp: the nearest supported level at or above the request, else below it. */
export function clampThinkingLevel(model: ThinkingModel, requested: ModelThinkingLevel): ModelThinkingLevel {
  const supported = supportedThinkingLevels(model);
  if (supported.includes(requested)) return requested;
  const index = MODEL_THINKING_LEVELS.indexOf(requested);
  return MODEL_THINKING_LEVELS.slice(index).find((level) => supported.includes(level))
    ?? MODEL_THINKING_LEVELS.slice(0, index).reverse().find((level) => supported.includes(level))
    ?? supported[0] ?? "off";
}
