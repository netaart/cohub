import { Hono, type Context } from "hono";
import { and, asc, count, desc, eq, inArray, isNull, lt, max, or, sql } from "drizzle-orm";
import { checkpoints, labelAssignments, labels, spaceSessions } from "@cohub/db";
import { listLabelsByRank, normalizeLabelName, parseLabelRef, parseLabelRefs, resolveLabelPaths, resolveOrCreateLabelPaths, slugifyLabelName } from "@cohub/core/labels";
import { db } from "../../db/index.js";
import { getPostgresErrorConstraint, isPostgresUniqueViolation } from "../../db/postgres-error.js";
import { authzDenied, getOptionalAuth, requireValidId, useAuth } from "../../lib/middleware.js";
import { filterSessionsByPermission, getSpaceMemberRole, hasPermission } from "../../permissions.js";
import { dispatchLabelAssignmentsUpdated } from "../../realtime-events.js";
import { listSessionForksForSessions } from "../../session-forks.js";
import { redactSessionForksForViewer } from "../../session-fork-visibility.js";
import { attachActiveTurns, hydrateSessionParticipantProfiles } from "../../space-sessions.js";

const router = new Hono();
const SCOPE_TYPE = "space";
const RESOURCE_TYPES = new Set(["session", "checkpoint", "file"]);
const DEFAULT_ITEMS_LIMIT = 30;
const MAX_ITEMS_LIMIT = 50;
/** Extra raw rows to scan per fill attempt when post-filtering for session.view. */
const VISIBILITY_FILL_BATCH = 50;
/** Cap total raw rows scanned while filling one visible page for non-members. */
const VISIBILITY_FILL_MAX_SCAN = 500;
const MANUAL_ITEMS_CURSOR_RANK_FLOOR = -2147483648;

function normalizeName(value: unknown) {
  try {
    return normalizeLabelName(value);
  } catch {
    return null;
  }
}

function isSafeFilePath(path: string) {
  const trimmed = path.trim();
  return trimmed.length > 0 &&
    !trimmed.startsWith("/") &&
    !trimmed.includes("\0") &&
    !trimmed.split("/").some((part) => part === ".." || part === "");
}

function parseItemsLimit(value: string | undefined) {
  const limit = Number(value ?? DEFAULT_ITEMS_LIMIT);
  if (!Number.isSafeInteger(limit) || limit < 1) return DEFAULT_ITEMS_LIMIT;
  return Math.min(limit, MAX_ITEMS_LIMIT);
}

function encodeManualItemsCursor(row: typeof labelAssignments.$inferSelect) {
  return Buffer.from(JSON.stringify({ type: "manual", rank: row.rank, createdAt: row.createdAt?.toISOString() ?? null, id: row.id })).toString("base64url");
}

function encodeSessionActivityItemsCursor(row: { lastMessageAt: Date | null; sessionId: string }) {
  return Buffer.from(JSON.stringify({ type: "sessionActivity", lastMessageAt: row.lastMessageAt?.toISOString() ?? null, sessionId: row.sessionId })).toString("base64url");
}

function decodeItemsCursor(value: string | undefined) {
  if (!value) return { ok: true as const, cursor: null };
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { type?: unknown; rank?: unknown; createdAt?: unknown; id?: unknown; lastMessageAt?: unknown; sessionId?: unknown };
    if (parsed.type === "sessionActivity") {
      if (parsed.lastMessageAt !== null && typeof parsed.lastMessageAt !== "string") return { ok: false as const };
      if (typeof parsed.sessionId !== "string" || !requireValidId(parsed.sessionId)) return { ok: false as const };
      const lastMessageAt = parsed.lastMessageAt ? new Date(parsed.lastMessageAt) : null;
      if (lastMessageAt && !Number.isFinite(lastMessageAt.getTime())) return { ok: false as const };
      return { ok: true as const, cursor: { type: "sessionActivity" as const, lastMessageAt, sessionId: parsed.sessionId } };
    }
    if (parsed.type !== undefined && parsed.type !== "manual") return { ok: false as const };
    if (parsed.rank === undefined || (parsed.rank !== null && !Number.isSafeInteger(parsed.rank))) return { ok: false as const };
    if (typeof parsed.id !== "string" || !requireValidId(parsed.id)) return { ok: false as const };
    if (parsed.createdAt !== null && typeof parsed.createdAt !== "string") return { ok: false as const };
    const createdAt = parsed.createdAt ? new Date(parsed.createdAt) : null;
    if (createdAt && !Number.isFinite(createdAt.getTime())) return { ok: false as const };
    const rank = typeof parsed.rank === "number" ? parsed.rank : null;
    return { ok: true as const, cursor: { type: "manual" as const, rank, createdAt, id: parsed.id } };
  } catch {
    return { ok: false as const };
  }
}

function buildSessionActivityItemsCursorCondition(cursor: { lastMessageAt: Date | null; sessionId: string } | null) {
  if (!cursor) return undefined;
  if (!cursor.lastMessageAt) return and(isNull(spaceSessions.lastMessageAt), lt(spaceSessions.id, cursor.sessionId));
  return or(
    lt(spaceSessions.lastMessageAt, cursor.lastMessageAt),
    isNull(spaceSessions.lastMessageAt),
    and(eq(spaceSessions.lastMessageAt, cursor.lastMessageAt), lt(spaceSessions.id, cursor.sessionId)),
  );
}

