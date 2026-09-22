import { BillingAccessBlockedError, COHUB_BILLING_FEATURES, billingOperations } from "@cohub/billing";
import { DEFAULT_SANDBOX_SPEC_ID, SANDBOX_SPECS, getSandboxSpecRank, isSandboxSpecId, type SandboxSpecId } from "@cohub/sandbox-controller";
import { createLogger } from "@cohub/infra/logging";
import { getCurrentRequestId } from "@cohub/infra/tracing";
import { Hono, type Context } from "hono";
import type { ContentBlock } from "@cohub/protocol/core";
import { fileWatcherStatusSchema, getDefaultSpaceModsForEnv, harnessSchema, isLocalHarness, runtimeStopConfirmationSchema, runtimeWorkspaceKey, runtimeWorkspaceStatus } from "@cohub/protocol";
import {
  parseSpaceSlug,
  validatePublicIdentifierAssignment,
} from "@cohub/protocol/public-identifiers";
import { normalizeGenerationPolicy, type GenerationContentBlock } from "@cohub/protocol/generation";
import * as cronParser from "cron-parser";
import { db } from "../../db/index.js";
import { getPostgresErrorConstraint, isPostgresUniqueViolation } from "../../db/postgres-error.js";
import {
  userChannels,
  spaceChannels,
  spaces,
  taskRuns,
  spaceSessions,
  spaceMembers,
  userProfiles,
  sessionTurns,
} from "@cohub/db";
import { eq, and, inArray, desc, lt, or, sql } from "drizzle-orm";
import { useAuth, getOptionalAuth, getAppSessionPrincipal, requireValidId, buildSpaceListItems, authzDenied, getSpacePublicProfile, normalizePublicAvatarUrl } from "../../lib/middleware.js";
import { config } from "../../config.js";
import { scheduleSandboxAutoDestroy } from "../../sandbox-idle-scheduler.js";
import { attachSandboxPublicEndpoints } from "../../sandbox-public-network.js";
import {
  createOwnedSpace,
  provisionCreatedSpace,
  type ProvisionCreatedSpaceResult,
  type SpaceBootstrapSource,
  type SpaceSandboxAutoDestroyPolicy,
  type SpaceSandboxProvider,
} from "../../space-create.js";
import {
  normalizeSpaceBootstrapSource,
  sanitizeSpaceBootstrapSource,
} from "../../space-bootstrap-source.js";
import { getSpaceSandboxBySpaceId, markSandboxSpecPendingRestart, recoverSpaceSandbox, resizeSpaceSandboxToSpec } from "../../space-sandboxes.js";
import { createGenerationSessionExecution, GenerationSessionExecutionError } from "../../generation-session-execution.js";
import {
  createInitialSpaceSession,
  getSpaceById,
  getSpaceSessionById,
  hydrateSessionParticipantProfiles,
  InvalidSessionListCursorError,
  listSpaceSessions,
  normalizeSpaceEnv,
  validateSpaceEnv,
  setSpaceEnv,
  SandboxNotReadyError,
  SpaceEnvValidationError,
} from "../../space-sessions.js";
import { syncSpaceChannelConfigCache, getSpaceChannelsBySpaceId, bindSpaceChannelsToGateway, unbindSpaceChannelFromGateway, updateSpaceChannelConfig } from "../../channels.js";
import { fallbackBoundChannelHealth, getChannelHealthMap } from "../../channel-health.js";
import { createCronJob, enqueueTask } from "../../tasks.js";
import { RUN_COMMAND_TASK_TYPE } from "@cohub/core/commands";
import { sanitizePostgresJsonValue } from "@cohub/core/content/sanitize";
import { assignLabelsToSession, getPinnedSpaceIds, parseLabelRefs, resolveLabelPaths, resolveOrCreateLabelPaths } from "@cohub/core/labels";
import { assignSessionSourceSystemLabel } from "@cohub/core/labels/session-source";
import { hasPermission, getSpaceMemberRole, filterSessionsByPermission, resolvePermissionAccess, asAccountIdentity, listAccessibleSpaceIds } from "../../permissions.js";
import { checkpoints } from "@cohub/db";
import { LogtoUserRequiredError } from "../../user-profiles.js";
import {
  CHECKPOINT_DIFF_CACHE_CONTROL,
  getCheckpointDiffFile,
  getCheckpointDiffSummary,
} from "../../checkpoint-diff.js";
import { checkpointFsJsonError, listCheckpointDirectory, readCheckpointFile } from "../../checkpoint-fs.js";
import type { AuthUser } from "../../lib/middleware.js";
import { submitSessionPrompt } from "../../session-prompts.js";
import { getRuntimeRegistration, getSessionRuntimeRecovery, confirmRuntimeStopped } from "../../runtime.js";
import runtimeArchivesRouter from "./runtime-archives.route.js";
import { HarnessUnavailableError, ModelUnavailableError, parsePromptEnv, PromptEnvValidationError } from "@cohub/core/sessions";
import { delegatedPromptAuthFromAppSession, promptAuthContextFromAppSession } from "../../prompt-auth-context.js";
import { buildSessionTurnResponse } from "../../session-turn-response.js";
import { getSessionTurnById, hydrateTurnAuthorProfiles } from "../../session-turns.js";
import { InvalidSpaceTurnListQueryError, listSpaceTurns } from "../../space-turns.js";
import { dispatchTurnUpdated } from "../../session-output.js";
import { enqueueAgentTurnJob } from "../../agent-turn-queue.js";
import { requestAgentTurnAbort } from "../../agent-turn-abort.js";
import { dispatchLabelAssignmentsUpdated } from "../../realtime-events.js";
import { listSessionForksForSessions, redactSessionForksForViewer } from "../../session-forks.js";
import { fallbackPublicUserProfile, getProfilesByUuids } from "../../user-profiles.js";
import { SYSTEM_ENV_KEY_SET } from "@cohub/protocol/sandbox";
import { prepareSpaceModInserts, spaceModErrorResponse, type CreateSpaceModInput } from "../../space-mods.js";
import { parseChannelConfigPatch, mergeChannelConfig, validateChannelModelConfig } from "../../lib/channel-model-config.js";
import { redisCommandClient } from "../../redis.js";
import { featureGateResponse } from "../../lib/feature-gate.js";
import { billingBlockedResponse } from "../../lib/billing-blocked.js";
import { applyRequestSourceToMeta, getRequestSource, resolveSessionSourceFromRequest } from "../../lib/request-source.js";
import { validatePromptModel } from "../../llm/models.js";


const logger = createLogger({ serviceName: "cohub-api" });
const getSpaceSaveCheckpointLockKey = (spaceId: string) => `cohub:space:${spaceId}:save-checkpoint`;
const router = new Hono();
router.route("/:id/runtime/archives", runtimeArchivesRouter);
const { CronExpressionParser } = cronParser;

type SpaceRouteSessionRecord = NonNullable<Awaited<ReturnType<typeof getSpaceSessionById>>>;

function getPromptAuthContext(c: Context, spaceId: string) {
  return promptAuthContextFromAppSession(getAppSessionPrincipal(c), spaceId);
}

function getScheduledPromptAuthContext(c: Context, spaceId: string, actorUserId: string) {
  return delegatedPromptAuthFromAppSession(getAppSessionPrincipal(c), spaceId, actorUserId);
}



async function buildSpacePromptTurnResponse(session: SpaceRouteSessionRecord | null, turnId: string) {
  const response = session ? await buildSessionTurnResponse(session, turnId) : null;
  return response ? { mode: "immediate" as const, ...response } : null;
}

type SpacePromptSchedule =
  | { mode?: "immediate" }
  | { mode: "delay"; delayMs?: number }
  | { mode: "at"; sendAt?: string }
  | { mode: "repeat"; cronExpression?: string; timezone?: string };

type PromptAccessMode = "read_only" | "full_access";

const normalizePromptAccessMode = (value: unknown): PromptAccessMode | null => {
  if (value === undefined || value === null) return "full_access";
  return value === "read_only" || value === "full_access" ? value : null;
};

type SpacePromptIntent = "followup" | "steer";

const normalizeSpacePromptIntent = (value: unknown): SpacePromptIntent | null => {
  if (value === undefined || value === null) return "followup";
  return value === "followup" || value === "steer" ? value : null;
};

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const normalizePromptThinkingLevel = (value: unknown): string | null | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return VALID_THINKING_LEVELS.has(trimmed) ? trimmed : null;
};

const readMetaRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const sanitizeMeta = (value: Record<string, unknown>) =>
  sanitizePostgresJsonValue(value) as Record<string, unknown>;

type SpaceTurnActionResult = {
  turn: NonNullable<Awaited<ReturnType<typeof getSessionTurnById>>>;
  affectedTurns: NonNullable<Awaited<ReturnType<typeof getSessionTurnById>>>[];
};

async function loadHydratedTurns(sessionId: string, turnIds: string[]) {
  const turns = (await Promise.all(turnIds.map((turnId) => getSessionTurnById(sessionId, turnId))))
    .filter(Boolean) as NonNullable<Awaited<ReturnType<typeof getSessionTurnById>>>[];
  return hydrateTurnAuthorProfiles(turns);
}

async function dispatchAffectedTurnUpdates(input: {
  spaceId: string;
  sessionId: string;
  turns: SpaceTurnActionResult["affectedTurns"];
}) {
  await Promise.all(input.turns.map((turn) =>
    dispatchTurnUpdated({ spaceId: input.spaceId, sessionId: input.sessionId, turn })
      .catch((error) => logger.warn("[SessionTurn] failed to dispatch steered turn", error)),
  ));
}

async function promoteQueuedTurnToSteer(input: {
  spaceId: string;
  sessionId: string;
  turnId: string;
  actorUserId: string;
}): Promise<SpaceTurnActionResult> {
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [session] = await tx.select({ id: spaceSessions.id, spaceId: spaceSessions.spaceId }).from(spaceSessions).where(eq(spaceSessions.id, input.sessionId)).for("update").limit(1);
    if (!session || session.spaceId !== input.spaceId) throw new Error("session not found");

    const [target] = await tx.select().from(sessionTurns).where(and(eq(sessionTurns.id, input.turnId), eq(sessionTurns.sessionId, input.sessionId))).for("update").limit(1);
    if (target?.status !== "queued") throw new Error("turn is not queued");
    if (target.executionKind !== "agent") throw new Error("direct generation turns cannot be steered");
    if (target.intent !== "followup") throw new Error("only follow-up turns can be steered");

    const [maxSequenceRow] = await tx.select({ max: sql<number>`coalesce(max(${sessionTurns.sequence}), 0)::int` }).from(sessionTurns).where(eq(sessionTurns.sessionId, input.sessionId));
    const nextSequence = (maxSequenceRow?.max ?? target.sequence) + 1;
    await tx.update(sessionTurns).set({
      sequence: nextSequence,
      intent: "steer",
      meta: sanitizeMeta({
        ...readMetaRecord(target.meta),
        promotedToSteerAt: now.toISOString(),
        promotedByUserId: input.actorUserId,
        promotedFromIntent: target.intent,
        dispatchIntent: "steer",
      }),
      updatedAt: now,
    }).where(eq(sessionTurns.id, target.id));

    const [activeTurn] = await tx.select({ id: sessionTurns.id, status: sessionTurns.status, meta: sessionTurns.meta }).from(sessionTurns).where(and(eq(sessionTurns.sessionId, input.sessionId), eq(sessionTurns.executionKind, "agent"), inArray(sessionTurns.status, ["running", "abort_requested"]))).orderBy(desc(sessionTurns.sequence)).limit(1);
    if (activeTurn && activeTurn.id !== target.id) {
      await tx.update(sessionTurns).set({
        status: "abort_requested",
        meta: sanitizeMeta({
          ...readMetaRecord(activeTurn.meta),
          abortRequestedAt: now.toISOString(),
          continuedByTurnId: target.id,
          abortActorUserId: input.actorUserId,
        }),
        updatedAt: now,
      }).where(and(eq(sessionTurns.id, activeTurn.id), eq(sessionTurns.executionKind, "agent"), inArray(sessionTurns.status, ["running", "abort_requested"])));
    }

    return { targetId: target.id, activeTurnId: activeTurn?.id ?? null, activeTurnStatus: activeTurn?.status ?? null, affectedTurnIds: [target.id, ...(activeTurn?.id && activeTurn.id !== target.id ? [activeTurn.id] : [])] };
  });

  try {
    await enqueueAgentTurnJob({ spaceId: input.spaceId, sessionId: input.sessionId, reason: "steer" });
  } catch (error) {
    const failedAt = new Date();
    await db.update(sessionTurns).set({
      status: "failed",
      summary: { finishReason: "failed", reason: "enqueue_failed" },
      errorMessage: error instanceof Error ? error.message : String(error),
      meta: sql`coalesce(${sessionTurns.meta}, '{}'::jsonb) || ${JSON.stringify({ enqueueFailedAt: failedAt.toISOString() })}::jsonb`,
      completedAt: failedAt,
      updatedAt: failedAt,
    }).where(and(eq(sessionTurns.id, result.targetId), eq(sessionTurns.sessionId, input.sessionId), eq(sessionTurns.status, "queued")));
    if (result.activeTurnId && result.activeTurnId !== result.targetId && result.activeTurnStatus === "running") {
      await db.update(sessionTurns).set({ status: "running", updatedAt: failedAt }).where(and(eq(sessionTurns.id, result.activeTurnId), eq(sessionTurns.sessionId, input.sessionId), eq(sessionTurns.status, "abort_requested")));
    }
    await loadHydratedTurns(input.sessionId, result.affectedTurnIds)
      .then((turns) => dispatchAffectedTurnUpdates({
        spaceId: input.spaceId,
        sessionId: input.sessionId,
        turns,
      }))
      .catch((dispatchError) => logger.warn("[SessionTurn] failed to dispatch steer enqueue rollback", dispatchError));
    throw new Error("failed to enqueue steered turn");
  }

  if (result.activeTurnId && result.activeTurnId !== result.targetId) {
    await requestAgentTurnAbort({
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      turnId: result.activeTurnId,
      reason: "interrupt",
      continuedByTurnId: result.targetId,
      actorUserId: input.actorUserId,
    }).catch((error) => {
      logger.warn("[SessionTurn] failed to publish steer abort", error);
    });
  }
  const hydrated = await loadHydratedTurns(input.sessionId, result.affectedTurnIds);
  const target = hydrated.find((turn) => turn.id === result.targetId);
  if (!target) throw new Error("turn not found");
  return { turn: target, affectedTurns: hydrated };
}

