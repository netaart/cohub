import { listSpaceAudienceUserIds } from "@cohub/core/permissions";
import { getRealtimeUserRoom } from "@cohub/protocol/realtime";
import { dispatchRealtimeEvent } from "./channels.js";
import { db } from "./db/index.js";

export const spaceAudienceUserIds = (spaceId: string, extraUserIds: string[] = []) =>
  listSpaceAudienceUserIds(db, spaceId, extraUserIds);

export async function dispatchSpaceListChanged(spaceId: string, extraUserIds: string[] = []) {
  const audience = await spaceAudienceUserIds(spaceId, extraUserIds);
  if (!audience) return;
  const rooms = audience.map(getRealtimeUserRoom);
  const revision = new Date().toISOString();
  await dispatchRealtimeEvent({
    id: crypto.randomUUID(), timestamp: Date.now(), domain: "space", type: "space.list.changed",
    spaceId, rooms, payload: { spaceId, revision },
  }).catch(() => undefined);
}