function buildManualItemsCursorCondition(cursor: { rank: number | null; createdAt: Date | null; id: string } | null) {
  if (!cursor) return undefined;
  const rankKey = sql<number>`coalesce(${labelAssignments.rank}, ${MANUAL_ITEMS_CURSOR_RANK_FLOOR})`;
  const cursorRank = cursor.rank ?? MANUAL_ITEMS_CURSOR_RANK_FLOOR;
  const cursorCreatedAt = cursor.createdAt ?? new Date(0);
  return or(
    lt(rankKey, cursorRank),
    and(eq(rankKey, cursorRank), lt(labelAssignments.createdAt, cursorCreatedAt)),
    and(eq(rankKey, cursorRank), eq(labelAssignments.createdAt, cursorCreatedAt), lt(labelAssignments.id, cursor.id)),
  );
}

function buildHref(spaceId: string, resourceType: string, resourceRef: string) {
  if (resourceType === "session") return `/spaces/${spaceId}/sessions/${resourceRef}`;
  if (resourceType === "checkpoint") return `/spaces/${spaceId}/checkpoints/${resourceRef}`;
  if (resourceType === "file") return `/spaces/${spaceId}/files/${resourceRef.split("/").map(encodeURIComponent).join("/")}`;
  return `/spaces/${spaceId}`;
}

function buildLabelTree(rows: Array<typeof labels.$inferSelect>) {
  const sorted = [...rows].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.name.localeCompare(b.name);
  });
  const byId = new Map(sorted.map((label) => [label.id, { ...label, children: [] as Array<typeof label & { children: never[] }> }]));
  const roots: Array<typeof sorted[number] & { children: Array<typeof sorted[number]> }> = [];
  for (const label of byId.values()) {
    if (label.parentId) {
      const parent = byId.get(label.parentId);
      if (parent) {
        parent.children.push(label as never);
        continue;
      }
    }
    roots.push(label as never);
  }
  return roots;
}

async function requireSpacePermission(c: Context, permission: Parameters<typeof hasPermission>[1]) {
  const user = permission === "space.label.view" ? getOptionalAuth(c) : useAuth(c);
  if (user instanceof Response) return { error: user };
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return { error: c.json({ message: "space not found" }, 404) };
  if (!(await hasPermission(user, permission, { spaceId }))) return { error: authzDenied(c) };
  return { user, spaceId };
}

async function getScopeLabels(spaceId: string) {
  return listLabelsByRank(db, spaceId);
}

async function getLabelInSpace(spaceId: string, labelId: string) {
  const [label] = await db
    .select()
    .from(labels)
    .where(and(eq(labels.id, labelId), eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, spaceId)))
    .limit(1);
  return label ?? null;
}

async function getLabelByRef(spaceId: string, labelRef: unknown) {
  const path = parseLabelRef(labelRef);
  const resolved = await resolveLabelPaths({ db, spaceId, paths: [path] });
  const labelId = resolved.labelIds[0];
  if (!labelId) return null;
  return getLabelInSpace(spaceId, labelId);
}

async function resolveOrCreateRefs(spaceId: string, labelRefs: unknown, userId: string | null) {
  const paths = parseLabelRefs(labelRefs);
  return resolveOrCreateLabelPaths({ db, spaceId, paths, userId });
}

async function resolveRefsWithCreatePermission(c: Context, access: { user: ReturnType<typeof getOptionalAuth>; spaceId: string }, labelRefs: unknown) {
  const paths = parseLabelRefs(labelRefs);
  const resolved = await resolveLabelPaths({ db, spaceId: access.spaceId, paths });
  if (resolved.missingPaths.length === 0) return { labelIds: resolved.labelIds };
  if (!(await hasPermission(access.user, "space.label.manage", { spaceId: access.spaceId }))) {
    return { error: authzDenied(c) };
  }
  await resolveOrCreateLabelPaths({ db, spaceId: access.spaceId, paths: resolved.missingPaths, userId: access.user?.uuid ?? null });
  return resolveLabelPaths({ db, spaceId: access.spaceId, paths });
}

async function resolveExistingRefs(spaceId: string, labelRefs: unknown) {
  const paths = parseLabelRefs(labelRefs);
  return resolveLabelPaths({ db, spaceId, paths });
}

function isUniqueLabelNameViolation(error: unknown) {
  const constraint = getPostgresErrorConstraint(error) ?? "";
  return isPostgresUniqueViolation(error) && constraint.includes("labels_scope_parent_name");
}

async function validateResource(spaceId: string, resourceType: string, resourceRef: string) {
  if (!RESOURCE_TYPES.has(resourceType)) return false;
  if (resourceType === "file") return isSafeFilePath(resourceRef);
  if (!requireValidId(resourceRef)) return false;
  if (resourceType === "session") {
    const [row] = await db.select({ id: spaceSessions.id }).from(spaceSessions).where(and(eq(spaceSessions.spaceId, spaceId), eq(spaceSessions.id, resourceRef))).limit(1);
    return Boolean(row);
  }
  const [row] = await db.select({ id: checkpoints.id }).from(checkpoints).where(and(eq(checkpoints.spaceId, spaceId), eq(checkpoints.id, resourceRef))).limit(1);
  return Boolean(row);
}

async function getUserLabelIds(c: Context, spaceId: string, labelIds: string[]) {
  const uniqueLabelIds = [...new Set(labelIds)].filter(Boolean);
  if (uniqueLabelIds.length === 0) return { labelIds: [] };
  const rows = await db.select().from(labels).where(and(eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, spaceId), inArray(labels.id, uniqueLabelIds)));
  if (rows.length !== uniqueLabelIds.length || rows.some((label) => label.source !== "user")) return { error: authzDenied(c) };
  const userIds = new Set(rows.map((label) => label.id));
  return { labelIds: uniqueLabelIds.filter((labelId) => userIds.has(labelId)) };
}

