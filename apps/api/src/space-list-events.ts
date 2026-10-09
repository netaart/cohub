import { eq } from "drizzle-orm";
import { spaceMembers, spaces } from "@cohub/db";
import { getRealtimeUserRoom } from "@cohub/protocol/realtime";
import { dispatchRealtimeEvent } from "./channels.js";
import { db } from "./db/index.js";

export async function dispatchSpaceListChanged(spaceId: string, extraUserIds: string[] = []) {
  const [space] = await db.select({ userUuid: spaces.userUuid }).from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return;
  const members = await db.select({ userId: spaceMembers.userId }).from(spaceMembers).where(eq(spaceMembers.spaceId, spaceId));
  const rooms = [...new Set([space.userUuid, ...members.map((member) => member.userId), ...extraUserIds])].map(getRealtimeUserRoom);
  const revision = new Date().toISOString();
  await dispatchRealtimeEvent({
    id: crypto.randomUUID(), timestamp: Date.now(), domain: "space", type: "space.list.changed",
    spaceId, rooms, payload: { spaceId, revision },
  }).catch(() => undefined);
}
