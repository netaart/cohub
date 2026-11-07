import { checkpoints } from "@cohub/db";
import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/** Merge fields atomically without overwriting metadata written by another stage. */
export const updateCheckpointMeta = (
  db: Pick<PostgresJsDatabase, "update">,
  checkpointId: string,
  patch: Record<string, unknown>,
) => db.update(checkpoints).set({
  meta: sql`coalesce(${checkpoints.meta}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
}).where(eq(checkpoints.id, checkpointId));

/** The checkpoint a task run already committed, if a previous attempt got that far. Saves use the task run id as the checkpoint id. */
export const findCheckpointForTaskRun = async (
  db: Pick<PostgresJsDatabase, "select">,
  spaceId: string,
  taskRunId: string,
) => (await db.select().from(checkpoints)
  .where(and(eq(checkpoints.id, taskRunId), eq(checkpoints.spaceId, spaceId)))
  .limit(1))[0] ?? null;
