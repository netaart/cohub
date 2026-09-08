import type { CohubClient, SessionTurnRecord } from "@neta-art/cohub";

/** Server-side follow-ups waiting for the running turn to finish, excluding the turn currently streaming. */
export function queuedFollowupTurns(turns: readonly SessionTurnRecord[], activeTurnId: string | null | undefined) {
  return turns
    .filter((turn) => turn.status === "queued" && turn.intent === "followup" && turn.id !== activeTurnId)
    .sort((left, right) => left.sequence - right.sequence || left.createdAt.localeCompare(right.createdAt));
}

export function followupPreviewText(turn: Pick<SessionTurnRecord, "userText">) {
  return (turn.userText ?? "").replace(/\s+/g, " ").trim() || "Follow-up";
}

/** Aborts the running turn and runs this queued follow-up next. */
export async function steerQueuedFollowup(client: CohubClient, spaceId: string, sessionId: string, turnId: string) {
  return client.space(spaceId).session(sessionId).steerTurn(turnId);
}

export async function cancelQueuedFollowup(client: CohubClient, spaceId: string, sessionId: string, turnId: string) {
  return client.space(spaceId).session(sessionId).cancelTurn(turnId);
}
