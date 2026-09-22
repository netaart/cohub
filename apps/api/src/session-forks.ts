import { createLogger } from "@cohub/infra/logging";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import type { SessionForkRecord, SessionTurnSegmentRecord } from "@cohub/protocol/model";
import { db } from "./db/index.js";
import { labelAssignments, sessionForks, sessionTurnSegments, sessionTurns, spaceSessions } from "@cohub/db";
import { sanitizePostgresJsonValue } from "@cohub/core/content/sanitize";
import { sessionForkReference } from "@cohub/core/references";
import { enqueueReferences } from "./reference-index-queue.js";
import { assignSessionParticipantSystemLabels } from "@cohub/core/labels/session-user";
import { normalizeSessionTitle, readSessionParticipantUserUuids, setSessionParticipantsMeta, setSessionTitleMeta } from "@cohub/core/sessions";

type SegmentRow = typeof sessionTurnSegments.$inferSelect;
export const MAX_SESSION_TURN_SEGMENTS = 128;
type ForkRow = typeof sessionForks.$inferSelect;

const logger = createLogger({ serviceName: "cohub-api" });

const toIso = (value: Date | string | null | undefined) => {
  if (!value) return new Date().toISOString();
  return value instanceof Date ? value.toISOString() : value;
};

const toSegmentRecord = (row: SegmentRow): SessionTurnSegmentRecord => ({
  id: row.id,
  sessionId: row.sessionId,
  ordinal: row.ordinal,
  sourceSessionId: row.sourceSessionId,
  fromSequence: row.fromSequence,
  toSequence: row.toSequence ?? null,
  createdAt: toIso(row.createdAt),
});

const toForkRecord = (row: ForkRow): SessionForkRecord => ({
  id: row.id,
  spaceId: row.spaceId,
  parentSessionId: row.parentSessionId,
  childSessionId: row.childSessionId,
  rootSessionId: row.rootSessionId,
  depth: row.depth,
  anchorSourceSessionId: row.anchorSourceSessionId,
  anchorTurnId: row.anchorTurnId,
  anchorSequence: row.anchorSequence,
  ancestorSessionIds: row.ancestorSessionIds,
  sessionPath: row.sessionPath,
  createdBy: row.createdBy ?? null,
  createdAt: toIso(row.createdAt),
});

export const ensureSessionTurnSegments = async (sessionId: string) => {
  const rows = await db.select().from(sessionTurnSegments).where(eq(sessionTurnSegments.sessionId, sessionId)).orderBy(asc(sessionTurnSegments.ordinal));
  if (rows.length > 0) return rows;
  await db
    .insert(sessionTurnSegments)
    .values({
      sessionId,
      ordinal: 1,
      sourceSessionId: sessionId,
      fromSequence: 1,
      toSequence: null,
    })
    .onConflictDoNothing({ target: [sessionTurnSegments.sessionId, sessionTurnSegments.ordinal] });
  return db.select().from(sessionTurnSegments).where(eq(sessionTurnSegments.sessionId, sessionId)).orderBy(asc(sessionTurnSegments.ordinal));
};

export const listSessionTurnSegments = async (sessionId: string) => (await ensureSessionTurnSegments(sessionId)).map(toSegmentRecord);

export const getSessionForkByChild = async (childSessionId: string) => {
  const [row] = await db.select().from(sessionForks).where(eq(sessionForks.childSessionId, childSessionId)).limit(1);
  return row ? toForkRecord(row) : null;
};

export const listSessionForkTree = async (rootSessionId: string) => {
  const rows = await db.select().from(sessionForks).where(eq(sessionForks.rootSessionId, rootSessionId)).orderBy(asc(sessionForks.depth), asc(sessionForks.createdAt));
  return rows.map(toForkRecord);
};

export type SessionForkListItem = SessionForkRecord & {
  firstUserTextAfterFork: string | null;
  parentTitle: string | null;
};

/** Fork edge shaped for sidebar rendering. `parentSessionId`/`parentTitle` may be
 * redacted to null when the parent session is not visible to the current viewer. */
export type SidebarSessionFork = Omit<SessionForkListItem, "parentSessionId"> & {
  parentSessionId: string | null;
};

