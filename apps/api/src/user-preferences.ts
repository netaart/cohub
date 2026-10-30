import { randomUUID } from "node:crypto";
import { updateUserPreferences } from "@cohub/core/preferences";
import { createLogger } from "@cohub/infra/logging";
import type { UserPreferencesPatch } from "@cohub/protocol/notifications";
import { getRealtimeUserRoom } from "@cohub/protocol/realtime";
import { dispatchRealtimeEvent } from "./channels.js";
import { db } from "./db/index.js";

const logger = createLogger({ serviceName: "cohub-api" });

/** Every write goes through here so all of the user's open clients converge. */
export async function updateAndPublishUserPreferences(userUuid: string, patch: UserPreferencesPatch) {
  const preferences = await updateUserPreferences(db, userUuid, patch);
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "user",
    type: "user.preferences.updated",
    rooms: [getRealtimeUserRoom(userUuid)],
    payload: { preferences },
  }).catch((error) => logger.warn("[Preferences] failed to publish update", { userUuid, error }));
  return preferences;
}
