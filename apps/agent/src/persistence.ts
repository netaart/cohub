import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { ContentBlock, Usage } from "@cohub/protocol/core";
import type {
  ContextCompactionMeta,
  ContextCompactionScope,
  ContextCompactionTriggerReason,
  MessageRecord,
  MessageToolCallsFile,
  PersistMessageInput,
  SessionTurnRecord,
  SessionTurnStatus,
  StoredIntermediateMessage,
  StoredToolCall,
  TurnIntermediateMessagesFile,
} from "@cohub/protocol/model";
import type { ModelThinkingLevel } from "@cohub/protocol";
import type { ChannelProvider, GatewayOutboundCommand } from "@cohub/protocol/gateway";
import { getRealtimeUserRoom } from "@cohub/protocol/realtime";
import { sessionMessages, sessionTurns, spaceChannels, spaceSessionBindings, spaceSessions, providerMessageRefs, userChannels, userProfiles } from "@cohub/db";
import { listResourceLabelRefs } from "@cohub/core/labels";
import { runtimeResolutionOpen } from "@cohub/core/sessions";
import { sanitizeContentBlocksForPostgresJson, sanitizePostgresJsonValue } from "@cohub/core/content/sanitize";
import { addImageToTextCallsToSummary, claimSessionFallbackTitle, countToolCallsInContent, createImageToTextUsageSummaryAccumulator, deriveMessagePreviewText, deriveSessionFallbackTitle, finalizeImageToTextUsageSummary, readImageToTextCalls, readSessionTitleSource, resolveMessageTurnId, shouldGenerateSessionTitle, summarizeSessionTurnCompactions, sumImageToTextUsage } from "@cohub/core/sessions";
import { buildTraceHeaders, getCurrentRequestId } from "@cohub/infra/tracing";
import { enqueueSessionMessagePostprocess } from "./session-message-postprocess-queue.js";
import { enqueueSessionTitleGeneration } from "./session-title-queue.js";
import { normalizeAssistantTurn } from "./assistant-message-normalizer.js";
import { indexTurnReferences } from "./reference-index.js";
import { db } from "./db.js";
import { buildUserMessagesForBatch, type ClaimedTurnBatch } from "./batch.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { redis, publishRealtimeEnvelope, clearPersistedSessionStreamSnapshot, getGatewayNodeOutboundStreamKey, xaddWithMaxlen } from "./redis.js";
import { buildTurnObjectPrefix, writeTurnObjectJson } from "./turn-object-storage.js";
import { pickRealtimeMessageMeta } from "./realtime-message-meta.js";


