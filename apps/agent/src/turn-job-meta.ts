import type { Job } from "bullmq";
import { logger } from "./logger.js";
import { getPromptAuthScopes, parsePromptEnv, type PromptAccessMode } from "@cohub/core/sessions";
import { createAgentExecutionToken } from "./execution-grants.js";

export function resolveRequestedModel(ownerMeta: Record<string, unknown>) {
  const provider = typeof ownerMeta.provider === "string" && ownerMeta.provider.trim() ? ownerMeta.provider.trim() : null;
  const model = typeof ownerMeta.model === "string" && ownerMeta.model.trim() ? ownerMeta.model.trim() : null;
  return provider && model ? { provider, id: model } : undefined;
}

export function resolveRequestedThinkingLevel(ownerMeta: Record<string, unknown>): string | null | undefined {
  if (typeof ownerMeta.requestedThinkingLevel !== "string") return undefined;
  const trimmed = ownerMeta.requestedThinkingLevel.trim();
  return trimmed || null;
}

export function resolveActorUserId(ownerMeta: Record<string, unknown>) {
  return typeof ownerMeta.userId === "string" && ownerMeta.userId.trim() ? ownerMeta.userId.trim() : null;
}

export function resolveSourceClientId(ownerMeta: Record<string, unknown>) {
  const sourceClientId = ownerMeta.sourceClientId;
  return typeof sourceClientId === "string" && sourceClientId.trim() ? sourceClientId.trim() : null;
}

function resolveContextHookEnv(ownerMeta: Record<string, unknown>) {
  const context = ownerMeta.context && typeof ownerMeta.context === "object" && !Array.isArray(ownerMeta.context)
    ? ownerMeta.context as Record<string, unknown>
    : null;
  if (context?.kind !== "space_hook") return null;
  const env = context.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("COHUB_HOOK_")) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function resolvePromptEnv(ownerMeta: Record<string, unknown>) {
  let userEnv: Record<string, string> | null = null;
  try {
    userEnv = parsePromptEnv(ownerMeta.env);
  } catch (error) {
    logger.warn(`[Agent] ignoring invalid prompt env: ${error instanceof Error ? error.message : String(error)}`);
  }
  const hookEnv = resolveContextHookEnv(ownerMeta);
  if (!userEnv && !hookEnv) return null;
  // System hook keys win over user prompt.env.
  return { ...(userEnv ?? {}), ...(hookEnv ?? {}) };
}

export async function createTurnExecutionToken(input: {
  accessMode: PromptAccessMode;
  actorUserId: string;
  spaceId: string;
  sessionId: string;
  turnId: string;
  source: unknown;
  promptAuth?: unknown;
}) {
  if (input.accessMode !== "full_access") return null;
  return createAgentExecutionToken({
    actorUserId: input.actorUserId,
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    source: typeof input.source === "string" && input.source.trim() ? input.source.trim() : "agent_turn",
    scopes: getPromptAuthScopes(input.promptAuth, input.spaceId),
  });
}

function getSpaceBootstrapMeta(meta: unknown) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const bootstrap = (meta as Record<string, unknown>).bootstrap;
  if (!bootstrap || typeof bootstrap !== "object" || Array.isArray(bootstrap)) return null;
  return bootstrap as Record<string, unknown>;
}

export function logSpaceBootstrapWarning(spaceId: string, meta: unknown) {
  const bootstrap = getSpaceBootstrapMeta(meta);
  const status = typeof bootstrap?.status === "string" ? bootstrap.status : null;
  if (!status || status === "ready") return;
  logger.warn(`[Agent] space bootstrap is not ready; continuing execution spaceId=${spaceId} status=${status} stage=${typeof bootstrap?.stage === "string" ? bootstrap.stage : ""} error=${typeof bootstrap?.errorMessage === "string" ? bootstrap.errorMessage : ""}`);
}

export function getQueueWaitMs(job: Pick<Job<unknown>, "timestamp" | "processedOn">) {
  if (!job.timestamp) return null;
  const processedAt = job.processedOn && job.processedOn >= job.timestamp ? job.processedOn : Date.now();
  return Math.max(0, processedAt - job.timestamp);
}