async function cancelQueuedTurn(input: {
  spaceId: string;
  sessionId: string;
  turnId: string;
  actorUserId: string;
}): Promise<NonNullable<Awaited<ReturnType<typeof getSessionTurnById>>>> {
  const now = new Date();
  const [updated] = await db.transaction(async (tx) => {
    const [session] = await tx.select({ id: spaceSessions.id, spaceId: spaceSessions.spaceId }).from(spaceSessions).where(eq(spaceSessions.id, input.sessionId)).for("update").limit(1);
    if (!session || session.spaceId !== input.spaceId) throw new Error("session not found");
    const [turn] = await tx.select().from(sessionTurns).where(and(eq(sessionTurns.id, input.turnId), eq(sessionTurns.sessionId, input.sessionId))).for("update").limit(1);
    if (turn?.status !== "queued") throw new Error("turn is not queued");
    if (turn.intent !== "followup") throw new Error("only follow-up turns can be cancelled");
    const [maxSequenceRow] = await tx.select({ max: sql<number>`coalesce(max(${sessionTurns.sequence}), 0)::int` }).from(sessionTurns).where(eq(sessionTurns.sessionId, input.sessionId));
    return tx.update(sessionTurns).set({
      sequence: (maxSequenceRow?.max ?? turn.sequence) + 1,
      status: "cancelled",
      summary: { finishReason: "cancelled", reason: "queued_followup_cancelled" },
      meta: sanitizeMeta({
        ...readMetaRecord(turn.meta),
        cancelledAt: now.toISOString(),
        cancelledByUserId: input.actorUserId,
        cancelledBeforeDispatch: true,
      }),
      completedAt: now,
      updatedAt: now,
    }).where(eq(sessionTurns.id, input.turnId)).returning();
  });
  if (!updated) throw new Error("turn not found");
  const turn = await getSessionTurnById(input.sessionId, input.turnId);
  if (!turn) throw new Error("turn not found");
  const [hydrated = turn] = await hydrateTurnAuthorProfiles([turn]);
  return hydrated;
}

type SpacePromptInput = {
  mode?: "agent" | "create";
  generation?: {
    model?: string | null;
    content?: GenerationContentBlock[];
    parameters?: Record<string, unknown>;
    meta?: Record<string, unknown>;
  } | null;
  sessionId?: string | null;
  title?: string | null;
  source?: string | null;
  content?: ContentBlock[];
  model?: string | null;
  provider?: string | null;
  harness?: "cohub" | "pi" | "codex" | null;
  thinkingLevel?: string | null;
  clientMessageId?: string | null;
  generationPolicy?: unknown;
  intent?: SpacePromptIntent | null;
  accessMode?: PromptAccessMode | null;
  schedule?: SpacePromptSchedule | null;
  labelRefs?: unknown;
  env?: unknown;
};

type SpaceConfigInput = {
  sandbox?: {
    provider?: SpaceSandboxProvider;
    autoDestroy?: SpaceSandboxAutoDestroyPolicy;
    spec?: SandboxSpecId;
  };
};

const DEFAULT_SPACE_SANDBOX_AUTO_DESTROY: SpaceSandboxAutoDestroyPolicy = {
  mode: "idle",
  ttlSeconds: config.env === "prod" ? 12 * 60 * 60 : 10 * 60,
};

const MIN_SPACE_SANDBOX_AUTO_DESTROY_TTL_SECONDS = 60;
const MAX_SPACE_SANDBOX_AUTO_DESTROY_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_SPACE_DESCRIPTION_LENGTH = 10_000;
const HOME_SPACE_SLUG = "home";
const HOME_SPACE_NAME = "Home";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeSpaceSlug = (value: unknown): { slug: string | null; error?: string } => {
  if (value === undefined || value === null) return { slug: null };
  if (typeof value !== "string") return { slug: null, error: "slug must be a string or null" };
  const rawSlug = value.trim();
  if (!rawSlug) return { slug: null };
  const slug = parseSpaceSlug(rawSlug);
  if (!slug) {
    return {
      slug: null,
      error: "slug must be 1-80 characters, lowercase letters, numbers, hyphens, or underscores, and cannot start or end with a separator",
    };
  }
  return { slug };
};

const reservedSpaceSlugResponse = (c: Context) => c.json({
  code: "public_identifier_reserved",
  field: "slug",
  message: "This Space slug is reserved.",
}, 400);

const uniqueViolationConstraint = (error: unknown): string | null =>
  isPostgresUniqueViolation(error) ? getPostgresErrorConstraint(error) : null;

type SpaceRow = typeof spaces.$inferSelect;

function compareSpaceActivityDesc(left: SpaceRow, right: SpaceRow): number {
  const leftActivity = left.lastActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const rightActivity = right.lastActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (leftActivity !== rightActivity) return rightActivity - leftActivity;

  const leftCreated = left.createdAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const rightCreated = right.createdAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  return rightCreated - leftCreated;
}

function selectMostRecentSpace(candidates: Array<SpaceRow | null | undefined>): SpaceRow | null {
  return candidates.filter((space): space is SpaceRow => Boolean(space)).sort(compareSpaceActivityDesc)[0] ?? null;
}

const readSpaceConfig = (space: typeof spaces.$inferSelect) => {
  const meta = isRecord(space.meta) ? space.meta : {};
  const config = isRecord(meta.config) ? meta.config : {};
  return { meta, config };
};

const normalizeSpaceSandboxAutoDestroyPolicy = (value: unknown): SpaceSandboxAutoDestroyPolicy => {
  if (!isRecord(value) || typeof value.mode !== "string") {
    throw new Error("sandbox.autoDestroy must be an object with mode");
  }
  if (value.mode === "never") return { mode: "never" };
  if (value.mode !== "idle") {
    throw new Error("sandbox.autoDestroy.mode must be idle or never");
  }
  const ttlSeconds = Number((value as { ttlSeconds?: unknown }).ttlSeconds);
  if (!Number.isInteger(ttlSeconds)) {
    throw new Error("sandbox.autoDestroy.ttlSeconds must be an integer number of seconds");
  }
  if (ttlSeconds < MIN_SPACE_SANDBOX_AUTO_DESTROY_TTL_SECONDS || ttlSeconds > MAX_SPACE_SANDBOX_AUTO_DESTROY_TTL_SECONDS) {
    throw new Error(`sandbox.autoDestroy.ttlSeconds must be between ${MIN_SPACE_SANDBOX_AUTO_DESTROY_TTL_SECONDS} and ${MAX_SPACE_SANDBOX_AUTO_DESTROY_TTL_SECONDS}`);
  }
  return { mode: "idle", ttlSeconds };
};

const getSpaceSandboxAutoDestroyPolicy = (space: typeof spaces.$inferSelect) => {
  const { config } = readSpaceConfig(space);
  const sandbox = isRecord(config.sandbox) ? config.sandbox : {};
  const autoDestroy = sandbox.autoDestroy;
  if (!autoDestroy) return DEFAULT_SPACE_SANDBOX_AUTO_DESTROY;
  try {
    return normalizeSpaceSandboxAutoDestroyPolicy(autoDestroy);
  } catch {
    return DEFAULT_SPACE_SANDBOX_AUTO_DESTROY;
  }
};

const normalizeSpaceSandboxProvider = (value: unknown): SpaceSandboxProvider => {
  if (value === "local") return "local";
  if (value === undefined || value === null || value === "cloud") return "cloud";
  throw new Error("sandbox.provider must be 'cloud' or 'local'");
};

const getSpaceSandboxProvider = (space: typeof spaces.$inferSelect): SpaceSandboxProvider => {
  const { config } = readSpaceConfig(space);
  const sandbox = isRecord(config.sandbox) ? config.sandbox : {};
  return sandbox.provider === "local" ? "local" : "cloud";
};

const normalizeSpaceSandboxSpec = (value: unknown): SandboxSpecId => {
  if (value === undefined || value === null) return DEFAULT_SANDBOX_SPEC_ID;
  if (isSandboxSpecId(value)) return value;
  throw new Error(`sandbox.spec must be one of: ${Object.keys(SANDBOX_SPECS).join(", ")}`);
};

const getSpaceSandboxSpec = (space: typeof spaces.$inferSelect): SandboxSpecId => {
  const { config } = readSpaceConfig(space);
  const sandbox = isRecord(config.sandbox) ? config.sandbox : {};
  return isSandboxSpecId(sandbox.spec) ? sandbox.spec : DEFAULT_SANDBOX_SPEC_ID;
};

async function getAllowedSandboxSpecId(userId: string): Promise<SandboxSpecId> {
  try {
    const state = await billingOperations.getState({ userId });
    const keys = new Set(state.entitlements.filter((entitlement) => entitlement.enabled).map((entitlement) => entitlement.key));
    if (keys.has(COHUB_BILLING_FEATURES.sandboxSpecUltra)) return "ultra";
    if (keys.has(COHUB_BILLING_FEATURES.sandboxSpecBoost)) return "boost";
    return DEFAULT_SANDBOX_SPEC_ID;
  } catch (error) {
    logger.warn("[SandboxSpec] failed to check entitlement", { userId, error });
    return DEFAULT_SANDBOX_SPEC_ID;
  }
}

const createSandboxSpecRequiredResponse = (c: Context, specId: SandboxSpecId) =>
  featureGateResponse(c, {
    source: "sandbox_spec",
    message: `${SANDBOX_SPECS[specId].label} sandboxes are available on ${SANDBOX_SPECS[specId].requiredPlan ?? "a higher plan"}.`,
    title: `Upgrade for ${SANDBOX_SPECS[specId].label} sandboxes`,
    conversionMessage: `Choose a higher plan to use ${SANDBOX_SPECS[specId].label} with ${SANDBOX_SPECS[specId].resources.limits.cpu} vCPU and ${SANDBOX_SPECS[specId].resources.limits.memory} memory.`,
  });

const normalizeSpaceConfigInput = (input?: SpaceConfigInput | null): SpaceConfigInput => {
  const provider = normalizeSpaceSandboxProvider(input?.sandbox?.provider);
  const policy = input?.sandbox?.autoDestroy;
  const spec = normalizeSpaceSandboxSpec(input?.sandbox?.spec);
  return {
    sandbox: {
      provider,
      autoDestroy: policy ? normalizeSpaceSandboxAutoDestroyPolicy(policy) : DEFAULT_SPACE_SANDBOX_AUTO_DESTROY,
      spec,
    },
  };
};