const INTERNAL_API_BASE_URL =
  env.ENV === "prod"
    ? "http://cohub-api.cohub.svc.cluster.local:8787"
    : "http://cohub-api-dev.cohub-dev.svc.cluster.local:8787";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const stableSerialize = (value: unknown): string => {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, nestedValue]) => `${JSON.stringify(key)}:${stableSerialize(nestedValue)}`).join(",")}}`;
};

const hash = async (value: string) => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
};

const buildAssistantIdempotencyKey = async (input: { previousMessageId: string; message: PersistMessageInput["message"] }) => hash(stableSerialize({ previousMessageId: input.previousMessageId, role: "assistant", message: input.message }));
const buildUserIdempotencyKey = async (input: { messageId: string; content: ContentBlock[]; meta?: Record<string, unknown> | null }) => hash(stableSerialize({ role: "user", messageId: input.messageId, content: input.content, meta: input.meta ?? null }));

const toDateOrNull = (value: string | Date | null | undefined) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const completeMessageTiming = (input?: { startedAt?: string | null; completedAt?: string | null; durationMs?: number | null } | null) => {
  const completedAt = toDateOrNull(input?.completedAt) ?? new Date();
  const startedAt = toDateOrNull(input?.startedAt) ?? completedAt;
  const durationMs = typeof input?.durationMs === "number" && Number.isFinite(input.durationMs)
    ? Math.max(0, Math.floor(input.durationMs))
    : Math.max(0, completedAt.getTime() - startedAt.getTime());
  return { startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(), durationMs };
};

const finiteNumberOrUndefined = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const finiteNumberOrZero = (value: unknown): number => finiteNumberOrUndefined(value) ?? 0;

const compactUndefined = <T extends Record<string, unknown>>(value: T): Partial<T> => Object.fromEntries(
  Object.entries(value).filter(([, nestedValue]) => nestedValue !== undefined),
) as Partial<T>;

const normalizeUsage = (usage: PersistMessageInput["message"]["usage"]): Usage | null => {
  if (!usage || typeof usage !== "object") return null;

  const cost = usage.cost && typeof usage.cost === "object" ? compactUndefined({
    input: finiteNumberOrUndefined(usage.cost.input),
    output: finiteNumberOrUndefined(usage.cost.output),
    cacheRead: finiteNumberOrUndefined(usage.cost.cacheRead),
    cacheWrite: finiteNumberOrUndefined(usage.cost.cacheWrite),
    total: finiteNumberOrUndefined(usage.cost.total),
  }) : null;
  if (cost && cost.total === undefined) {
    cost.total = finiteNumberOrZero(cost.input)
      + finiteNumberOrZero(cost.output)
      + finiteNumberOrZero(cost.cacheRead)
      + finiteNumberOrZero(cost.cacheWrite);
  }

  return compactUndefined({
    input: finiteNumberOrUndefined(usage.input),
    output: finiteNumberOrUndefined(usage.output),
    cacheRead: finiteNumberOrUndefined(usage.cacheRead),
    cacheWrite: finiteNumberOrUndefined(usage.cacheWrite),
    totalTokens: finiteNumberOrUndefined(usage.totalTokens),
    cost: cost && Object.keys(cost).length > 0 ? cost : null,
  }) as Usage;
};

const normalizeRecord = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const THINKING_LEVEL_SET = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function extractThinkingLevel(meta: unknown): ModelThinkingLevel | null {
  const record = normalizeRecord(meta);
  if (!record) return null;
  const level = record.effectiveThinkingLevel;
  return typeof level === "string" && THINKING_LEVEL_SET.has(level) ? level as ModelThinkingLevel : null;
}

const getNextSessionSequence = async (sessionId: string) => {
  const [row] = await db.select({ max: sql<number>`coalesce(max(${sessionMessages.sequence}), 0)::int` }).from(sessionMessages).where(eq(sessionMessages.sessionId, sessionId));
  return (row?.max ?? 0) + 1;
};

const toIso = (value: Date | string | null | undefined) => value instanceof Date ? value.toISOString() : value ?? new Date().toISOString();
const toIsoOrNull = (value: Date | string | null | undefined) => value ? toIso(value) : null;

const toMessageRecord = (row: typeof sessionMessages.$inferSelect): MessageRecord => ({
  id: row.id,
  sessionId: row.sessionId,
  role: row.role as MessageRecord["role"],
  content: row.content as ContentBlock[],
  text: row.text ?? null,
  sequence: row.sequence,
  provider: row.provider ?? null,
  model: row.model ?? null,
  stopReason: row.stopReason ?? null,
  errorMessage: row.errorMessage ?? null,
  usage: row.usage as Usage | null,
  meta: normalizeRecord(row.meta),
  startedAt: toIsoOrNull(row.startedAt),
  completedAt: toIsoOrNull(row.completedAt),
  durationMs: row.durationMs ?? null,
  createdAt: toIso(row.createdAt),
});

const toTurnRecord = (row: typeof sessionTurns.$inferSelect): SessionTurnRecord => ({
  id: row.id,
  sessionId: row.sessionId,
  userUuid: row.userUuid ?? null,
  sequence: row.sequence,
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
  finalUsage: row.finalUsage ?? null,
  totalUsage: row.totalUsage ?? null,
  summary: row.summary ?? null,
  intermediateIndex: row.intermediateIndex ?? null,
  intermediateSummary: row.intermediateSummary ?? null,
  harnessIndex: row.harnessIndex ?? null,
  meta: normalizeRecord(row.meta),
  thinkingLevel: extractThinkingLevel(row.meta),
  startedAt: toIsoOrNull(row.startedAt),
  completedAt: toIsoOrNull(row.completedAt),
  durationMs: row.durationMs ?? null,
  createdAt: toIso(row.createdAt),
  updatedAt: toIso(row.updatedAt),
});

const fallbackDisplayName = (userUuid: string) => userUuid.replaceAll("-", "").slice(0, 8);

async function hydrateTurnAuthorProfile(turn: SessionTurnRecord): Promise<SessionTurnRecord> {
  if (!turn.userUuid) return { ...turn, authorProfile: null };
  const [profile] = await db.select({
    userUuid: userProfiles.userUuid,
    displayName: userProfiles.displayName,
    avatarUrl: userProfiles.avatarUrl,
  }).from(userProfiles).where(eq(userProfiles.userUuid, turn.userUuid)).limit(1);
  return {
    ...turn,
    authorProfile: profile
      ? {
          userUuid: profile.userUuid,
          displayName: profile.displayName,
          avatarUrl: profile.avatarUrl ?? null,
        }
      : {
          userUuid: turn.userUuid,
          displayName: fallbackDisplayName(turn.userUuid),
          avatarUrl: null,
        },
  };
}

async function publishMessagePersisted(spaceId: string, message: MessageRecord) {
  await publishRealtimeEnvelope({
    domain: "session",
    type: "session.message.persisted",
    spaceId,
    sessionId: message.sessionId,
    payload: {
      message: { ...message, text: message.content.length > 0 ? null : message.text, meta: pickRealtimeMessageMeta(message.meta) },
    },
  });
}

async function publishTurnCreated(spaceId: string, turn: SessionTurnRecord) {
  const hydratedTurn = await hydrateTurnAuthorProfile(turn);
  await publishRealtimeEnvelope({ domain: "session", type: "session.turn.created", spaceId, sessionId: hydratedTurn.sessionId, payload: { turn: hydratedTurn } });
}

const truncateTurnPreview = (text: string | null | undefined) => {
  const normalized = text?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
};

export async function publishSessionTurnsUpdated(input: {
  sessionId: string;
  turnIds: string[];
}) {
  const turnIds = [...new Set(input.turnIds.filter(Boolean))];
  if (turnIds.length === 0) return;
  const rows = await db.select({
    turn: sessionTurns,
    spaceId: spaceSessions.spaceId,
  }).from(sessionTurns).innerJoin(
    spaceSessions,
    eq(spaceSessions.id, sessionTurns.sessionId),
  ).where(and(
    eq(sessionTurns.sessionId, input.sessionId),
    inArray(sessionTurns.id, turnIds),
  ));
  await Promise.all(rows.map(({ turn, spaceId }) => publishRealtimeEnvelope({
    domain: "session",
    type: "session.turn.updated",
    spaceId,
    sessionId: input.sessionId,
    payload: { turn: toTurnRecord(turn) },
  })));
}

async function publishTurnFinalized(spaceId: string, turn: SessionTurnRecord) {
  await clearPersistedSessionStreamSnapshot(spaceId, turn.sessionId, turn.id);
  const sessionLabelRefs = await listResourceLabelRefs({
    db,
    spaceId,
    resourceType: "session",
    resourceRef: turn.sessionId,
  }).catch((error) => {
    logger.warn("[Realtime] failed to load session labels for finalized turn", {
      spaceId,
      sessionId: turn.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  await publishRealtimeEnvelope({
    domain: "session",
    type: "session.turn.finalized",
    spaceId,
    sessionId: turn.sessionId,
    payload: { turn, sessionLabelRefs },
  });
  if (!turn.userUuid) return;
  await publishRealtimeEnvelope({
    domain: "session",
    type: "session.turn.notify",
    spaceId,
    sessionId: turn.sessionId,
    rooms: [getRealtimeUserRoom(turn.userUuid)],
    payload: {
      spaceId,
      sessionId: turn.sessionId,
      turnId: turn.id,
      status: turn.status,
      finishReason: turn.summary?.finishReason ?? null,
      userPreview: truncateTurnPreview(turn.userText),
      durationMs: turn.durationMs,
      stepCount: turn.intermediateSummary?.messageCount ?? null,
      sequence: turn.sequence ?? null,
      provider: turn.provider,
      model: turn.model,
      completedAt: turn.completedAt,
    },
  });
}

async function updateSessionAfterAppend(sessionId: string, message: typeof sessionMessages.$inferSelect) {
  await db.update(spaceSessions).set({ lastMessageId: message.id, latestMessageText: message.text, lastMessageAt: message.createdAt ?? new Date(), updatedAt: new Date() }).where(eq(spaceSessions.id, sessionId));
}

type PersistenceTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function persistMessageNode(input: PersistMessageInput & { message: PersistMessageInput["message"] & { id?: string } }, finalizeLocal?: (tx: PersistenceTransaction, message: typeof sessionMessages.$inferSelect) => Promise<void>): Promise<{ message: typeof sessionMessages.$inferSelect; created: boolean }> {
  const [existing] = await db.select().from(sessionMessages).where(and(eq(sessionMessages.sessionId, input.sessionId), eq(sessionMessages.idempotencyKey, input.idempotencyKey))).limit(1);
  if (existing) {
    if (existing.role === "user") {
      try {
        const [session] = await db.select({ meta: spaceSessions.meta })
          .from(spaceSessions)
          .where(eq(spaceSessions.id, input.sessionId))
          .limit(1);
        if (
          readSessionTitleSource(session?.meta) === "fallback"
          && shouldGenerateSessionTitle({ content: existing.content })
        ) {
          await enqueueSessionTitleGeneration({
            sessionId: input.sessionId,
            messageId: existing.id,
            userId: input.userId ?? null,
          });
        }
      } catch (error) {
        logger.warn("[SessionTitle] failed to re-enqueue title generation", error);
      }
    }
    return { message: existing, created: false };
  }

  const [session] = await db.select({ id: spaceSessions.id, spaceId: spaceSessions.spaceId }).from(spaceSessions).where(eq(spaceSessions.id, input.sessionId)).limit(1);
  if (!session || session.spaceId !== input.spaceId) throw new Error("Space session not found");

  if (input.previousMessageId) {
    const [previous] = await db.select({ id: sessionMessages.id }).from(sessionMessages).where(and(eq(sessionMessages.id, input.previousMessageId), eq(sessionMessages.sessionId, input.sessionId))).limit(1);
    if (!previous) throw new Error("Previous message not found");
  }

  const sequence = await getNextSessionSequence(input.sessionId);
  const content = sanitizeContentBlocksForPostgresJson(input.message.content);
  const text = deriveMessagePreviewText({ content }) || null;
  const messageRole = input.message.role ?? "assistant";
  const normalizedUsage = normalizeUsage(input.message.usage);
  const isAborted = input.message.stopReason === "aborted";
  const hasError = Boolean(input.message.errorMessage) || input.message.stopReason === "error";
  const isUnsuccessful = hasError || isAborted;
  if (messageRole === "assistant" && content.length === 0 && !text?.trim() && !isUnsuccessful) throw new Error("Refusing to persist empty assistant message");

  const requestedMessageKind = input.message.meta?.messageKind;
  // Explicit intermediate/final kinds win over inference so local streamed commits stay intermediate.
  const messageKind = messageRole !== "assistant"
    ? messageRole
    : requestedMessageKind === "assistant_intermediate"
      ? "assistant_intermediate"
      : isUnsuccessful
        ? "assistant_error"
        : requestedMessageKind === "shell_command_result" || requestedMessageKind === "assistant_final"
          ? "assistant_final"
          : countToolCallsInContent(content) > 0 || input.message.stopReason === "tool_use"
            ? "assistant_intermediate"
            : "assistant_final";
  const completedAt = toDateOrNull(input.message.completedAt) ?? new Date();
  const startedAt = toDateOrNull(input.message.startedAt) ?? completedAt;
  const durationMs = typeof input.message.durationMs === "number" ? Math.max(0, Math.floor(input.message.durationMs)) : Math.max(0, completedAt.getTime() - startedAt.getTime());
  const anchorUserMessageId = input.anchorUserMessageId?.trim() || null;
  const messageTurnId = resolveMessageTurnId(input.message.meta);

  const values: typeof sessionMessages.$inferInsert = {
    id: input.message.id?.trim() || undefined,
    sessionId: input.sessionId,
    turnId: messageTurnId,
    role: messageRole,
    content,
    text,
    meta: sanitizePostgresJsonValue({ ...input.message.meta, messageKind, anchorUserMessageId, actorUserId: input.userId ?? null, providerResponseId: input.message.meta?.responseId ?? null }),
    idempotencyKey: input.idempotencyKey,
    sequence,
    provider: input.message.provider ?? null,
    model: input.message.model ?? null,
    stopReason: input.message.stopReason ?? null,
    errorMessage: isAborted ? null : input.message.errorMessage ?? null,
    usage: normalizedUsage,
    startedAt,
    completedAt,
    durationMs,
  };
  const localResult = messageRole === "assistant" && input.message.meta?.runtime === "local";
  let created = true;
  const [messageNode] = localResult ? await db.transaction(async (tx) => {
    if (!messageTurnId) throw new Error("Runtime result has no turn identity");
    const resolution = input.message.meta?.runtimeResolution === true;
    const [turn] = await tx.select({ id: sessionTurns.id, status: sessionTurns.status }).from(sessionTurns)
      .where(and(eq(sessionTurns.id, messageTurnId), eq(sessionTurns.sessionId, input.sessionId), resolution ? sql`${sessionTurns.meta}->'runtimeRecovery'->>'state' = 'confirmed_stopped'` : runtimeResolutionOpen)).limit(1).for("update");
    if (!turn) throw new Error("Runtime execution was manually resolved; late result retained locally");
    const [duplicate] = await tx.select().from(sessionMessages).where(and(eq(sessionMessages.sessionId, input.sessionId), eq(sessionMessages.idempotencyKey, input.idempotencyKey))).limit(1);
    if (duplicate) { created = false; return [duplicate]; }
    if (!["running", "abort_requested"].includes(turn.status)) throw new Error("Runtime execution already finalized");
    const [message] = await tx.insert(sessionMessages).values(values).returning();
    if (!message) throw new Error("Failed to persist Runtime message");
    if (finalizeLocal) await finalizeLocal(tx, message);
    await tx.update(spaceSessions).set({ lastMessageId: message.id, latestMessageText: message.text, lastMessageAt: message.createdAt ?? new Date(), updatedAt: new Date() }).where(eq(spaceSessions.id, input.sessionId));
    return [message];
  }) : await db.insert(sessionMessages).values(values).returning();
  if (!messageNode) throw new Error("Failed to persist message");

  if (messageRole === "user") {
    try {
      const fallbackTitle = deriveSessionFallbackTitle({ content, text });
      if (
        fallbackTitle
        && await claimSessionFallbackTitle(db, { sessionId: input.sessionId, title: fallbackTitle })
        && shouldGenerateSessionTitle({ content })
      ) {
        await enqueueSessionTitleGeneration({
          sessionId: input.sessionId,
          messageId: messageNode.id,
          userId: input.userId ?? null,
        });
      }
    } catch (error) {
      logger.warn("[SessionTitle] failed to prepare title generation", error);
    }
  }
  if (!localResult) await updateSessionAfterAppend(input.sessionId, messageNode);
  return { message: messageNode, created };
}

const addUsage = (a: Usage | null | undefined, b: Usage | null | undefined): Usage | null => {
  if (!a && !b) return null;
  return {
    input: (a?.input ?? 0) + (b?.input ?? 0),
    output: (a?.output ?? 0) + (b?.output ?? 0),
    cacheRead: (a?.cacheRead ?? 0) + (b?.cacheRead ?? 0),
    cacheWrite: (a?.cacheWrite ?? 0) + (b?.cacheWrite ?? 0),
    totalTokens: (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0),
    cost: a?.cost || b?.cost
      ? {
          input: (a?.cost?.input ?? 0) + (b?.cost?.input ?? 0),
          output: (a?.cost?.output ?? 0) + (b?.cost?.output ?? 0),
          cacheRead: (a?.cost?.cacheRead ?? 0) + (b?.cost?.cacheRead ?? 0),
          cacheWrite: (a?.cost?.cacheWrite ?? 0) + (b?.cost?.cacheWrite ?? 0),
          total: (a?.cost?.total ?? 0) + (b?.cost?.total ?? 0),
        }
      : null,
  };
};

const addDurationMs = (a: number | null, b: number | null | undefined) => {
  if (typeof b !== "number" || !Number.isFinite(b)) return a;
  return (a ?? 0) + Math.max(0, Math.floor(b));
};

const truncateText = (text: string, limit: number) => {
  if (text.length <= limit) return { value: text, truncated: false, originalLength: text.length };
  return { value: `${text.slice(0, Math.max(0, limit - 1))}…`, truncated: true, originalLength: text.length };
};

const summarizeValue = (value: unknown, limit = 240): unknown => {
  if (typeof value === "string") {
    const truncated = truncateText(value, limit);
    return truncated.truncated ? { preview: truncated.value, _truncated: true, originalLength: truncated.originalLength } : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  try {
    const text = JSON.stringify(value);
    const truncated = truncateText(text, limit);
    return { preview: truncated.value, ...(truncated.truncated ? { _truncated: true, originalLength: truncated.originalLength } : {}) };
  } catch {
    const text = String(value);
    const truncated = truncateText(text, limit);
    return { preview: truncated.value, ...(truncated.truncated ? { _truncated: true, originalLength: truncated.originalLength } : {}) };
  }
};

const summarizeToolInput = (input: Record<string, unknown>) => Object.fromEntries(
  Object.entries(input).map(([key, value]) => [key, summarizeValue(value)]),
) as Record<string, unknown>;

const getContentLengthMeta = (content: string | ContentBlock[]) => typeof content === "string"
  ? { originalContentKind: "string", originalLength: content.length }
  : { originalContentKind: "content_blocks", originalBlockCount: content.length };

const extractToolCalls = (content: ContentBlock[]): StoredToolCall[] => {
  const byId = new Map<string, StoredToolCall>();
  for (const block of content) {
    if (block.type === "tool_use") {
      byId.set(block.id, {
        id: block.id,
        name: block.name,
        input: block.input,
        meta: normalizeRecord(block._meta),
        result: null,
      });
    }
  }
  for (const block of content) {
    if (block.type === "tool_result") {
      const existing = byId.get(block.tool_use_id);
      if (existing) {
        byId.set(block.tool_use_id, {
          ...existing,
          result: {
            content: block.content,
            isError: Boolean(block.is_error),
            meta: normalizeRecord(block._meta),
          },
        });
      }
    }
  }
  return [...byId.values()];
};

const summarizeIntermediateContent = (content: ContentBlock[], tools: StoredToolCall[]): ContentBlock[] => {
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  return content.map((block) => {
    if (block.type === "tool_use") {
      const tool = byId.get(block.id);
      return {
        ...block,
        input: summarizeToolInput(tool?.input ?? block.input),
        _meta: {
          ...(block._meta ?? {}),
          contentDetail: "summary",
          inputDetail: "summary",
          toolStatus: tool?.result ? (tool.result.isError ? "failed" : "done") : "running",
        },
      };
    }
    if (block.type === "tool_result") {
      return {
        ...block,
        content: [],
        _meta: {
          ...(block._meta ?? {}),
          contentDetail: "summary",
          resultDetail: "omitted",
          ...getContentLengthMeta(block.content),
        },
      };
    }
    return block;
  });
};

const writeTurnObjects = async (files: Array<{ objectKey: string; value: unknown }>) => {
  const concurrency = Math.min(4, files.length);
  await Promise.all(Array.from({ length: concurrency }, async (_, workerIndex) => {
    for (let index = workerIndex; index < files.length; index += concurrency) {
      const file = files[index];
      if (!file) continue;
      await writeTurnObjectJson(file.objectKey, file.value);
    }
  }));
};

const buildIntermediateObjectsForTurn = async (input: { spaceId: string; sessionId: string; turnId: string }) => {
  const rows = await db.select().from(sessionMessages).where(and(
    eq(sessionMessages.sessionId, input.sessionId),
    eq(sessionMessages.turnId, input.turnId),
  )).orderBy(asc(sessionMessages.sequence), asc(sessionMessages.createdAt));

  const intermediateRows = rows.filter((row) => {
    if (row.role === "user") return false;
    const meta = normalizeRecord(row.meta);
    return meta?.messageKind !== "assistant_final" && meta?.messageKind !== "assistant_error";
  });

  const prefix = buildTurnObjectPrefix(input);
  const toolCallsBaseObjectKey = `${prefix}intermediate/messages/`;
  let totalUsage: Usage | null = null;
  const imageToText = createImageToTextUsageSummaryAccumulator();
  let totalDurationMs: number | null = null;
  let toolCallCount = 0;
  let hasError = false;

  const messages: StoredIntermediateMessage[] = [];
  const toolFiles: Array<{ objectKey: string; value: MessageToolCallsFile }> = [];
  for (const row of intermediateRows) {
    const content = row.content as ContentBlock[];
    const details = extractToolCalls(content);
    toolCallCount += details.length;
    totalUsage = addUsage(totalUsage, row.usage as Usage | null | undefined);
    const imageToTextCalls = readImageToTextCalls(row.meta);
    addImageToTextCallsToSummary(imageToText, imageToTextCalls);
    totalUsage = addUsage(totalUsage, sumImageToTextUsage(row.meta));
    totalDurationMs = addDurationMs(totalDurationMs, row.durationMs ?? null);
    hasError = hasError || Boolean(row.errorMessage) || details.some((tool) => tool.result?.isError);
    const toolCallsObjectKey = details.length > 0 ? `${toolCallsBaseObjectKey}${row.id}/tool-calls.json` : null;
    if (toolCallsObjectKey) {
      toolFiles.push({
        objectKey: toolCallsObjectKey,
        value: {
          version: 1,
          spaceId: input.spaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          messageId: row.id,
          toolCalls: details,
        },
      });
    }
    messages.push({
      id: row.id,
      sessionId: row.sessionId,
      sequence: row.sequence,
      role: row.role as "user" | "assistant" | "system",
      content: summarizeIntermediateContent(content, details),
      text: row.text ?? null,
      provider: row.provider ?? null,
      model: row.model ?? null,
      stopReason: row.stopReason ?? null,
      errorMessage: row.errorMessage ?? null,
      usage: row.usage as Usage | null,
      durationMs: row.durationMs ?? null,
      toolCallsObjectKey,
      meta: normalizeRecord(row.meta),
      createdAt: toIso(row.createdAt),
    });
  }

  const summary = {
    messageCount: messages.length,
    toolCallCount,
    usage: totalUsage,
    durationMs: totalDurationMs,
    lastMessageText: messages.at(-1)?.text ?? null,
    hasError,
    compaction: summarizeSessionTurnCompactions(messages),
    imageToText: finalizeImageToTextUsageSummary(imageToText),
  };
  if (messages.length === 0) return { index: null, summary, rows, imageToTextAccumulator: imageToText };

  try {
    await writeTurnObjects(toolFiles);
    const messagesObjectKey = `${prefix}intermediate/messages.json`;
    const file: TurnIntermediateMessagesFile = {
      version: 1,
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      summary,
      messages,
    };
    const written = await writeTurnObjectJson(messagesObjectKey, file);
    return {
      index: {
        version: 1 as const,
        messagesObjectKey,
        messagesSizeBytes: written.sizeBytes,
        toolCallsBaseObjectKey,
      },
      summary,
      rows,
      imageToTextAccumulator: imageToText,
    };
  } catch (error) {
    logger.warn("[SessionTurn] failed to write intermediate objects", error);
    return { index: null, summary, rows, imageToTextAccumulator: imageToText };
  }
};

async function finalizeSessionTurnFromMessage(input: { spaceId: string; sessionId: string; turnId: string; status: Exclude<SessionTurnStatus, "running">; assistantContent: ContentBlock[]; assistantText: string | null; provider: string | null; model: string | null; stopReason: string | null; errorMessage: string | null; usage: Usage | null; metaPatch?: Record<string, unknown> | null }, executor: Pick<typeof db, "update"> = db, prepared?: Awaited<ReturnType<typeof buildIntermediateObjectsForTurn>>) {
  const intermediate = prepared ?? await buildIntermediateObjectsForTurn(input);
  const imageToText = intermediate?.imageToTextAccumulator ?? createImageToTextUsageSummaryAccumulator();
  const finalCalls = readImageToTextCalls(input.metaPatch);
  addImageToTextCallsToSummary(imageToText, finalCalls);
  const imageToTextSummary = finalizeImageToTextUsageSummary(imageToText);
  const currentImageToText = normalizeRecord(input.metaPatch?.imageToText);
  const turnMetaPatch = {
    ...(input.metaPatch ?? {}),
    ...(imageToTextSummary.callCount > 0
      ? { imageToText: { ...(currentImageToText ?? {}), schemaVersion: 1, summary: imageToTextSummary } }
      : {}),
  };
  const completedAt = new Date();
  const completedAtIso = completedAt.toISOString();
  const [row] = await executor.update(sessionTurns).set({
    status: input.status,
    assistantContent: input.assistantContent,
    assistantText: input.assistantText,
    provider: input.provider,
    model: input.model,
    stopReason: input.stopReason,
    errorMessage: input.errorMessage,
    finalUsage: input.usage,
    totalUsage: addUsage(addUsage(intermediate?.summary.usage, input.usage), sumImageToTextUsage(input.metaPatch)),
    ...(Object.keys(turnMetaPatch).length > 0 ? { meta: sql`coalesce(${sessionTurns.meta}, '{}'::jsonb) || ${JSON.stringify(turnMetaPatch)}::jsonb` } : {}),
    summary: { text: input.assistantText, finishReason: input.status === "interrupted" ? "interrupted" : input.status === "failed" ? "failed" : "completed" },
    intermediateIndex: intermediate?.index ?? null,
    intermediateSummary: intermediate?.summary ?? null,
    completedAt,
    durationMs: sql<number>`greatest(0, floor(extract(epoch from (${completedAtIso}::timestamptz - ${sessionTurns.startedAt})) * 1000)::int)`,
    updatedAt: completedAt,
  }).where(and(eq(sessionTurns.id, input.turnId), eq(sessionTurns.sessionId, input.sessionId), inArray(sessionTurns.status, ["running", "abort_requested", "interrupted"]), input.metaPatch?.runtimeResolution === true ? undefined : runtimeResolutionOpen)).returning();
  return { turn: row ? toTurnRecord(row) : null, messages: intermediate.rows };
}

async function requestGatewayChannelReconcile(reason: string) {
  try {
    const response = await fetch(`${INTERNAL_API_BASE_URL}/internal/gateway/reconcile-channels`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(env.WORKER_SECRET ? { "x-worker-secret": env.WORKER_SECRET } : {}), ...buildTraceHeaders({ requestId: getCurrentRequestId() }) },
      body: JSON.stringify({ reason }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Gateway reconcile failed ${response.status}: ${text}`);
    }
  } catch (error) {
    logger.warn("[GatewayBinding] failed to request channel reconcile", { reason, error });
  }
}

