import { randomUUID } from "node:crypto";
import { updateUserPreferences } from "@cohub/core/preferences";
import { createLogger } from "@cohub/infra/logging";
import type { UserPreferencesPatch } from "@cohub/protocol/notifications";
import { getRealtimeUserRoom } from "@cohub/protocol/realtime";
import { dispatchRealtimeEvent } from "./channels.js";
import { db } from "./db/index.js";

const logger = createLogger({ serviceName: "cohub-api" });

/**
 * A signal without the data: App sessions share the user room, and the full
 * preferences are account-only. Clients refetch them.
 */
export async function publishUserPreferencesChanged(userUuid: string) {
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "user",
    type: "user.preferences.updated",
    rooms: [getRealtimeUserRoom(userUuid)],
    payload: {},
  }).catch((error) => logger.warn("[Preferences] failed to publish update", { userUuid, error }));
}

export async function updateAndPublishUserPreferences(userUuid: string, patch: UserPreferencesPatch) {
  const preferences = await updateUserPreferences(db, userUuid, patch);
  await publishUserPreferencesChanged(userUuid);
  return preferences;
}