const mergeSpaceConfig = (space: typeof spaces.$inferSelect, patch: SpaceConfigInput) => {
  const { meta, config } = readSpaceConfig(space);
  const nextSandbox = {
    ...(isRecord(config.sandbox) ? config.sandbox : {}),
    ...(patch.sandbox?.provider ? { provider: patch.sandbox.provider } : {}),
    ...(patch.sandbox?.autoDestroy ? { autoDestroy: patch.sandbox.autoDestroy } : {}),
    ...(patch.sandbox?.spec ? { spec: patch.sandbox.spec } : {}),
  };
  const nextConfig = {
    ...config,
    sandbox: nextSandbox,
  };
  return {
    ...meta,
    config: nextConfig,
  };
};
const hasExplicitTimezone = (value: string) => /(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim());

function validatePromptContentBlocks(content: unknown): content is ContentBlock[] {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((block) => block && typeof block === "object" && !Array.isArray(block) && typeof (block as { type?: unknown }).type === "string");
}

function promptInputError(error: unknown): string | null {
  if (error instanceof SandboxNotReadyError) return null;
  if (!(error instanceof Error)) return String(error);
  if (
    error.message.includes("content") ||
    error.message.includes("clientMessageId") ||
    error.message.includes("userId") ||
    error.message.includes("Invalid image") ||
    error.message.includes("Invalid content block") ||
    error.message.includes("shell command is empty") ||
    error.message.includes("shell_command is not allowed")
  ) {
    return error.message;
  }
  return null;
}

const isPositiveSafeInteger = (value: number) => Number.isSafeInteger(value) && value > 0;

const validateTimezone = (timezone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

const parseScheduledAt = (sendAt: string) => {
  const trimmed = sendAt.trim();
  if (!hasExplicitTimezone(trimmed)) {
    throw new Error("sendAt must include timezone, e.g. 2026-05-09T10:00:00+08:00 or 2026-05-09T02:00:00Z");
  }
  const scheduledAt = new Date(trimmed);
  if (Number.isNaN(scheduledAt.getTime())) {
    throw new Error("sendAt must be a valid ISO 8601 datetime, e.g. 2026-05-09T10:00:00+08:00");
  }
  if (scheduledAt.getTime() <= Date.now()) throw new Error("sendAt must be in the future");
  return scheduledAt;
};

const validateRepeatSchedule = (input: { cronExpression: string; timezone: string }) => {
  const cronExpression = input.cronExpression.trim();
  const timezone = input.timezone.trim();
  if (cronExpression.split(/\s+/).length !== 5) {
    throw new Error("cronExpression must have 5 fields, e.g. 0 9 * * *");
  }
  if (!validateTimezone(timezone)) throw new Error("timezone must be an IANA timezone, e.g. Asia/Shanghai or UTC");
  const interval = CronExpressionParser.parse(cronExpression, { tz: timezone });
  const nextRun = interval.next().toDate();
  const secondRun = interval.next().toDate();
  if (secondRun.getTime() - nextRun.getTime() < 60_000) {
    throw new Error("cron interval must be at least 1 minute");
  }
  return { cronExpression, timezone, nextRun };
};

// ── Provisioning params builder ──────────────────────────────────────────────

function getSpaceProvisionParams(
  user: AuthUser,
  space: typeof spaces.$inferSelect,
) {
  return {
    spaceId: space.id,
    userUuid: user.uuid,
    ownerUserUuid: space.userUuid,
  };
}

async function findOwnedHomeSpace(userUuid: string): Promise<SpaceRow | null> {
  const [ownedHome] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.userUuid, userUuid), eq(spaces.slug, HOME_SPACE_SLUG)))
    .limit(1);
  return ownedHome ?? null;
}

async function findOwnedRecentSpace(userUuid: string): Promise<SpaceRow | null> {
  const [ownedRecent] = await db
    .select()
    .from(spaces)
    .where(eq(spaces.userUuid, userUuid))
    .orderBy(sql`${spaces.lastActivityAt} desc nulls last`, desc(spaces.createdAt))
    .limit(1);
  return ownedRecent ?? null;
}

/** After a unique conflict, prefer the real home slug, then any owned space. */
async function resolveHomeEnsureConflict(userUuid: string, reason: string): Promise<SpaceRow | null> {
  const home = await findOwnedHomeSpace(userUuid);
  if (home) return home;
  const recent = await findOwnedRecentSpace(userUuid);
  if (recent) {
    logger.warn("[DefaultSpace] home ensure conflict without slug=home", {
      userUuid,
      reason,
      spaceId: recent.id,
      name: recent.name,
      slug: recent.slug,
    });
  }
  return recent;
}

async function findDefaultSpaceCandidate(userUuid: string): Promise<SpaceRow | null> {
  // Hot path: most accounts already have a home space.
  const [[ownedHome], [memberHome]] = await Promise.all([
    db
      .select()
      .from(spaces)
      .where(and(eq(spaces.userUuid, userUuid), eq(spaces.slug, HOME_SPACE_SLUG)))
      .limit(1),
    db
      .select({ space: spaces })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(and(eq(spaceMembers.userId, userUuid), eq(spaces.slug, HOME_SPACE_SLUG)))
      .orderBy(sql`${spaces.lastActivityAt} desc nulls last`, desc(spaces.createdAt))
      .limit(1),
  ]);
  const homeSpace = selectMostRecentSpace([ownedHome, memberHome?.space]);
  if (homeSpace) return homeSpace;

  const [[ownedRecent], [memberRecent]] = await Promise.all([
    db
      .select()
      .from(spaces)
      .where(eq(spaces.userUuid, userUuid))
      .orderBy(sql`${spaces.lastActivityAt} desc nulls last`, desc(spaces.createdAt))
      .limit(1),
    db
      .select({ space: spaces })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(eq(spaceMembers.userId, userUuid))
      .orderBy(sql`${spaces.lastActivityAt} desc nulls last`, desc(spaces.createdAt))
      .limit(1),
  ]);
  return selectMostRecentSpace([ownedRecent, memberRecent?.space]);
}

type PreparedHomeMods = Awaited<ReturnType<typeof prepareSpaceModInserts>>;

const HOME_BOOTSTRAP: SpaceBootstrapSource = { type: "blank" };

/**
 * Home bootstrap source: fork from `HOME_BOOTSTRAP_CHECKPOINT_ID` when set,
 * otherwise create a blank workspace.
 */
function resolveHomeBootstrap(): SpaceBootstrapSource {
  const checkpointId = config.homeBootstrapCheckpointId;
  return checkpointId ? { type: "checkpoint", checkpointId } : HOME_BOOTSTRAP;
}

async function insertHomeSpaceRecord(
  user: AuthUser,
  preparedModValues: PreparedHomeMods,
  bootstrapSource: SpaceBootstrapSource,
): Promise<SpaceRow> {
  const { space } = await createOwnedSpace({
    user,
    name: HOME_SPACE_NAME,
    slug: HOME_SPACE_SLUG,
    bootstrapSource,
    sandbox: {
      provider: "cloud",
      autoDestroy: DEFAULT_SPACE_SANDBOX_AUTO_DESTROY,
      spec: DEFAULT_SANDBOX_SPEC_ID,
    },
    extraEnv: [],
    mods: preparedModValues,
    meta: { createdSource: "default_ensure" },
  });
  return space;
}

/**
 * Create the first-time Home space for a user. Idempotent under concurrency:
 * unique conflicts re-select the winner instead of failing the entry path.
 * Bootstraps from `HOME_BOOTSTRAP_CHECKPOINT_ID` when set, else blank.
 */
async function ensureHomeSpace(user: AuthUser): Promise<SpaceRow | null> {
  const bootstrapSource = resolveHomeBootstrap();
  // Caller only invokes this when no accessible space was found. Concurrent
  // ensures rely on (userUuid, slug|name) unique indexes + re-select.
  const createMods = getDefaultSpaceModsForEnv(config.env);
  // spaceId is remapped at insert; placeholder only for prepare validation.
  const preparedModValues = await prepareSpaceModInserts({
    actor: user,
    spaceId: crypto.randomUUID(),
    mods: createMods,
    existing: [],
  }).catch((error) => {
    const response = spaceModErrorResponse(error);
    logger.warn("[DefaultSpace] failed to prepare home mods; creating without mods", {
      userUuid: user.uuid,
      message: response?.message ?? (error instanceof Error ? error.message : String(error)),
      status: response?.status,
    });
    return [] as PreparedHomeMods;
  });

  let space: SpaceRow | undefined;
  try {
    space = await insertHomeSpaceRecord(user, preparedModValues, bootstrapSource);
  } catch (error) {
    const constraint = uniqueViolationConstraint(error);
    if (constraint?.includes("user_slug") || constraint?.includes("user_name")) {
      return resolveHomeEnsureConflict(
        user.uuid,
        constraint.includes("user_slug") ? "slug_conflict" : "name_conflict",
      );
    }
    const modResponse = spaceModErrorResponse(error);
    if (modResponse) {
      // First attempt rolled back. Retry once without mods so first-time users
      // still get an entry target.
      logger.warn("[DefaultSpace] home mod insert failed; retrying without mods", {
        userUuid: user.uuid,
        message: modResponse.message,
      });
      try {
        space = await insertHomeSpaceRecord(user, [], bootstrapSource);
      } catch (retryError) {
        const retryConstraint = uniqueViolationConstraint(retryError);
        if (retryConstraint?.includes("user_slug") || retryConstraint?.includes("user_name")) {
          return resolveHomeEnsureConflict(user.uuid, "retry_unique_conflict");
        }
        throw retryError;
      }
    } else {
      throw error;
    }
  }

  if (!space) return resolveHomeEnsureConflict(user.uuid, "missing_space");
  const provisioned = await provisionCreatedSpace({
    user,
    space,
    bootstrapSource,
    extraEnv: [],
    sandbox: {
      provider: "cloud",
      autoDestroy: DEFAULT_SPACE_SANDBOX_AUTO_DESTROY,
    },
    onBootstrapFailure: "soft",
  });
  return provisioned.space;
}

router.get("/", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  if (!(await hasPermission(user, "user.space.list", { spaceId: "" }))) return authzDenied(c);
  const identity = asAccountIdentity(user);
  if (!identity) return authzDenied(c);

  // Account list: owned/member by viewer uuid, independent of work space scopes.
  const spaceIds = await listAccessibleSpaceIds(identity.uuid);
  if (spaceIds.length === 0) return c.json([]);

  const spaceList = await db
    .select()
    .from(spaces)
    .where(inArray(spaces.id, spaceIds))
    .orderBy(sql`${spaces.lastActivityAt} desc nulls last`, desc(spaces.createdAt));

  const items = await buildSpaceListItems(spaceList);
  const pinnedSpaceIds = await getPinnedSpaceIds(db, identity.uuid);
  const itemsWithPins = items.map((item) => ({
    ...item,
    isPinned: pinnedSpaceIds.has(item.id),
  }));
  const appSession = getAppSessionPrincipal(c);
  return c.json(appSession ? itemsWithPins.map(stripSensitiveSpaceFields) : itemsWithPins);
});

router.get("/default", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  if (!(await hasPermission(user, "user.space.list", { spaceId: "" }))) return authzDenied(c);
  const identity = asAccountIdentity(user);
  if (!identity) return authzDenied(c);

  // Prefer existing home / recent space.
  let space = await findDefaultSpaceCandidate(identity.uuid);
  if (!space) {
    space = await ensureHomeSpace(user);
  }

  return c.json({ space: space ? await buildSpaceResponse(c, space, user) : null });
});

// ── POST /api/spaces ─────────────────────────────────────────────────────────