async function getResourceLabelResponse(spaceId: string, resourceType: string, resourceRef: string) {
  const [allLabels, assignments] = await Promise.all([
    getScopeLabels(spaceId),
    db.select().from(labelAssignments).where(and(eq(labelAssignments.scopeType, SCOPE_TYPE), eq(labelAssignments.scopeId, spaceId), eq(labelAssignments.resourceType, resourceType), eq(labelAssignments.resourceRef, resourceRef))),
  ]);
  return { labels: buildLabelTree(allLabels), assignments };
}

async function hydrateAssignments(spaceId: string, rows: Array<typeof labelAssignments.$inferSelect>) {
  const sessionIds = rows.filter((m) => m.resourceType === "session").map((m) => m.resourceRef).filter(requireValidId);
  const checkpointIds = rows.filter((m) => m.resourceType === "checkpoint").map((m) => m.resourceRef).filter(requireValidId);
  const sessionRows = sessionIds.length > 0
    ? await db.select().from(spaceSessions).where(and(eq(spaceSessions.spaceId, spaceId), inArray(spaceSessions.id, sessionIds)))
    : [];
  const checkpointRows = checkpointIds.length > 0
    ? await db.select().from(checkpoints).where(and(eq(checkpoints.spaceId, spaceId), inArray(checkpoints.id, checkpointIds)))
    : [];
  const hydratedSessions = sessionRows.length > 0
    ? await hydrateSessionParticipantProfiles(sessionRows)
    : [];
  const sessionsById = new Map(hydratedSessions.map((s) => [s.id, s]));
  const checkpointsById = new Map(checkpointRows.map((cp) => [cp.id, cp]));

  const items = rows.flatMap((assignment) => {
    if (assignment.resourceType === "session") {
      const session = sessionsById.get(assignment.resourceRef);
      if (!session) return [];
      return [{
        ...assignment,
        href: buildHref(spaceId, assignment.resourceType, assignment.resourceRef),
        resource: {
          title: session.title ?? session.latestMessageText ?? "New chat",
          subtitle: session.lastMessageAt ? new Date(session.lastMessageAt).toISOString() : null,
          status: session.status ?? null,
        },
      }];
    }
    if (assignment.resourceType === "checkpoint") {
      const checkpoint = checkpointsById.get(assignment.resourceRef);
      if (!checkpoint) return [];
      return [{
        ...assignment,
        href: buildHref(spaceId, assignment.resourceType, assignment.resourceRef),
        resource: {
          title: checkpoint.description || checkpoint.commitHash.slice(0, 12),
          subtitle: checkpoint.createdAt ? new Date(checkpoint.createdAt).toISOString() : null,
          status: null,
        },
      }];
    }
    if (assignment.resourceType === "file") {
      return [{
        ...assignment,
        href: buildHref(spaceId, assignment.resourceType, assignment.resourceRef),
        resource: {
          title: assignment.resourceRef.split("/").pop() ?? assignment.resourceRef,
          subtitle: assignment.resourceRef,
          status: null,
        },
      }];
    }
    return [];
  });

  // Keep session/fork payloads aligned with this assignment page so clients can
  // render label rows (avatars + fork tree) without N+1 session detail fetches.
  const itemSessionIds = new Set(
    items.filter((item) => item.resourceType === "session").map((item) => item.resourceRef),
  );
  const sessions = hydratedSessions.filter((session) => itemSessionIds.has(session.id));
  return { items, sessions };
}

type HydratedLabelSession = Awaited<ReturnType<typeof hydrateSessionParticipantProfiles>>[number];

async function resolveViewerVisibleSessions(
  spaceId: string,
  user: Parameters<typeof hasPermission>[0],
  sessions: HydratedLabelSession[],
) {
  if (sessions.length === 0) {
    return { isMember: true, sessions: [] as HydratedLabelSession[] };
  }
  const isMember = user?.uuid
    ? (await getSpaceMemberRole(spaceId, user.uuid)) !== null
    : false;
  if (isMember) return { isMember, sessions };
  // Hydrated sessions still include the underlying spaceSessions row fields the
  // permission filter reads (id / spaceId / userUuid / accessPolicy / meta…).
  const visibleRows = await filterSessionsByPermission(user, "session.view", spaceId, sessions);
  const visibleIds = new Set(visibleRows.map((session) => session.id));
  return {
    isMember,
    sessions: sessions.filter((session) => visibleIds.has(session.id)),
  };
}


async function attachViewerVisibleForks(
  isMember: boolean,
  sessions: HydratedLabelSession[],
) {
  if (sessions.length === 0) return [];
  const visibleSessionIds = sessions.map((session) => session.id);
  return redactSessionForksForViewer(
    await listSessionForksForSessions(visibleSessionIds),
    { isMember, visibleSessionIds },
  );
}

type SystemItemsCursor = { lastMessageAt: Date | null; sessionId: string } | null;
type ManualItemsCursor = { rank: number | null; createdAt: Date | null; id: string } | null;

/**
 * Fill a full visible page after session.view filtering.
 *
 * Members: single query (limit+1) — same as before.
 * Non-members: scan ahead in batches, filter visibility, stop when we have
 * `limit` visible items or the source is exhausted. Cursor always advances over
 * the last *scanned* assignment so hidden sessions are not re-fetched forever.
 */
