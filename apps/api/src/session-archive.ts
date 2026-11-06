import { setSessionArchived } from "@cohub/core/labels";
import { cancelSessionArchiveEviction, enqueueSessionArchiveEviction } from "@cohub/infra/agent-queue";
import { createLogger } from "@cohub/infra/logging";
import { agentTurnQueue } from "./agent-turn-queue.js";
import { db } from "./db/index.js";
import { dispatchLabelAssignmentsUpdated, dispatchSessionUpdated } from "./realtime-events.js";
import { getSpaceSessionById } from "./space-sessions.js";

const logger = createLogger({ serviceName: "cohub-api" });

export async function publishSessionArchiveChange(input: { spaceId: string; sessionId: string; labelId: string; archived: boolean }) {
  const evict = input.archived
    ? enqueueSessionArchiveEviction(agentTurnQueue, { spaceId: input.spaceId, sessionId: input.sessionId })
    : cancelSessionArchiveEviction(agentTurnQueue, input.sessionId);
  await Promise.all([
    evict.catch((error: unknown) => logger.warn("[SessionArchive] failed to schedule runtime eviction", { sessionId: input.sessionId, error })),
    dispatchLabelAssignmentsUpdated({
      spaceId: input.spaceId,
      resourceType: "session",
      resourceRef: input.sessionId,
      sessionId: input.sessionId,
      affectedLabelIds: [input.labelId],
    }).catch((error: unknown) => logger.warn("[SessionArchive] failed to publish label change", { sessionId: input.sessionId, error })),
  ]);
}

export async function changeSessionArchive(input: { spaceId: string; sessionId: string; archived: boolean; userId: string }) {
  const { changed, labelId } = await setSessionArchived(db, input);
  if (!changed || !labelId) return;
  const session = await getSpaceSessionById(input.sessionId);
  await Promise.all([
    session
      ? dispatchSessionUpdated({ session, changed: ["archivedAt"] }).catch((error: unknown) =>
        logger.warn("[SessionArchive] failed to publish session.updated", { sessionId: input.sessionId, error }))
      : undefined,
    publishSessionArchiveChange({ spaceId: input.spaceId, sessionId: input.sessionId, labelId, archived: input.archived }),
  ]);
}