router.post("/", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  if (!(await hasPermission(user, "space.create", { spaceId: "" }))) return authzDenied(c);

  const body = (await c.req
    .json<{
      name?: string;
      slug?: string | null;
      description?: string | null;
      source?: string;
      cwd?: string;
      protocol?: "pi" | "acp" | "internal";
      meta?: Record<string, unknown>;
      extraEnv?: Array<{ name: string; value: string }>;
      channelBindings?: Array<{ channelId: string; config?: Record<string, unknown> | null }>;
      mods?: CreateSpaceModInput[];
      bootstrapSource?:
        | { type: "blank" }
        | { type: "git_repo"; repoUrl?: string; ref?: string | null }
        | { type: "checkpoint"; checkpointId?: string };
    gitHubToken?: string;
    }>()
    .catch(() => ({}))) as {
    name?: string;
    slug?: string | null;
    description?: string | null;
    source?: string;
    cwd?: string;
    protocol?: "pi" | "acp" | "internal";
    meta?: Record<string, unknown>;
    extraEnv?: Array<{ name: string; value: string }>;
    channelBindings?: Array<{ channelId: string; config?: Record<string, unknown> | null }>;
    mods?: CreateSpaceModInput[];
    bootstrapSource?:
      | { type: "blank" }
      | { type: "git_repo"; repoUrl?: string; ref?: string | null }
      | { type: "checkpoint"; checkpointId?: string };
    gitHubToken?: string;
    config?: SpaceConfigInput;
  };

  const name = body.name?.trim();
  if (!name) return c.json({ message: "name is required" }, 400);

  const { slug, error: slugError } = normalizeSpaceSlug(body.slug);
  if (slugError) return c.json({ message: slugError }, 400);
  if (slug && validatePublicIdentifierAssignment("spaceSlug", slug).reason === "reserved") {
    return reservedSpaceSlugResponse(c);
  }

  const existingSpace = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.userUuid, user.uuid), eq(spaces.name, name)))
    .limit(1);
  if (existingSpace.length > 0) return c.json({ message: "space already exists" }, 409);

  const normalizedExtraEnv = normalizeSpaceEnv(body.extraEnv);
  const envValidationError = validateSpaceEnvForResponse(normalizedExtraEnv);
  if (envValidationError) return c.json(envValidationError, 400);

  let normalizedConfig: SpaceConfigInput;
  try {
    normalizedConfig = normalizeSpaceConfigInput(body.config ?? null);
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "invalid space config" }, 400);
  }
  const requestedSpec = normalizedConfig.sandbox?.spec ?? DEFAULT_SANDBOX_SPEC_ID;
  const allowedSpec = await getAllowedSandboxSpecId(user.uuid);
  if (getSandboxSpecRank(requestedSpec) > getSandboxSpecRank(allowedSpec)) {
    return createSandboxSpecRequiredResponse(c, requestedSpec);
  }

  let normalizedChannelBindings: Array<{ channelId: string; config: ReturnType<typeof parseChannelConfigPatch> }> = [];
  try {
    normalizedChannelBindings = Array.isArray(body.channelBindings)
      ? body.channelBindings
          .filter((binding) => binding?.channelId && requireValidId(binding.channelId))
          .map((binding) => ({ channelId: binding.channelId, config: parseChannelConfigPatch(binding.config ?? null) }))
      : [];
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "invalid channel config" }, 400);
  }

  if (normalizedChannelBindings.length > 0) {
    const ids = normalizedChannelBindings.map((binding) => binding.channelId);
    const channels = await db
      .select({ id: userChannels.id })
      .from(userChannels)
      .where(and(eq(userChannels.userUuid, user.uuid), inArray(userChannels.id, ids)));
    if (channels.length !== ids.length) return c.json({ message: "one or more channels are invalid" }, 400);
  }

  const occupiedChannels = normalizedChannelBindings.length
    ? await db
        .select({ channelId: spaceChannels.channelId })
        .from(spaceChannels)
        .where(inArray(spaceChannels.channelId, normalizedChannelBindings.map((binding) => binding.channelId)))
    : [];
  if (occupiedChannels.length > 0) {
    return c.json({ message: "channel binding already exists for this channel" }, 409);
  }

  let normalizedBootstrapSource: SpaceBootstrapSource;
  const gitToken = body.gitHubToken?.trim() || c.req.header("X-Git-Token")?.trim() || null;
  try {
    normalizedBootstrapSource = normalizeSpaceBootstrapSource(
      body.bootstrapSource,
      requireValidId,
    );
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message.toLowerCase().replace(/\.$/, "") : "invalid bootstrap source" }, 400);
  }

  if (normalizedBootstrapSource.type === "checkpoint") {
    const [checkpoint] = await db.select().from(checkpoints).where(eq(checkpoints.id, normalizedBootstrapSource.checkpointId)).limit(1);
    if (!checkpoint) return c.json({ message: "checkpoint not found" }, 404);
    if (!(await hasPermission(user, "checkpoint.view", { spaceId: checkpoint.spaceId }))) return authzDenied(c);
  }

  const createMods = Array.isArray(body.mods) ? body.mods : getDefaultSpaceModsForEnv(config.env);
  // spaceId is remapped inside createOwnedSpace; placeholder for prepare only.
  const preparedModValues = await prepareSpaceModInserts({
    actor: user,
    spaceId: crypto.randomUUID(),
    mods: createMods,
    existing: [],
  }).catch((error) => {
    const response = spaceModErrorResponse(error);
    if (response) return response;
    throw error;
  });
  if (!Array.isArray(preparedModValues)) return c.json({ message: preparedModValues.message }, preparedModValues.status);

  const sandboxProvider = normalizedConfig.sandbox?.provider ?? "cloud";
  const sandboxAutoDestroy = normalizedConfig.sandbox?.autoDestroy ?? DEFAULT_SPACE_SANDBOX_AUTO_DESTROY;

  let space: typeof spaces.$inferSelect | undefined;
  let insertedChannels: Array<typeof spaceChannels.$inferSelect> = [];
  try {
    const result = await createOwnedSpace({
      user,
      name,
      slug,
      description: body.description ?? null,
      bootstrapSource: normalizedBootstrapSource,
      sandbox: {
        provider: sandboxProvider,
        autoDestroy: sandboxAutoDestroy,
        spec: requestedSpec,
      },
      extraEnv: normalizedExtraEnv,
      mods: preparedModValues,
      meta: applyRequestSourceToMeta(c, body.meta ?? {}) ?? {},
      channelBindings: normalizedChannelBindings.map((binding) => ({
        channelId: binding.channelId,
        config: (binding.config as Record<string, unknown> | null) ?? null,
      })),
    });
    space = result.space;
    insertedChannels = result.insertedChannels;
  } catch (error) {
    if (error instanceof LogtoUserRequiredError) {
      return c.json({ message: error.message }, 403);
    }
    const constraint = uniqueViolationConstraint(error);
    if (constraint?.includes("user_slug")) return c.json({ message: "space slug already exists" }, 409);
    const modResponse = spaceModErrorResponse(error);
    if (modResponse) return c.json({ message: modResponse.message }, modResponse.status);
    if (error instanceof Error && error.message === "model not found") return c.json({ message: "model not found" }, 400);
    throw error;
  }

  if (!space) return c.json({ message: "failed to create space" }, 500);

  if (insertedChannels.length > 0) {
    await Promise.all(
      insertedChannels.map((channel) =>
        syncSpaceChannelConfigCache({
          spaceChannelId: channel.id,
          config: (channel.config as Record<string, unknown> | null) ?? null,
        }),
      ),
    );
    // Push channel config to gateway so it starts long-polling
    void bindSpaceChannelsToGateway(space.id).catch((error) => logger.error("[SpaceChannels] failed to bind channels after space creation", { spaceId: space.id, error }));
  }

  let provisioned: ProvisionCreatedSpaceResult;
  try {
    provisioned = await provisionCreatedSpace({
      user,
      space,
      bootstrapSource: normalizedBootstrapSource,
      extraEnv: normalizedExtraEnv,
      sandbox: {
        provider: sandboxProvider,
        autoDestroy: sandboxAutoDestroy,
      },
      gitToken,
      onBootstrapFailure: "throw",
    });
  } catch (error) {
    const message =
      error instanceof Error && error.message === "failed to register local sandbox"
        ? error.message
        : "failed to create bootstrap job";
    // Space row is already committed — return it so the caller can close with
    // a created-but-not-provisioned result instead of 409-ing on the same name.
    return c.json({ message, space: { id: space.id, name: space.name } }, 500);
  }

  if (!provisioned.taskRunId) {
    return c.json({ message: "failed to create bootstrap job", space: { id: space.id, name: space.name } }, 500);
  }

  return c.json({
    space: await buildSpaceResponse(c, provisioned.space, user),
    taskRunId: provisioned.taskRunId,
  });
});

/**
 * Remove fields that are sensitive or irrelevant when a Work runtime session
 * lists the viewer's spaces. All omitted fields are already optional in the
 * SDK type, so the response stays type-compatible.
 */
function stripSensitiveSpaceFields(item: Record<string, unknown>): Record<string, unknown> {
  const { storageRepoName, sandboxStatus, access, meta, ...rest } = item;
  void storageRepoName;
  void sandboxStatus;
  void access;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const { extraEnv, config, ...safeMeta } = meta as Record<string, unknown>;
    void extraEnv;
    void config;
    return { ...rest, meta: safeMeta };
  }
  return rest;
}

async function buildSpaceResponse(c: Context, space: SpaceRow, user: AuthUser) {
  if (!getAppSessionPrincipal(c)) return serializeSpaceForResponse(space, user);
  const [item] = await buildSpaceListItems([space]);
  return item ? stripSensitiveSpaceFields(item) : null;
}

// ── GET /api/spaces/:id ──────────────────────────────────────────────────────

async function serializeSpaceForResponse(space: typeof spaces.$inferSelect, user: AuthUser | null) {
  const [sandbox, access] = await Promise.all([
    getSpaceSandboxBySpaceId(space.id),
    resolvePermissionAccess(user, { spaceId: space.id }),
  ]);
  const profileMap = await getProfilesByUuids([space.userUuid]);
  const ownerProfile = profileMap.get(space.userUuid) ?? fallbackPublicUserProfile(space.userUuid);

  return {
    ...space,
    meta: sanitizeSpaceMeta(space.meta),
    publicProfile: getSpacePublicProfile(space),
    sandboxStatus: sandbox?.status ?? null,
    sandbox: attachSandboxPublicEndpoints(sandbox),
    access,
    ownerProfile,
  };
}

function sanitizeSpaceMeta(meta: unknown): Record<string, unknown> | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return meta as null;
  }
  const metaObj = meta as Record<string, unknown>;
  const bootstrap = metaObj.bootstrap;
  if (
    !bootstrap ||
    typeof bootstrap !== "object" ||
    Array.isArray(bootstrap)
  ) {
    return metaObj;
  }
  const bootstrapObj = bootstrap as Record<string, unknown>;
  const source = bootstrapObj.source;
  if (
    !source ||
    typeof source !== "object" ||
    Array.isArray(source)
  ) {
    return metaObj;
  }
  return {
    ...metaObj,
    bootstrap: {
      ...bootstrapObj,
      source: sanitizeSpaceBootstrapSource(source),
    },
  };
}

router.get("/:id", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);

  if (await hasPermission(user, "space.view", { spaceId })) {
    return c.json(await serializeSpaceForResponse(space, user));
  }

  // Fallback: only session-level access — keep the response intentionally tiny.
  // Access is omitted here because effective permissions depend on a concrete session policy.
  return c.json({
    id: space.id,
    name: space.name,
    accessLevel: "minimal" as const,
  });
});

// ── GET /api/spaces/by-slug/:username/:slug ────────────────────────────────

router.get("/by-slug/:username/:slug", async (c) => {
  const user = getOptionalAuth(c);
  const username = c.req.param("username");
  const rawSlug = c.req.param("slug");
  const { slug, error: slugError } = normalizeSpaceSlug(rawSlug);
  if (slugError || !slug) return c.json({ message: "space not found" }, 404);

  const [profile] = await db
    .select({ userUuid: userProfiles.userUuid })
    .from(userProfiles)
    .where(eq(userProfiles.username, username))
    .limit(1);
  if (!profile) return c.json({ message: "space not found" }, 404);

  const [space] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.userUuid, profile.userUuid), eq(spaces.slug, slug)))
    .limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);

  if (await hasPermission(user, "space.view", { spaceId: space.id })) {
    return c.json(await serializeSpaceForResponse(space, user));
  }

  return c.json({
    id: space.id,
    name: space.name,
    slug: space.slug,
    accessLevel: "minimal" as const,
  });
});

// ── PATCH /api/spaces/:id (rename / slug) ───────────────────────────────────

