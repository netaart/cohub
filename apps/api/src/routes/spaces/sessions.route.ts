import { Hono } from "hono";
import { isUuid } from "@cohub/protocol";
import { db } from "../../db/index.js";
import { spaceSessions } from "@cohub/db";
import { eq } from "drizzle-orm";
import { useAuth, getOptionalAuth, requireValidId, authzDenied } from "../../lib/middleware.js";
import {
  createInitialSpaceSession,
  getSpaceById,
  getSpaceSessionById,
  hydrateSessionParticipantProfiles,
  InvalidSessionListCursorError,
  listSpaceSessions,
  listSpaceSessionsByIds,
} from "../../space-sessions.js";
import { parseSessionArchiveFilter } from "@cohub/core/labels";
import { hasPermission, getSpaceMemberRole, filterSessionsByPermission } from "../../permissions.js";
import { resolveSessionTurnOrigin } from "@cohub/core/sessions";
import { InvalidSpaceTurnListQueryError, listSpaceTurns } from "../../space-turns.js";
import { listSessionForksForSessions } from "../../session-forks.js";
import { redactSessionForksForViewer } from "../../session-fork-visibility.js";
import { getRequestSource, resolveSessionSourceFromRequest } from "../../lib/request-source.js";
import { applySessionLabels, resolveLabelRefIds } from "./session-labels.js";

const router = new Hono();

const SESSION_IDS_LIMIT = 100;

router.post("/:id/sessions", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "session.prompt.fullaccess", { spaceId }))) return authzDenied(c);

  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);

  let body: { title?: string | null; source?: string | null; labelRefs?: unknown };
  try {
    body = await c.req.json<{ title?: string | null; source?: string | null; labelRefs?: unknown }>();
  } catch {
    return c.json({ message: "invalid json body" }, 400);
  }

  const userLabelIds = await resolveLabelRefIds(c, user, spaceId, null, body.labelRefs);
  if (userLabelIds instanceof Response) return userLabelIds;

  const source = resolveSessionSourceFromRequest(c, body.source);
  const requestSource = getRequestSource(c);
  const origin = await resolveSessionTurnOrigin(db, requestSource, "prompt",
    (scope) => hasPermission(user, "session.view", scope));
  const session = await createInitialSpaceSession({
    spaceId: space.id,
    sessionId: crypto.randomUUID(),
    userUuid: user.uuid,
    title: body.title ?? null,
    source,
    externalSessionId: null,
    meta: { createdBy: "api_space_session_create", ...(requestSource ? { requestSource } : {}), ...(origin ? { origin } : {}) },
  });

  await applySessionLabels({ spaceId, sessionId: session.id, labelIds: userLabelIds, userId: user.uuid });

  return c.json({ ok: true, session });
});

router.get("/:id/turns", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId }))) return authzDenied(c);

  const sessionId = c.req.query("sessionId")?.trim() || null;
  if (sessionId && !requireValidId(sessionId)) return c.json({ message: "invalid sessionId" }, 400);

  const isMember = user?.uuid
    ? (await getSpaceMemberRole(spaceId, user.uuid)) !== null
    : false;
  let accessibleSessionIds: string[] | null = null;
  if (!isMember) {
    const sessions = sessionId
      ? [await getSpaceSessionById(sessionId)].filter(
        (session): session is NonNullable<typeof session> => session?.spaceId === spaceId,
      )
      : await db.select().from(spaceSessions).where(eq(spaceSessions.spaceId, spaceId));
    const visibleSessions = await filterSessionsByPermission(user, "session.view", spaceId, sessions);
    accessibleSessionIds = visibleSessions.map((session) => session.id);
  }

  const rawLimit = c.req.query("limit");
  try {
    return c.json(await listSpaceTurns({
      spaceId,
      userUuid: user?.uuid ?? null,
      author: (c.req.query("author") ?? "any") as "any" | "self" | "others",
      after: c.req.query("after") ?? null,
      before: c.req.query("before") ?? null,
      cursor: c.req.query("cursor") ?? null,
      limit: rawLimit === undefined ? undefined : Number(rawLimit),
      sessionId,
      accessibleSessionIds,
    }));
  } catch (error) {
    if (error instanceof InvalidSpaceTurnListQueryError) {
      return c.json({ message: error.message }, 400);
    }
    throw error;
  }
});

router.get("/:id/sessions", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId }))) return authzDenied(c);

  const ids = c.req.query("ids")?.split(",").filter(Boolean);
  if (ids && (ids.length > SESSION_IDS_LIMIT || !ids.every(isUuid))) {
    return c.json({ message: `ids must be at most ${SESSION_IDS_LIMIT} session ids` }, 400);
  }
  const limitParam = Number(c.req.query("limit") ?? 20);
  const limit = Number.isFinite(limitParam) ? limitParam : 20;
  const cursor = c.req.query("cursor") ?? null;
  const archive = parseSessionArchiveFilter(c.req.query("archived"));
  if (!archive) return c.json({ message: "archived must be one of: exclude, only, include" }, 400);
  let sessions: Awaited<ReturnType<typeof listSpaceSessions>>["sessions"];
  let pageInfo: Awaited<ReturnType<typeof listSpaceSessions>>["pageInfo"];
  try {
    ({ sessions, pageInfo } = ids
      ? { sessions: await listSpaceSessionsByIds(spaceId, ids), pageInfo: { hasMore: false, nextCursor: null } }
      : await listSpaceSessions(spaceId, { limit, cursor, archive }));
  } catch (error) {
    if (error instanceof InvalidSessionListCursorError) {
      return c.json({ message: "invalid cursor" }, 400);
    }
    throw error;
  }

  // Member users have space-level permission that covers all sessions.
  // Only non-members need per-session accessPolicy checks.
  const isMember = user?.uuid
    ? (await getSpaceMemberRole(spaceId, user.uuid)) !== null
    : false;
  const visibleSessions = isMember
    ? sessions
    : await filterSessionsByPermission(user, "session.view", spaceId, sessions);

  const hydratedSessions = await hydrateSessionParticipantProfiles(visibleSessions);

  const includeForks = c.req.query("includeForks") === "1" || c.req.query("includeForks") === "true";
  const forks = includeForks
    ? redactSessionForksForViewer(
      await listSessionForksForSessions(visibleSessions.map((session) => session.id)),
      { isMember, visibleSessionIds: visibleSessions.map((session) => session.id) },
    )
    : undefined;

  return c.json({ sessions: hydratedSessions, ...(forks ? { forks } : {}), pageInfo });
});

export default router;
