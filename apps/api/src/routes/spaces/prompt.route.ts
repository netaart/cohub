import { BillingAccessBlockedError } from "@cohub/billing";
import { createLogger } from "@cohub/infra/logging";
import { releaseCancelledGeneration } from "../../generation-billing.js";
import { getCurrentRequestId } from "@cohub/infra/tracing";
import { Hono, type Context } from "hono";
import type { ContentBlock } from "@cohub/protocol/core";
import { isModelThinkingLevel, MODEL_THINKING_LEVELS, harnessSchema, isLocalHarness, isSessionTurnReplyMode, type ApprovalMode, type HarnessKind } from "@cohub/protocol";
import { normalizeGenerationPolicy, type GenerationContentBlock } from "@cohub/protocol/generation";
import * as cronParser from "cron-parser";
import { rotateQueuedTurnSequences } from "../../queued-steer.js";
import { db } from "../../db/index.js";
import { spaceSessions, sessionTurns } from "@cohub/db";
import { eq, and, inArray, desc, sql } from "drizzle-orm";
import { hostPromptImages } from "../../session-images.js";
import { useAuth, getAppSessionPrincipal, requireValidId, authzDenied } from "../../lib/middleware.js";
import { createGenerationSessionExecution, GenerationSessionExecutionError } from "../../generation-session-execution.js";
import {
  createInitialSpaceSession,
  getSpaceById,
  getSpaceSessionById,
  SandboxNotReadyError,
} from "../../space-sessions.js";
import { createCronJob, enqueueTask } from "../../tasks.js";
import { notifyCronJobListChanged } from "../../user-lists.js";
import { normalizeContentBlocks } from "@cohub/core/content/normalize";
import { sanitizePostgresJsonValue } from "@cohub/core/content/sanitize";
import { hasPermission } from "../../permissions.js";
import type { AuthUser } from "../../lib/middleware.js";
import { submitSessionPrompt } from "../../session-prompts.js";
import { recordSessionNote } from "../../session-notes.js";
import { onTurnSettled } from "../../turn-settled.js";
import { HarnessUnavailableError, ModelUnavailableError, parsePromptEnv, PromptEnvValidationError, resolveSessionTurnOrigin } from "@cohub/core/sessions";
import { delegatedPromptAuthFromAppSession, promptAuthContextFromAppSession } from "../../prompt-auth-context.js";
import { buildSessionTurnResponse } from "../../session-turn-response.js";
import { getSessionTurnById, hydrateTurnAuthorProfiles } from "../../session-turns.js";
import { dispatchTurnUpdated } from "../../session-output.js";
import { enqueueAgentTurnJob } from "../../agent-turn-queue.js";
import { requestAgentTurnAbort } from "../../agent-turn-abort.js";
import { billingBlockedResponse } from "../../lib/billing-blocked.js";
import { getRequestSource, resolveSessionSourceFromRequest } from "../../lib/request-source.js";
import { validatePromptModel } from "../../llm/models.js";
import { applySessionLabels, resolveLabelRefIds } from "./session-labels.js";

const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();

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