router.patch("/:id", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  const body = await c.req.json<{ name?: string; slug?: string | null }>().catch(() => null);
  if (!body) return c.json({ message: "invalid body" }, 400);

  const updates: Partial<Pick<typeof spaces.$inferSelect, "name" | "slug">> = {};

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return c.json({ message: "name is required" }, 400);
    if (name !== space.name) {
      const duplicate = await db
        .select({ id: spaces.id })
        .from(spaces)
        .where(and(eq(spaces.userUuid, space.userUuid), eq(spaces.name, name)))
        .limit(1);
      if (duplicate.length > 0) return c.json({ message: "space name already exists" }, 409);
      updates.name = name;
    }
  }

  if (body.slug !== undefined) {
    const { slug, error: slugError } = normalizeSpaceSlug(body.slug);
    if (slugError) return c.json({ message: slugError }, 400);
    if (!slug && space.slug) return c.json({ message: "space slug cannot be cleared once set" }, 400);
    if (
      slug &&
      slug !== space.slug &&
      validatePublicIdentifierAssignment("spaceSlug", slug).reason === "reserved"
    ) {
      return reservedSpaceSlugResponse(c);
    }
    if (slug !== space.slug) updates.slug = slug;
  }

  if (updates.name === undefined && updates.slug === undefined) {
    return c.json({ space: await serializeSpaceForResponse(space, user) });
  }

  try {
    const [updated] = await db
      .update(spaces)
      .set({ ...updates, updatedAt: new Date(), lastActivityAt: new Date() })
      .where(eq(spaces.id, spaceId))
      .returning();

    const result = updated ?? space;
    return c.json({ space: await serializeSpaceForResponse(result, user) });
  } catch (error) {
    const constraint = uniqueViolationConstraint(error);
    if (constraint?.includes("user_slug")) return c.json({ message: "space slug already exists" }, 409);
    throw error;
  }
});

// ── PATCH /api/spaces/:id/profile ───────────────────────────────────────────

router.patch("/:id/profile", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || !isRecord(body)) return c.json({ message: "invalid body" }, 400);

  let nextDescription = space.description;
  if ("description" in body) {
    if (body.description !== null && typeof body.description !== "string") {
      return c.json({ message: "description must be a string or null" }, 400);
    }
    if (typeof body.description === "string" && body.description.length > MAX_SPACE_DESCRIPTION_LENGTH) {
      return c.json({ message: `description must be at most ${MAX_SPACE_DESCRIPTION_LENGTH} characters` }, 400);
    }
    nextDescription = body.description;
  }

  const existingMeta = (space.meta as Record<string, unknown> | null) ?? {};
  const existingProfile = typeof existingMeta.publicProfile === "object" && existingMeta.publicProfile !== null && !Array.isArray(existingMeta.publicProfile)
    ? existingMeta.publicProfile as Record<string, unknown>
    : {};
  const nextProfile: Record<string, unknown> = { ...existingProfile };
  if ("avatarUrl" in body) {
    if (body.avatarUrl !== null && typeof body.avatarUrl !== "string") {
      return c.json({ message: "avatarUrl must be a URL string or null" }, 400);
    }
    const avatarUrl = body.avatarUrl === null ? null : normalizePublicAvatarUrl(body.avatarUrl);
    if (body.avatarUrl !== null && !avatarUrl) {
      return c.json({ message: "avatarUrl must be a valid http(s) URL under 2048 characters" }, 400);
    }
    nextProfile.avatarUrl = avatarUrl;
    delete nextProfile.pictureUrl;
  }

  const [updated] = await db
    .update(spaces)
    .set({
      description: nextDescription,
      meta: { ...existingMeta, publicProfile: nextProfile },
      updatedAt: new Date(),
      lastActivityAt: new Date(),
    })
    .where(eq(spaces.id, spaceId))
    .returning();

  const result = updated ?? space;
  return c.json({ space: await serializeSpaceForResponse(result, user) });
});

// ── Checkpoints ──────────────────────────────────────────────────────────────

router.post("/:id/checkpoints", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "checkpoint.edit", { spaceId }))) return authzDenied(c);

  const body = await c.req.json<{ description?: string }>().catch(() => null);
  const description = body?.description?.trim() || null;

  if (space.name === "config") {
    const duplicateConfigSpaces = await db
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.userUuid, space.userUuid), eq(spaces.name, "config")))
      .limit(2);
    if (duplicateConfigSpaces.length > 1) {
      return c.json({ message: "multiple config spaces found for this user" }, 409);
    }
  }

  const existingSave = await db
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .where(and(eq(taskRuns.spaceId, spaceId), eq(taskRuns.taskType, "save_checkpoint"), inArray(taskRuns.status, ["pending", "running"])))
    .orderBy(desc(taskRuns.createdAt))
    .limit(1);
  if (existingSave[0]) return c.json({ ok: true, taskRunId: existingSave[0].id, existing: true });

  const saveLockBusy = await redisCommandClient.exists(getSpaceSaveCheckpointLockKey(spaceId)).catch((error) => {
    logger.warn(`[Checkpoints] failed to check save lock for space=${spaceId}`, error);
    return 0;
  });
  if (saveLockBusy) {
    return c.json({ message: "Checkpoint save in progress.", reason: "save_checkpoint_lock_busy" }, 409);
  }

  const { taskRunId } = await enqueueTask({
    type: "save_checkpoint",
    spaceId,
    userId: user.uuid,
    data: {
      spaceId,
      description,
      requestSource: getRequestSource(c),
    },
  });

  return c.json({ ok: true, taskRunId });
});

const DEFAULT_CHECKPOINT_LIST_LIMIT = 20;
const MAX_CHECKPOINT_LIST_LIMIT = 100;

const encodeCheckpointListCursor = (
  checkpoint: { id: string; createdAt: Date | string | null } | null | undefined,
) => {
  if (!checkpoint?.createdAt) return null;
  const createdAt = checkpoint.createdAt instanceof Date
    ? checkpoint.createdAt.toISOString()
    : new Date(checkpoint.createdAt).toISOString();
  return `${createdAt}|${checkpoint.id}`;
};

const decodeCheckpointListCursor = (cursor: string | null | undefined) => {
  if (!cursor) return null;
  const separatorIndex = cursor.lastIndexOf("|");
  const rawDate = separatorIndex > 0 ? cursor.slice(0, separatorIndex) : cursor;
  const id = separatorIndex > 0 ? cursor.slice(separatorIndex + 1) : null;
  const date = new Date(rawDate);
  if (Number.isNaN(date.getTime())) return null;
  return { date, id };
};

router.get("/:id/checkpoints", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "checkpoint.view", { spaceId }))) return authzDenied(c);

  const limitParam = Number(c.req.query("limit") ?? DEFAULT_CHECKPOINT_LIST_LIMIT);
  const rawLimit = Math.trunc(limitParam);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_CHECKPOINT_LIST_LIMIT)
    : DEFAULT_CHECKPOINT_LIST_LIMIT;
  const cursor = decodeCheckpointListCursor(c.req.query("cursor"));

  const rows = await db
    .select({
      id: checkpoints.id,
      spaceId: checkpoints.spaceId,
      commitHash: checkpoints.commitHash,
      description: checkpoints.description,
      parentCheckpointId: checkpoints.parentCheckpointId,
      rootCheckpointId: checkpoints.rootCheckpointId,
      forkCount: checkpoints.forkCount,
      saveVersion: checkpoints.saveVersion,
      createdAt: checkpoints.createdAt,
    })
    .from(checkpoints)
    .where(
      cursor
        ? and(
            eq(checkpoints.spaceId, spaceId),
            or(
              lt(checkpoints.createdAt, cursor.date),
              cursor.id
                ? and(eq(checkpoints.createdAt, cursor.date), lt(checkpoints.id, cursor.id))
                : undefined,
            ),
          )
        : eq(checkpoints.spaceId, spaceId),
    )
    .orderBy(desc(checkpoints.createdAt), desc(checkpoints.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const listedCheckpoints = hasMore ? rows.slice(0, limit) : rows;

  return c.json({
    checkpoints: listedCheckpoints,
    pageInfo: {
      hasMore,
      nextCursor: hasMore ? encodeCheckpointListCursor(listedCheckpoints.at(-1)) : null,
    },
  });
});

router.get("/:id/checkpoints/:checkpointId", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  const checkpointId = c.req.param("checkpointId");
  if (!requireValidId(spaceId) || !requireValidId(checkpointId)) {
    return c.json({ message: "checkpoint not found" }, 404);
  }
  if (!(await hasPermission(user, "checkpoint.view", { spaceId }))) return authzDenied(c);

  const [checkpoint] = await db
    .select()
    .from(checkpoints)
    .where(and(eq(checkpoints.id, checkpointId), eq(checkpoints.spaceId, spaceId)))
    .limit(1);

  if (!checkpoint) return c.json({ message: "checkpoint not found" }, 404);

  return c.json({ checkpoint });
});

// In production, these checkpoints/fs routes are routed to fs-api by the gateway.
// This remains a local/non-split fallback.
router.get("/:id/checkpoints/:checkpointId/fs/tree", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  const checkpointId = c.req.param("checkpointId");
  if (!requireValidId(spaceId) || (checkpointId !== "latest" && !requireValidId(checkpointId))) return c.json({ code: "checkpoint_not_found", message: "Checkpoint not found." }, 404);
  if (!(await hasPermission(user, "checkpoint.view", { spaceId }))) return authzDenied(c);

  try {
    return c.json(await listCheckpointDirectory({ spaceId, checkpointId, path: c.req.query("path") ?? "" }));
  } catch (error) {
    const { status, body } = checkpointFsJsonError(error);
    return c.json(body, status as never);
  }
});

router.get("/:id/checkpoints/:checkpointId/fs/file", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  const checkpointId = c.req.param("checkpointId");
  if (!requireValidId(spaceId) || (checkpointId !== "latest" && !requireValidId(checkpointId))) return c.json({ code: "checkpoint_not_found", message: "Checkpoint not found." }, 404);
  if (!(await hasPermission(user, "checkpoint.view", { spaceId }))) return authzDenied(c);

  try {
    return c.json(await readCheckpointFile({ spaceId, checkpointId, path: c.req.query("path") ?? "" }));
  } catch (error) {
    const { status, body } = checkpointFsJsonError(error);
    return c.json(body, status as never);
  }
});

router.get("/:id/checkpoints/:checkpointId/fs/diff", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  const checkpointId = c.req.param("checkpointId");
  if (!requireValidId(spaceId) || (checkpointId !== "latest" && !requireValidId(checkpointId))) {
    return c.json({ code: "checkpoint_not_found", message: "Checkpoint not found." }, 404);
  }
  if (!(await hasPermission(user, "checkpoint.view", { spaceId }))) return authzDenied(c);

  const base = c.req.query("base") ?? null;
  if (base && !requireValidId(base)) {
    return c.json({ code: "checkpoint_not_found", message: "Base checkpoint not found." }, 404);
  }

  try {
    const summary = await getCheckpointDiffSummary({ spaceId, checkpointId, baseCheckpointId: base });
    // Immutable parent diffs: long private browser cache. Auth still gates origin.
    // Large precomputed payloads use delivery=url (OSS object with public immutable Cache-Control).
    if (summary.precomputed && !base) {
      c.header("Cache-Control", CHECKPOINT_DIFF_CACHE_CONTROL);
      c.header("Vary", "Authorization, Cookie");
    } else {
      c.header("Cache-Control", "private, max-age=60");
    }
    return c.json(summary);
  } catch (error) {
    const { status, body } = checkpointFsJsonError(error);
    return c.json(body, status as never);
  }
});

router.get("/:id/checkpoints/:checkpointId/fs/diff/file", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  const checkpointId = c.req.param("checkpointId");
  if (!requireValidId(spaceId) || (checkpointId !== "latest" && !requireValidId(checkpointId))) {
    return c.json({ code: "checkpoint_not_found", message: "Checkpoint not found." }, 404);
  }
  if (!(await hasPermission(user, "checkpoint.view", { spaceId }))) return authzDenied(c);

  const path = c.req.query("path") ?? "";
  if (!path) return c.json({ code: "path_invalid", message: "path is required" }, 400);
  const base = c.req.query("base") ?? null;
  if (base && !requireValidId(base)) {
    return c.json({ code: "checkpoint_not_found", message: "Base checkpoint not found." }, 404);
  }

  try {
    const file = await getCheckpointDiffFile({ spaceId, checkpointId, path, baseCheckpointId: base });
    // Align with summary: long immutable cache only for precomputed parent diffs.
    if (!base && file.precomputed) {
      c.header("Cache-Control", CHECKPOINT_DIFF_CACHE_CONTROL);
    } else {
      c.header("Cache-Control", "private, max-age=60");
    }
    c.header("Vary", "Authorization, Cookie");
    return c.json(file);
  } catch (error) {
    const { status, body } = checkpointFsJsonError(error);
    return c.json(body, status as never);
  }
});

