import type { MessageRecord } from "@neta-art/cohub";

export function isLiveStreamStatus(status: string | null | undefined) {
  return status === "pending" || status === "streaming";
}

export function isTerminalTurnStatus(status: string | null | undefined) {
  return status === "completed" || status === "failed" || status === "interrupted";
}

/** Idle/completed patches are finished; they must not keep a live working overlay. */
export function liveStreamStatusFromPatch(status: string) {
  if (status === "pending" || status === "streaming" || status === "failed" || status === "interrupted") return status;
  return null;
}

export function hasFinalAssistantForTurn(messages: MessageRecord[], turnId: string | null | undefined) {
  if (!turnId) return false;
  return messages.some((message) => (
    message.role === "assistant"
    && message.meta?.turnId === turnId
    && message.meta?.messageKind !== "assistant_intermediate"
    && Boolean(message.errorMessage?.trim() || message.text?.trim() || (message.content ?? []).length)
  ));
}

export function shouldShowLiveStream(stream: { status: string; turnId: string | null } | null | undefined, messages: MessageRecord[]) {
  if (!stream) return false;
  if (hasFinalAssistantForTurn(messages, stream.turnId)) return false;
  return isLiveStreamStatus(stream.status) || stream.status === "failed" || stream.status === "interrupted";
}