const GATEWAY_ROUTE_RETRY_DELAYS_MS = [200, 800, 2_000];

async function resolveGatewayNodeForOutbound(input: { spaceChannelId: string; spaceId: string; sessionId: string; messageId: string }) {
  for (let attempt = 0; attempt <= GATEWAY_ROUTE_RETRY_DELAYS_MS.length; attempt += 1) {
    const nodeId = await redis.hget("gateway:channel_routing", input.spaceChannelId);
    if (nodeId) return nodeId;
    await requestGatewayChannelReconcile(`missing_agent_outbound_route:${input.spaceChannelId}`);
    const retryDelay = GATEWAY_ROUTE_RETRY_DELAYS_MS[attempt];
    if (retryDelay == null) break;
    await sleep(retryDelay);
  }
  throw new Error(`Gateway route is missing for final assistant outbound channel ${input.spaceChannelId}`);
}

async function dispatchFinalAssistantToGateway(input: { spaceId: string; sessionId: string; message: MessageRecord }) {
  if (input.message.role !== "assistant") return;
  const kind = input.message.meta?.messageKind;
  if (kind !== "assistant_final" && kind !== "assistant_error") return;

  const bindings = await db.select().from(spaceSessionBindings).where(eq(spaceSessionBindings.spaceSessionId, input.sessionId));
  const targetBindings = bindings.length > 0
    ? bindings.map((binding) => ({ spaceChannelId: binding.spaceChannelId, provider: binding.provider, externalChatId: binding.externalChatId, bindingKey: binding.bindingKey }))
    : (await db.select({ spaceChannelId: spaceChannels.id, provider: userChannels.provider, externalChatId: sql<string | null>`null`, bindingKey: sql<string>`''` }).from(spaceChannels).innerJoin(userChannels, eq(userChannels.id, spaceChannels.channelId)).where(eq(spaceChannels.spaceId, input.spaceId))).map((row) => ({ ...row, externalChatId: row.externalChatId ?? null }));

  for (const binding of targetBindings) {
    if (!binding.externalChatId) continue;
    const nodeId = await resolveGatewayNodeForOutbound({ spaceChannelId: binding.spaceChannelId, spaceId: input.spaceId, sessionId: input.sessionId, messageId: input.message.id });
    const turnAnchorMessageId = typeof input.message.meta?.anchorUserMessageId === "string" ? input.message.meta.anchorUserMessageId : input.message.id;
    const [anchorRef] = await db.select({ externalMessageId: providerMessageRefs.externalMessageId }).from(providerMessageRefs).where(and(eq(providerMessageRefs.spaceChannelId, binding.spaceChannelId), eq(providerMessageRefs.sessionMessageId, turnAnchorMessageId), eq(providerMessageRefs.direction, "inbound"))).orderBy(desc(providerMessageRefs.createdAt)).limit(1);
    const command: GatewayOutboundCommand = {
      commandId: randomUUID(), timestamp: Date.now(), channelId: binding.spaceChannelId,
      provider: binding.provider as ChannelProvider, externalChatId: binding.externalChatId,
      content: input.message.content, replyToExternalMessageId: anchorRef?.externalMessageId,
      spaceId: input.spaceId, spaceSessionId: input.sessionId, sessionMessageId: input.message.id,
      meta: { sessionOutput: { type: "session.message.persisted", spaceId: input.spaceId, sessionId: input.sessionId, message: input.message }, bindingKey: binding.bindingKey, sessionMessageRole: input.message.role, turnAnchorMessageId, targetNodeId: nodeId },
    };
    await xaddWithMaxlen(redis, getGatewayNodeOutboundStreamKey(nodeId), "*", "payload", JSON.stringify(command));
  }
}

