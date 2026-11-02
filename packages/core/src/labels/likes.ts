import { and, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { resourceLikeCounts } from "@cohub/db";
import type { LikeResourceType } from "@cohub/protocol";

type LikesDb = PostgresJsDatabase<Record<string, unknown>>;

export async function getLikeCount(db: LikesDb, resourceType: LikeResourceType, resourceId: string): Promise<number> {
  const [row] = await db
    .select({ likeCount: resourceLikeCounts.likeCount })
    .from(resourceLikeCounts)
    .where(and(eq(resourceLikeCounts.resourceType, resourceType), eq(resourceLikeCounts.resourceId, resourceId)))
    .limit(1);
  return row?.likeCount ?? 0;
}

export async function adjustLikeCounts(db: LikesDb, resourceType: LikeResourceType, resourceIds: string[], delta: 1 | -1) {
  if (!resourceIds.length) return;
  const updatedAt = new Date();
  if (delta > 0) {
    await db
      .insert(resourceLikeCounts)
      .values(resourceIds.map((resourceId) => ({ resourceType, resourceId, likeCount: 1, updatedAt })))
      .onConflictDoUpdate({
        target: [resourceLikeCounts.resourceType, resourceLikeCounts.resourceId],
        set: { likeCount: sql`${resourceLikeCounts.likeCount} + 1`, updatedAt },
      });
    return;
  }
  await db
    .update(resourceLikeCounts)
    .set({ likeCount: sql`greatest(${resourceLikeCounts.likeCount} - 1, 0)`, updatedAt })
    .where(and(eq(resourceLikeCounts.resourceType, resourceType), inArray(resourceLikeCounts.resourceId, resourceIds)));
}
