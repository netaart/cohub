import { and, eq, inArray, like, sql } from "drizzle-orm";
import * as schema from "@cohub/db";
import { fileTargetId, WORKSPACE_ROOT } from "@cohub/core/references";
import type { SessionFileRecord } from "@cohub/protocol/model";
import { db } from "./db/index.js";
import {
  projectSessionFiles,
  SESSION_FILE_REFERENCE_KINDS,
  type SessionFileReferenceGroup,
} from "./session-files-projection.js";

const refs = schema.resourceReferences;
const turns = schema.sessionTurns;

/**
 * Order by turn, not by index row time: rows are rewritten on retries and
 * backfills. Within a turn a write outranks an edit.
 */
async function listFileReferenceGroups(spaceId: string, sessionId: string, limit: number) {
  const latestFirst = sql`${turns.sequence} desc, (${refs.kind} = 'agent_tool_file_write') desc`;
  const changedAt = sql`coalesce(${turns.completedAt}, ${turns.startedAt}, ${turns.createdAt})`;
  const lastSequence = sql<number>`max(${turns.sequence})`;
  const rows = await db
    .select({
      targetId: refs.targetId,
      kinds: sql<string[]>`array_agg(distinct ${refs.kind})`,
      lastKind: sql<string>`(array_agg(${refs.kind} order by ${latestFirst}))[1]`,
      changeCount: sql<number>`sum(${refs.count})::int`,
      firstChangedAt: sql<Date>`min(coalesce(${turns.startedAt}, ${turns.createdAt}))`,
      lastChangedAt: sql<Date>`max(${changedAt})`,
      lastTurnId: sql<string>`(array_agg(${refs.sourceId} order by ${latestFirst}))[1]`,
      lastTurnSequence: lastSequence,
    })
    .from(refs)
    // Text compare: casting `source_id` could fail on a malformed row.
    .innerJoin(turns, eq(refs.sourceId, sql`${turns.id}::text`))
    .where(and(
      eq(refs.sourceSessionId, sessionId),
      eq(refs.sourceType, "turn"),
      inArray(refs.kind, [...SESSION_FILE_REFERENCE_KINDS]),
      eq(refs.targetType, "file"),
      like(refs.targetId, `${fileTargetId(spaceId, WORKSPACE_ROOT)}/%`),
      eq(turns.sessionId, sessionId),
    ))
    .groupBy(refs.targetId)
    .orderBy(sql`${lastSequence} desc`, refs.targetId)
    .limit(limit);
  return rows.map((row): SessionFileReferenceGroup => ({
    ...row,
    changeCount: Number(row.changeCount) || 0,
    lastTurnSequence: Number(row.lastTurnSequence),
    firstChangedAt: new Date(row.firstChangedAt),
    lastChangedAt: new Date(row.lastChangedAt),
  }));
}

/** Excludes the running turn, which is indexed when it finalizes. */
export async function listSessionFiles(input: {
  spaceId: string;
  sessionId: string;
  limit: number;
}): Promise<SessionFileRecord[]> {
  const references = await listFileReferenceGroups(input.spaceId, input.sessionId, input.limit);
  return projectSessionFiles({ spaceId: input.spaceId, references });
}