export async function persistBatchUserMessages(input: { spaceId: string; sessionId: string; batch: ClaimedTurnBatch }) {
  const users = buildUserMessagesForBatch(input.batch);
  if (!users.length) return;
  const rows = await db.select({ id: sessionMessages.id, turnId: sessionMessages.turnId, role: sessionMessages.role }).from(sessionMessages)
    .where(and(eq(sessionMessages.sessionId, input.sessionId), inArray(sessionMessages.id, users.map((user) => user.userMessageId))));
  const existing = new Map(rows.map((row) => [row.id, row]));
  // Claim/recovery metadata can change. Stable message IDs, not a metadata hash, fence replay.
  for (const user of users) {
    const previous = existing.get(user.userMessageId);
    if (previous) {
      if (previous.turnId !== user.turnId || previous.role !== "user") throw new Error("Batch message identity mismatch");
      continue;
    }
    await persistUserMessage({ spaceId: input.spaceId, sessionId: input.sessionId, ...user });
  }
}

export async function persistUserMessage(input: { spaceId: string; sessionId: string; userMessageId: string; turnId: string; agentSessionEntryId?: string | null; content: ContentBlock[]; meta?: Record<string, unknown> | null; startedAt?: string | null }) {
  const turnId = resolveMessageTurnId({ turnId: input.turnId });
  if (!turnId) throw new Error("Valid user message turn id is required");
  const [turnRow] = await db.select().from(sessionTurns).where(and(
    eq(sessionTurns.id, turnId),
    eq(sessionTurns.sessionId, input.sessionId),
  )).limit(1);
  if (!turnRow) throw new Error("User message turn not found in session");
  const timing = completeMessageTiming({ startedAt: input.startedAt });
  const persisted = await persistMessageNode({
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    previousMessageId: null,
    anchorUserMessageId: input.userMessageId,
    userId: turnRow.userUuid ?? null,
    idempotencyKey: await buildUserIdempotencyKey({ messageId: input.userMessageId, content: input.content, meta: input.meta ?? null }),
    message: { id: input.userMessageId, role: "user", content: input.content, meta: { ...(input.meta ?? {}), turnId, messageId: input.userMessageId, clientMessageId: typeof input.meta?.clientMessageId === "string" ? input.meta.clientMessageId : null, agentSessionEntryId: input.agentSessionEntryId ?? (typeof input.meta?.sessionEntryId === "string" ? input.meta.sessionEntryId : null) }, provider: null, model: null, stopReason: null, errorMessage: null, usage: null, ...timing },
  });
  const record = toMessageRecord(persisted.message);
  if (!persisted.created) return { ok: true, message: record, created: false };
  await publishMessagePersisted(input.spaceId, record);
  return { ok: true, message: record };
}