// ── Env ──────────────────────────────────────────────────────────────────────

function getExtraEnvFromSpace(space: typeof spaces.$inferSelect) {
  const meta = space.meta as Record<string, unknown> | null;
  return normalizeSpaceEnv(meta?.extraEnv);
}

async function persistSpaceEnv(space: typeof spaces.$inferSelect, envs: Array<{ name: string; value: string }>) {
  const existingMeta = space.meta as Record<string, unknown> | null;
  await db
    .update(spaces)
    .set({
      meta: { ...existingMeta, extraEnv: envs },
      updatedAt: new Date(),
      lastActivityAt: new Date(),
    })
    .where(eq(spaces.id, space.id));
  await setSpaceEnv(space.id, envs);
}

router.get("/:id/env", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);

  const envs = getExtraEnvFromSpace(space);
  return c.json({ env: envs });
});

const toSpaceEnvValidationResponse = (error: unknown) => {
  if (!(error instanceof SpaceEnvValidationError)) return null;
  return { message: error.message };
};

const validateSpaceEnvForResponse = (envs: Array<{ name: string; value: string }>) => {
  try {
    validateSpaceEnv(envs);
    return null;
  } catch (error) {
    const response = toSpaceEnvValidationResponse(error);
    if (response) return response;
    throw error;
  }
};

router.post("/:id/env", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);

  const body = await c.req.json<{ name: string; value: string }>().catch(() => null);
  if (!body?.name || body.value === undefined) return c.json({ message: "name and value are required" }, 400);

  const entry = { name: body.name.trim(), value: String(body.value) };
  if (SYSTEM_ENV_KEY_SET.has(entry.name)) {
    return c.json({ message: `env name "${entry.name}" is reserved by the system` }, 400);
  }

  const existing = getExtraEnvFromSpace(space);
  const filtered = existing.filter((e) => e.name !== entry.name);
  const updated = [...filtered, entry];
  const validationError = validateSpaceEnvForResponse(updated);
  if (validationError) return c.json(validationError, 400);
  await persistSpaceEnv(space, updated);

  return c.json({ env: updated }, 201);
});

router.put("/:id/env/:name", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const envName = c.req.param("name");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  if (!envName?.trim()) return c.json({ message: "env name is required" }, 400);
  if (SYSTEM_ENV_KEY_SET.has(envName)) {
    return c.json({ message: `env name "${envName}" is reserved by the system` }, 400);
  }

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);

  const body = await c.req.json<{ value?: string }>().catch(() => null);
  if (!body || body.value === undefined || body.value === null) return c.json({ message: "value is required" }, 400);

  const existing = getExtraEnvFromSpace(space);
  const target = existing.find((e) => e.name === envName);
  if (!target) return c.json({ message: `env "${envName}" not found` }, 404);

  target.value = String(body.value);
  const validationError = validateSpaceEnvForResponse(existing);
  if (validationError) return c.json(validationError, 400);
  await persistSpaceEnv(space, existing);

  return c.json({ env: existing });
});

router.delete("/:id/env/:name", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const envName = c.req.param("name");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);

  const existing = getExtraEnvFromSpace(space);
  const filtered = existing.filter((e) => e.name !== envName);
  if (filtered.length === existing.length) return c.json({ message: `env "${envName}" not found` }, 404);

  await persistSpaceEnv(space, filtered);
  return c.json({ env: filtered });
});

// ── Config ───────────────────────────────────────────────────────────────────

router.get("/:id/config", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.view", { spaceId }))) return authzDenied(c);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);

  const [allowedSpec, sandbox] = await Promise.all([
    user?.uuid ? getAllowedSandboxSpecId(user.uuid) : Promise.resolve(DEFAULT_SANDBOX_SPEC_ID),
    getSpaceSandboxBySpaceId(spaceId),
  ]);
  return c.json({
    config: {
      sandbox: {
        provider: getSpaceSandboxProvider(space),
        autoDestroy: getSpaceSandboxAutoDestroyPolicy(space),
        spec: getSpaceSandboxSpec(space),
        appliedSpec: isRecord(sandbox?.meta) && isSandboxSpecId(sandbox.meta.appliedSpec) ? sandbox.meta.appliedSpec : null,
        specPendingRestart: isRecord(sandbox?.meta) ? sandbox.meta.specPendingRestart === true : false,
        allowedSpec,
        specs: SANDBOX_SPECS,
      },
    },
  });
});

router.patch("/:id/config", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);

  const body = await c.req.json<{ sandbox?: { autoDestroy?: SpaceSandboxAutoDestroyPolicy; spec?: SandboxSpecId } }>().catch(() => null);
  if (!body) return c.json({ message: "invalid body" }, 400);

  let nextAutoDestroy: SpaceSandboxAutoDestroyPolicy;
  let nextSpec: SandboxSpecId;
  try {
    nextAutoDestroy = body.sandbox?.autoDestroy ? normalizeSpaceSandboxAutoDestroyPolicy(body.sandbox.autoDestroy) : getSpaceSandboxAutoDestroyPolicy(space);
    nextSpec = body.sandbox?.spec ? normalizeSpaceSandboxSpec(body.sandbox.spec) : getSpaceSandboxSpec(space);
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "invalid space config" }, 400);
  }

  const allowedSpec = await getAllowedSandboxSpecId(space.userUuid);
  if (getSandboxSpecRank(nextSpec) > getSandboxSpecRank(allowedSpec)) {
    return createSandboxSpecRequiredResponse(c, nextSpec);
  }

  const nextMeta = mergeSpaceConfig(space, { sandbox: { autoDestroy: nextAutoDestroy, spec: nextSpec } });

  const [updated] = await db.update(spaces).set({ meta: nextMeta, updatedAt: new Date(), lastActivityAt: new Date() }).where(eq(spaces.id, spaceId)).returning();
  if (!updated) return c.json({ message: "failed to update space config" }, 500);

  const sandbox = await getSpaceSandboxBySpaceId(spaceId);
  const baseAt = sandbox?.lastActivityAt ?? sandbox?.lastHeartbeatAt ?? sandbox?.createdAt ?? updated.createdAt ?? new Date();
  await scheduleSandboxAutoDestroy({ spaceId, policy: nextAutoDestroy, baseAt: baseAt ? new Date(baseAt) : null }).catch((error) => logger.error("[SandboxAutoDestroy] failed to reschedule policy", { spaceId, error }));

  const specResult = body.sandbox?.spec ? await resizeSpaceSandboxToSpec({ spaceId, specId: nextSpec }).catch(async (error) => {
    logger.warn("[SandboxSpec] failed to resize sandbox", { spaceId, specId: nextSpec, error });
    await markSandboxSpecPendingRestart({ spaceId, specId: nextSpec, reason: "resize_failed" }).catch((markError) => {
      logger.warn("[SandboxSpec] failed to mark pending restart", { spaceId, specId: nextSpec, error: markError });
    });
    return { resized: false, pendingRestart: true, message: error instanceof Error ? error.message : String(error) };
  }) : { resized: false, pendingRestart: false };

  return c.json({ space: await serializeSpaceForResponse(updated, user), sandbox: specResult });
});

// ── Sandbox ──────────────────────────────────────────────────────────────────

router.get("/:id/sandbox", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "sandbox.view", { spaceId }))) return authzDenied(c);

  const sandbox = await getSpaceSandboxBySpaceId(spaceId);
  return c.json({ sandbox: attachSandboxPublicEndpoints(sandbox) });
});

router.get("/:id/sandbox/ports", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "sandbox.view", { spaceId }))) return authzDenied(c);

  const sandbox = await getSpaceSandboxBySpaceId(spaceId);
  return c.json({ endpoints: attachSandboxPublicEndpoints(sandbox)?.publicEndpoints ?? {} });
});

router.post("/:id/sandbox/recreate", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "sandbox.manage", { spaceId }))) return authzDenied(c);

  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);

  const result = await recoverSpaceSandbox({
    ...getSpaceProvisionParams(user, space),
    reason: "manual_recreate",
    source: "manual",
    verify: true,
  });

  return c.json(result);
});

const MAX_COMMAND_LENGTH = 16 * 1024;

router.post("/:id/commands", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "command.execute", { spaceId }))) return authzDenied(c);

  const body = await c.req.json<{ command?: string }>().catch(() => null);
  const command = body?.command?.trim();
  if (!command) return c.json({ message: "command is required" }, 400);
  if (command.length > MAX_COMMAND_LENGTH) return c.json({ message: `command is too long; max ${MAX_COMMAND_LENGTH} characters` }, 400);
  const cwd = "/workspace";
  const sourceClientId = getRequestSource(c)?.clientId;

  const { taskRunId } = await enqueueTask({
    type: RUN_COMMAND_TASK_TYPE,
    spaceId,
    userId: user.uuid,
    data: {
      command,
      cwd,
      source: "command_palette",
      ...(sourceClientId ? { sourceClientId } : {}),
    },
  });

  return c.json({ taskRunId });
});

// ── Sessions ─────────────────────────────────────────────────────────────────

router.get("/:id/runtime", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "sandbox.view", { spaceId }))) return authzDenied(c);
  const [sandbox, registration] = await Promise.all([
    getSpaceSandboxBySpaceId(spaceId), getRuntimeRegistration(spaceId),
  ]);
  const rawWatcher = sandbox?.provider === "local" && registration
    ? await redisCommandClient.get(`sandbox:watcher:${spaceId}`).catch(() => null) : null;
  let fileWatcher = null;
  if (rawWatcher) {
    try {
      const parsed = fileWatcherStatusSchema.safeParse(JSON.parse(rawWatcher));
      if (parsed.success) fileWatcher = parsed.data;
    } catch { /* Invalid telemetry never affects Runtime availability. */ }
  }
  const rawWorkspace = registration ? await redisCommandClient.get(runtimeWorkspaceKey(spaceId)) : null;
  const workspace = runtimeWorkspaceStatus(registration?.runtimeId, rawWorkspace);
  return c.json({ kind: sandbox?.provider ?? "cloud", online: Boolean(registration), runtimeId: registration?.runtimeId ?? null, capabilities: registration?.capabilities ?? null, fileWatcher: workspace.online ? fileWatcher : null, workspace, observedAt: new Date().toISOString() });
});

router.get("/:id/sessions/:sessionId/runtime", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const sessionId = c.req.param("sessionId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId)) return c.json({ message: "Session not found / Session 不存在" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId, sessionId }))) return authzDenied(c);
  const [recovery, canManage] = await Promise.all([
    getSessionRuntimeRecovery(spaceId, sessionId),
    hasPermission(user, "sandbox.manage", { spaceId }),
  ]);
  return c.json({ ...recovery, canManage });
});

router.post("/:id/sessions/:sessionId/runtime/confirm-stopped", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const sessionId = c.req.param("sessionId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId)) return c.json({ message: "Session not found / Session 不存在" }, 404);
  if (!(await hasPermission(user, "sandbox.manage", { spaceId }))) return authzDenied(c);
  const parsed = runtimeStopConfirmationSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ message: "Invalid confirmation / 确认请求无效" }, 400);
  const accepted = await confirmRuntimeStopped(spaceId, sessionId, user.uuid, parsed.data);
  if (!accepted) return c.json({ message: "Runtime state changed; refresh before confirming / Runtime 状态已变化，请刷新后确认" }, 409);
  return c.json({ accepted: true }, 202);
});

