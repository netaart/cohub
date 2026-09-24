import { randomUUID } from "node:crypto";
import type {
  RealtimeAppRecord,
  RealtimeAppVersionRecord,
} from "@cohub/protocol/realtime";
import type { RequestSource } from "@cohub/protocol/provenance";
import { dispatchSpaceDomainEvent } from "./space-events.js";

export async function dispatchAppVersionPublished(input: {
  app: RealtimeAppRecord;
  version: RealtimeAppVersionRecord;
  previousVersionId: string | null;
  actorUserId: string;
  source: RequestSource | null;
}) {
  await dispatchSpaceDomainEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "space",
    type: "app.version.published",
    spaceId: input.app.spaceId,
    sessionId: null,
    payload: {
      app: input.app,
      version: input.version,
      previousVersionId: input.previousVersionId,
      actor: { userId: input.actorUserId },
      source: input.source,
    },
  });
}