async function listVisibleSystemLabelItems(input: {
  spaceId: string;
  user: Parameters<typeof hasPermission>[0];
  labelId: string;
  limit: number;
  cursor: SystemItemsCursor;
}) {
  const isMember = input.user?.uuid
    ? (await getSpaceMemberRole(input.spaceId, input.user.uuid)) !== null
    : false;

  if (isMember) {
    const rows = await db
      .select({ assignment: labelAssignments, lastMessageAt: spaceSessions.lastMessageAt, sessionId: spaceSessions.id })
      .from(spaceSessions)
      .innerJoin(labelAssignments, and(
        eq(labelAssignments.scopeType, SCOPE_TYPE),
        eq(labelAssignments.scopeId, input.spaceId),
        eq(labelAssignments.labelId, input.labelId),
        eq(labelAssignments.resourceType, "session"),
        sql`${labelAssignments.resourceRef} = ${spaceSessions.id}::text`,
      ))
      .where(and(
        eq(spaceSessions.spaceId, input.spaceId),
        buildSessionActivityItemsCursorCondition(input.cursor),
      ))
      .orderBy(sql`${spaceSessions.lastMessageAt} desc nulls last`, desc(spaceSessions.id))
      .limit(input.limit + 1);
    const pageRows = rows.slice(0, input.limit);
    const lastRow = pageRows.at(-1);
    const nextCursor = rows.length > input.limit && lastRow
      ? encodeSessionActivityItemsCursor({ lastMessageAt: lastRow.lastMessageAt, sessionId: lastRow.sessionId })
      : null;
    const hydrated = await hydrateAssignments(input.spaceId, pageRows.map((row) => row.assignment));
    const forks = await attachViewerVisibleForks(true, hydrated.sessions);
    return { items: hydrated.items, sessions: hydrated.sessions, forks, pageInfo: { hasMore: Boolean(nextCursor), nextCursor } };
  }

  let cursor = input.cursor;
  const acceptedAssignments: Array<typeof labelAssignments.$inferSelect> = [];
  let scanned = 0;
  let sourceExhausted = false;
  let lastScanned: { lastMessageAt: Date | null; sessionId: string } | null = null;

  while (acceptedAssignments.length < input.limit && scanned < VISIBILITY_FILL_MAX_SCAN) {
    const batchLimit = Math.min(VISIBILITY_FILL_BATCH, VISIBILITY_FILL_MAX_SCAN - scanned);
    const rows = await db
      .select({ assignment: labelAssignments, lastMessageAt: spaceSessions.lastMessageAt, sessionId: spaceSessions.id })
      .from(spaceSessions)
      .innerJoin(labelAssignments, and(
        eq(labelAssignments.scopeType, SCOPE_TYPE),
        eq(labelAssignments.scopeId, input.spaceId),
        eq(labelAssignments.labelId, input.labelId),
        eq(labelAssignments.resourceType, "session"),
        sql`${labelAssignments.resourceRef} = ${spaceSessions.id}::text`,
      ))
      .where(and(
        eq(spaceSessions.spaceId, input.spaceId),
        buildSessionActivityItemsCursorCondition(cursor),
      ))
      .orderBy(sql`${spaceSessions.lastMessageAt} desc nulls last`, desc(spaceSessions.id))
      .limit(batchLimit);
    if (rows.length === 0) {
      sourceExhausted = true;
      break;
    }
    scanned += rows.length;
    // System labels only assign sessions; filter the raw assignment rows by session.view.
    const hydrated = await hydrateAssignments(input.spaceId, rows.map((row) => row.assignment));
    const visible = await resolveViewerVisibleSessions(input.spaceId, input.user, hydrated.sessions);
    const visibleIds = new Set(visible.sessions.map((session) => session.id));
    let filled = false;
    for (const row of rows) {
      lastScanned = { lastMessageAt: row.lastMessageAt, sessionId: row.sessionId };
      cursor = lastScanned;
      if (!visibleIds.has(row.assignment.resourceRef)) continue;
      acceptedAssignments.push(row.assignment);
      if (acceptedAssignments.length >= input.limit) {
        filled = true;
        break;
      }
    }
    if (filled) break;
    if (rows.length < batchLimit) {
      sourceExhausted = true;
      break;
    }
  }

  const pageAssignments = acceptedAssignments.slice(0, input.limit);
  const hydrated = await hydrateAssignments(input.spaceId, pageAssignments);
  const forks = await attachViewerVisibleForks(false, hydrated.sessions);
  const nextCursor = !sourceExhausted && lastScanned
    ? encodeSessionActivityItemsCursor(lastScanned)
    : null;
  return {
    items: hydrated.items,
    sessions: hydrated.sessions,
    forks,
    pageInfo: { hasMore: Boolean(nextCursor), nextCursor },
  };
}