router.post("/:id/prompt", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);

  const body = await c.req.json<SpacePromptInput>().catch(() => null);
  if (body?.mode === "create") {
    const generation = body.generation;
    if (!generation?.model || !Array.isArray(generation.content) || generation.content.length === 0) {
      return c.json({ message: "generation.model and generation.content are required" }, 400);
    }
    if (!(await hasPermission(user, "generation.create", { spaceId }))) return authzDenied(c);
    if (!(await hasPermission(user, "session.prompt.readonly", { spaceId }))) return authzDenied(c);
    if (body.sessionId) {
      if (!requireValidId(body.sessionId)) return c.json({ message: "invalid sessionId" }, 400);
      const existingSession = await getSpaceSessionById(body.sessionId);
      if (existingSession && !(await hasPermission(user, "session.prompt.readonly", { spaceId, sessionId: body.sessionId }))) return authzDenied(c);
    }
    try {
      const execution = await createGenerationSessionExecution({
        spaceId,
        userId: user.uuid,
        sessionId: body.sessionId ?? null,
        clientMessageId: body.clientMessageId ?? null,
        model: generation.model,
        content: generation.content,
        parameters: generation.parameters,
        meta: generation.meta,
        source: body.source ?? "web",
      });
      const [session, turn] = await Promise.all([
        getSpaceSessionById(execution.sessionId),
        getSessionTurnById(execution.sessionId, execution.turnId),
      ]);
      if (!session || !turn) return c.json({ message: "generation session projection unavailable" }, 500);
      return c.json({ mode: "immediate", session, turn, execution: { kind: "direct_generation", taskRunId: execution.taskRunId } }, 202);
    } catch (error) {
      if (error instanceof BillingAccessBlockedError) return billingBlockedResponse(c, error);
      if (error instanceof GenerationSessionExecutionError) return c.json({ code: error.code, message: error.message }, error.status);
      logger.error("[prompt] direct generation failed", { spaceId, userId: user.uuid, error });
      return c.json({ code: "generation_unavailable", message: "Generation is temporarily unavailable." }, 503);
    }
  }
  if (!validatePromptContentBlocks(body?.content)) {
    return c.json({ message: "content must be a non-empty ContentBlock array" }, 400);
  }
  const accessMode = normalizePromptAccessMode(body.accessMode);
  if (!accessMode) return c.json({ message: "accessMode must be one of: read_only, full_access" }, 400);
  const promptIntent = normalizeSpacePromptIntent(body.intent);
  if (!promptIntent) return c.json({ message: "intent must be one of: followup, steer" }, 400);
  const promptThinkingLevel = normalizePromptThinkingLevel(body.thinkingLevel);
  if (promptThinkingLevel === null) return c.json({ message: "thinkingLevel must be one of: off, minimal, low, medium, high, xhigh, max" }, 400);
  if (body.harness !== undefined && body.harness !== null && !harnessSchema.safeParse(body.harness).success) {
    return c.json({ message: "harness must be one of: cohub, pi, codex" }, 400);
  }
  const promptPermission = accessMode === "read_only" ? "session.prompt.readonly" : "session.prompt.fullaccess";
  if (!(await hasPermission(user, promptPermission, { spaceId }))) return authzDenied(c);

  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);

  if (body.sessionId && !requireValidId(body.sessionId)) return c.json({ message: "invalid sessionId" }, 400);

  let sessionId = body.sessionId?.trim() || null;
  let promptSession: SpaceRouteSessionRecord | null = null;
  let createdPromptSession: SpaceRouteSessionRecord | null = null;
  if (sessionId) {
    const session = await getSpaceSessionById(sessionId);
    if (!session || session.spaceId !== spaceId) return c.json({ message: "session not found" }, 404);
    if (!(await hasPermission(user, promptPermission, { spaceId, sessionId }))) {
      return authzDenied(c);
    }
    promptSession = session;
  }

  const schedule = body.schedule ?? { mode: "immediate" as const };
  const mode = schedule.mode ?? "immediate";
  if (!["immediate", "delay", "at", "repeat"].includes(mode)) {
    return c.json({ message: "schedule.mode must be one of: immediate, delay, at, repeat" }, 400);
  }

  const generationPolicy = body.generationPolicy === undefined || body.generationPolicy === null
    ? null
    : normalizeGenerationPolicy(body.generationPolicy);
  if (body.generationPolicy !== undefined && body.generationPolicy !== null && !generationPolicy) {
    return c.json({ message: "generationPolicy is invalid" }, 400);
  }

  const requestedModel = body.model?.trim() || null;
  const localHarness = isLocalHarness(body.harness);
  const requestedProvider = body.provider?.trim() || (requestedModel && !localHarness ? "cohub" : null);
  if (mode !== "immediate" && localHarness) return c.json({ message: "Local Harness scheduling is unavailable" }, 422);
  if (
    requestedModel &&
    requestedProvider &&
    !localHarness &&
    !(await validatePromptModel({ userId: user.uuid, provider: requestedProvider, model: requestedModel }))
  ) {
    return c.json({ code: "model_unavailable", message: "requested model is not available" }, 422);
  }

  let promptLabelIds: string[] = [];
  try {
    const labelPaths = parseLabelRefs(body.labelRefs);
    if (labelPaths.length > 0) {
      const labelPermissionScope = sessionId ? { spaceId, sessionId } : { spaceId };
      if (!(await hasPermission(user, "space.label.assign", labelPermissionScope))) return authzDenied(c);
      const resolved = await resolveLabelPaths({ db, spaceId, paths: labelPaths });
      if (resolved.missingPaths.length > 0 && !(await hasPermission(user, "space.label.manage", { spaceId }))) return authzDenied(c);
      promptLabelIds = (await resolveOrCreateLabelPaths({ db, spaceId, paths: labelPaths, userId: user.uuid })).labelIds;
    }
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }

  let promptEnv: Record<string, string> | null = null;
  try {
    promptEnv = parsePromptEnv(body.env);
  } catch (error) {
    if (error instanceof PromptEnvValidationError) return c.json({ message: error.message }, 400);
    throw error;
  }

  const content = body.content;
  const clientMessageId = body.clientMessageId?.trim() || crypto.randomUUID();
  const source = resolveSessionSourceFromRequest(c, typeof body.source === "string" ? body.source : null);

  const scheduledAuth = await getScheduledPromptAuthContext(c, spaceId, user.uuid);
  const taskData = {
    content,
    clientMessageId,
    ...(generationPolicy ? { generationPolicy } : {}),
    ...(promptIntent !== "followup" ? { intent: promptIntent } : {}),
    ...(accessMode !== "full_access" ? { accessMode } : {}),
    ...(promptEnv ? { env: promptEnv } : {}),
    ...(source !== "scheduled_task" ? { source } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(body.title ? { title: body.title } : {}),
    ...(body.model ? { model: body.model } : {}),
    ...(body.provider ? { provider: body.provider } : {}),
    ...(promptThinkingLevel ? { thinkingLevel: promptThinkingLevel } : {}),
    ...(promptLabelIds.length > 0 ? { labelIds: promptLabelIds } : {}),
    ...(scheduledAuth ? { auth: scheduledAuth } : {}),
  };

  if (mode === "immediate") {
    if (!sessionId) {
      promptSession = await createInitialSpaceSession({
        spaceId,
        sessionId: crypto.randomUUID(),
        userUuid: user.uuid,
        title: body.title ?? null,
        source,
        externalSessionId: null,
        meta: { createdBy: "api_space_prompt" },
      });
      createdPromptSession = promptSession;
      sessionId = promptSession.id;
    }

    try {
      if (promptLabelIds.length > 0) {
        await assignLabelsToSession({ db, spaceId, sessionId, labelIds: promptLabelIds, userId: user.uuid });
      }
      if (createdPromptSession) {
        const createdPromptSessionId = createdPromptSession.id;
        await assignSessionSourceSystemLabel({ db, spaceId, sessionId: createdPromptSessionId, source: createdPromptSession.source }).then(() =>
          dispatchLabelAssignmentsUpdated({ spaceId, resourceType: "session", resourceRef: createdPromptSessionId, sessionId: createdPromptSessionId }),
        ).catch((error) => {
          logger.warn("[SessionSourceLabel] failed to assign system source label", error);
        });
      }
      const { turnId } = await submitSessionPrompt({
        spaceId,
        sessionId,
        userId: user.uuid,
        clientMessageId,
        content,
        source,
        sourceClientId: getRequestSource(c)?.clientId ?? null,
        model: requestedModel,
        provider: requestedProvider,
        harness: body.harness ?? null,
        thinkingLevel: promptThinkingLevel ?? null,
        generationPolicy,
        intent: promptIntent,
        accessMode,
        env: promptEnv,
        context: { kind: "public_api", requestId: getCurrentRequestId(), auth: await getPromptAuthContext(c, spaceId) },
      }, {}, requestedModel && requestedProvider
        ? { prevalidatedModel: { provider: requestedProvider, model: requestedModel } }
        : {});
      const response = await buildSpacePromptTurnResponse(await getSpaceSessionById(sessionId), turnId);
      if (!response) return c.json({ message: "turn not found" }, 500);
      return c.json(response);
    } catch (error) {
      // If we created the session for this request, surface its id so clients can retry
      // without spawning another empty session.
      const createdSessionId = createdPromptSession?.id ?? null;
      if (error instanceof BillingAccessBlockedError) {
        const res = billingBlockedResponse(c, error);
        if (createdSessionId) {
          // Preserve body shape; append sessionId for retry reuse.
          const body = await res.json().catch(() => ({ message: error.message }));
          return c.json({ ...body, sessionId: createdSessionId }, res.status as never);
        }
        return res;
      }
      if (error instanceof HarnessUnavailableError) return c.json({ code: error.code, message: error.message, ...(createdSessionId ? { sessionId: createdSessionId } : {}) }, 503);
      if (error instanceof ModelUnavailableError) {
        return c.json(
          { code: error.code, message: "requested model is not available", ...(createdSessionId ? { sessionId: createdSessionId } : {}) },
          422,
        );
      }
      if (error instanceof SandboxNotReadyError) {
        return c.json(
          { message: "sandbox is not ready", ...(createdSessionId ? { sessionId: createdSessionId } : {}) },
          503,
        );
      }
      const inputError = promptInputError(error);
      if (inputError) {
        return c.json(
          { message: inputError, ...(createdSessionId ? { sessionId: createdSessionId } : {}) },
          400,
        );
      }
      throw error;
    }
  }

  if (mode === "delay") {
    const delayMs = Number((schedule as { delayMs?: number }).delayMs);
    if (!isPositiveSafeInteger(delayMs)) {
      return c.json({ message: "delayMs must be a positive integer, e.g. 600000" }, 400);
    }
    const scheduledAt = new Date(Date.now() + delayMs);
    const { taskRunId } = await enqueueTask({
      type: "send_message",
      spaceId,
      sessionId: sessionId ?? undefined,
      userId: user.uuid,
      data: taskData,
    }, { delay: delayMs, scheduledAt });
    return c.json({ mode: "delay", taskRunId, scheduledAt: scheduledAt.toISOString(), sessionId });
  }

  if (mode === "at") {
    const sendAt = (schedule as { sendAt?: string }).sendAt;
    if (!sendAt?.trim()) return c.json({ message: "sendAt is required, e.g. 2026-05-09T10:00:00+08:00" }, 400);
    let scheduledAt: Date;
    try {
      scheduledAt = parseScheduledAt(sendAt);
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message.toLowerCase().replace(/\.$/, "") : "invalid sendAt" }, 400);
    }
    const { taskRunId } = await enqueueTask({
      type: "send_message",
      spaceId,
      sessionId: sessionId ?? undefined,
      userId: user.uuid,
      data: taskData,
    }, { delay: scheduledAt.getTime() - Date.now(), scheduledAt });
    return c.json({ mode: "at", taskRunId, scheduledAt: scheduledAt.toISOString(), sessionId });
  }

  const repeat = schedule as { cronExpression?: string; timezone?: string };
  if (!repeat.cronExpression?.trim()) return c.json({ message: "cronExpression is required, e.g. 0 9 * * *" }, 400);
  if (!repeat.timezone?.trim()) return c.json({ message: "timezone is required, e.g. Asia/Shanghai" }, 400);
  let parsedRepeat: { cronExpression: string; timezone: string; nextRun: Date };
  try {
    parsedRepeat = validateRepeatSchedule({ cronExpression: repeat.cronExpression, timezone: repeat.timezone });
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message.toLowerCase().replace(/\.$/, "") : "invalid repeat schedule" }, 400);
  }

  const cronJob = await createCronJob({
    userId: user.uuid,
    title: body.title?.trim() || "scheduled prompt",
    taskType: "send_message",
    payload: taskData,
    schedule: { pattern: parsedRepeat.cronExpression, timezone: parsedRepeat.timezone },
    spaceId,
    sessionId,
  });

  return c.json({
    mode: "repeat",
    cronJobId: cronJob.id,
    nextRunAt: parsedRepeat.nextRun.toISOString(),
    timezone: parsedRepeat.timezone,
    sessionId,
  });
});