const EMPTY_ASSISTANT_MESSAGE_ERROR = "LLM returned an empty assistant message after streaming completed.";

export async function persistAssistantMessage(input: { spaceId: string; spaceSessionId: string; userMessageId: string; event: Record<string, unknown>; userId?: string | null; turnId?: string | null; startedAt?: string | null; completedAt?: string | null; messageOrdinal?: number | null; thinkingLevel?: string | null; idempotencyKey?: string }) {
  const assistantMessage = input.event.message;
  const toolResultsRaw = Array.isArray(input.event.toolResults) ? input.event.toolResults as Array<Record<string, unknown>> : [];
  if (!assistantMessage || typeof assistantMessage !== "object") {
    logger.warn("[Persist] turn_end event missing assistant message payload.");
    return;
  }
  const assistant = assistantMessage as Record<string, unknown>;
  const normalized = normalizeAssistantTurn(assistant, toolResultsRaw);
  const stopReason = typeof assistant.stopReason === "string" ? assistant.stopReason : null;
  const errorMessage = typeof assistant.errorMessage === "string" ? assistant.errorMessage : null;
  const hasAssistantError = stopReason === "error" || stopReason === "aborted" || Boolean(errorMessage);
  const isEmptySuccessfulAssistant = normalized.content.length === 0 && !hasAssistantError;
  const effectiveStopReason = isEmptySuccessfulAssistant ? "error" : stopReason;
  const effectiveErrorMessage = isEmptySuccessfulAssistant ? EMPTY_ASSISTANT_MESSAGE_ERROR : errorMessage;
  const timing = completeMessageTiming({ startedAt: input.startedAt, completedAt: input.completedAt });

  const message: PersistMessageInput["message"] = {
    role: "assistant",
    externalMessageId: typeof assistant.id === "string" ? assistant.id : null,
    protocolMessageId: typeof assistant.id === "string" ? assistant.id : null,
    content: normalized.content,
    provider: typeof assistant.provider === "string" ? assistant.provider : null,
    model: typeof assistant.model === "string" ? assistant.model : null,
    stopReason: effectiveStopReason,
    errorMessage: effectiveErrorMessage,
    // messageOrdinal 必须与 stream_update(session.turn.patch) 事件里的 messageOrdinal 保持同一套编号体系，
    // 否则 SDK 的 messageRecordToIntermediate(处理 session.message.persisted 事件)
    // 会因为读不到 meta.messageOrdinal 而 fallback 到 messageId=message.id(DB UUID)，
    // 与 stream-snapshot API 重新编号的 ordinal:N 不在同一套去重 key 体系里，
    // 导致同一条中间消息在快照恢复与实时事件两条路径里无法合并，最终在
    // ProcessCard/ToolCallList 的 {#each ... (id)} 产生重复 key(each_key_duplicate)。
    meta: { ...(normalizeRecord(assistant.meta) ?? {}), turnId: input.turnId ?? null, spaceId: input.spaceId, sessionId: input.spaceSessionId, nativeApi: typeof assistant.api === "string" ? assistant.api : null, rawStopReason: stopReason, messageOrdinal: input.messageOrdinal ?? null, ...(isEmptySuccessfulAssistant ? { emptyAssistantMessageConvertedToError: true } : {}), thinking: normalized.thinking, thinkingSummary: normalized.thinkingSummary, toolCallRenderStates: normalized.toolCallRenderStates, agentSessionEntryId: typeof assistant.sessionEntryId === "string" ? assistant.sessionEntryId : null },
    usage: normalizeUsage(assistant.usage as PersistMessageInput["message"]["usage"]),
    ...timing,
  };
  const local = message.meta?.runtime === "local";
  const localFinal = local && (message.meta?.messageKind === "assistant_final" || message.meta?.messageKind === "assistant_error");
  if (local && input.idempotencyKey) {
    const [existing] = await db.select().from(sessionMessages).where(and(eq(sessionMessages.sessionId, input.spaceSessionId), eq(sessionMessages.idempotencyKey, input.idempotencyKey))).limit(1);
    if (existing) return { ok: true, message: toMessageRecord(existing), created: false };
  }
  const prepared = localFinal && input.turnId ? await buildIntermediateObjectsForTurn({ spaceId: input.spaceId, sessionId: input.spaceSessionId, turnId: input.turnId }) : undefined;
  const persisted = await persistMessageNode({ spaceId: input.spaceId, sessionId: input.spaceSessionId, previousMessageId: input.userMessageId, anchorUserMessageId: input.userMessageId, userId: input.userId ?? null, idempotencyKey: input.idempotencyKey ?? await buildAssistantIdempotencyKey({ previousMessageId: input.userMessageId, message }), message }, localFinal ? async (tx, row) => {
    if (!input.turnId) throw new Error("Missing Runtime final turn identity");
    const result = await finalizeSessionTurnFromMessage({ spaceId: input.spaceId, sessionId: input.spaceSessionId, turnId: input.turnId,
      status: effectiveStopReason === "aborted" ? "interrupted" : effectiveStopReason === "error" || effectiveErrorMessage ? "failed" : "completed",
      assistantContent: row.content, assistantText: row.text, provider: row.provider, model: row.model, stopReason: row.stopReason, errorMessage: row.errorMessage, usage: row.usage as Usage | null,
      metaPatch: { ...(message.meta?.runtimeResolution === true ? { runtimeResolution: true } : {}), runtimeArchiveStatus: message.meta?.runtimeArchiveStatus ?? "failed", finalMessageDurationMs: row.durationMs,
        ...(input.thinkingLevel ? { effectiveThinkingLevel: input.thinkingLevel } : {}),
      },
    }, tx, prepared);
    if (!result.turn) throw new Error("Runtime finalization lost its turn");
  } : undefined);
  const record = toMessageRecord(persisted.message);
  if (local) {
    if (persisted.created && prepared && input.turnId) indexTurnReferences({ spaceId: input.spaceId, sessionId: input.spaceSessionId, turnId: input.turnId, messages: [...prepared.rows, persisted.message] });
    if (persisted.created) {
      await publishMessagePersisted(input.spaceId, record).catch((error) => logger.warn("[Realtime] failed to publish local Runtime message", error));
      await enqueueSessionMessagePostprocess({ sessionId: input.spaceSessionId, messageId: record.id }).catch((error) => logger.warn("[Postprocess] failed to enqueue local Runtime message", error));
    }
    if (localFinal && input.turnId) {
      const [turn] = await db.select().from(sessionTurns).where(eq(sessionTurns.id, input.turnId)).limit(1);
      if (turn) await publishTurnFinalized(input.spaceId, toTurnRecord(turn)).catch((error) => logger.warn("[Realtime] failed to publish local Runtime turn", error));
      await dispatchFinalAssistantToGateway({ spaceId: input.spaceId, sessionId: input.spaceSessionId, message: record }).catch((error) => logger.warn("[GatewayOutbound] failed to dispatch local Runtime message", error));
    }
    return { ok: true, message: record, created: persisted.created };
  }
  if (!persisted.created && !input.idempotencyKey) {
    await enqueueSessionMessagePostprocess({ sessionId: input.spaceSessionId, messageId: record.id });
    return { ok: true, message: record, created: false };
  }
  if (persisted.created) await publishMessagePersisted(input.spaceId, record);
  if (record.meta?.messageKind === "assistant_final" || record.meta?.messageKind === "assistant_error") {
    const turnId = typeof record.meta.turnId === "string" ? record.meta.turnId : null;
    if (turnId) {
      const { turn: finalized, messages: turnMessages } = await finalizeSessionTurnFromMessage({ spaceId: input.spaceId, sessionId: input.spaceSessionId, turnId, status: effectiveStopReason === "aborted" ? "interrupted" : record.meta.messageKind === "assistant_error" ? "failed" : "completed", assistantContent: record.content, assistantText: record.text, provider: record.provider, model: record.model, stopReason: record.stopReason, errorMessage: record.errorMessage, usage: record.usage, metaPatch: { ...(record.meta.runtimeResolution === true ? { runtimeResolution: true } : {}), ...(typeof record.meta.agentSessionEntryId === "string" ? { agentSessionEntryId: record.meta.agentSessionEntryId } : {}), ...(record.meta.imageToText ? { imageToText: record.meta.imageToText } : {}), ...(typeof record.durationMs === "number" ? { finalMessageDurationMs: record.durationMs } : {}), ...(typeof input.thinkingLevel === "string" && input.thinkingLevel.trim() ? { effectiveThinkingLevel: input.thinkingLevel } : {}) } });
      if (finalized) {
        indexTurnReferences({ spaceId: input.spaceId, sessionId: finalized.sessionId, turnId: finalized.id, messages: turnMessages });
        await publishTurnFinalized(input.spaceId, finalized).catch((error) => logger.warn("[Realtime] failed to publish finalized turn", error));
      }
    }
    if (persisted.created) await dispatchFinalAssistantToGateway({ spaceId: input.spaceId, sessionId: input.spaceSessionId, message: record }).catch((error) => logger.error("[GatewayOutbound] failed to dispatch assistant message", error));
  }
  // Every assistant round is postprocessed, including intermediate tool-use messages.
  // Billing uses a stable message operation ID; hourly aggregation intentionally runs last.
  await enqueueSessionMessagePostprocess({ sessionId: input.spaceSessionId, messageId: record.id });
  return { ok: true, message: record };
}

