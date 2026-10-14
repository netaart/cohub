import { clampThinkingLevel, type Api, type Model, type ProviderStreams, type SimpleStreamOptions, type ThinkingLevel } from "@earendil-works/pi-ai";

type GoogleModel = Model<"google-generative-ai" | "google-vertex">;
type GooglePayload = { config?: { thinkingConfig?: { thinkingBudget?: number } } };

const GEMINI_MAJOR_VERSION = /^gemini(?:-live)?-(\d+)/;

/**
 * Gemini 4 rejects `thinkingBudget` ("Use thinking level instead"), but pi-ai only
 * sends `thinkingLevel` for the Gemini 3 IDs it recognizes and falls back to a
 * budget for every other model (earendil-works/pi#10890). Once pi-ai sends a level
 * itself, no budget reaches the payload and this rewrite does nothing.
 */
const requiresThinkingLevel = (model: Model<Api>) =>
  model.reasoning && Number(GEMINI_MAJOR_VERSION.exec(model.id.toLowerCase())?.[1] ?? 0) >= 4;

/** The thinking config pi-ai builds for its thinking-level models; `undefined` when pi-ai would also disable thinking with a budget. */
async function thinkingLevelConfig(model: GoogleModel, reasoning: ThinkingLevel | undefined) {
  // Loaded only after the Google adapter already imported it, so this never pulls @google/genai early.
  const google = await import("@earendil-works/pi-ai/api/google-shared");
  const toLevel = (level: ThinkingLevel) =>
    google.toGoogleSdkThinkingLevel(google.toGoogleThinkingLevel(google.resolveGoogleThinkingLevel(model, level)));
  const level = reasoning ? clampThinkingLevel(model, reasoning) : "off";
  if (level !== "off") return { includeThoughts: true, thinkingLevel: toLevel(level) };
  const fallback = clampThinkingLevel(model, "off");
  return fallback === "off" ? undefined : { thinkingLevel: toLevel(fallback) };
}

function withThinkingLevelPayload(model: Model<Api>, options?: SimpleStreamOptions): SimpleStreamOptions | undefined {
  if (!requiresThinkingLevel(model)) return options;
  const onPayload = options?.onPayload;
  return {
    ...options,
    onPayload: async (payload, payloadModel) => {
      const next = (onPayload ? ((await onPayload(payload, payloadModel)) ?? payload) : payload) as GooglePayload;
      if (next.config?.thinkingConfig?.thinkingBudget === undefined) return next;
      const thinkingConfig = await thinkingLevelConfig(model as GoogleModel, options?.reasoning);
      return thinkingConfig ? { ...next, config: { ...next.config, thinkingConfig } } : next;
    },
  };
}

/** Send Gemini 4 thinking as `thinkingLevel`, mapped from the requested reasoning level exactly as pi-ai maps Gemini 3. */
export function withGeminiThinkingLevel(streams: ProviderStreams): ProviderStreams {
  return {
    ...streams,
    streamSimple: (model, context, options) => streams.streamSimple(model, context, withThinkingLevelPayload(model, options)),
  };
}
