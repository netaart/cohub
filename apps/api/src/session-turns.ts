import { createLogger } from "@cohub/infra/logging";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { ContentBlock, Usage } from "@cohub/protocol/core";
import type {
  MessageToolCallsFile,
  SessionTurnIndexItem,
  SessionTurnIntent,
  SessionTurnExecutionKind,
  SessionTurnRecord,
  SessionTurnStatus,
  StoredIntermediateMessage,
  StoredToolCall,
  TurnIntermediateMessagesFile,
} from "@cohub/protocol/model";
import type { ModelThinkingLevel } from "@cohub/protocol";
import { db } from "./db/index.js";
import { sessionMessages, sessionTurnSegments, sessionTurns, spaceSessions } from "@cohub/db";
import { addSessionParticipantMeta, summarizeSessionTurnCompactions } from "@cohub/core/sessions";
import { sanitizePostgresJsonValue, sanitizeContentBlocksForPostgresJson } from "@cohub/core/content/sanitize";
import { ensureSessionTurnSegments, findSegmentForTurn, MAX_SESSION_TURN_SEGMENTS } from "./session-forks.js";
import { fallbackPublicUserProfile, getProfilesByUuids } from "./user-profiles.js";
import { buildTurnObjectPrefix, assertTurnObjectKeyForTurn, createTurnObjectCdnUrl, writeTurnObjectJson } from "./turn-object-storage.js";
import { deriveMessagePreviewText } from "./session-content.js";


const logger = createLogger({ serviceName: "cohub-api" });
const toIso = (value: Date | string | null | undefined) => {
  if (!value) return new Date().toISOString();
  return value instanceof Date ? value.toISOString() : value;
};

const normalizeRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const THINKING_LEVEL_SET = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Extracts the effective thinking level from turn meta, if present. */
function extractThinkingLevel(meta: unknown): ModelThinkingLevel | null {
  const record = normalizeRecord(meta);
  if (!record) return null;
  const level = record.effectiveThinkingLevel;
  return typeof level === "string" && THINKING_LEVEL_SET.has(level) ? level as ModelThinkingLevel : null;
}

