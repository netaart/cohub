import type { MessageRecord, SessionTurnRecord } from "@neta-art/cohub";

export function isLiveStreamStatus(status: string | null | undefined) {
  return status === "pending" || status === "streaming";
}

export function isTerminalTurnStatus(status: string | null | undefined) {
  return status === "completed" || status === "failed" || status === "interrupted" || status === "merged" || status === "cancelled";
}

export function isActiveTurnStatus(status: string | null | undefined) {
  return status === "queued" || status === "running" || status === "abort_requested";
}

export function pendingStreamForTurn(turnId: string | null): {
  status: "pending";
  contentBlocks: [];
  intermediateMessages: [];
  turnId: string | null;
  messageId: null;
  runtimePhase: null;
  runtimeProvider: null;
  runtimeModel: null;
} {
  return {
    status: "pending",
    contentBlocks: [],
    intermediateMessages: [],
    turnId,
    messageId: null,
    runtimePhase: null,
    runtimeProvider: null,
    runtimeModel: null,
  };
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

/**
 * Reconcile the live-stream overlay against an authoritative turn tail after a
 * reconnect/foreground gap. Returns `clear` when the overlay is stale, `pending`
 * when a still-running turn lost its overlay, or `null` to leave it untouched.
 */
export function streamRecoveryFromTail(input: {
  stream: { turnId: string | null } | null | undefined;
  tail: Pick<SessionTurnRecord, "id" | "sequence" | "status"> | null;
  turns: Pick<SessionTurnRecord, "id" | "sequence" | "status">[];
  messages: MessageRecord[];
}): "clear" | "pending" | null {
  const { tail } = input;
  if (!tail) return null;
  const stream = input.stream ?? null;
  if (stream) {
    const streamTurn = stream.turnId ? input.turns.find((turn) => turn.id === stream.turnId) : undefined;
    // A finished tail means no overlay can still be live unless it already tracks a
    // newer turn the fetched window has not caught up with yet; an unknown turn id is
    // treated the same way rather than dropping a possibly fresh overlay.
    const mayTrackNewerTurn = stream.turnId !== null && (streamTurn === undefined || streamTurn.sequence > tail.sequence);
    return isTerminalTurnStatus(tail.status) && !mayTrackNewerTurn ? "clear" : null;
  }
  return isActiveTurnStatus(tail.status) && !hasFinalAssistantForTurn(input.messages, tail.id) ? "pending" : null;
}
