import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { labelAssignments, labels, sessionTurnIsActive, sessionTurns, spaceSessions } from "@cohub/db";
import { SESSION_ARCHIVED_LABEL_SYSTEM_KEY, type SessionArchiveFilter } from "@cohub/protocol/model";
import { getOrCreateSpaceSystemLabel } from "./system-label.js";

// biome-ignore lint/suspicious/noExplicitAny: any Postgres driver, including transactions.
type Executor = PgDatabase<PgQueryResultHKT, any, any>;

export const SESSION_ARCHIVED_LABEL_NAME = "Archived";

export class SessionRunningError extends Error {
  constructor() {
    super("session is running; stop it before archiving");
    this.name = "SessionRunningError";
  }
}

export function sessionArchivedCondition(): SQL {
  return sql`exists (
    select 1 from ${labelAssignments}
    inner join ${labels} on ${labels.id} = ${labelAssignments.labelId}
    where ${labelAssignments.scopeType} = 'space'
      and ${labelAssignments.scopeId} = ${spaceSessions.spaceId}::text
      and ${labelAssignments.resourceType} = 'session'
      and ${labelAssignments.resourceRef} = ${spaceSessions.id}::text
      and ${labels.systemKey} = ${SESSION_ARCHIVED_LABEL_SYSTEM_KEY}
  )`;
}

export function sessionArchiveFilterCondition(filter: SessionArchiveFilter = "exclude"): SQL | undefined {
  if (filter === "include") return undefined;
  return filter === "only" ? sessionArchivedCondition() : sql`not ${sessionArchivedCondition()}`;
}

export function parseSessionArchiveFilter(value: string | null | undefined): SessionArchiveFilter | null {
  const raw = value?.trim().toLowerCase();
  if (!raw) return "exclude";
  return raw === "only" || raw === "include" || raw === "exclude" ? raw : null;
}

export const nextSessionVersion = (at: Date) =>
  sql`greatest(${at.toISOString()}::timestamptz, ${spaceSessions.updatedAt} + interval '1 millisecond')`;

export async function unarchiveSessionInTx(tx: Executor, input: { spaceId: string; sessionId: string }): Promise<string | null> {
  const [removed] = await tx.delete(labelAssignments).where(and(
    eq(labelAssignments.scopeType, "space"),
    eq(labelAssignments.scopeId, input.spaceId),
    eq(labelAssignments.resourceType, "session"),
    eq(labelAssignments.resourceRef, input.sessionId),
    inArray(labelAssignments.labelId, tx.select({ id: labels.id }).from(labels).where(and(
      eq(labels.scopeType, "space"),
      eq(labels.scopeId, input.spaceId),
      eq(labels.systemKey, SESSION_ARCHIVED_LABEL_SYSTEM_KEY),
    ))),
  )).returning({ labelId: labelAssignments.labelId });
  return removed?.labelId ?? null;
}

export async function setSessionArchived(db: PostgresJsDatabase<Record<string, unknown>>, input: {
  spaceId: string;
  sessionId: string;
  archived: boolean;
  userId: string | null;
}): Promise<{ changed: boolean; labelId: string | null }> {
  const label = input.archived
    ? await getOrCreateSpaceSystemLabel(db, {
      spaceId: input.spaceId,
      name: SESSION_ARCHIVED_LABEL_NAME,
      parentId: null,
      depth: 0,
      systemKey: SESSION_ARCHIVED_LABEL_SYSTEM_KEY,
    })
    : null;
  return db.transaction(async (tx) => {
    await tx.select({ id: spaceSessions.id }).from(spaceSessions).where(eq(spaceSessions.id, input.sessionId)).for("update");
    const touch = () => tx.update(spaceSessions).set({ updatedAt: nextSessionVersion(new Date()) }).where(eq(spaceSessions.id, input.sessionId));
    if (!label) {
      const labelId = await unarchiveSessionInTx(tx, input);
      if (labelId) await touch();
      return { changed: Boolean(labelId), labelId };
    }
    const [active] = await tx.select({ id: sessionTurns.id }).from(sessionTurns)
      .where(and(eq(sessionTurns.sessionId, input.sessionId), sessionTurnIsActive(sessionTurns.status)))
      .limit(1);
    if (active) throw new SessionRunningError();
    const [created] = await tx.insert(labelAssignments).values({
      labelId: label.id,
      scopeType: "space",
      scopeId: input.spaceId,
      resourceType: "session",
      resourceRef: input.sessionId,
      source: "system",
      createdBy: input.userId,
    }).onConflictDoNothing().returning({ id: labelAssignments.id });
    if (created) await touch();
    return { changed: Boolean(created), labelId: label.id };
  });
}
