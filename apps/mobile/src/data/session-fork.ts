import type { CohubClient, SessionRecord, SessionTurnRecord } from "@neta-art/cohub";

export async function forkSessionTurn(
  client: CohubClient,
  spaceId: string,
  sessionId: string,
  turn: Pick<SessionTurnRecord, "id" | "sourceTurnId">,
): Promise<SessionRecord> {
  const anchorId = turn.sourceTurnId ?? turn.id;
  if (!spaceId.trim() || !sessionId.trim() || !anchorId.trim()) {
    throw new Error("Cannot fork without a Space, Chat, and saved turn. Reload the Chat and try again.");
  }
  // Inherited turns must use their original server anchor, as in the web client.
  const response = await client.space(spaceId).session(sessionId).turn(anchorId).fork();
  return response.session;
}
