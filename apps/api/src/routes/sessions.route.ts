import { createLogger } from "@cohub/infra/logging";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { hasPermission } from "../permissions.js";
import { getOptionalAuth, useAuth, requireValidId, authzDenied } from "../lib/middleware.js";
import {
  attachActiveTurns,
  getSpaceById,
  getSpaceSessionById,
  getSessionMessageById,
  hydrateSessionParticipantProfiles,
  listSessionMessages,
  enqueueSessionAbort,
  enqueueSessionFork,
  updateSpaceSessionInfo,
} from "../space-sessions.js";
import { markMessageAsFull, summarizeMessageForHistory } from "../session-content.js";
import { createSignedTurnUrls, findLatestVisibleAgentEntryId, getSessionTurnById, getSessionTurnSequenceById, hydrateTurnAuthorProfiles, listSessionTurnIndex, listSessionTurns, listSessionTurnWindow } from "../session-turns.js";
import { clearSessionStreamSnapshot, getSessionStreamSnapshot } from "../session-stream-snapshot.js";
import { createSessionFork, listSessionForksForSessions } from "../session-forks.js";
import { dispatchLabelAssignmentsUpdated } from "../realtime-events.js";
import { buildSessionTurnResponse } from "../session-turn-response.js";
import { parseSessionTitleInput } from "../session-title-input.js";
import { isNativeClientTurn } from "@cohub/protocol";
import { getSessionRuntimeTurn } from "../runtime.js";


const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();

router.post("/:id/turns/:turnId/fork", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const sessionId = c.req.param("id");
  const turnId = c.req.param("turnId");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);
  if (!turnId || !requireValidId(turnId)) return c.json({ message: "turn not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.edit", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }

  const sourceTurn = await getSessionTurnById(session.id, turnId);
  if (!sourceTurn) return c.json({ message: "turn not found" }, 404);
  if (sourceTurn.executionKind === "direct_generation" && !["completed", "failed", "interrupted", "cancelled"].includes(sourceTurn.status)) {
    return c.json({ message: "cannot fork a running turn" }, 400);
  }
  const sourceTurnId = sourceTurn.sourceTurnId ?? sourceTurn.id;

  const body = await c.req.json<{ title?: string | null }>().catch((): { title?: string | null } => ({}));
  const anchorEntryId = await findLatestVisibleAgentEntryId(session.id, sourceTurn.sequence);
  if (!anchorEntryId && !["completed", "failed", "interrupted", "cancelled", "merged"].includes(sourceTurn.status)) {
    return c.json({ message: "cannot fork an unfinished turn without a durable context boundary" }, 400);
  }

  try {
    const { session: childSession, fork } = await createSessionFork({
      spaceId: session.spaceId,
      childSessionId: randomUUID(),
      parentSessionId: session.id,
      turnId: sourceTurnId,
      sequence: sourceTurn.sequence,
      title: body.title,
      createdBy: user.uuid,
    });
    // Notify clients so they proactively cache the inherited labels.
    dispatchLabelAssignmentsUpdated({
      spaceId: session.spaceId,
      resourceType: "session",
      resourceRef: childSession.id,
      sessionId: childSession.id,
    }).catch((error) => {
      logger.warn("[SessionFork] failed to dispatch label assignments updated", error);
    });
    try {
      await enqueueSessionFork({
        spaceId: session.spaceId,
        sessionId: childSession.id,
        parentSessionId: session.id,
        anchorTurnId: sourceTurnId,
        anchorSequence: sourceTurn.sequence,
        anchorEntryId,
      });
    } catch (enqueueError) {
      logger.error("[SessionFork] failed to enqueue agent fork", enqueueError);
      return c.json({ message: "failed to prepare fork session" }, 503);
    }
    const [hydratedChildSession] = await hydrateSessionParticipantProfiles([childSession]);
    const [enrichedFork] = await listSessionForksForSessions([childSession.id]);
    return c.json({ session: hydratedChildSession ?? childSession, fork: enrichedFork ?? fork });
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message.toLowerCase().replace(/\.$/, "") : "failed to fork session" }, 400);
  }
});

router.get("/:id", async (c) => {
  const user = getOptionalAuth(c);
  const sessionId = c.req.param("id");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }

  const space = await getSpaceById(session.spaceId);
  if (!space) return c.json({ message: "session not found" }, 404);

  const [hydratedSession] = await hydrateSessionParticipantProfiles([session]);
  const [sessionWithActiveTurn] = await attachActiveTurns([hydratedSession ?? session]);
  return c.json({ space, session: sessionWithActiveTurn ?? hydratedSession ?? session, user });
});

// ── PATCH /api/sessions/:id (rename) ─────────────────────────────────────────