export const addUsage = (a: Usage | null | undefined, b: Usage | null | undefined): Usage | null => {
  if (!a && !b) return null;
  return {
    input: (a?.input ?? 0) + (b?.input ?? 0) || undefined,
    output: (a?.output ?? 0) + (b?.output ?? 0) || undefined,
    cacheRead: (a?.cacheRead ?? 0) + (b?.cacheRead ?? 0) || undefined,
    cacheWrite: (a?.cacheWrite ?? 0) + (b?.cacheWrite ?? 0) || undefined,
    totalTokens: (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0) || undefined,
    cost: (a?.cost || b?.cost)
      ? {
          input: ((a?.cost?.input ?? 0) + (b?.cost?.input ?? 0)) || undefined,
          output: ((a?.cost?.output ?? 0) + (b?.cost?.output ?? 0)) || undefined,
          cacheRead: ((a?.cost?.cacheRead ?? 0) + (b?.cost?.cacheRead ?? 0)) || undefined,
          cacheWrite: ((a?.cost?.cacheWrite ?? 0) + (b?.cost?.cacheWrite ?? 0)) || undefined,
          total: ((a?.cost?.total ?? 0) + (b?.cost?.total ?? 0)) || undefined,
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

const previewText = (value: string | null | undefined, limit = 160) => {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return truncateText(normalized, limit).value;
};

const summarizeValue = (value: unknown, limit = 240): unknown => {
  if (typeof value === "string") {
    const truncated = truncateText(value, limit);
    return truncated.truncated
      ? { preview: truncated.value, _truncated: true, originalLength: truncated.originalLength }
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  try {
    const text = JSON.stringify(value);
    const truncated = truncateText(text, limit);
    return {
      preview: truncated.value,
      ...(truncated.truncated ? { _truncated: true, originalLength: truncated.originalLength } : {}),
    };
  } catch {
    const text = String(value);
    const truncated = truncateText(text, limit);
    return {
      preview: truncated.value,
      ...(truncated.truncated ? { _truncated: true, originalLength: truncated.originalLength } : {}),
    };
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

const toTurnRecord = (row: typeof sessionTurns.$inferSelect): SessionTurnRecord => ({
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
  harnessIndex: row.harnessIndex ?? null,
  meta: normalizeRecord(row.meta),
  thinkingLevel: extractThinkingLevel(row.meta),
  startedAt: row.startedAt ? toIso(row.startedAt) : null,
  completedAt: row.completedAt ? toIso(row.completedAt) : null,
  durationMs: row.durationMs ?? null,
  createdAt: toIso(row.createdAt),
  updatedAt: toIso(row.updatedAt),
});

export async function hydrateTurnAuthorProfiles(turns: SessionTurnRecord[]) {
  const userUuids = turns.map((turn) => turn.userUuid).filter((value): value is string => Boolean(value));
  const profiles = await getProfilesByUuids(userUuids);
  return turns.map((turn) => {
    if (!turn.userUuid) return { ...turn, authorProfile: null };
    return {
      ...turn,
      authorProfile: profiles.get(turn.userUuid) ?? fallbackPublicUserProfile(turn.userUuid),
    };
  });
}

export type SessionTurnIndexRow = {
  id: string;
  sessionId: string;
  sequence: number;
  executionKind?: SessionTurnExecutionKind;
  status: SessionTurnStatus;
  intent: SessionTurnIntent;
  userUuid: string | null;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  durationMs: number | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
  userText: string | null;
  assistantText: string | null;
  provider: string | null;
  model: string | null;
  finalUsage: Usage | null;
  totalUsage: Usage | null;
  errorMessage: string | null;
};

export const toTurnIndexItem = (row: SessionTurnIndexRow): SessionTurnIndexItem => ({
  id: row.id,
  sessionId: row.sessionId,
  sequence: row.sequence,
  executionKind: row.executionKind,
  status: row.status,
  intent: row.intent,
  userUuid: row.userUuid ?? null,
  startedAt: row.startedAt ? toIso(row.startedAt) : null,
  completedAt: row.completedAt ? toIso(row.completedAt) : null,
  durationMs: row.durationMs ?? null,
  createdAt: toIso(row.createdAt),
  updatedAt: toIso(row.updatedAt),
  userPreview: previewText(row.userText),
  assistantPreview: previewText(row.assistantText),
  provider: row.provider ?? null,
  model: row.model ?? null,
  finalUsage: row.finalUsage ?? row.totalUsage ?? null,
  totalUsage: row.totalUsage ?? row.finalUsage ?? null,
  errorMessage: previewText(row.errorMessage, 220),
});

export const hydrateTurnIndexAuthorProfiles = async (turns: SessionTurnIndexItem[]) => {
  const userUuids = turns
    .map((turn) => turn.userUuid)
    .filter((value): value is string => Boolean(value));
  if (userUuids.length === 0) {
    return turns.map((turn) => ({ ...turn, authorProfile: turn.authorProfile ?? null }));
  }
  const profiles = await getProfilesByUuids(userUuids);
  return turns.map((turn) => {
    if (!turn.userUuid) return { ...turn, authorProfile: null };
    return {
      ...turn,
      authorProfile: profiles.get(turn.userUuid) ?? fallbackPublicUserProfile(turn.userUuid),
    };
  });
};

const withTimelineSource = <T extends SessionTurnRecord | SessionTurnIndexItem>(turn: T, currentSessionId: string): T => ({
  ...turn,
  sessionId: currentSessionId,
  sourceSessionId: turn.sessionId,
  sourceTurnId: turn.id,
});

export const createSessionTurn = async (input: {
  id?: string;
  sessionId: string;
  userUuid: string | null;
  userContent: ContentBlock[];
  executionKind?: SessionTurnExecutionKind;
  intent?: SessionTurnIntent;
  meta?: Record<string, unknown> | null;
}) => {
  const userContent = sanitizeContentBlocksForPostgresJson(input.userContent);
  const meta = input.meta ? sanitizePostgresJsonValue(input.meta) : null;
  const userText = deriveMessagePreviewText({ content: userContent }) || null;
  const [row] = await db.transaction(async (tx) => {
    const [sessionRow] = await tx.select({ meta: spaceSessions.meta, spaceId: spaceSessions.spaceId }).from(spaceSessions).where(eq(spaceSessions.id, input.sessionId)).for("update").limit(1);
    if (!sessionRow) throw new Error("session not found");
    const [seqRow] = await tx.select({ max: sql<number>`coalesce(max(${sessionTurns.sequence}), 0)::int` }).from(sessionTurns).where(eq(sessionTurns.sessionId, input.sessionId));
    let startSequence = 1;
    const [localSegment] = await tx.select({ fromSequence: sessionTurnSegments.fromSequence }).from(sessionTurnSegments).where(and(
      eq(sessionTurnSegments.sessionId, input.sessionId),
      eq(sessionTurnSegments.sourceSessionId, input.sessionId),
      isNull(sessionTurnSegments.toSequence),
    )).orderBy(desc(sessionTurnSegments.ordinal)).limit(1);
    startSequence = localSegment?.fromSequence ?? 1;
    const sequence = seqRow?.max ? (seqRow.max + 1) : startSequence;
    if (input.userUuid) {
      await tx.update(spaceSessions).set({
        meta: sanitizePostgresJsonValue(addSessionParticipantMeta(sessionRow.meta, input.userUuid)),
      }).where(eq(spaceSessions.id, input.sessionId));
    }
    return tx.insert(sessionTurns).values({
      ...(input.id ? { id: input.id } : {}),
      sessionId: input.sessionId,
      userUuid: input.userUuid,
      sequence,
      executionKind: input.executionKind ?? "agent",
      status: "queued",
      intent: input.intent ?? "steer",
      userContent,
      userText,
      meta,
    }).returning();
  });
  if (!row) throw new Error("failed to create session turn");
  return toTurnRecord(row);
};

export async function getSourceSessionTurnById(turnId: string) {
  const [row] = await db.select().from(sessionTurns).where(eq(sessionTurns.id, turnId)).limit(1);
  return row ? toTurnRecord(row) : null;
}

const buildSegmentPredicate = (segment: Awaited<ReturnType<typeof ensureSessionTurnSegments>>[number], options?: { cursor?: number; direction?: "older" | "newer" }) => {
  const clauses = [
    eq(sessionTurns.sessionId, segment.sourceSessionId),
    gte(sessionTurns.sequence, segment.fromSequence),
  ];
  if (segment.toSequence != null) clauses.push(lte(sessionTurns.sequence, segment.toSequence));
  if (options?.cursor != null) clauses.push(options.direction === "newer" ? gt(sessionTurns.sequence, options.cursor) : lt(sessionTurns.sequence, options.cursor));
  return and(...clauses);
};

export const listSessionTurns = async (sessionId: string, options?: { cursor?: number; limit?: number; direction?: "older" | "newer" }) => {
  const limit = Math.min(options?.limit ?? 30, 100);
  const direction = options?.direction ?? "older";
  const segments = await ensureSessionTurnSegments(sessionId);
  const collected: SessionTurnRecord[] = [];
  const orderedSegments = direction === "newer" ? segments : [...segments].reverse();

  for (const segment of orderedSegments) {
    const predicate = buildSegmentPredicate(segment, { cursor: options?.cursor, direction });
    const remaining = limit - collected.length;
    if (remaining <= 0) break;
    const rows = await db.select().from(sessionTurns).where(predicate).orderBy(direction === "newer" ? asc(sessionTurns.sequence) : desc(sessionTurns.sequence)).limit(remaining);
    collected.push(...rows.map((row) => withTimelineSource(toTurnRecord(row), sessionId)));
    if (collected.length >= limit) break;
  }
  return direction === "newer" ? collected : collected.reverse();
};

export const listSessionTurnIndex = async (sessionId: string, options?: { cursor?: number; limit?: number }) => {
  const limit = Math.min(Math.max(Math.floor(options?.limit ?? 200), 1), 500);
  const segments = await ensureSessionTurnSegments(sessionId);
  const collected: SessionTurnIndexItem[] = [];
  for (const segment of segments) {
    if (collected.length >= limit + 1) break;
    const clauses = [
      eq(sessionTurns.sessionId, segment.sourceSessionId),
      gte(sessionTurns.sequence, segment.fromSequence),
    ];
    if (segment.toSequence != null) clauses.push(lte(sessionTurns.sequence, segment.toSequence));
    if (options?.cursor != null) clauses.push(gt(sessionTurns.sequence, options.cursor));
    const rows = await db.select({
      id: sessionTurns.id,
      sessionId: sessionTurns.sessionId,
      sequence: sessionTurns.sequence,
      executionKind: sessionTurns.executionKind,
      status: sessionTurns.status,
      intent: sessionTurns.intent,
      userUuid: sessionTurns.userUuid,
      startedAt: sessionTurns.startedAt,
      completedAt: sessionTurns.completedAt,
      durationMs: sessionTurns.durationMs,
      createdAt: sessionTurns.createdAt,
      updatedAt: sessionTurns.updatedAt,
      userText: sessionTurns.userText,
      assistantText: sessionTurns.assistantText,
      provider: sessionTurns.provider,
      model: sessionTurns.model,
      finalUsage: sessionTurns.finalUsage,
      totalUsage: sessionTurns.totalUsage,
      errorMessage: sessionTurns.errorMessage,
    }).from(sessionTurns).where(and(...clauses)).orderBy(asc(sessionTurns.sequence)).limit(limit + 1 - collected.length);
    collected.push(...rows.map((row) => withTimelineSource(toTurnIndexItem(row), sessionId)));
  }
  const hasMore = collected.length > limit;
  const pageRows = hasMore ? collected.slice(0, limit) : collected;
  return {
    turns: await hydrateTurnIndexAuthorProfiles(pageRows),
    hasMore,
    nextCursor: pageRows.at(-1)?.sequence,
  };
};

export const getSessionTurnSequenceById = async (sessionId: string, turnId: string) => {
  const segments = await ensureSessionTurnSegments(sessionId);
  const sourceIds = [...new Set(segments.map((segment) => segment.sourceSessionId))];
  const [row] = await db.select({ sequence: sessionTurns.sequence, sessionId: sessionTurns.sessionId }).from(sessionTurns).where(and(inArray(sessionTurns.sessionId, sourceIds), eq(sessionTurns.id, turnId))).limit(1);
  if (!row) return null;
  return findSegmentForTurn(segments, { sourceSessionId: row.sessionId, sequence: row.sequence }) ? row.sequence : null;
};

export const listSessionTurnWindow = async (sessionId: string, input: { sequence: number; before?: number; after?: number }) => {
  const before = Math.min(Math.max(Math.floor(input.before ?? 10), 0), 100);
  const after = Math.min(Math.max(Math.floor(input.after ?? 20), 0), 100);
  const [older, anchorAndNewer] = await Promise.all([
    listSessionTurns(sessionId, { cursor: input.sequence, direction: "older", limit: before + 1 }),
    listSessionTurns(sessionId, { cursor: input.sequence - 1, direction: "newer", limit: after + 2 }),
  ]);
  const anchor = anchorAndNewer.find((turn) => turn.sequence === input.sequence);
  if (!anchor) return null;
  const hasMoreOlder = older.length > before;
  const hasMoreNewer = anchorAndNewer.length > after + 1;
  const turns = [
    ...(hasMoreOlder ? older.slice(1) : older),
    ...(hasMoreNewer ? anchorAndNewer.slice(0, after + 1) : anchorAndNewer),
  ];
  return {
    turns,
    hasMoreOlder,
    hasMoreNewer,
    oldestCursor: turns[0]?.sequence,
    newestCursor: turns.at(-1)?.sequence,
    anchorSequence: input.sequence,
  };
};

export const getSessionTurnById = async (sessionId: string, turnId: string) => {
  const segments = await ensureSessionTurnSegments(sessionId);
  const sourceIds = [...new Set(segments.map((segment) => segment.sourceSessionId))];
  const [row] = await db.select().from(sessionTurns).where(and(inArray(sessionTurns.sessionId, sourceIds), eq(sessionTurns.id, turnId))).limit(1);
  if (!row || !findSegmentForTurn(segments, { sourceSessionId: row.sessionId, sequence: row.sequence })) return null;
  return withTimelineSource(toTurnRecord(row), sessionId);
};

export const findLatestVisibleAgentEntryId = async (sessionId: string, throughSequence: number) => {
  const segments = await ensureSessionTurnSegments(sessionId);
  if (segments.length > MAX_SESSION_TURN_SEGMENTS) throw new Error("Fork chain is too deep");
  const rangePredicates = segments.flatMap((segment) => {
    const toSequence = Math.min(segment.toSequence ?? throughSequence, throughSequence);
    if (toSequence < segment.fromSequence) return [];
    return [and(
      eq(sessionTurns.sessionId, segment.sourceSessionId),
      gte(sessionTurns.sequence, segment.fromSequence),
      lte(sessionTurns.sequence, toSequence),
    )];
  });
  const visibleRange = or(...rangePredicates);
  if (!visibleRange) return null;

  const [row] = await db.select({ meta: sessionTurns.meta }).from(sessionTurns).where(and(
    eq(sessionTurns.executionKind, "agent"),
    visibleRange,
    or(
      sql`nullif(${sessionTurns.meta}->>'agentSessionEntryId', '') is not null`,
      sql`nullif(${sessionTurns.meta}->'agent'->>'leafEntryId', '') is not null`,
    ),
  )).orderBy(desc(sessionTurns.sequence)).limit(1);
  const meta = normalizeRecord(row?.meta);
  const agentMeta = normalizeRecord(meta?.agent);
  const entryId = typeof meta?.agentSessionEntryId === "string"
    ? meta.agentSessionEntryId.trim()
    : typeof agentMeta?.leafEntryId === "string"
      ? agentMeta.leafEntryId.trim()
      : "";
  return entryId || null;
};

export const buildIntermediateObjectsForTurn = async (input: { spaceId: string; sessionId: string; turnId: string }, suppliedRows?: Array<typeof sessionMessages.$inferSelect>) => {
  const rows = suppliedRows ?? await db.select().from(sessionMessages).where(and(
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
  let totalDurationMs: number | null = null;
  let toolCallCount = 0;
  let hasError = false;

  const messages: StoredIntermediateMessage[] = [];
  for (const row of intermediateRows) {
    const content = row.content as ContentBlock[];
    const details = extractToolCalls(content);
    toolCallCount += details.length;
    totalUsage = addUsage(totalUsage, row.usage as Usage | null | undefined);
    totalDurationMs = addDurationMs(totalDurationMs, row.durationMs ?? null);
    hasError = hasError || Boolean(row.errorMessage) || details.some((tool) => tool.result?.isError);
    const toolCallsObjectKey = details.length > 0 ? `${toolCallsBaseObjectKey}${row.id}/tool-calls.json` : null;
    if (toolCallsObjectKey) {
      const toolFile: MessageToolCallsFile = {
        version: 1,
        spaceId: input.spaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        messageId: row.id,
        toolCalls: details,
      };
      await writeTurnObjectJson(toolCallsObjectKey, toolFile);
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
  };
  if (messages.length === 0) {
    return {
      index: null,
      summary,
    };
  }
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
  };
};

export const setGenerationTurnAssistantProjection = async (input: {
  sessionId: string;
  turnId: string;
  content: ContentBlock[];
  text: string | null;
  model: string | null;
  taskId: string;
}) => {
  const [row] = await db.update(sessionTurns).set({
    assistantContent: sanitizeContentBlocksForPostgresJson(input.content),
    assistantText: input.text,
    model: input.model,
    meta: sql`coalesce(${sessionTurns.meta}, '{}'::jsonb) || ${JSON.stringify({ generationTaskId: input.taskId })}::jsonb`,
    updatedAt: new Date(),
  }).where(and(eq(sessionTurns.id, input.turnId), eq(sessionTurns.sessionId, input.sessionId), eq(sessionTurns.executionKind, "direct_generation"), inArray(sessionTurns.status, ["queued", "running"]))).returning();
  return row ? toTurnRecord(row) : null;
};

export const failSessionTurn = async (input: { sessionId: string; turnId: string; errorMessage: string }) => {
  const completedAt = new Date();
  const completedAtIso = completedAt.toISOString();
  const [row] = await db.update(sessionTurns).set({
    status: "failed",
    errorMessage: input.errorMessage,
    summary: { finishReason: "failed", text: input.errorMessage },
    completedAt,
    durationMs: sql<number>`greatest(0, floor(extract(epoch from (${completedAtIso}::timestamptz - ${sessionTurns.startedAt})) * 1000)::int)`,
    updatedAt: completedAt,
  }).where(and(eq(sessionTurns.id, input.turnId), eq(sessionTurns.sessionId, input.sessionId), inArray(sessionTurns.status, ["queued", "running", "abort_requested", "interrupted"]))).returning();
  return row ? toTurnRecord(row) : null;
};

export const finalizeSessionTurnFromMessage = async (input: {
  spaceId: string;
  sessionId: string;
  turnId: string;
  status: Exclude<SessionTurnStatus, "running">;
  assistantContent: ContentBlock[];
  assistantText: string | null;
  provider: string | null;
  model: string | null;
  stopReason: string | null;
  errorMessage: string | null;
  usage: Usage | null;
  metaPatch?: Record<string, unknown> | null;
}) => {
  const intermediate = await buildIntermediateObjectsForTurn(input).catch((error) => {
    logger.warn("[SessionTurn] failed to build intermediate objects", error);
    return null;
  });
  const completedAt = new Date();
  const completedAtIso = completedAt.toISOString();
  const [row] = await db.update(sessionTurns).set({
    status: input.status,
    assistantContent: input.assistantContent,
    assistantText: input.assistantText,
    provider: input.provider,
    model: input.model,
    stopReason: input.stopReason,
    errorMessage: input.errorMessage,
    finalUsage: input.usage,
    totalUsage: addUsage(intermediate?.summary.usage, input.usage),
    ...(input.metaPatch && Object.keys(input.metaPatch).length > 0
      ? {
          meta: sql`coalesce(${sessionTurns.meta}, '{}'::jsonb) || ${JSON.stringify(input.metaPatch)}::jsonb`,
        }
      : {}),
    summary: {
      text: input.assistantText,
      finishReason: input.status === "interrupted" ? "interrupted" : input.status === "merged" ? "merged" : input.status === "cancelled" ? "cancelled" : input.status === "failed" ? "failed" : "completed",
      ...(input.status === "interrupted" && input.stopReason === "aborted" ? { reason: "abort" } : {}),
    },
    intermediateIndex: intermediate?.index ?? null,
    intermediateSummary: intermediate?.summary ?? null,
    completedAt,
    durationMs: sql<number>`greatest(0, floor(extract(epoch from (${completedAtIso}::timestamptz - ${sessionTurns.startedAt})) * 1000)::int)`,
    updatedAt: completedAt,
  }).where(and(eq(sessionTurns.id, input.turnId), eq(sessionTurns.sessionId, input.sessionId), inArray(sessionTurns.status, ["running", "abort_requested", "interrupted"]))).returning();
  return row ? toTurnRecord(row) : null;
};

const finalizeInterruptedTurn = async (input: {
  spaceId: string;
  sessionId: string;
  turnId: string;
  stopReason: "interrupted" | "aborted";
  summary: Record<string, unknown>;
}) => {
  const [existing] = await db.select().from(sessionTurns).where(and(eq(sessionTurns.id, input.turnId), eq(sessionTurns.sessionId, input.sessionId))).limit(1);
  if (!existing) return null;
  if (!["running", "abort_requested", "interrupted"].includes(existing.status)) return toTurnRecord(existing);
  const existingSummary = normalizeRecord(existing.summary);
  const shouldPromoteSteerSummary = existing.status === "interrupted" && input.summary.reason === "steer" && existingSummary?.reason !== "steer";
  const shouldFillInterruptedContent = existing.status === "interrupted" && !existing.assistantContent;
  if (existing.status === "interrupted" && !shouldPromoteSteerSummary && !shouldFillInterruptedContent) return toTurnRecord(existing);
  const rows = await db.select().from(sessionMessages).where(and(
    eq(sessionMessages.sessionId, input.sessionId),
    eq(sessionMessages.turnId, input.turnId),
    eq(sessionMessages.role, "assistant"),
  )).orderBy(desc(sessionMessages.sequence)).limit(1);
  const last = rows[0] ?? null;
  const intermediate = await buildIntermediateObjectsForTurn(input).catch((error) => {
    logger.warn("[SessionTurn] failed to build interrupted intermediate objects", error);
    return null;
  });
  const completedAt = new Date();
  const completedAtIso = completedAt.toISOString();
  const [row] = await db.update(sessionTurns).set({
    status: "interrupted",
    assistantContent: last?.content ?? null,
    assistantText: last?.text ?? null,
    provider: last?.provider ?? null,
    model: last?.model ?? null,
    stopReason: input.stopReason,
    errorMessage: null,
    finalUsage: (last?.usage as Usage | null | undefined) ?? null,
    totalUsage: intermediate?.summary.usage ?? null,
    summary: shouldPromoteSteerSummary || existing.status !== "interrupted" ? input.summary : existing.summary,
    intermediateIndex: intermediate?.index ?? null,
    intermediateSummary: intermediate?.summary ?? null,
    completedAt,
    durationMs: sql<number>`greatest(0, floor(extract(epoch from (${completedAtIso}::timestamptz - ${sessionTurns.startedAt})) * 1000)::int)`,
    updatedAt: completedAt,
  }).where(and(eq(sessionTurns.id, input.turnId), eq(sessionTurns.sessionId, input.sessionId), inArray(sessionTurns.status, ["running", "abort_requested", "interrupted"]))).returning();
  return row ? toTurnRecord(row) : null;
};

export const interruptSessionTurn = async (input: { spaceId: string; sessionId: string; turnId: string; continuedByTurnId: string }) => {
  return finalizeInterruptedTurn({
    ...input,
    stopReason: "interrupted",
    summary: {
      finishReason: "interrupted",
      reason: "steer",
      continuedByTurnId: input.continuedByTurnId,
    },
  });
};

export const abortSessionTurn = async (input: { spaceId: string; sessionId: string; turnId: string; actorUserId?: string | null }) => {
  return finalizeInterruptedTurn({
    ...input,
    stopReason: "aborted",
    summary: {
      finishReason: "interrupted",
      reason: "abort",
    },
  });
};


export const createSignedTurnUrls = async (input: { spaceId: string; sessionId: string; turnId: string; objectKeys: string[] }) => {
  const turn = await getSessionTurnById(input.sessionId, input.turnId);
  if (!turn) throw new Error("turn not found");
  const sourceSessionId = turn.sourceSessionId ?? turn.sessionId;
  const sourceTurnId = turn.sourceTurnId ?? turn.id;
  return Object.fromEntries(input.objectKeys.map((objectKey) => [
    objectKey,
    createTurnObjectCdnUrl(assertTurnObjectKeyForTurn({
      objectKey,
      spaceId: input.spaceId,
      sessionId: sourceSessionId,
      turnId: sourceTurnId,
    })).url,
  ]));
};
