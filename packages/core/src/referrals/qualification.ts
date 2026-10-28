import type { sessionMessages, sessionTurns } from "@cohub/db";

export type ReferralQualificationTurn = Pick<typeof sessionTurns.$inferSelect,
  "id" | "sessionId" | "userUuid" | "executionKind" | "status" | "intent" | "meta" | "userContent" | "completedAt"
>;

export type ReferralQualificationMessage = Pick<typeof sessionMessages.$inferSelect,
  "sessionId" | "turnId" | "role" | "meta" | "content" | "stopReason" | "errorMessage"
>;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const automaticContexts = new Set(["scheduled_task", "background_bash_task", "space_hook"]);
const automaticOrigins = new Set(["scheduled_prompt", "background_task", "hook"]);
const normalStops = new Set(["stop", "end", "end_turn", "stop_sequence"]);

function hasVisibleContent(content: unknown): boolean {
  return Array.isArray(content) && content.some((value) => {
    const block = record(value);
    if (block.type === "text") return nonempty(block.text);
    if (block.type !== "image") return false;
    const source = record(block.source);
    if (source.type === "url") return nonempty(source.url) && /^https?:\/\//i.test(source.url);
    return source.type === "base64" && nonempty(source.data) && nonempty(source.media_type);
  });
}

/** Use persisted turn and final-message facts for both live rewards and delayed recovery. */
export function isQualifyingReferralTurn(
  turn: ReferralQualificationTurn,
  message: ReferralQualificationMessage,
): turn is ReferralQualificationTurn & { userUuid: string; completedAt: Date } {
  if (turn.executionKind !== "agent" || turn.status !== "completed" || turn.intent === "compact") return false;
  if (!nonempty(turn.userUuid) || !turn.completedAt || !Number.isFinite(turn.completedAt.getTime())) return false;

  const turnMeta = record(turn.meta);
  const messageMeta = record(message.meta);
  if (turnMeta.runtime === "local" || messageMeta.runtime === "local") return false;
  if (turnMeta.llm === false || turnMeta.intent === "shell_command" || messageMeta.llm === false || messageMeta.executionKind === "shell_command_result") return false;
  if (automaticContexts.has(String(record(turnMeta.context).kind)) || automaticOrigins.has(String(record(turnMeta.origin).kind))) return false;
  if (!hasVisibleContent(turn.userContent) || turn.userContent.some((block) => block.type === "shell_command")) return false;

  const messageTurnId = message.turnId ?? messageMeta.turnId;
  if (messageTurnId !== turn.id || message.sessionId !== turn.sessionId || message.role !== "assistant") return false;
  if (messageMeta.turnId !== undefined && messageMeta.turnId !== null && messageMeta.turnId !== turn.id) return false;
  if (nonempty(messageMeta.actorUserId) && messageMeta.actorUserId.trim() !== turn.userUuid.trim()) return false;
  if (messageMeta.messageKind !== "assistant_final" || message.errorMessage || !normalStops.has(message.stopReason ?? "")) return false;
  return hasVisibleContent(message.content);
}