async function listVisibleManualLabelItems(input: {
  spaceId: string;
  user: Parameters<typeof hasPermission>[0];
  labelId: string;
  limit: number;
  cursor: ManualItemsCursor;
}) {
  const isMember = input.user?.uuid
    ? (await getSpaceMemberRole(input.spaceId, input.user.uuid)) !== null
    : false;

  if (isMember) {
    const rows = await db
      .select()
      .from(labelAssignments)
      .where(and(
        eq(labelAssignments.scopeType, SCOPE_TYPE),
        eq(labelAssignments.scopeId, input.spaceId),
        eq(labelAssignments.labelId, input.labelId),
        buildManualItemsCursorCondition(input.cursor),
      ))
      .orderBy(sql`${labelAssignments.rank} desc nulls last`, desc(labelAssignments.createdAt), desc(labelAssignments.id))
      .limit(input.limit + 1);
    const pageRows = rows.slice(0, input.limit);
    const lastRow = pageRows.at(-1);
    const nextCursor = rows.length > input.limit && lastRow ? encodeManualItemsCursor(lastRow) : null;
    const hydrated = await hydrateAssignments(input.spaceId, pageRows);
    const forks = await attachViewerVisibleForks(true, hydrated.sessions);
    return { items: hydrated.items, sessions: hydrated.sessions, forks, pageInfo: { hasMore: Boolean(nextCursor), nextCursor } };
  }

  let cursor = input.cursor;
  const accepted: Array<typeof labelAssignments.$inferSelect> = [];
  let scanned = 0;
  let sourceExhausted = false;
  let lastScanned: typeof labelAssignments.$inferSelect | null = null;

  while (accepted.length < input.limit && scanned < VISIBILITY_FILL_MAX_SCAN) {
    const batchLimit = Math.min(VISIBILITY_FILL_BATCH, VISIBILITY_FILL_MAX_SCAN - scanned);
    const rows = await db
      .select()
      .from(labelAssignments)
      .where(and(
        eq(labelAssignments.scopeType, SCOPE_TYPE),
        eq(labelAssignments.scopeId, input.spaceId),
        eq(labelAssignments.labelId, input.labelId),
        buildManualItemsCursorCondition(cursor),
      ))
      .orderBy(sql`${labelAssignments.rank} desc nulls last`, desc(labelAssignments.createdAt), desc(labelAssignments.id))
      .limit(batchLimit);
    if (rows.length === 0) {
      sourceExhausted = true;
      break;
    }
    scanned += rows.length;
    const hydrated = await hydrateAssignments(input.spaceId, rows);
    const visible = await resolveViewerVisibleSessions(input.spaceId, input.user, hydrated.sessions);
    const visibleIds = new Set(visible.sessions.map((session) => session.id));
    let filled = false;
    for (const row of rows) {
      lastScanned = row;
      cursor = {
        rank: row.rank,
        createdAt: row.createdAt,
        id: row.id,
      };
      if (row.resourceType === "session" && !visibleIds.has(row.resourceRef)) continue;
      // Non-session resources stay visible under space.label.view.
      if (row.resourceType === "session" && !hydrated.sessions.some((s) => s.id === row.resourceRef)) continue;
      accepted.push(row);
      if (accepted.length >= input.limit) {
        filled = true;
        break;
      }
    }
    if (filled) break;
    if (rows.length < batchLimit) {
      sourceExhausted = true;
      break;
    }
  }

  const pageRows = accepted.slice(0, input.limit);
  const hydrated = await hydrateAssignments(input.spaceId, pageRows);
  const forks = await attachViewerVisibleForks(false, hydrated.sessions);
  // Advance past the last scanned raw row so hidden sessions are not re-fetched.
  const nextCursor = !sourceExhausted && lastScanned
    ? encodeManualItemsCursor(lastScanned)
    : null;
  return {
    items: hydrated.items,
    sessions: hydrated.sessions,
    forks,
    pageInfo: { hasMore: Boolean(nextCursor), nextCursor },
  };
}

router.get("/", async (c) => {
  const access = await requireSpacePermission(c, "space.label.view");
  if (access.error) return access.error;
  const rows = await getScopeLabels(access.spaceId);
  return c.json({ labels: buildLabelTree(rows) });
});

router.post("/", async (c) => {
  const access = await requireSpacePermission(c, "space.label.manage");
  if (access.error) return access.error;
  const body = await c.req.json<{ labelRef?: unknown }>().catch(() => null);
  try {
    const { labelIds } = await resolveOrCreateRefs(access.spaceId, [body?.labelRef], access.user?.uuid ?? null);
    const rows = labelIds.length > 0
      ? await db.select().from(labels).where(and(eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, access.spaceId), inArray(labels.id, labelIds)))
      : [];
    return c.json({ labels: rows }, 201);
  } catch (error) {
    if (isUniqueLabelNameViolation(error)) return c.json({ message: "label already exists" }, 409);
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }
});

router.post("/resolve", async (c) => {
  const access = await requireSpacePermission(c, "space.label.manage");
  if (access.error) return access.error;
  const body = await c.req.json<{ labelRefs?: unknown }>().catch(() => null);
  try {
    const { labelIds } = await resolveOrCreateRefs(access.spaceId, body?.labelRefs, access.user?.uuid ?? null);
    const rows = labelIds.length > 0
      ? await db.select().from(labels).where(and(eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, access.spaceId), inArray(labels.id, labelIds)))
      : [];
    return c.json({ labels: rows });
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }
});

router.patch("/by-ref", async (c) => {
  const access = await requireSpacePermission(c, "space.label.manage");
  if (access.error) return access.error;
  const body = await c.req.json<{ labelRef?: unknown; name?: string; parentRef?: string | null; rank?: number }>().catch(() => null);
  let label: typeof labels.$inferSelect | null;
  try {
    label = await getLabelByRef(access.spaceId, body?.labelRef);
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }
  if (!label) return c.json({ message: "label not found" }, 404);
  if (label.source !== "user") return authzDenied(c);
  const patch: Partial<typeof labels.$inferInsert> = { updatedAt: new Date() };
  if (body?.name !== undefined) {
    const name = normalizeName(body.name);
    if (!name) return c.json({ message: "name is required" }, 400);
    patch.name = name;
    patch.slug = slugifyLabelName(name);
  }
  if (body?.rank !== undefined) {
    const rank = Number(body.rank);
    if (!Number.isSafeInteger(rank) || rank < -1_000_000 || rank > 1_000_000) return c.json({ message: "invalid rank" }, 400);
    patch.rank = rank;
  }
  if (body?.parentRef !== undefined) {
    let parentId: string | null = null;
    let depth = 0;
    if (body.parentRef !== null) {
      let parent: typeof labels.$inferSelect | null;
      try {
        parent = await getLabelByRef(access.spaceId, body.parentRef);
      } catch (error) {
        return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
      }
      if (parent?.depth !== 0 || parent.id === label.id) return c.json({ message: "parent label not found" }, 404);
      parentId = parent.id;
      depth = 1;
    }
    const [{ value: childCount } = { value: 0 }] = await db.select({ value: count() }).from(labels).where(eq(labels.parentId, label.id));
    if (depth === 1 && Number(childCount) > 0) return c.json({ message: "label has child labels" }, 400);
    patch.parentId = parentId;
    patch.depth = depth;
  }
  try {
    const [updated] = await db.update(labels).set(patch).where(and(eq(labels.id, label.id), eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, access.spaceId))).returning();
    return c.json({ label: updated });
  } catch (error) {
    if (isUniqueLabelNameViolation(error)) return c.json({ message: "label already exists" }, 409);
    throw error;
  }
});