/**
 * Redact fork edges for a viewer. Members see everything; non-members lose the
 * parent linkage (and its title) whenever the parent session is not in their
 * visible set. Shared by session list and label item endpoints so both surfaces
 * enforce identical visibility.
 */
export const redactSessionForksForViewer = (forks: SessionForkListItem[], input: { isMember: boolean; visibleSessionIds: Iterable<string> }): SidebarSessionFork[] => {
  if (input.isMember) return forks;
  const visible = new Set(input.visibleSessionIds);
  return forks.map((fork) => {
    const parentVisible = visible.has(fork.parentSessionId);
    const rootVisible = visible.has(fork.rootSessionId);
    const anchorVisible = visible.has(fork.anchorSourceSessionId);
    return {
      ...fork,
      parentSessionId: parentVisible ? fork.parentSessionId : null,
      parentTitle: parentVisible ? fork.parentTitle : null,
      // Hide private ancestry graph for viewers who cannot see those sessions.
      rootSessionId: rootVisible ? fork.rootSessionId : fork.childSessionId,
      anchorSourceSessionId: anchorVisible ? fork.anchorSourceSessionId : fork.childSessionId,
      ancestorSessionIds: fork.ancestorSessionIds.filter((id) => visible.has(id)),
      sessionPath: fork.sessionPath.filter((id) => visible.has(id)),
    };
  });
};

export const listSessionForksForSessions = async (sessionIds: string[]) => {
  const ids = [...new Set(sessionIds.filter(Boolean))];
  if (ids.length === 0) return [] satisfies SessionForkListItem[];

  const rows = await db
    .select({
      fork: sessionForks,
      parentTitle: spaceSessions.title,
    })
    .from(sessionForks)
    .leftJoin(spaceSessions, eq(spaceSessions.id, sessionForks.parentSessionId))
    .where(inArray(sessionForks.childSessionId, ids))
    .orderBy(asc(sessionForks.depth), asc(sessionForks.createdAt));

  const childIds = rows.map((row) => row.fork.childSessionId);
  const turnRows =
    childIds.length > 0
      ? await db
          .select({
            sessionId: sessionTurns.sessionId,
            userText: sessionTurns.userText,
            sequence: sessionTurns.sequence,
          })
          .from(sessionTurns)
          .where(inArray(sessionTurns.sessionId, childIds))
          .orderBy(asc(sessionTurns.sessionId), asc(sessionTurns.sequence))
      : [];

  const firstUserTextBySession = new Map<string, string | null>();
  for (const turn of turnRows) {
    if (firstUserTextBySession.has(turn.sessionId)) continue;
    firstUserTextBySession.set(turn.sessionId, turn.userText ?? null);
  }

  return rows.map(
    (row): SessionForkListItem => ({
      ...toForkRecord(row.fork),
      firstUserTextAfterFork: firstUserTextBySession.get(row.fork.childSessionId) ?? null,
      parentTitle: row.parentTitle ?? null,
    }),
  );
};

export const findSegmentForTurn = (segments: SegmentRow[], input: { sourceSessionId: string; sequence: number }) => segments.find((segment) => segment.sourceSessionId === input.sourceSessionId && segment.fromSequence <= input.sequence && (segment.toSequence == null || input.sequence <= segment.toSequence)) ?? null;

export const findSegmentForSequence = (segments: SegmentRow[], sequence: number) => segments.find((segment) => segment.fromSequence <= sequence && (segment.toSequence == null || sequence <= segment.toSequence)) ?? null;

const clipSegments = (segments: SegmentRow[], anchorSequence: number) => {
  const clipped: Array<Pick<SegmentRow, "sourceSessionId" | "fromSequence" | "toSequence">> = [];
  for (const segment of segments) {
    if (segment.fromSequence > anchorSequence) break;
    const toSequence = segment.toSequence == null ? anchorSequence : Math.min(segment.toSequence, anchorSequence);
    clipped.push({
      sourceSessionId: segment.sourceSessionId,
      fromSequence: segment.fromSequence,
      toSequence,
    });
    if (toSequence >= anchorSequence) break;
  }
  return clipped;
};

