import type { ContentBlock } from "./core/content.js";

export type SessionTurnReplyMode = "note" | "prompt";

export type SessionTurnReply = { mode: SessionTurnReplyMode };

export type SessionTurnReplyStatus = "completed" | "failed" | "interrupted" | "cancelled";

export type ReplyBlockRole = "header" | "status";

export const MAX_REPLY_WAKE_DEPTH = 4;

const REPLY_STATUSES = new Set<string>(["completed", "failed", "interrupted", "cancelled"] satisfies SessionTurnReplyStatus[]);

export const isSessionTurnReplyStatus = (value: unknown): value is SessionTurnReplyStatus =>
  typeof value === "string" && REPLY_STATUSES.has(value);

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const isSessionTurnReplyMode = (value: unknown): value is SessionTurnReplyMode =>
  value === "note" || value === "prompt";

export const readSessionTurnReply = (meta: unknown): SessionTurnReply | null => {
  const mode = record(record(meta)?.reply)?.mode;
  return isSessionTurnReplyMode(mode) ? { mode } : null;
};

export const readExecutionBatchTurnIds = (meta: unknown): string[] => {
  const ids = record(record(meta)?.executionBatch)?.turnIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
};

export const failedBeforeRun = (turn: { status: string; meta: unknown }): boolean =>
  turn.status === "failed" && record(turn.meta)?.executionBatch === undefined;

export const needsTurnReplyDelivery = (turn: { status: string; meta?: unknown }): boolean =>
  isSessionTurnReplyStatus(turn.status)
  && (readSessionTurnReply(turn.meta) !== null || record(record(turn.meta)?.executionBatch)?.replies === true);

export const readReplyBlockRole = (block: ContentBlock): ReplyBlockRole | null => {
  const role = block._meta?.reply;
  return role === "header" || role === "status" ? role : null;
};

export const readReplyStatus = (content: readonly ContentBlock[]): SessionTurnReplyStatus => {
  for (const block of content) {
    const status = readReplyBlockRole(block) === "status" ? block._meta?.status : null;
    if (isSessionTurnReplyStatus(status)) return status;
  }
  return "completed";
};

export const formatSpaceMention = (input: { spaceId: string; sessionId?: string | null; label: string }): string => {
  const label = input.label.replace(/[[\]\\]/g, "").replace(/\s+/g, " ").trim() || `space:${input.spaceId.slice(0, 8)}`;
  const uri = `cohub://spaces/${encodeURIComponent(input.spaceId)}${input.sessionId ? `/sessions/${encodeURIComponent(input.sessionId)}` : ""}`;
  return `@[${label}](${uri})`;
};