async function recordNotePrompt(c: Context, user: AuthUser, spaceId: string, body: SpacePromptInput & { content: ContentBlock[] }) {
  if (body.schedule?.mode && body.schedule.mode !== "immediate") return c.json({ message: "notes cannot be scheduled" }, 400);
  if (!(await hasPermission(user, "session.prompt.readonly", { spaceId }))) return authzDenied(c);
  if (body.sessionId && !requireValidId(body.sessionId)) return c.json({ message: "invalid sessionId" }, 400);

  const requestedSessionId = body.sessionId?.trim() || null;
  const existingSession = requestedSessionId ? await getSpaceSessionById(requestedSessionId) : null;
  if (requestedSessionId) {
    if (!existingSession || existingSession.spaceId !== spaceId) return c.json({ message: "session not found" }, 404);
    if (!(await hasPermission(user, "session.prompt.readonly", { spaceId, sessionId: requestedSessionId }))) return authzDenied(c);
  } else if (!(await getSpaceById(spaceId))) {
    return c.json({ message: "space not found" }, 404);
  }

  const labelIds = await resolveLabelRefIds(c, user, spaceId, requestedSessionId, body.labelRefs);
  if (labelIds instanceof Response) return labelIds;

  let content: ContentBlock[];
  try {
    content = await hostPromptImages(normalizeContentBlocks(body.content), { userUuid: user.uuid, spaceId, sessionId: requestedSessionId });
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }

  const source = resolveSessionSourceFromRequest(c, typeof body.source === "string" ? body.source : null);
  const requestSource = getRequestSource(c);
  const origin = await resolveSessionTurnOrigin(db, requestSource, "prompt", (scope) => hasPermission(user, "session.view", scope));
  const provenance = { ...(requestSource ? { requestSource } : {}), ...(origin ? { origin } : {}) };
  const session = existingSession ?? await createInitialSpaceSession({
    spaceId,
    sessionId: crypto.randomUUID(),
    userUuid: user.uuid,
    title: body.title ?? null,
    source,
    externalSessionId: null,
    meta: { createdBy: "api_space_note", ...provenance },
  });
  const sessionId = session.id;
  const createdSession = existingSession ? null : session;

  try {
    await applySessionLabels({ spaceId, sessionId, labelIds, userId: user.uuid });
    const turn = await recordSessionNote({
      spaceId,
      sessionId,
      userId: user.uuid,
      clientMessageId: body.clientMessageId?.trim() || crypto.randomUUID(),
      content,
      meta: { source, ...provenance, ...(requestSource?.clientId ? { sourceClientId: requestSource.clientId } : {}) },
    });
    const response = await buildSpacePromptTurnResponse(await getSpaceSessionById(sessionId), turn.id);
    if (!response) return c.json({ message: "turn not found" }, 500);
    return c.json(response);
  } catch (error) {
    if (!createdSession) throw error;
    logger.error("[prompt] note recording failed", { spaceId, sessionId, error });
    return c.json({ message: "failed to record note", sessionId }, 500);
  }
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

const normalizePromptThinkingLevel = (value: unknown): string | null | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return isModelThinkingLevel(trimmed) ? trimmed : null;
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

    const affectedTurnIds = await rotateQueuedTurnSequences(tx, target);
    await tx.update(sessionTurns).set({
      intent: "steer",
      meta: sanitizeMeta({
        ...readMetaRecord(target.meta),
        promotedToSteerAt: now.toISOString(),
        promotedByUserId: input.actorUserId,
        promotedFromIntent: target.intent,
        dispatchIntent: "steer",
      }),
    }).where(eq(sessionTurns.id, target.id));

    const [activeTurn] = await tx.select({ id: sessionTurns.id, status: sessionTurns.status }).from(sessionTurns).where(and(eq(sessionTurns.sessionId, input.sessionId), eq(sessionTurns.executionKind, "agent"), inArray(sessionTurns.status, ["running", "abort_requested"]))).orderBy(desc(sessionTurns.sequence)).limit(1);
    if (activeTurn && activeTurn.id !== target.id) {
      // Merge, not rewrite: the row is unlocked and children may append `messagesSent`.
      const abortMeta = sanitizeMeta({
        abortRequestedAt: now.toISOString(),
        continuedByTurnId: target.id,
        abortActorUserId: input.actorUserId,
      });
      await tx.update(sessionTurns).set({
        status: "abort_requested",
        meta: sql`coalesce(${sessionTurns.meta}, '{}'::jsonb) || ${JSON.stringify(abortMeta)}::jsonb`,
        updatedAt: now,
      }).where(and(eq(sessionTurns.id, activeTurn.id), eq(sessionTurns.executionKind, "agent"), inArray(sessionTurns.status, ["running", "abort_requested"])));
      affectedTurnIds.push(activeTurn.id);
    }

    return { targetId: target.id, activeTurnId: activeTurn?.id ?? null, activeTurnStatus: activeTurn?.status ?? null, affectedTurnIds };
  });

  try {
    await enqueueAgentTurnJob({ spaceId: input.spaceId, sessionId: input.sessionId, reason: "steer" });
  } catch (error) {
    const failedAt = new Date();
    const [failed] = await db.update(sessionTurns).set({
      status: "failed",
      summary: { finishReason: "failed", reason: "enqueue_failed" },
      errorMessage: error instanceof Error ? error.message : String(error),
      meta: sql`coalesce(${sessionTurns.meta}, '{}'::jsonb) || ${JSON.stringify({ enqueueFailedAt: failedAt.toISOString() })}::jsonb`,
      completedAt: failedAt,
      updatedAt: failedAt,
    }).where(and(eq(sessionTurns.id, result.targetId), eq(sessionTurns.sessionId, input.sessionId), eq(sessionTurns.status, "queued"))).returning({ id: sessionTurns.id, status: sessionTurns.status, meta: sessionTurns.meta });
    if (failed) void onTurnSettled(failed);
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
  const generationTaskId = updated.executionKind === "direct_generation" ? readMetaRecord(updated.meta).generationTaskId : null;
  if (typeof generationTaskId === "string") {
    // The worker refuses cancelled turns that hold a reserve or drew quota, so both are freed without waiting for the queue.
    await releaseCancelledGeneration(generationTaskId).catch((error) => {
      logger.warn("[Billing] failed to release cancelled generation billing", { taskRunId: generationTaskId, error });
    });
  }
  const turn = await getSessionTurnById(input.sessionId, input.turnId);
  if (!turn) throw new Error("turn not found");
  const [hydrated = turn] = await hydrateTurnAuthorProfiles([turn]);
  return hydrated;
}

