import { displaysSnapshotSchema, runtimeDisplaysKey } from "@cohub/protocol";
import { logger } from "../logger.js";
import { redis } from "../redis.js";

export async function hasSharedDisplays(spaceId: string): Promise<boolean> {
  try {
    const raw = await redis.get(runtimeDisplaysKey(spaceId));
    if (!raw) return false;
    const parsed = displaysSnapshotSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.displays.length > 0;
  } catch (error) {
    logger.warn(`[Displays] snapshot unavailable spaceId=${spaceId}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
