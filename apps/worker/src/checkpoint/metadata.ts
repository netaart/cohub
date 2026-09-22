import { checkpoints } from "@cohub/db";
import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/** Merge fields atomically without overwriting metadata written by another stage. */
export const updateCheckpointMeta = (
  db: Pick<PostgresJsDatabase, "update">,
  checkpointId: string,
  patch: Record<string, unknown>,
) => db.update(checkpoints).set({
  meta: sql`coalesce(${checkpoints.meta}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
}).where(eq(checkpoints.id, checkpointId));