type SpacePromptInput = {
  mode?: "agent" | "create" | "note";
  reply?: unknown;
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
  harness?: HarnessKind | null;
  thinkingLevel?: string | null;
  /** Optional context window for this session from this prompt on, capped at the platform value. */
  contextWindow?: number | null;
  /** Compact the session context before this Turn runs. */
  compactFirst?: boolean | null;
  approvalMode?: ApprovalMode | null;
  serviceTier?: string | null;
  clientMessageId?: string | null;
  generationPolicy?: unknown;
  intent?: SpacePromptIntent | null;
  accessMode?: PromptAccessMode | null;
  schedule?: SpacePromptSchedule | null;
  labelRefs?: unknown;
  env?: unknown;
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
    error.message.includes("shell_command is not allowed") ||
    error.message.startsWith("approvalMode") ||
    error.message.startsWith("serviceTier")
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

router.post("/:id/prompt", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);

  const body = await c.req.json<SpacePromptInput>().catch(() => null);
  if (body?.reply != null && body.mode && body.mode !== "agent") return c.json({ message: "reply is only supported for agent prompts" }, 400);
  if (body?.compactFirst != null && typeof body.compactFirst !== "boolean") return c.json({ message: "compactFirst must be a boolean" }, 400);
  const compactFirst = body?.compactFirst === true;
  if (compactFirst && (
    (body.mode && body.mode !== "agent")
    || isLocalHarness(body.harness)
    || (body.schedule?.mode ?? "immediate") !== "immediate"
    || !body.sessionId
  )) {
    return c.json({ message: "compactFirst needs an immediate agent prompt to an existing cohub session" }, 400);
  }
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
        source: resolveSessionSourceFromRequest(c, body.source),
        requestSource: getRequestSource(c),
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
  if (body.mode === "note") return recordNotePrompt(c, user, spaceId, { ...body, content: body.content });
  if (body.reply != null && !isSessionTurnReplyMode(body.reply)) return c.json({ message: "reply must be one of: note, prompt" }, 400);
  const reply = body.reply == null ? null : { mode: body.reply };
  const accessMode = normalizePromptAccessMode(body.accessMode);
  if (!accessMode) return c.json({ message: "accessMode must be one of: read_only, full_access" }, 400);
  const promptIntent = normalizeSpacePromptIntent(body.intent);
  if (!promptIntent) return c.json({ message: "intent must be one of: followup, steer" }, 400);
  const promptThinkingLevel = normalizePromptThinkingLevel(body.thinkingLevel);
  if (promptThinkingLevel === null) return c.json({ message: `thinkingLevel must be one of: ${MODEL_THINKING_LEVELS.join(", ")}` }, 400);
  if (body.contextWindow !== undefined && body.contextWindow !== null
    && (!Number.isSafeInteger(body.contextWindow) || body.contextWindow <= 0)) {
    return c.json({ message: "contextWindow must be a positive integer" }, 400);
  }
  const promptContextWindow = typeof body.contextWindow === "number" ? body.contextWindow : null;
  if (body.harness !== undefined && body.harness !== null && !harnessSchema.safeParse(body.harness).success) {
    return c.json({ message: `harness must be one of: ${harnessSchema.options.join(", ")}` }, 400);
  }
  if (promptContextWindow && isLocalHarness(body.harness)) {
    return c.json({ message: "contextWindow is only supported by the cohub harness" }, 400);
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

  const promptLabelIds = await resolveLabelRefIds(c, user, spaceId, sessionId, body.labelRefs);
  if (promptLabelIds instanceof Response) return promptLabelIds;

  let promptEnv: Record<string, string> | null = null;
  try {
    promptEnv = parsePromptEnv(body.env);
  } catch (error) {
    if (error instanceof PromptEnvValidationError) return c.json({ message: error.message }, 400);
    throw error;
  }

  let content: ContentBlock[];
  try {
    content = await hostPromptImages(normalizeContentBlocks(body.content), { userUuid: user.uuid, spaceId, sessionId });
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }
  const clientMessageId = body.clientMessageId?.trim() || crypto.randomUUID();
  const source = resolveSessionSourceFromRequest(c, typeof body.source === "string" ? body.source : null);
  const requestSource = getRequestSource(c);
  const origin = await resolveSessionTurnOrigin(db, requestSource, mode === "immediate" ? "prompt" : "scheduled_prompt",
    (scope) => hasPermission(user, "session.view", scope));
  if (reply && (mode !== "immediate" || !origin)) return c.json({ message: "reply needs an immediate prompt sent from a Cohub turn" }, 400);
  const provenance = { ...(requestSource ? { requestSource } : {}), ...(origin ? { origin } : {}) };

  const scheduledAuth = await getScheduledPromptAuthContext(c, spaceId, user.uuid);
  const taskData = {
    ...provenance,
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
    ...(promptContextWindow ? { contextWindow: promptContextWindow } : {}),
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
        meta: { createdBy: "api_space_prompt", ...provenance },
      });
      createdPromptSession = promptSession;
      sessionId = promptSession.id;
    }

    try {
      await applySessionLabels({ spaceId, sessionId, labelIds: promptLabelIds, userId: user.uuid });
      const { turnId } = await submitSessionPrompt({
        spaceId,
        sessionId,
        userId: user.uuid,
        clientMessageId,
        content,
        source,
        requestSource,
        origin,
        reply,
        sourceClientId: requestSource?.clientId ?? null,
        model: requestedModel,
        provider: requestedProvider,
        harness: body.harness ?? null,
        thinkingLevel: promptThinkingLevel ?? null,
        contextWindow: promptContextWindow,
        compactFirst,
        approvalMode: body.approvalMode ?? null,
        serviceTier: body.serviceTier ?? null,
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

  notifyCronJobListChanged(cronJob);
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
    void onTurnSettled(turn);
    return c.json({ ok: true, turn });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "session not found" || message === "turn not found") return c.json({ message }, 404);
    if (message.includes("not queued") || message.includes("only follow-up")) return c.json({ message }, 409);
    throw error;
  }
});

export default router;