async function finalizeInterruptedTurn(input: { spaceId: string; sessionId: string; turnId: string; stopReason: "interrupted" | "aborted"; summary: Record<string, unknown> }) {
  const [existing] = await db.select().from(sessionTurns).where(and(eq(sessionTurns.id, input.turnId), eq(sessionTurns.sessionId, input.sessionId))).limit(1);
  if (!existing) return { turn: null, messages: [] };
  if (!["running", "abort_requested", "interrupted"].includes(existing.status)) return { turn: toTurnRecord(existing), messages: [] };
  const [last] = await db.select().from(sessionMessages).where(and(
    eq(sessionMessages.sessionId, input.sessionId),
    eq(sessionMessages.turnId, input.turnId),
    eq(sessionMessages.role, "assistant"),
  )).orderBy(desc(sessionMessages.sequence)).limit(1);
  const intermediate = await buildIntermediateObjectsForTurn(input);
  const imageToTextSummary = intermediate?.summary.imageToText;
  const completedAt = new Date();
  const completedAtIso = completedAt.toISOString();
  const [row] = await db.update(sessionTurns).set({ status: "interrupted", assistantContent: last?.content ?? null, assistantText: last?.text ?? null, provider: last?.provider ?? null, model: last?.model ?? null, stopReason: input.stopReason, errorMessage: null, finalUsage: last?.usage as Usage | null ?? null, totalUsage: intermediate?.summary.usage ?? null, summary: input.summary, intermediateIndex: intermediate?.index ?? null, intermediateSummary: intermediate?.summary ?? null, ...(imageToTextSummary && imageToTextSummary.callCount > 0 ? { meta: sql`coalesce(${sessionTurns.meta}, '{}'::jsonb) || ${JSON.stringify({ imageToText: { schemaVersion: 1, summary: imageToTextSummary } })}::jsonb` } : {}), completedAt, durationMs: sql<number>`greatest(0, floor(extract(epoch from (${completedAtIso}::timestamptz - ${sessionTurns.startedAt})) * 1000)::int)`, updatedAt: completedAt }).where(and(eq(sessionTurns.id, input.turnId), eq(sessionTurns.sessionId, input.sessionId), inArray(sessionTurns.status, ["running", "abort_requested", "interrupted"]))).returning();
  return { turn: row ? toTurnRecord(row) : null, messages: intermediate.rows };
}