router.delete("/by-ref", async (c) => {
  const access = await requireSpacePermission(c, "space.label.manage");
  if (access.error) return access.error;
  let label: typeof labels.$inferSelect | null;
  try {
    label = await getLabelByRef(access.spaceId, c.req.query("ref"));
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }
  if (!label) return c.json({ message: "label not found" }, 404);
  if (label.source !== "user") return authzDenied(c);
  const [{ value: childCount } = { value: 0 }] = await db.select({ value: count() }).from(labels).where(and(eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, access.spaceId), eq(labels.parentId, label.id)));
  if (Number(childCount) > 0) return c.json({ message: "delete child labels first" }, 400);
  await db.transaction(async (tx) => {
    await tx.delete(labelAssignments).where(and(eq(labelAssignments.scopeType, SCOPE_TYPE), eq(labelAssignments.scopeId, access.spaceId), eq(labelAssignments.labelId, label.id)));
    await tx.delete(labels).where(and(eq(labels.id, label.id), eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, access.spaceId)));
  });
  return c.json({ ok: true });
});

router.post("/reorder", async (c) => {
  const access = await requireSpacePermission(c, "space.label.manage");
  if (access.error) return access.error;
  const body = await c.req.json<{ labelRefs?: unknown }>().catch(() => null);
  let labelIds: string[];
  try {
    const paths = parseLabelRefs(body?.labelRefs);
    const resolved = await resolveLabelPaths({ db, spaceId: access.spaceId, paths });
    if (resolved.missingPaths.length > 0) return c.json({ message: "label not found" }, 404);
    labelIds = resolved.labelIds;
    const rows = labelIds.length > 0
      ? await db.select({ id: labels.id, source: labels.source }).from(labels).where(and(eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, access.spaceId), inArray(labels.id, labelIds)))
      : [];
    if (rows.length !== labelIds.length || rows.some((label) => label.source !== "user")) return authzDenied(c);
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }
  await db.transaction(async (tx) => {
    for (const [index, labelId] of labelIds.entries()) {
      await tx.update(labels).set({ rank: (index + 1) * 10, updatedAt: new Date() }).where(and(eq(labels.id, labelId), eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, access.spaceId)));
    }
  });
  return c.json({ labels: buildLabelTree(await getScopeLabels(access.spaceId)) });
});

router.get("/items", async (c) => {
  const access = await requireSpacePermission(c, "space.label.view");
  if (access.error) return access.error;
  let label: typeof labels.$inferSelect | null;
  try {
    label = await getLabelByRef(access.spaceId, c.req.query("ref"));
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }
  if (!label) return c.json({ message: "label not found" }, 404);
  const limit = parseItemsLimit(c.req.query("limit"));
  const decodedCursor = decodeItemsCursor(c.req.query("cursor"));
  if (!decodedCursor.ok) return c.json({ message: "invalid cursor" }, 400);
  const cursor = decodedCursor.cursor;
  const system = label.source === "system";
  if (cursor && cursor.type !== (system ? "sessionActivity" : "manual")) return c.json({ message: "invalid cursor" }, 400);
  const input = { spaceId: access.spaceId, user: access.user, labelId: label.id, limit };
  const page = system
    ? await listVisibleSystemLabelItems({ ...input, cursor: cursor?.type === "sessionActivity" ? cursor : null })
    : await listVisibleManualLabelItems({ ...input, cursor: cursor?.type === "manual" ? cursor : null });
  return c.json({ ...page, sessions: await attachActiveTurns(page.sessions) });
});

