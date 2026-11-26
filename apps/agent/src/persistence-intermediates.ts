import { and, asc, eq } from "drizzle-orm";
import type { ContentBlock, Usage } from "@cohub/protocol/core";
import type {
  MessageToolCallsFile,
  StoredIntermediateMessage,
  StoredToolCall,
  TurnIntermediateMessagesFile,
} from "@cohub/protocol/model";
import { sessionMessages } from "@cohub/db";
import { addImageToTextCallsToSummary, createImageToTextUsageSummaryAccumulator, finalizeImageToTextUsageSummary, readImageToTextCalls, summarizeSessionTurnCompactions, sumImageToTextUsage } from "@cohub/core/sessions";
import { db } from "./db.js";
import { logger } from "./logger.js";
import { buildTurnObjectPrefix, writeTurnObjectJson } from "./turn-object-storage.js";
import { normalizeRecord, toIso } from "./persistence-records.js";

export const addUsage = (a: Usage | null | undefined, b: Usage | null | undefined): Usage | null => {
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

export const buildIntermediateObjectsForTurn = async (input: { spaceId: string; sessionId: string; turnId: string }) => {
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
