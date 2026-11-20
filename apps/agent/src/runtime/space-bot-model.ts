import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isModelThinkingLevel, type ModelThinkingLevel } from "@cohub/protocol";
import { logger } from "../logger.js";
import type { CohubModelRegistry } from "./model-registry.js";
import { getAgentWorkspacePath } from "./paths.js";

// Same window the cohubbot `tell` wake-up pins, so a bare prompt and a tell run alike.
const SPACE_BOT_DEFAULT_CONTEXT_WINDOW = 200_000;

type SpaceBotModel = {
  provider: string;
  id: string;
  thinkingLevel?: ModelThinkingLevel;
  contextWindow: number;
};

export type PromptModelRequest = {
  requestedModel?: { provider: string; id: string };
  requestedThinkingLevel?: string | null;
  requestedContextWindow?: number | null;
};

function parseSpaceBotModel(raw: string, spaceId: string): SpaceBotModel | null {
  let config: { model?: { provider?: unknown; id?: unknown; thinkingLevel?: unknown }; contextWindow?: unknown } | null;
  try {
    config = JSON.parse(raw);
  } catch {
    logger.warn(`[Agent] ignoring invalid .agents/bot.json spaceId=${spaceId}: not JSON`);
    return null;
  }
  const provider = typeof config?.model?.provider === "string" ? config.model.provider.trim() : "";
  const id = typeof config?.model?.id === "string" ? config.model.id.trim() : "";
  if (!provider || !id) return null;
  const thinkingLevel = config?.model?.thinkingLevel;
  const windowValue = config?.contextWindow;
  const contextWindow = typeof windowValue === "number" && Number.isSafeInteger(windowValue) && windowValue > 0
    ? windowValue
    : SPACE_BOT_DEFAULT_CONTEXT_WINDOW;
  return { provider, id, thinkingLevel: isModelThinkingLevel(thinkingLevel) ? thinkingLevel : undefined, contextWindow };
}

async function readSpaceBotModel(spaceId: string): Promise<SpaceBotModel | null> {
  const raw = await readFile(join(getAgentWorkspacePath(spaceId), ".agents", "bot.json"), "utf-8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") logger.warn(`[Agent] failed to read .agents/bot.json spaceId=${spaceId}; using deployment default`, error);
    return null;
  });
  return raw === null ? null : parseSpaceBotModel(raw, spaceId);
}

/**
 * A turn without an explicit model runs on its Space Bot's model from `.agents/bot.json`.
 * Explicit model wins; a missing or unavailable model keeps the request as it was, so the session's
 * own model or the deployment default applies.
 */
export async function resolveSpaceBotPromptModel(
  spaceId: string,
  request: PromptModelRequest,
  modelRegistry: Pick<CohubModelRegistry, "find">,
): Promise<PromptModelRequest> {
  if (request.requestedModel) return request;
  const bot = await readSpaceBotModel(spaceId);
  if (!bot) return request;
  if (!modelRegistry.find(bot.provider, bot.id)) {
    logger.warn(`[Agent] .agents/bot.json model is not available; using deployment default spaceId=${spaceId} model=${bot.provider}/${bot.id}`);
    return request;
  }
  return {
    requestedModel: { provider: bot.provider, id: bot.id },
    requestedThinkingLevel: request.requestedThinkingLevel ?? bot.thinkingLevel,
    requestedContextWindow: request.requestedContextWindow ?? bot.contextWindow,
  };
}