type SessionForkInput = {
  spaceId: string;
  parentSessionId: string;
  childSessionId: string;
  turnId: string;
  sequence?: number;
  title?: string | null;
  createdBy?: string | null;
};
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Shared Turn-fork operation; callers can atomically fork and claim a native execution. */
export async function createSessionForkInTransaction(tx: Transaction, input: SessionForkInput) {
  const now = new Date();
  const createdBy = input.createdBy?.trim();
  if (!createdBy) throw new Error("createdBy is required");
  const [anchorTurn] = await tx.select().from(sessionTurns).where(eq(sessionTurns.id, input.turnId)).limit(1);
  if (!anchorTurn) throw new Error("Turn not found");
  const [anchorSourceSession] = await tx
    .select({ id: spaceSessions.id })
    .from(spaceSessions)
    .where(and(eq(spaceSessions.id, anchorTurn.sessionId), eq(spaceSessions.spaceId, input.spaceId)))
    .limit(1);
  if (!anchorSourceSession) throw new Error("Turn source session not found");
  if (anchorTurn.status === "running") throw new Error("Cannot fork a running turn");
  const anchorSequence = input.sequence ?? anchorTurn.sequence;
  const [parent] = await tx
    .select()
    .from(spaceSessions)
    .where(and(eq(spaceSessions.id, input.parentSessionId), eq(spaceSessions.spaceId, input.spaceId)))
    .limit(1);
  if (!parent) throw new Error("Parent session not found");

  const existingChild = await tx.select().from(spaceSessions).where(eq(spaceSessions.id, input.childSessionId)).limit(1);
  if (existingChild[0]) {
    const [existingFork] = await tx.select().from(sessionForks).where(eq(sessionForks.childSessionId, input.childSessionId)).limit(1);
    if (existingFork?.parentSessionId === parent.id && existingFork.anchorTurnId === input.turnId && existingFork.anchorSequence === anchorSequence) {
      return { session: existingChild[0], fork: existingFork, participantUserUuids: [createdBy, ...readSessionParticipantUserUuids(existingChild[0].meta)] };
    }
    throw new Error("Session id already exists");
  }

  let parentSegments = await tx.select().from(sessionTurnSegments).where(eq(sessionTurnSegments.sessionId, parent.id)).orderBy(asc(sessionTurnSegments.ordinal));
  if (parentSegments.length === 0) {
    await tx
      .insert(sessionTurnSegments)
      .values({ sessionId: parent.id, ordinal: 1, sourceSessionId: parent.id, fromSequence: 1, toSequence: null })
      .onConflictDoNothing({ target: [sessionTurnSegments.sessionId, sessionTurnSegments.ordinal] });
    parentSegments = await tx.select().from(sessionTurnSegments).where(eq(sessionTurnSegments.sessionId, parent.id)).orderBy(asc(sessionTurnSegments.ordinal));
  }
  const anchorSegment = findSegmentForTurn(parentSegments, { sourceSessionId: anchorTurn.sessionId, sequence: anchorSequence });
  if (!anchorSegment || anchorTurn.sequence !== anchorSequence) throw new Error("Turn is not visible in this session");

  const [parentFork] = await tx.select().from(sessionForks).where(eq(sessionForks.childSessionId, parent.id)).limit(1);
  const rootSessionId = parentFork?.rootSessionId ?? parent.id;
  const ancestorSessionIds = parentFork?.sessionPath ?? [parent.id];
  const sessionPath = [...ancestorSessionIds, input.childSessionId];
  const depth = parentFork ? parentFork.depth + 1 : 1;

  const clipped = clipSegments(parentSegments, anchorSequence);
  if (clipped.length > MAX_SESSION_TURN_SEGMENTS) throw new Error("Fork chain is too deep");
  const childSegments = [...clipped, { sourceSessionId: input.childSessionId, fromSequence: anchorSequence + 1, toSequence: null }];
  const visibleTurnUserUuids = new Set<string>();
  for (const segment of childSegments) {
    const toSequence = segment.toSequence ?? anchorSequence;
    if (toSequence < segment.fromSequence) continue;
    const rows = await tx
      .select({ userUuid: sessionTurns.userUuid })
      .from(sessionTurns)
      .where(and(eq(sessionTurns.sessionId, segment.sourceSessionId), gte(sessionTurns.sequence, segment.fromSequence), lte(sessionTurns.sequence, toSequence)));
    for (const row of rows) if (row.userUuid?.trim()) visibleTurnUserUuids.add(row.userUuid.trim());
  }

  const childParticipantUserUuids = [createdBy, ...visibleTurnUserUuids];
  const requestedTitle = normalizeSessionTitle(input.title);
  const childMeta = setSessionParticipantsMeta(
    {
      ...(parent.meta && typeof parent.meta === "object" && !Array.isArray(parent.meta) ? (parent.meta as Record<string, unknown>) : {}),
      fork: {
        version: 1,
        kind: "turn",
        createdAt: now.toISOString(),
        createdBy,
      },
    },
    childParticipantUserUuids,
    now,
  );

  const [child] = await tx
    .insert(spaceSessions)
    .values({
      id: input.childSessionId,
      spaceId: input.spaceId,
      userUuid: createdBy,
      title: requestedTitle,
      source: parent.source,
      status: "active",
      externalSessionId: null,
      meta: sanitizePostgresJsonValue(requestedTitle ? setSessionTitleMeta(childMeta, { source: "user" }) : childMeta),
      lastMessageAt: now,
      lastMessageId: null,
      latestMessageText: anchorTurn.userText ?? parent.latestMessageText ?? null,
    })
    .returning();
  if (!child) throw new Error("Failed to create fork session");

  const [fork] = await tx
    .insert(sessionForks)
    .values({
      spaceId: input.spaceId,
      parentSessionId: parent.id,
      childSessionId: child.id,
      rootSessionId,
      depth,
      anchorSourceSessionId: anchorSegment.sourceSessionId,
      anchorTurnId: anchorTurn.id,
      anchorSequence,
      ancestorSessionIds,
      sessionPath,
      createdBy,
    })
    .returning();
  if (!fork) throw new Error("Failed to create fork record");

  await tx.insert(sessionTurnSegments).values(
    childSegments.map((segment, index) => ({
      sessionId: child.id,
      ordinal: index + 1,
      sourceSessionId: segment.sourceSessionId,
      fromSequence: segment.fromSequence,
      toSequence: segment.toSequence,
    })),
  );

  // Inherit the parent session's label assignments so the fork is categorized
  // consistently with its origin. Preserves the original source (user/system)
  // and provenance while pointing the assignment at the new child session.
  const parentLabelAssignments = await tx
    .select({
      labelId: labelAssignments.labelId,
      rank: labelAssignments.rank,
      source: labelAssignments.source,
      createdBy: labelAssignments.createdBy,
      meta: labelAssignments.meta,
    })
    .from(labelAssignments)
    .where(and(eq(labelAssignments.scopeType, "space"), eq(labelAssignments.scopeId, input.spaceId), eq(labelAssignments.resourceType, "session"), eq(labelAssignments.resourceRef, parent.id)));
  if (parentLabelAssignments.length > 0) {
    await tx
      .insert(labelAssignments)
      .values(
        parentLabelAssignments.map((assignment) => ({
          labelId: assignment.labelId,
          scopeType: "space",
          scopeId: input.spaceId,
          resourceType: "session",
          resourceRef: child.id,
          rank: assignment.rank,
          source: assignment.source,
          createdBy: assignment.createdBy,
          meta: assignment.meta,
        })),
      )
      .onConflictDoNothing();
  }

  return { session: child, fork, participantUserUuids: childParticipantUserUuids };
}

export async function publishSessionFork(result: Awaited<ReturnType<typeof createSessionForkInTransaction>>) {
  await assignSessionParticipantSystemLabels({
    db,
    spaceId: result.fork.spaceId,
    sessionId: result.session.id,
    userUuids: result.participantUserUuids,
  }).catch((error) => {
    logger.warn("[SessionFork] failed to assign participant labels", { sessionId: result.session.id, error });
  });
  // Index the fork lineage. Enqueued for async, retryable indexing so stats
  // never block or fail the fork.
  enqueueReferences([
    sessionForkReference({
      spaceId: result.fork.spaceId,
      parentSessionId: result.fork.parentSessionId,
      childSessionId: result.fork.childSessionId,
      anchorTurnId: result.fork.anchorTurnId,
      createdBy: result.fork.createdBy,
    }),
  ]);
  return { session: result.session, fork: toForkRecord(result.fork) };
}

export async function createSessionFork(input: SessionForkInput) {
  return publishSessionFork(await db.transaction((tx) => createSessionForkInTransaction(tx, input)));
}