router.patch("/:id", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const sessionId = c.req.param("id");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.edit", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }

  const input = parseSessionTitleInput(await c.req.json<unknown>().catch(() => null));
  if (!input.success) return c.json({ message: "title must be a string or null" }, 400);

  await updateSpaceSessionInfo({ spaceId: session.spaceId, sessionId: session.id, title: input.title });

  const refreshed = await getSpaceSessionById(sessionId);
  const [hydratedSession] = await hydrateSessionParticipantProfiles([refreshed ?? session]);
  const [sessionWithActiveTurn] = await attachActiveTurns([hydratedSession ?? refreshed ?? session]);
  return c.json({ session: sessionWithActiveTurn ?? hydratedSession ?? refreshed ?? session });
});

router.get("/:id/turns", async (c) => {
  const user = getOptionalAuth(c);
  const sessionId = c.req.param("id");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }

  const cursorParam = c.req.query("cursor");
  let cursor = cursorParam ? Number(cursorParam) : undefined;
  if (cursor !== undefined && (!Number.isFinite(cursor) || cursor < 1)) return c.json({ message: "invalid cursor" }, 400);
  cursor = cursor === undefined ? undefined : Math.floor(cursor);
  const rawLimit = Number(c.req.query("limit") ?? 30);
  if (!Number.isFinite(rawLimit)) return c.json({ message: "invalid limit" }, 400);
  const pageLimit = Math.min(Math.max(Math.floor(rawLimit), 1), 100);
  const directionParam = c.req.query("direction") ?? "older";
  if (directionParam !== "older" && directionParam !== "newer") return c.json({ message: "invalid direction" }, 400);
  const direction = directionParam;
  const fetchLimit = Math.min(pageLimit + 1, 101);
  const rows = await listSessionTurns(session.id, { cursor, limit: fetchLimit, direction });
  const hasMore = rows.length > pageLimit;
  const pageTurns = hasMore ? (direction === "newer" ? rows.slice(0, pageLimit) : rows.slice(1)) : rows;
  const turns = await hydrateTurnAuthorProfiles(pageTurns);
  return c.json({
    session,
    turns,
    hasMore,
    nextCursor: turns.length > 0
      ? direction === "older"
        ? turns[0]?.sequence
        : turns[turns.length - 1]?.sequence
      : undefined,
  });
});

router.get("/:id/turns/index", async (c) => {
  const user = getOptionalAuth(c);
  const sessionId = c.req.param("id");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }

  const cursorParam = c.req.query("cursor");
  let cursor = cursorParam ? Number(cursorParam) : undefined;
  if (cursor !== undefined && (!Number.isFinite(cursor) || cursor < 1)) return c.json({ message: "invalid cursor" }, 400);
  cursor = cursor === undefined ? undefined : Math.floor(cursor);
  const rawLimit = Number(c.req.query("limit") ?? 200);
  if (!Number.isFinite(rawLimit)) return c.json({ message: "invalid limit" }, 400);
  const limit = Math.min(Math.max(Math.floor(rawLimit), 1), 500);
  const result = await listSessionTurnIndex(session.id, { cursor, limit });
  return c.json({ session, ...result });
});

router.get("/:id/turns/window", async (c) => {
  const user = getOptionalAuth(c);
  const sessionId = c.req.param("id");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }

  const turnId = c.req.query("turnId");
  let sequence = c.req.query("sequence") ? Number(c.req.query("sequence")) : undefined;
  if (turnId) {
    if (!requireValidId(turnId)) return c.json({ message: "invalid turn id" }, 400);
    const found = await getSessionTurnSequenceById(session.id, turnId);
    if (found == null) return c.json({ message: "turn not found" }, 404);
    sequence = found;
  }
  if (sequence === undefined || !Number.isFinite(sequence) || sequence < 1) return c.json({ message: "invalid sequence" }, 400);
  const before = Number(c.req.query("before") ?? 10);
  const after = Number(c.req.query("after") ?? 20);
  if (!Number.isFinite(before) || !Number.isFinite(after)) return c.json({ message: "invalid window" }, 400);
  const result = await listSessionTurnWindow(session.id, { sequence: Math.floor(sequence), before, after });
  if (!result) return c.json({ message: "turn not found" }, 404);
  return c.json({ session, ...result, turns: await hydrateTurnAuthorProfiles(result.turns) });
});

router.get("/:id/turns/stream-snapshot", async (c) => {
  const user = getOptionalAuth(c);
  const sessionId = c.req.param("id");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }

  const snapshot = await getSessionStreamSnapshot({ spaceId: session.spaceId, sessionId: session.id });
  if (snapshot?.turnId) {
    const turn = await getSessionTurnById(session.id, snapshot.turnId);
    if (!turn || (turn.status !== "running" && turn.status !== "abort_requested")) {
      await clearSessionStreamSnapshot({ spaceId: session.spaceId, sessionId: session.id, turnId: snapshot.turnId });
      return c.json({ snapshot: null });
    }
  }

  return c.json({ snapshot });
});