router.post("/attach", async (c) => {
  const access = await requireSpacePermission(c, "space.label.assign");
  if (access.error) return access.error;
  const body = await c.req.json<{ labelRef?: unknown; resourceType?: string; resourceRef?: string }>().catch(() => null);
  const resourceType = body?.resourceType ?? "";
  const resourceRef = body?.resourceRef?.trim() ?? "";
  if (!resourceRef || !(await validateResource(access.spaceId, resourceType, resourceRef))) return c.json({ message: "resource not found" }, 404);
  let labelIds: string[];
  try {
    const resolved = await resolveRefsWithCreatePermission(c, access, [body?.labelRef]);
    if ("error" in resolved) return resolved.error;
    labelIds = resolved.labelIds;
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }
  const labelId = labelIds[0];
  if (!labelId) return c.json({ message: "label not found" }, 404);
  const label = await getLabelInSpace(access.spaceId, labelId);
  if (label?.source !== "user") return authzDenied(c);
  const [{ value: maxRank } = { value: 0 }] = await db.select({ value: max(labelAssignments.rank) }).from(labelAssignments).where(eq(labelAssignments.labelId, labelId));
  const [assignment] = await db.insert(labelAssignments).values({
    labelId,
    scopeType: SCOPE_TYPE,
    scopeId: access.spaceId,
    resourceType,
    resourceRef,
    rank: Number(maxRank ?? 0) + 10,
    source: "user",
    createdBy: access.user?.uuid ?? null,
  }).onConflictDoNothing().returning();
  if (assignment) {
    await dispatchLabelAssignmentsUpdated({
      spaceId: access.spaceId,
      resourceType: resourceType as "session" | "checkpoint" | "file",
      resourceRef,
      sessionId: resourceType === "session" ? resourceRef : null,
      affectedLabelIds: [labelId],
    }).catch(() => undefined);
    return c.json({ assignment }, 201);
  }
  const [existing] = await db.select().from(labelAssignments).where(and(eq(labelAssignments.labelId, labelId), eq(labelAssignments.resourceType, resourceType), eq(labelAssignments.resourceRef, resourceRef))).limit(1);
  if (existing) {
    await dispatchLabelAssignmentsUpdated({
      spaceId: access.spaceId,
      resourceType: resourceType as "session" | "checkpoint" | "file",
      resourceRef,
      sessionId: resourceType === "session" ? resourceRef : null,
      affectedLabelIds: [labelId],
    }).catch(() => undefined);
  }
  return c.json({ assignment: existing }, existing ? 200 : 409);
});

router.post("/detach", async (c) => {
  const access = await requireSpacePermission(c, "space.label.assign");
  if (access.error) return access.error;
  const body = await c.req.json<{ labelRef?: unknown; resourceType?: string; resourceRef?: string }>().catch(() => null);
  const resourceType = body?.resourceType ?? "";
  const resourceRef = body?.resourceRef?.trim() ?? "";
  if (!resourceRef || !RESOURCE_TYPES.has(resourceType)) return c.json({ message: "resource not found" }, 404);
  let label: typeof labels.$inferSelect | null;
  try {
    label = await getLabelByRef(access.spaceId, body?.labelRef);
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }
  if (!label) return c.json({ message: "label not found" }, 404);
  if (label.source !== "user") return authzDenied(c);
  await db.delete(labelAssignments).where(and(eq(labelAssignments.labelId, label.id), eq(labelAssignments.scopeType, SCOPE_TYPE), eq(labelAssignments.scopeId, access.spaceId), eq(labelAssignments.resourceType, resourceType), eq(labelAssignments.resourceRef, resourceRef)));
  await dispatchLabelAssignmentsUpdated({
    spaceId: access.spaceId,
    resourceType: resourceType as "session" | "checkpoint" | "file",
    resourceRef,
    sessionId: resourceType === "session" ? resourceRef : null,
    affectedLabelIds: [label.id],
  }).catch(() => undefined);
  return c.json({ ok: true });
});

export async function getResourceLabels(c: Context) {
  const access = await requireSpacePermission(c, "space.label.view");
  if (access.error) return access.error;
  const resourceType = c.req.param("resourceType") ?? "";
  const resourceRef = c.req.query("resourceRef")?.trim() ?? "";
  if (!resourceRef || !RESOURCE_TYPES.has(resourceType)) return c.json({ message: "resource not found" }, 404);
  if (resourceType === "file" && !isSafeFilePath(resourceRef)) return c.json({ message: "resource not found" }, 404);
  return c.json(await getResourceLabelResponse(access.spaceId, resourceType, resourceRef));
}