export async function interruptSessionTurn(input: { spaceId: string; sessionId: string; turnId: string; continuedByTurnId: string }) {
  const { turn, messages } = await finalizeInterruptedTurn({ ...input, stopReason: "interrupted", summary: { finishReason: "interrupted", reason: "steer", continuedByTurnId: input.continuedByTurnId } });
  if (turn) {
    indexTurnReferences({ spaceId: input.spaceId, sessionId: turn.sessionId, turnId: turn.id, messages });
    await publishTurnFinalized(input.spaceId, turn);
  }
  return turn;
}

export async function abortSessionTurn(input: { spaceId: string; sessionId: string; turnId: string; actorUserId?: string | null }) {
  const { turn, messages } = await finalizeInterruptedTurn({ ...input, stopReason: "aborted", summary: { finishReason: "interrupted", reason: "abort" } });
  if (turn) {
    indexTurnReferences({ spaceId: input.spaceId, sessionId: turn.sessionId, turnId: turn.id, messages });
    await publishTurnFinalized(input.spaceId, turn);
  }
  return turn;
}

export async function failSessionTurn(input: { spaceId: string; sessionId: string; turnId: string; errorMessage: string }) {
  const completedAt = new Date();
  const completedAtIso = completedAt.toISOString();
  const [row] = await db.update(sessionTurns).set({ status: "failed", errorMessage: input.errorMessage, summary: { finishReason: "failed", text: input.errorMessage }, completedAt, durationMs: sql<number>`greatest(0, floor(extract(epoch from (${completedAtIso}::timestamptz - ${sessionTurns.startedAt})) * 1000)::int)`, updatedAt: completedAt }).where(and(eq(sessionTurns.id, input.turnId), eq(sessionTurns.sessionId, input.sessionId), inArray(sessionTurns.status, ["queued", "running", "abort_requested", "interrupted"]))).returning();
  const turn = row ? toTurnRecord(row) : null;
  if (turn) {
    // No message load on the failure path, so we skip live reference indexing
    // here (avoiding an extra query for a rare error case); the backfill script
    // reconciles any references from a failed turn's messages.
    await publishTurnFinalized(input.spaceId, turn);
  }
  return turn;
}

type PersistCompactionEventInput = {
  spaceId: string;
  sessionId: string;
  actorUserId: string | null;
  compactionId: string;
  scope: ContextCompactionScope;
  ownerTurnId: string | null;
  firstKeptTurnId: string | null;
  llmRound: number | null;
  triggerReason: ContextCompactionTriggerReason;
  summary: string;
  tokensBefore: number;
  estimatedTokensAfter: number | null;
  firstKeptEntryId: string;
  model: { provider: string; id: string };
  contextWindow: number;
  keepRecentTokens: number;
  summarizedMessageCount: number;
  attemptCount: number;
  providerCalls: {
    total: number;
    succeeded: number;
    failed: number;
  };
  isSplitTurn: boolean;
  usage: Usage | null | undefined;
  durationMs: number;
  archivePath: string | undefined;
  insertBeforeTurnSequence: number | null;
};

