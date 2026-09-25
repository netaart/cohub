import type { BillingUsageGate } from "@cohub/billing";
import { randomUUID as defaultRandomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { ContentBlock } from "@cohub/protocol/core";
import type { SessionTurnIntent, SessionTurnRecord } from "@cohub/protocol/model";
import { AGENT_TURN_ABORT_CHANNEL, type ModelThinkingLevel } from "@cohub/protocol";
import { sessionTurnSegments, sessionTurns, spaceSessions, spaces } from "@cohub/db";
import { sanitizePostgresJsonValue } from "../content/sanitize.js";
import {
  addSessionParticipantMeta,
  initializeSessionParticipantsMeta,
  normalizeSessionTitle,
  setSessionTitleMeta,
} from "./session-meta.js";
import { submitSessionPrompt, type PromptHarness, type ExpandedPromptTemplate, type ExpandedSkillCommand, expandPromptContent, type SubmitSessionPromptHooks, type SubmitSessionPromptInput, type SubmitSessionPromptOptions } from "./prompt.js";

export type PromptTemplateService = {
  expand(text: string, options?: { userId?: string | null; spaceId?: string | null; sessionId?: string | null }): Promise<ExpandedPromptTemplate | null>;
};

export type SkillService = {
  expand(text: string, options?: { userId?: string | null; spaceId?: string | null; harness?: PromptHarness | null }): Promise<ExpandedSkillCommand | null>;
};

type DrizzleDb = PostgresJsDatabase<Record<string, unknown>>;

type RedisPipeline = {
  del(key: string): unknown;
  sadd(key: string, ...members: string[]): unknown;
  set(key: string, value: string): unknown;
  exec(): Promise<unknown>;
};

type RedisClient = {
  pipeline(): RedisPipeline;
  set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
};

export type AgentTurnQueue = {
  enqueue(input: {
    spaceId: string;
    sessionId: string;
    reason?: "prompt" | "steer" | "drain" | "retry" | "recovery";
    requestId?: string | null;
    trace?: Record<string, unknown>;
    jobId?: string;
  }): Promise<unknown>;
};

export type SessionServices = ReturnType<typeof createSessionServices>;

const getAgentTurnAbortKey = (turnId: string) => `agent:turn:${turnId}:abort`;

const imagePreviewLabel = (count: number) => (count === 1 ? "Image" : `${count} images`);

const THINKING_LEVELS = new Set<ModelThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const toSessionTurnRecord = (row: typeof sessionTurns.$inferSelect): SessionTurnRecord => {
  const meta = row.meta && typeof row.meta === "object" && !Array.isArray(row.meta)
    ? row.meta as Record<string, unknown>
    : null;
  const thinkingLevel = typeof meta?.effectiveThinkingLevel === "string" && THINKING_LEVELS.has(meta.effectiveThinkingLevel as ModelThinkingLevel)
    ? meta.effectiveThinkingLevel as ModelThinkingLevel
    : null;
  const fallbackTimestamp = new Date().toISOString();
  return {
    id: row.id,
    sessionId: row.sessionId,
    userUuid: row.userUuid ?? null,
    sequence: row.sequence,
    executionKind: row.executionKind,
    status: row.status,
    intent: row.intent,
    userContent: row.userContent,
    userText: row.userText ?? null,
    assistantContent: row.assistantContent ?? null,
    assistantText: row.assistantText ?? null,
    provider: row.provider ?? null,
    model: row.model ?? null,
    stopReason: row.stopReason ?? null,
    errorMessage: row.errorMessage ?? null,
    finalUsage: row.finalUsage ?? row.totalUsage ?? null,
    totalUsage: row.totalUsage ?? row.finalUsage ?? null,
    summary: row.summary ?? null,
    intermediateIndex: row.intermediateIndex ?? null,
    intermediateSummary: row.intermediateSummary ?? null,
    meta,
    thinkingLevel,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    durationMs: row.durationMs ?? null,
    createdAt: row.createdAt?.toISOString() ?? fallbackTimestamp,
    updatedAt: row.updatedAt?.toISOString() ?? fallbackTimestamp,
  };
};

const deriveMessagePreviewText = (input: { content: ContentBlock[] }) => {
  const parts: string[] = [];
  let imageCount = 0;

  for (const block of input.content) {
    switch (block.type) {
      case "text": {
        const text = block.text.trim();
        if (text) parts.push(text);
        break;
      }
      case "image":
        imageCount += 1;
        break;
      case "shell_command":
        parts.push(["$", block.command].join(""));
        break;
      case "system_note": {
        const text = block.text.trim();
        if (text) parts.push(text);
        break;
      }
      default:
        break;
    }
  }

  if (imageCount > 0) parts.push(imagePreviewLabel(imageCount));
  return parts.join(" · ").replace(/\s+/g, " ").trim();
};

export function createSessionServices(input: {
  db: DrizzleDb;
  redis: RedisClient;
  promptTemplateService: PromptTemplateService;
  skillService?: SkillService;
  billingUsageGate?: BillingUsageGate;
  validateLocalHarness?: (input: SubmitSessionPromptInput) => Promise<void>;
  validatePromptModel?: (input: { userId: string; provider: string; model: string }) => Promise<boolean>;
  sandboxRecovery?: {
    maybeRecoverForPrompt(input: {
      spaceId: string;
      sessionId: string;
      userId: string;
      source: string;
      context?: import("./prompt.js").SubmitSessionPromptContext | null;
    }): void | Promise<void>;
  };
  agentTurnQueue: AgentTurnQueue;
  randomUUID?: () => string;
  injectTrace?: () => Record<string, unknown>;
  getRequestId?: () => string | null | undefined;
  logger?: Pick<Console, "warn">;
  onSessionTurnCreated?: (input: { spaceId: string; turn: SessionTurnRecord }) => void | Promise<void>;
  onSessionTurnUpdated?: (input: { spaceId: string; turn: SessionTurnRecord }) => void | Promise<void>;
  onSessionActivityUpdated?: (input: { sessionId: string; changed: string[] }) => void | Promise<void>;
  onSessionParticipantsUpdated?: (input: { spaceId: string; sessionId: string; userUuids: string[] }) => void | Promise<void>;
}) {
  const randomUUID = input.randomUUID ?? defaultRandomUUID;
  const injectTrace = input.injectTrace ?? (() => ({}));
  const getRequestId = input.getRequestId ?? (() => null);
  const logger = input.logger ?? console;
  const skillService = input.skillService;

  async function ensureRootSessionTurnSegment(sessionId: string) {
    await input.db.insert(sessionTurnSegments).values({
      sessionId,
      ordinal: 1,
      sourceSessionId: sessionId,
      fromSequence: 1,
      toSequence: null,
    }).onConflictDoNothing({
      target: [sessionTurnSegments.sessionId, sessionTurnSegments.ordinal],
    });
  }

  async function registerCronjobSession(spaceId: string, options: { source: string; title?: string | null; userUuid: string }) {
    const userUuid = options.userUuid.trim();
    if (!userUuid) throw new Error("userUuid is required");
    const [space] = await input.db.select({ id: spaces.id }).from(spaces).where(eq(spaces.id, spaceId)).limit(1);
    if (!space) throw new Error("space not found");

    const sessionId = randomUUID();
    const title = normalizeSessionTitle(options.title);
    const participantMeta = initializeSessionParticipantsMeta({ createdBy: "cronjob" }, userUuid);
    const [session] = await input.db.insert(spaceSessions).values({
      id: sessionId,
      spaceId,
      userUuid,
      title,
      source: options.source,
      status: "active",
      externalSessionId: null,
      meta: sanitizePostgresJsonValue(title ? setSessionTitleMeta(participantMeta, { source: "user" }) : participantMeta),
      lastMessageAt: new Date(),
      lastMessageId: null,
    }).returning();
    if (!session) throw new Error("failed to register cronjob session");
    await ensureRootSessionTurnSegment(session.id);
    await Promise.resolve(input.onSessionParticipantsUpdated?.({
      spaceId,
      sessionId: session.id,
      userUuids: [userUuid],
    })).catch((error) => logger.warn("[Session] failed to publish session participant labels", error));
    return session;
  }

  async function createSessionTurn(turnInput: {
    sessionId: string;
    userUuid: string;
    userContent: ContentBlock[];
    intent: SessionTurnIntent;
    meta: Record<string, unknown>;
  }) {
    const userContent = sanitizePostgresJsonValue(turnInput.userContent);
    const requestId = getRequestId();
    const turnMeta: Record<string, unknown> = {
      ...turnInput.meta,
      ...(requestId && typeof turnInput.meta.requestId !== "string" ? { requestId } : {}),
    };
    const meta = sanitizePostgresJsonValue(turnMeta);
    const userText = deriveMessagePreviewText({ content: userContent }) || null;
    const model = typeof meta.model === "string" && meta.model.trim() ? meta.model.trim() : null;
    const provider = typeof meta.provider === "string" && meta.provider.trim() ? meta.provider.trim() : null;
    const touchedAt = new Date();
    const { row, spaceId } = await input.db.transaction(async (tx) => {
      const [sessionRow] = await tx.select({ meta: spaceSessions.meta, spaceId: spaceSessions.spaceId }).from(spaceSessions).where(eq(spaceSessions.id, turnInput.sessionId)).for("update").limit(1);
      if (!sessionRow) throw new Error("session not found");
      const [seqRow] = await tx.select({ max: sql<number>`coalesce(max(${sessionTurns.sequence}), 0)::int` }).from(sessionTurns).where(eq(sessionTurns.sessionId, turnInput.sessionId));
      const [localSegment] = await tx.select({ fromSequence: sessionTurnSegments.fromSequence }).from(sessionTurnSegments).where(and(
        eq(sessionTurnSegments.sessionId, turnInput.sessionId),
        eq(sessionTurnSegments.sourceSessionId, turnInput.sessionId),
        isNull(sessionTurnSegments.toSequence),
      )).orderBy(desc(sessionTurnSegments.ordinal)).limit(1);
      const sequence = seqRow?.max ? (seqRow.max + 1) : (localSegment?.fromSequence ?? 1);
      await tx.update(spaceSessions).set({
        latestMessageText: userText,
        lastMessageAt: touchedAt,
        updatedAt: touchedAt,
        meta: sanitizePostgresJsonValue(addSessionParticipantMeta(sessionRow.meta, turnInput.userUuid)),
      }).where(eq(spaceSessions.id, turnInput.sessionId));
      const [row] = await tx.insert(sessionTurns).values({
        sessionId: turnInput.sessionId,
        sequence,
        userUuid: turnInput.userUuid,
        userContent,
        userText,
        intent: turnInput.intent,
        status: "queued",
        provider,
        model,
        meta,
      }).returning();
      return { row, spaceId: sessionRow.spaceId };
    });
    if (!row) throw new Error("failed to create session turn");
    await Promise.resolve(input.onSessionTurnCreated?.({ spaceId, turn: toSessionTurnRecord(row) }))
      .catch((error) => logger.warn("[Session] failed to publish created turn", error));
    await Promise.resolve(input.onSessionActivityUpdated?.({
      sessionId: turnInput.sessionId,
      changed: ["latestMessageText", "lastMessageAt", "updatedAt"],
    })).catch((error) => logger.warn("[Session] failed to publish session activity update", error));
    await Promise.resolve(input.onSessionParticipantsUpdated?.({
      spaceId,
      sessionId: turnInput.sessionId,
      userUuids: [turnInput.userUuid],
    })).catch((error) => logger.warn("[Session] failed to publish session participant labels", error));
    return { ...row, spaceId };
  }

  async function failSessionTurn(turnInput: { sessionId: string; turnId: string; errorMessage: string }) {
    const [session] = await input.db.select({ spaceId: spaceSessions.spaceId })
      .from(spaceSessions)
      .where(eq(spaceSessions.id, turnInput.sessionId))
      .limit(1);
    if (!session) return null;
    const [row] = await input.db.update(sessionTurns).set({
      status: "failed",
      errorMessage: turnInput.errorMessage,
      summary: { finishReason: "failed", text: turnInput.errorMessage },
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(sessionTurns.id, turnInput.turnId),
      eq(sessionTurns.sessionId, turnInput.sessionId),
      inArray(sessionTurns.status, ["queued", "running", "abort_requested"]),
    )).returning();
    if (row) {
      await Promise.resolve(input.onSessionTurnUpdated?.({ spaceId: session.spaceId, turn: toSessionTurnRecord(row) }))
        .catch((error) => logger.warn("[Session] failed to publish updated turn", error));
    }
    return row ?? null;
  }

  async function requestAgentTurnAbort(abortInput: {
    spaceId: string;
    sessionId: string;
    turnId: string;
    reason: "interrupt";
    continuedByTurnId: string;
    actorUserId?: string | null;
  }) {
    const event = {
      id: randomUUID(),
      spaceId: abortInput.spaceId,
      sessionId: abortInput.sessionId,
      turnId: abortInput.turnId,
      reason: abortInput.reason,
      continuedByTurnId: abortInput.continuedByTurnId,
      actorUserId: abortInput.actorUserId ?? null,
      timestamp: Date.now(),
    };
    await input.redis.set(getAgentTurnAbortKey(abortInput.turnId), JSON.stringify(event), "EX", 60 * 60);
    await input.redis.publish(AGENT_TURN_ABORT_CHANNEL, JSON.stringify(event));
  }

  async function enqueueSpacePrompt(promptInput: {
    spaceId: string;
    sessionId: string;
    turnId: string;
    userMessageId: string;
    content: ContentBlock[];
    meta: Record<string, unknown>;
  }) {
    const actorUserId = typeof promptInput.meta.userId === "string" && promptInput.meta.userId.trim() ? promptInput.meta.userId.trim() : null;
    const dispatchIntent = promptInput.meta.dispatchIntent === "steer" ? "steer" : "followup";
    const [activeTurn] = await input.db.select({ id: sessionTurns.id })
      .from(sessionTurns)
      .where(and(eq(sessionTurns.sessionId, promptInput.sessionId), eq(sessionTurns.executionKind, "agent"), inArray(sessionTurns.status, ["running", "abort_requested"])))
      .orderBy(desc(sessionTurns.sequence))
      .limit(1);

    if (dispatchIntent === "followup" && activeTurn && activeTurn.id !== promptInput.turnId) {
      return;
    }

    if (dispatchIntent === "steer" && activeTurn && activeTurn.id !== promptInput.turnId) {
      const [updatedActiveTurn] = await input.db.update(sessionTurns).set({
        status: "abort_requested",
        meta: sql`coalesce(${sessionTurns.meta}, '{}'::jsonb) || ${JSON.stringify({ abortRequestedAt: new Date().toISOString(), continuedByTurnId: promptInput.turnId })}::jsonb`,
        updatedAt: new Date(),
      }).where(and(eq(sessionTurns.id, activeTurn.id), eq(sessionTurns.sessionId, promptInput.sessionId), eq(sessionTurns.executionKind, "agent"), inArray(sessionTurns.status, ["running", "abort_requested"]))).returning();
      if (updatedActiveTurn) {
        await Promise.resolve(input.onSessionTurnUpdated?.({
          spaceId: promptInput.spaceId,
          turn: toSessionTurnRecord(updatedActiveTurn),
        })).catch((error) => logger.warn("[Session] failed to publish abort-requested turn", error));
      }
      await requestAgentTurnAbort({
        spaceId: promptInput.spaceId,
        sessionId: promptInput.sessionId,
        turnId: activeTurn.id,
        reason: "interrupt",
        continuedByTurnId: promptInput.turnId,
        actorUserId,
      }).catch((error) => logger.warn(`[AgentTurn] failed to publish abort for turn=${activeTurn.id}:`, error));
    }

    const metaContext = promptInput.meta.context && typeof promptInput.meta.context === "object" && !Array.isArray(promptInput.meta.context)
      ? promptInput.meta.context as Record<string, unknown>
      : null;
    const requestId = typeof promptInput.meta.requestId === "string" && promptInput.meta.requestId.trim()
      ? promptInput.meta.requestId.trim()
      : typeof metaContext?.requestId === "string" && metaContext.requestId.trim()
        ? metaContext.requestId.trim()
        : getRequestId();
    await input.agentTurnQueue.enqueue({
      spaceId: promptInput.spaceId,
      sessionId: promptInput.sessionId,
      reason: dispatchIntent === "steer" ? "steer" : "prompt",
      requestId: requestId ?? null,
      trace: injectTrace(),
    });
  }

  async function submitPrompt(
    promptInput: SubmitSessionPromptInput,
    hooks: SubmitSessionPromptHooks = {},
    options: SubmitSessionPromptOptions = {},
  ) {
    return submitSessionPrompt({
      randomUUID,
      expandPromptTemplate: ({ text, userId, spaceId, sessionId }) => input.promptTemplateService.expand(text, { userId, spaceId, sessionId }),
      expandSkillCommand: skillService
        ? ({ text, userId, spaceId, harness }) => skillService.expand(text, { userId, spaceId, harness })
        : undefined,
      createSessionTurn,
      enqueueSpacePrompt,
      failSessionTurn,
      validateLocalHarness: input.validateLocalHarness,
      validatePromptModel: input.validatePromptModel,
      billingUsageGate: input.billingUsageGate,
    }, promptInput, hooks, options);
  }

  async function expandSessionPromptContent(promptInput: {
    content: ContentBlock[];
    userId: string;
    spaceId: string;
    sessionId?: string | null;
    harness?: PromptHarness | null;
    sandboxSemantics?: boolean;
  }) {
    return expandPromptContent({
      expandPromptTemplate: ({ text, userId, spaceId, sessionId }) => input.promptTemplateService.expand(text, { userId, spaceId, sessionId }),
      expandSkillCommand: skillService
        ? ({ text, userId, spaceId, harness }) => skillService.expand(text, { userId, spaceId, harness })
        : undefined,
    }, promptInput);
  }

  return {
    registerCronjobSession,
    submitPrompt,
    expandPromptContent: expandSessionPromptContent,
  };
}