router.get("/:id/turns/:turnId", async (c) => {
  const user = getOptionalAuth(c);
  const sessionId = c.req.param("id");
  const turnId = c.req.param("turnId");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);
  if (!turnId || !requireValidId(turnId)) return c.json({ message: "turn not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }

  const response = await buildSessionTurnResponse(session, turnId);
  if (!response) return c.json({ message: "turn not found" }, 404);
  return c.json(response);
});

router.post("/:id/turns/:turnId/signed-urls", async (c) => {
  const user = getOptionalAuth(c);
  const sessionId = c.req.param("id");
  const turnId = c.req.param("turnId");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);
  if (!turnId || !requireValidId(turnId)) return c.json({ message: "turn not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }
  const turn = await getSessionTurnById(session.id, turnId);
  if (!turn) return c.json({ message: "turn not found" }, 404);

  const body = await c.req.json<{ objectKeys?: string[] }>().catch(() => null);
  const objectKeys = Array.isArray(body?.objectKeys) ? body.objectKeys.filter((key): key is string => typeof key === "string") : [];
  if (objectKeys.length === 0 || objectKeys.length > 50) return c.json({ message: "objectKeys is required" }, 400);
  let urls: Awaited<ReturnType<typeof createSignedTurnUrls>>;
  try {
    urls = await createSignedTurnUrls({ spaceId: session.spaceId, sessionId: session.id, turnId, objectKeys });
  } catch {
    return c.json({ message: "invalid object key" }, 400);
  }
  return c.json({ urls });
});

router.get("/:id/messages", async (c) => {
  const user = getOptionalAuth(c);
  const sessionId = c.req.param("id");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }

  const cursorParam = c.req.query("cursor");
  const cursor = cursorParam ? Number(cursorParam) : undefined;
  const pageLimit = Math.min(Number(c.req.query("limit") ?? 30), 100) || 30;
  const direction = (c.req.query("direction") as "older" | "newer" | undefined) ?? "older";
  const detail = c.req.query("detail") === "full" ? "full" : "summary";

  // Always fetch +1 sentinel to correctly detect hasMore.
  // The sentinel position depends on the query direction:
  //   - Initial load (no cursor) or "older": sentinel is the oldest (index 0)
  //   - "newer": sentinel is the newest (last element)
  const fetchLimit = Math.min(pageLimit + 1, 101);

  const rows = await listSessionMessages(session.id, {
    cursor,
    limit: fetchLimit,
    direction,
  });
  const hasMore = rows.length > pageLimit;
  const pageMessages = hasMore
    ? (direction === "newer" ? rows.slice(0, -1) : rows.slice(1))
    : rows;
  const messages = detail === "full"
    ? pageMessages.map(markMessageAsFull)
    : pageMessages.map((message) => summarizeMessageForHistory(message));

  return c.json({
    session,
    messages,
    hasMore,
    nextCursor: pageMessages.length > 0
      ? direction === "older"
        ? (pageMessages[0]?.sequence ?? 0) - 1
        : (pageMessages[pageMessages.length - 1]?.sequence ?? 0)
      : undefined,
  });
});

router.get("/:id/messages/:messageId", async (c) => {
  const user = getOptionalAuth(c);
  const sessionId = c.req.param("id");
  const messageId = c.req.param("messageId");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);
  if (!messageId || !requireValidId(messageId)) return c.json({ message: "message not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }

  const message = await getSessionMessageById(session.id, messageId);
  if (!message) return c.json({ message: "message not found" }, 404);
  const detail = c.req.query("detail") === "summary" ? "summary" : "full";

  return c.json({
    session,
    message: detail === "summary"
      ? summarizeMessageForHistory(message, { placeholderIntermediate: false })
      : markMessageAsFull(message),
  });
});

router.post("/:id/abort", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const sessionId = c.req.param("id");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.prompt.fullaccess", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }

  const body = await c.req.json<{ turnId?: string | null }>().catch(() => null);
  const turnId = body?.turnId?.trim() || null;
  if (turnId && !requireValidId(turnId)) return c.json({ message: "invalid turn id" }, 400);
  const target = turnId ? await getSessionTurnById(session.id, turnId) : await getSessionRuntimeTurn(session.spaceId, session.id);
  if (target && isNativeClientTurn(target.meta) && (target.meta as { harness?: string }).harness === "codex" && ["running", "abort_requested"].includes(target.status)) {
    return c.json({ message: "Stop this native Codex run in its terminal / 请在终端中停止此原生 Codex 任务" }, 409);
  }

  await enqueueSessionAbort({
    sessionId: session.id,
    actorUserId: user.uuid,
    turnId,
  });

  return c.json({ ok: true });
});

export default router;