/** Persist a turn-boundary or in-turn compaction event at its retained-tail boundary. */
export async function persistCompactionEvent(
  input: PersistCompactionEventInput,
): Promise<{ compactTurnId: string | null; compactSequence: number | null; messageSequence: number } | null> {
  const completedAt = new Date();
  const startedAt = new Date(completedAt.getTime() - Math.max(0, input.durationMs));
  const usage = normalizeUsage(input.usage as PersistMessageInput["message"]["usage"]);
  const state: {
    turnRow: typeof sessionTurns.$inferSelect | null;
    ownerTurnRow: typeof sessionTurns.$inferSelect | null;
    messageRow: typeof sessionMessages.$inferSelect | null;
    compactSequence: number | null;
    messageSequence: number;
  } = {
    turnRow: null,
    ownerTurnRow: null,
    messageRow: null,
    compactSequence: null,
    messageSequence: 0,
  };

  try {
    await db.transaction(async (tx) => {
      const anchorTurnId = input.firstKeptTurnId ?? input.ownerTurnId;
      const [anchorByEntry] = await tx.select({ id: sessionMessages.id, sequence: sessionMessages.sequence })
        .from(sessionMessages)
        .where(and(
          eq(sessionMessages.sessionId, input.sessionId),
          anchorTurnId ? eq(sessionMessages.turnId, anchorTurnId) : undefined,
          sql`${sessionMessages.meta}->>'agentSessionEntryId' = ${input.firstKeptEntryId}`,
        ))
        .limit(1);
      if (input.scope === "within_turn" && !anchorByEntry) {
        throw new Error(`In-turn compaction anchor not found: ${input.firstKeptEntryId}`);
      }
      const [anchorByTurn] = anchorByEntry || !input.firstKeptTurnId
        ? []
        : await tx.select({ id: sessionMessages.id, sequence: sessionMessages.sequence })
          .from(sessionMessages)
          .where(and(
            eq(sessionMessages.sessionId, input.sessionId),
            eq(sessionMessages.turnId, input.firstKeptTurnId),
          ))
          .orderBy(asc(sessionMessages.sequence))
          .limit(1);
      const anchor = anchorByEntry ?? anchorByTurn ?? null;
      const [maxMessage] = anchor
        ? []
        : await tx.select({ max: sql<number>`coalesce(max(${sessionMessages.sequence}), 0)::int` })
          .from(sessionMessages)
          .where(eq(sessionMessages.sessionId, input.sessionId));
      const messageSequence = anchor?.sequence ?? ((maxMessage?.max ?? 0) + 1);

      await tx.update(sessionMessages)
        .set({ sequence: sql`${sessionMessages.sequence} + 1000000` })
        .where(and(eq(sessionMessages.sessionId, input.sessionId), gte(sessionMessages.sequence, messageSequence)));
      await tx.update(sessionMessages)
        .set({ sequence: sql`${sessionMessages.sequence} - 999999` })
        .where(and(eq(sessionMessages.sessionId, input.sessionId), gte(sessionMessages.sequence, messageSequence + 1000000)));

      let compactTurnId: string | null = null;
      let ordinalInTurn: number | null = null;
      if (input.scope === "between_turns") {
        const compactSequence = input.insertBeforeTurnSequence;
        if (compactSequence == null) throw new Error("Missing compact turn insertion sequence");
        await tx.update(sessionTurns)
          .set({ sequence: sql`${sessionTurns.sequence} + 1000000` })
          .where(and(eq(sessionTurns.sessionId, input.sessionId), gte(sessionTurns.sequence, compactSequence)));
        await tx.update(sessionTurns)
          .set({ sequence: sql`${sessionTurns.sequence} - 999999` })
          .where(and(eq(sessionTurns.sessionId, input.sessionId), gte(sessionTurns.sequence, compactSequence + 1000000)));
        state.compactSequence = compactSequence;
      } else {
        if (!input.ownerTurnId) throw new Error("Missing owner turn for in-turn compaction");
        const [ownerTurn] = await tx.select().from(sessionTurns)
          .where(and(eq(sessionTurns.id, input.ownerTurnId), eq(sessionTurns.sessionId, input.sessionId)))
          .limit(1);
        if (!ownerTurn) throw new Error("In-turn compaction owner turn not found");
        state.ownerTurnRow = ownerTurn;
        const [ordinalRow] = await tx.select({
          ordinal: sql<number>`count(*)::int + 1`,
        }).from(sessionMessages).where(and(
          eq(sessionMessages.sessionId, input.sessionId),
          eq(sessionMessages.turnId, input.ownerTurnId),
          sql`${sessionMessages.meta}->>'messageKind' = 'compacted'`,
        ));
        ordinalInTurn = ordinalRow?.ordinal ?? 1;
      }

      const compaction: ContextCompactionMeta = {
        version: 1,
        compactionId: input.compactionId,
        scope: input.scope,
        ownerTurnId: input.ownerTurnId,
        ordinalInTurn,
        llmRound: input.llmRound,
        triggerReason: input.triggerReason,
        contextWindow: input.contextWindow,
        tokensBefore: input.tokensBefore,
        estimatedTokensAfter: input.estimatedTokensAfter,
        provider: input.model.provider,
        model: input.model.id,
        keepRecentTokens: input.keepRecentTokens,
        summarizedMessageCount: input.summarizedMessageCount,
        attemptCount: input.attemptCount,
        providerCalls: input.providerCalls,
        isSplitTurn: input.isSplitTurn,
        firstKeptEntryId: input.firstKeptEntryId,
        archivePath: input.archivePath ?? null,
        compactedAt: completedAt.toISOString(),
        placement: {
          beforeSessionEntryId: input.firstKeptEntryId,
          beforeMessageId: anchor?.id ?? null,
        },
      };
      const compactionMeta = { compaction };

      if (input.scope === "between_turns") {
        const compactSequence = state.compactSequence;
        if (compactSequence == null) throw new Error("Missing compact turn sequence");
        const [turnRow] = await tx.insert(sessionTurns).values({
          sessionId: input.sessionId,
          userUuid: input.actorUserId,
          sequence: compactSequence,
          status: "completed",
          intent: "compact",
          userContent: [],
          userText: null,
          assistantContent: [{ type: "system_note", note_type: "compacted", text: input.summary }],
          assistantText: null,
          provider: input.model.provider,
          model: input.model.id,
          stopReason: null,
          errorMessage: null,
          finalUsage: usage,
          totalUsage: usage,
          summary: { finishReason: "completed" },
          meta: compactionMeta,
          startedAt,
          completedAt,
          durationMs: input.durationMs,
        }).returning();
        if (!turnRow) throw new Error("Failed to insert compact turn");
        state.turnRow = turnRow;
        compactTurnId = turnRow.id;
      }

      const messageTurnId = input.scope === "within_turn" ? input.ownerTurnId : compactTurnId;
      const [messageRow] = await tx.insert(sessionMessages).values({
        sessionId: input.sessionId,
        turnId: messageTurnId,
        role: "system",
        content: [{ type: "system_note", note_type: "compacted", text: input.summary }],
        text: null,
        provider: input.model.provider,
        model: input.model.id,
        sequence: messageSequence,
        idempotencyKey: `compaction:${input.compactionId}`,
        usage,
        meta: {
          messageKind: "compacted",
          turnId: messageTurnId,
          actorUserId: input.actorUserId,
          ...compactionMeta,
        },
        startedAt,
        completedAt,
        durationMs: input.durationMs,
      }).returning();
      if (!messageRow) throw new Error("Failed to insert compact message");
      state.messageRow = messageRow;
      state.messageSequence = messageSequence;

    });
  } catch (error) {
    logger.error(`[Compaction] DB transaction failed sessionId=${input.sessionId}:`, error);
    return null;
  }

  const ownerTurn = state.ownerTurnRow;
  if (
    ownerTurn &&
    !["queued", "running", "abort_requested", "interrupted"].includes(ownerTurn.status)
  ) {
    try {
      const rebuilt = await buildIntermediateObjectsForTurn({
        spaceId: input.spaceId,
        sessionId: input.sessionId,
        turnId: ownerTurn.id,
      });
      const [rebuiltTurn] = await db.update(sessionTurns)
        .set({
          intermediateIndex: rebuilt.index ?? ownerTurn.intermediateIndex,
          intermediateSummary: rebuilt.summary,
          totalUsage: addUsage(rebuilt.summary.usage, ownerTurn.finalUsage as Usage | null),
          updatedAt: completedAt,
        })
        .where(and(eq(sessionTurns.id, ownerTurn.id), eq(sessionTurns.sessionId, input.sessionId)))
        .returning();
      if (rebuiltTurn) {
        state.ownerTurnRow = rebuiltTurn;
        indexTurnReferences({
          spaceId: input.spaceId,
          sessionId: input.sessionId,
          turnId: ownerTurn.id,
          messages: rebuilt.rows,
        });
      }
    } catch (error) {
      logger.warn("[Compaction] failed to rebuild completed owner turn", error);
    }
  }

  if (state.turnRow) {
    const turn = toTurnRecord(state.turnRow);
    await publishTurnCreated(input.spaceId, turn).catch((error) => {
      logger.warn("[Compaction] failed to publish turn created", error);
    });
    await publishTurnFinalized(input.spaceId, turn).catch((error) => {
      logger.warn("[Compaction] failed to publish turn finalized", error);
    });
  } else if (state.ownerTurnRow) {
    const turn = toTurnRecord(state.ownerTurnRow);
    await publishRealtimeEnvelope({
      domain: "session",
      type: "session.turn.updated",
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      payload: { turn },
    }).catch((error) => logger.warn("[Compaction] failed to publish owner turn update", error));
  }
  if (state.messageRow) {
    await publishMessagePersisted(input.spaceId, toMessageRecord(state.messageRow)).catch((error) => {
      logger.warn("[Compaction] failed to publish compact message persisted", error);
    });
    await enqueueSessionMessagePostprocess({
      sessionId: input.sessionId,
      messageId: state.messageRow.id,
    }).catch((error) => logger.warn("[Compaction] failed to enqueue usage postprocess", error));
  }

  logger.info(
    `[Compaction] persisted scope=${input.scope} turnSeq=${state.compactSequence ?? "inline"} msgSeq=${state.messageSequence} sessionId=${input.sessionId}`,
  );

  return state.messageRow
    ? {
        compactTurnId: state.turnRow?.id ?? null,
        compactSequence: state.compactSequence,
        messageSequence: state.messageSequence,
      }
    : null;
}
