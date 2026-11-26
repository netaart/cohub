import type { ContentBlock, Usage } from "@cohub/protocol/core";
import type { MessageRecord, PersistMessageInput, SessionTurnRecord } from "@cohub/protocol/model";
import { isModelThinkingLevel, type ModelThinkingLevel } from "@cohub/protocol";
import type { sessionMessages, sessionTurns } from "@cohub/db";

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

export const buildAssistantIdempotencyKey = async (input: { previousMessageId: string; message: PersistMessageInput["message"] }) => hash(stableSerialize({ previousMessageId: input.previousMessageId, role: "assistant", message: input.message }));
export const buildUserIdempotencyKey = async (input: { messageId: string; content: ContentBlock[]; meta?: Record<string, unknown> | null }) => hash(stableSerialize({ role: "user", messageId: input.messageId, content: input.content, meta: input.meta ?? null }));

export const toDateOrNull = (value: string | Date | null | undefined) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const completeMessageTiming = (input?: { startedAt?: string | null; completedAt?: string | null; durationMs?: number | null } | null) => {
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

export const normalizeUsage = (usage: PersistMessageInput["message"]["usage"]): Usage | null => {
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

export const normalizeRecord = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function extractThinkingLevel(meta: unknown): ModelThinkingLevel | null {
  const record = normalizeRecord(meta);
  if (!record) return null;
  const level = record.effectiveThinkingLevel;
  return isModelThinkingLevel(level) ? level : null;
}

export const toIso = (value: Date | string | null | undefined) => value instanceof Date ? value.toISOString() : value ?? new Date().toISOString();
const toIsoOrNull = (value: Date | string | null | undefined) => value ? toIso(value) : null;

export const toMessageRecord = (row: typeof sessionMessages.$inferSelect): MessageRecord => ({
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

export const toTurnRecord = (row: typeof sessionTurns.$inferSelect): SessionTurnRecord => ({
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
  finalUsageIsTotal: false,
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