export async function patchResourceLabels(c: Context) {
  const access = await requireSpacePermission(c, "space.label.assign");
  if (access.error) return access.error;
  const resourceType = c.req.param("resourceType") ?? "";
  const resourceRef = c.req.query("resourceRef")?.trim() ?? "";
  if (!resourceRef || !(await validateResource(access.spaceId, resourceType, resourceRef))) return c.json({ message: "resource not found" }, 404);
  const body = await c.req.json<{ addLabelRefs?: unknown; removeLabelRefs?: unknown }>().catch(() => undefined);
  if (!body) return c.json({ message: "invalid json body" }, 400);

  let addLabelIds: string[];
  let removeLabelIds: string[];
  try {
    const addResolved = await resolveRefsWithCreatePermission(c, access, body?.addLabelRefs ?? []);
    if ("error" in addResolved) return addResolved.error;
    const removeResolved = await resolveExistingRefs(access.spaceId, body?.removeLabelRefs ?? []);
    const addUserLabels = await getUserLabelIds(c, access.spaceId, addResolved.labelIds);
    if ("error" in addUserLabels) return addUserLabels.error;
    const removeUserLabels = await getUserLabelIds(c, access.spaceId, removeResolved.labelIds);
    if ("error" in removeUserLabels) return removeUserLabels.error;
    addLabelIds = addUserLabels.labelIds;
    removeLabelIds = removeUserLabels.labelIds;
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }

  const existing = await db.select().from(labelAssignments).where(and(eq(labelAssignments.scopeType, SCOPE_TYPE), eq(labelAssignments.scopeId, access.spaceId), eq(labelAssignments.resourceType, resourceType), eq(labelAssignments.resourceRef, resourceRef))).orderBy(sql`${labelAssignments.rank} asc nulls last`, asc(labelAssignments.createdAt), asc(labelAssignments.id));
  const removeSet = new Set(removeLabelIds);
  const nextUserLabelIds = existing
    .filter((assignment) => assignment.source === "user" && !removeSet.has(assignment.labelId))
    .map((assignment) => assignment.labelId);
  for (const labelId of addLabelIds) {
    if (!nextUserLabelIds.includes(labelId)) nextUserLabelIds.push(labelId);
  }
  const nextSet = new Set(nextUserLabelIds);
  const removeAssignmentIds = existing
    .filter((assignment) => assignment.source === "user" && removeSet.has(assignment.labelId) && !nextSet.has(assignment.labelId))
    .map((assignment) => assignment.id);
  const existingByLabelId = new Map(existing.map((assignment) => [assignment.labelId, assignment]));
  const changed = removeAssignmentIds.length > 0 || nextUserLabelIds.some((labelId, index) => {
    const existingAssignment = existingByLabelId.get(labelId);
    return !existingAssignment || existingAssignment.rank !== (index + 1) * 10;
  });

  await db.transaction(async (tx) => {
    if (removeAssignmentIds.length > 0) await tx.delete(labelAssignments).where(inArray(labelAssignments.id, removeAssignmentIds));
    for (const [index, labelId] of nextUserLabelIds.entries()) {
      const rank = (index + 1) * 10;
      const existingAssignment = existingByLabelId.get(labelId);
      if (existingAssignment) {
        if (existingAssignment.rank !== rank) await tx.update(labelAssignments).set({ rank, updatedAt: new Date() }).where(eq(labelAssignments.id, existingAssignment.id));
        continue;
      }
      await tx.insert(labelAssignments).values({
        labelId,
        scopeType: SCOPE_TYPE,
        scopeId: access.spaceId,
        resourceType,
        resourceRef,
        rank,
        source: "user",
        createdBy: access.user?.uuid ?? null,
      }).onConflictDoNothing();
    }
  });

  const affectedLabelIds = Array.from(new Set([...addLabelIds, ...removeLabelIds]));
  const result = await getResourceLabelResponse(access.spaceId, resourceType, resourceRef);
  await dispatchLabelAssignmentsUpdated({
    spaceId: access.spaceId,
    resourceType: resourceType as "session" | "checkpoint" | "file",
    resourceRef,
    sessionId: resourceType === "session" ? resourceRef : null,
    affectedLabelIds,
  }).catch(() => undefined);
  return c.json({ ...result, changed });
}

export async function setResourceLabels(c: Context) {
  const access = await requireSpacePermission(c, "space.label.assign");
  if (access.error) return access.error;
  const resourceType = c.req.param("resourceType") ?? "";
  const resourceRef = c.req.query("resourceRef")?.trim() ?? "";
  if (!resourceRef || !(await validateResource(access.spaceId, resourceType, resourceRef))) return c.json({ message: "resource not found" }, 404);
  const body = await c.req.json<{ labelRefs?: unknown }>().catch(() => undefined);
  if (!body) return c.json({ message: "invalid json body" }, 400);
  let labelIds: string[];
  try {
    const resolved = await resolveRefsWithCreatePermission(c, access, body?.labelRefs ?? []);
    if ("error" in resolved) return resolved.error;
    labelIds = resolved.labelIds;
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }
  const resolvedLabels = labelIds.length > 0
    ? await db.select().from(labels).where(and(eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, access.spaceId), inArray(labels.id, labelIds)))
    : [];
  const userLabelIds = resolvedLabels.filter((label) => label.source === "user").map((label) => label.id);
  const existing = await db.select().from(labelAssignments).where(and(eq(labelAssignments.scopeType, SCOPE_TYPE), eq(labelAssignments.scopeId, access.spaceId), eq(labelAssignments.resourceType, resourceType), eq(labelAssignments.resourceRef, resourceRef)));
  const preservedSystemLabelIds = existing.filter((assignment) => assignment.source === "system").map((assignment) => assignment.labelId);
  const wanted = new Set([...userLabelIds, ...preservedSystemLabelIds]);
  const existingIds = new Set(existing.map((assignment) => assignment.labelId));
  const affectedLabelIds = Array.from(new Set([...existingIds, ...userLabelIds]));
  const removeIds = existing.filter((assignment) => assignment.source !== "system" && !wanted.has(assignment.labelId)).map((assignment) => assignment.id);
  const existingByLabelId = new Map(existing.map((assignment) => [assignment.labelId, assignment]));
  const addIds = userLabelIds.filter((labelId) => !existingIds.has(labelId));
  await db.transaction(async (tx) => {
    if (removeIds.length > 0) await tx.delete(labelAssignments).where(inArray(labelAssignments.id, removeIds));
    for (const [index, labelId] of userLabelIds.entries()) {
      const rank = (index + 1) * 10;
      const existingAssignment = existingByLabelId.get(labelId);
      if (existingAssignment) {
        if (existingAssignment.rank !== rank) {
          await tx.update(labelAssignments).set({ rank, updatedAt: new Date() }).where(eq(labelAssignments.id, existingAssignment.id));
        }
        continue;
      }
      if (!addIds.includes(labelId)) continue;
      await tx.insert(labelAssignments).values({
        labelId,
        scopeType: SCOPE_TYPE,
        scopeId: access.spaceId,
        resourceType,
        resourceRef,
        rank,
        source: "user",
        createdBy: access.user?.uuid ?? null,
      }).onConflictDoNothing();
    }
  });
  const result = await getResourceLabelResponse(access.spaceId, resourceType, resourceRef);
  await dispatchLabelAssignmentsUpdated({
    spaceId: access.spaceId,
    resourceType: resourceType as "session" | "checkpoint" | "file",
    resourceRef,
    sessionId: resourceType === "session" ? resourceRef : null,
    affectedLabelIds,
  }).catch(() => undefined);
  return c.json(result);
}

export default router;
