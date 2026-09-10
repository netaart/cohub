import { translate } from "@/src/i18n/core";
import type { CohubClient, SessionRecord, SessionTurnRecord } from "@neta-art/cohub";

export async function forkSessionTurn(
  client: CohubClient,
  spaceId: string,
  sessionId: string,
  turn: Pick<SessionTurnRecord, "id" | "sourceTurnId">,
): Promise<SessionRecord> {
  const anchorId = turn.sourceTurnId ?? turn.id;
  if (!spaceId.trim() || !sessionId.trim() || !anchorId.trim()) {
    throw new Error(translate("data.forkUnavailable"));
  }
  // Inherited turns must use their original server anchor, as in the web client.
  const response = await client.space(spaceId).session(sessionId).turn(anchorId).fork();
  return response.session;
}