router.post("/:id/sessions/:sessionId/turns/:turnId/steer", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const sessionId = c.req.param("sessionId");
  const turnId = c.req.param("turnId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId) || !requireValidId(turnId)) return c.json({ message: "not found" }, 404);
  if (!(await hasPermission(user, "session.prompt.fullaccess", { spaceId, sessionId }))) return authzDenied(c);

  try {
    const result = await promoteQueuedTurnToSteer({ spaceId, sessionId, turnId, actorUserId: user.uuid });
    await dispatchAffectedTurnUpdates({ spaceId, sessionId, turns: result.affectedTurns });
    return c.json({ ok: true, turn: result.turn, affectedTurns: result.affectedTurns });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "session not found") return c.json({ message }, 404);
    if (message === "failed to enqueue steered turn") return c.json({ message }, 503);
    if (message.includes("not queued") || message.includes("only follow-up")) return c.json({ message }, 409);
    throw error;
  }
});

router.post("/:id/sessions/:sessionId/turns/:turnId/cancel", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const sessionId = c.req.param("sessionId");
  const turnId = c.req.param("turnId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId) || !requireValidId(turnId)) return c.json({ message: "not found" }, 404);
  if (!(await hasPermission(user, "session.prompt.fullaccess", { spaceId, sessionId }))) return authzDenied(c);

  try {
    const turn = await cancelQueuedTurn({ spaceId, sessionId, turnId, actorUserId: user.uuid });
    await dispatchTurnUpdated({ spaceId, sessionId, turn }).catch((error) => logger.warn("[SessionTurn] failed to dispatch cancelled turn", error));
    return c.json({ ok: true, turn });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "session not found" || message === "turn not found") return c.json({ message }, 404);
    if (message.includes("not queued") || message.includes("only follow-up")) return c.json({ message }, 409);
    throw error;
  }
});

router.post("/:id/sessions", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "session.prompt.fullaccess", { spaceId }))) return authzDenied(c);

  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);

  let body: { title?: string | null; source?: string | null; labelRefs?: unknown };
  try {
    body = await c.req.json<{ title?: string | null; source?: string | null; labelRefs?: unknown }>();
  } catch {
    return c.json({ message: "invalid json body" }, 400);
  }

  let userLabelIds: string[] = [];
  try {
    const labelPaths = parseLabelRefs(body.labelRefs);
    if (labelPaths.length > 0) {
      if (!(await hasPermission(user, "space.label.assign", { spaceId }))) return authzDenied(c);
      const resolved = await resolveLabelPaths({ db, spaceId, paths: labelPaths });
      if (resolved.missingPaths.length > 0 && !(await hasPermission(user, "space.label.manage", { spaceId }))) return authzDenied(c);
      userLabelIds = (await resolveOrCreateLabelPaths({ db, spaceId, paths: labelPaths, userId: user.uuid })).labelIds;
    }
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }

  const source = resolveSessionSourceFromRequest(c, body.source);
  const session = await createInitialSpaceSession({
    spaceId: space.id,
    sessionId: crypto.randomUUID(),
    userUuid: user.uuid,
    title: body.title ?? null,
    source,
    externalSessionId: null,
    meta: { createdBy: "api_space_session_create" },
  });

  if (userLabelIds.length > 0) {
    await assignLabelsToSession({ db, spaceId, sessionId: session.id, labelIds: userLabelIds, userId: user.uuid });
  }
  await assignSessionSourceSystemLabel({ db, spaceId, sessionId: session.id, source }).then(() =>
    dispatchLabelAssignmentsUpdated({ spaceId, resourceType: "session", resourceRef: session.id, sessionId: session.id }),
  ).catch((error) => {
    logger.warn("[SessionSourceLabel] failed to assign system source label", error);
  });

  return c.json({ ok: true, session });
});

router.get("/:id/turns", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId }))) return authzDenied(c);

  const sessionId = c.req.query("sessionId")?.trim() || null;
  if (sessionId && !requireValidId(sessionId)) return c.json({ message: "invalid sessionId" }, 400);

  const isMember = user?.uuid
    ? (await getSpaceMemberRole(spaceId, user.uuid)) !== null
    : false;
  let accessibleSessionIds: string[] | null = null;
  if (!isMember) {
    const sessions = sessionId
      ? [await getSpaceSessionById(sessionId)].filter(
        (session): session is NonNullable<typeof session> => session?.spaceId === spaceId,
      )
      : await db.select().from(spaceSessions).where(eq(spaceSessions.spaceId, spaceId));
    const visibleSessions = await filterSessionsByPermission(user, "session.view", spaceId, sessions);
    accessibleSessionIds = visibleSessions.map((session) => session.id);
  }

  const rawLimit = c.req.query("limit");
  try {
    return c.json(await listSpaceTurns({
      spaceId,
      userUuid: user?.uuid ?? null,
      author: (c.req.query("author") ?? "any") as "any" | "self" | "others",
      after: c.req.query("after") ?? null,
      before: c.req.query("before") ?? null,
      cursor: c.req.query("cursor") ?? null,
      limit: rawLimit === undefined ? undefined : Number(rawLimit),
      sessionId,
      accessibleSessionIds,
    }));
  } catch (error) {
    if (error instanceof InvalidSpaceTurnListQueryError) {
      return c.json({ message: error.message }, 400);
    }
    throw error;
  }
});

router.get("/:id/sessions", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId }))) return authzDenied(c);

  const limitParam = Number(c.req.query("limit") ?? 20);
  const limit = Number.isFinite(limitParam) ? limitParam : 20;
  const cursor = c.req.query("cursor") ?? null;
  let sessions: Awaited<ReturnType<typeof listSpaceSessions>>["sessions"];
  let pageInfo: Awaited<ReturnType<typeof listSpaceSessions>>["pageInfo"];
  try {
    ({ sessions, pageInfo } = await listSpaceSessions(spaceId, { limit, cursor }));
  } catch (error) {
    if (error instanceof InvalidSessionListCursorError) {
      return c.json({ message: "invalid cursor" }, 400);
    }
    throw error;
  }

  // Member users have space-level permission that covers all sessions.
  // Only non-members need per-session accessPolicy checks.
  const isMember = user?.uuid
    ? (await getSpaceMemberRole(spaceId, user.uuid)) !== null
    : false;
  const visibleSessions = isMember
    ? sessions
    : await filterSessionsByPermission(user, "session.view", spaceId, sessions);

  const hydratedSessions = await hydrateSessionParticipantProfiles(visibleSessions);

  const includeForks = c.req.query("includeForks") === "1" || c.req.query("includeForks") === "true";
  const forks = includeForks
    ? redactSessionForksForViewer(
      await listSessionForksForSessions(visibleSessions.map((session) => session.id)),
      { isMember, visibleSessionIds: visibleSessions.map((session) => session.id) },
    )
    : undefined;

  return c.json({ sessions: hydratedSessions, ...(forks ? { forks } : {}), pageInfo });
});

// ── Channels ─────────────────────────────────────────────────────────────────

router.get("/:id/channels", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "channel.view", { spaceId }))) return authzDenied(c);

  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);

  const channels = await getSpaceChannelsBySpaceId(space.id);
  const channelIds = channels.map((item) => item.channelId);
  const channelList =
    channelIds.length > 0
      ? await db.select().from(userChannels).where(inArray(userChannels.id, channelIds))
      : [];

  const userChannelById = new Map(channelList.map((item) => [item.id, item]));
  const healthBySpaceChannelId = await getChannelHealthMap(channels.map((channel) => channel.id));

  return c.json(
    channels.map((channel) => {
      const userChannel = userChannelById.get(channel.channelId) ?? null;
      const safeChannel = userChannel
        ? (({ credentials: _credentials, ...rest }) => rest)(userChannel)
        : null;
      return {
        ...channel,
        channel: safeChannel,
        health: healthBySpaceChannelId.get(channel.id) ?? fallbackBoundChannelHealth(),
      };
    }),
  );
});

// ── POST /api/spaces/:id/channels/:channelId — bind a channel at runtime ─────────────────

router.post("/:id/channels/:channelId", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const channelId = c.req.param("channelId");
  if (!requireValidId(spaceId) || !requireValidId(channelId)) {
    return c.json({ message: "space or channel not found" }, 404);
  }
  if (!(await hasPermission(user, "channel.manage", { spaceId }))) return authzDenied(c);

  // Verify ownership: the channel must belong to the same user
  const [userChannel] = await db.select().from(userChannels).where(and(eq(userChannels.id, channelId), eq(userChannels.userUuid, user.uuid))).limit(1);
  if (!userChannel) return c.json({ message: "channel not owned by you" }, 403);

  // Check if already bound to any space
  const [existingBinding] = await db.select({ id: spaceChannels.id }).from(spaceChannels).where(eq(spaceChannels.channelId, channelId)).limit(1);
  if (existingBinding) return c.json({ message: "channel is already bound to another space" }, 409);

  const body = (await c.req.json<{ config?: unknown }>().catch(() => ({}))) as { config?: unknown };
  let channelConfig: ReturnType<typeof parseChannelConfigPatch>;
  try {
    channelConfig = parseChannelConfigPatch(body.config ?? null);
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "invalid channel config" }, 400);
  }
  if (!(await validateChannelModelConfig(db, spaceId, channelConfig?.model ?? null))) {
    return c.json({ message: "model not found" }, 400);
  }

  const [spaceChannel] = await db.insert(spaceChannels).values({
    spaceId,
    channelId,
    config: channelConfig,
  }).returning();

  if (!spaceChannel) return c.json({ message: "failed to bind channel" }, 500);

  // Push to gateway so it starts listening (bindSingleChannelToGateway handles config cache internally)
  void bindSpaceChannelsToGateway(spaceId).catch((error) => logger.error("[SpaceChannels] failed to bind channel to gateway", { spaceId, error }));

  return c.json(spaceChannel, 201);
});

// ── PATCH /api/spaces/:id/channels/:channelId — update channel config ───────────────────

router.patch("/:id/channels/:channelId", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const channelId = c.req.param("channelId");
  if (!requireValidId(spaceId) || !requireValidId(channelId)) {
    return c.json({ message: "space or channel not found" }, 404);
  }
  if (!(await hasPermission(user, "channel.manage", { spaceId }))) return authzDenied(c);

  const [spaceChannel] = await db.select().from(spaceChannels).where(and(eq(spaceChannels.spaceId, spaceId), eq(spaceChannels.channelId, channelId))).limit(1);
  if (!spaceChannel) return c.json({ message: "channel not bound to this space" }, 404);

  const body = (await c.req.json<{ config?: unknown }>().catch(() => ({}))) as { config?: unknown };
  let configPatch: ReturnType<typeof parseChannelConfigPatch>;
  try {
    configPatch = parseChannelConfigPatch(body.config ?? null);
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "invalid channel config" }, 400);
  }

  const nextConfig = mergeChannelConfig(spaceChannel.config, configPatch);
  if (!(await validateChannelModelConfig(db, spaceId, nextConfig?.model ?? null))) {
    return c.json({ message: "model not found" }, 400);
  }

  const updated = await updateSpaceChannelConfig({ spaceChannelId: spaceChannel.id, config: nextConfig });
  if (!updated) return c.json({ message: "failed to update channel config" }, 500);

  return c.json(updated);
});

// ── DELETE /api/spaces/:id/channels/:channelId — unbind a channel at runtime ─────────────

router.delete("/:id/channels/:channelId", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const channelId = c.req.param("channelId");
  if (!requireValidId(spaceId) || !requireValidId(channelId)) {
    return c.json({ message: "space or channel not found" }, 404);
  }
  if (!(await hasPermission(user, "channel.manage", { spaceId }))) return authzDenied(c);

  const [spaceChannel] = await db.select().from(spaceChannels).where(and(eq(spaceChannels.spaceId, spaceId), eq(spaceChannels.channelId, channelId))).limit(1);
  if (!spaceChannel) return c.json({ message: "channel not bound to this space" }, 404);

  await db.delete(spaceChannels).where(eq(spaceChannels.id, spaceChannel.id));
  // Remove from gateway routing
  void unbindSpaceChannelFromGateway(spaceChannel.id).catch((error) => logger.error("[SpaceChannels] failed to unbind channel from gateway", { spaceId, spaceChannelId: spaceChannel.id, error }));

  return c.json({ ok: true });
});

export default router;
