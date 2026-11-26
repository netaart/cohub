import { Hono, type Context } from "hono";
import { authzDenied, getAppSessionPrincipal, requireValidId } from "../lib/middleware.js";
import {
  AppRoomOptionsError,
  appRoomOptionsErrorStatus,
  createAppRoom,
  createAppRoomAdmission,
  createAppRoomInvite,
  getAppRoomByCode,
  getAppRoomById,
  verifyAppRoomTicket,
} from "../app-rooms.js";
import { getAppById } from "./app-content.js";

const appRoomErrorResponse = (c: Context, error: unknown) => {
  if (!(error instanceof AppRoomOptionsError)) return c.json({ message: "failed to create realtime room" }, 503);
  return c.json({ code: error.code, message: error.message }, appRoomOptionsErrorStatus(error));
};

const getPublishedAppForRoom = async (c: Context, appId: string) => {
  const principal = getAppSessionPrincipal(c);
  if (!principal || principal.appId !== appId) return null;
  const app = await getAppById(appId);
  if (app?.status !== "published" || app.spaceId !== principal.spaceId) return null;
  return { principal, app };
};

export function createAppRealtimeRouter(): Hono {
  const router = new Hono();

router.post("/:id/realtime/rooms", async (c) => {
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "app not found" }, 404);
  const context = await getPublishedAppForRoom(c, id);
  if (!context) return authzDenied(c);
  const body = await c.req.json().catch(() => null) as {
    code?: unknown;
    expiresInSeconds?: unknown;
    maxParticipants?: unknown;
    seatPerUser?: unknown;
  } | null;
  try {
    const room = await createAppRoom({
      appId: id,
      code: body?.code,
      expiresInSeconds: body?.expiresInSeconds,
      maxParticipants: body?.maxParticipants,
      seatPerUser: body?.seatPerUser,
    });
    return c.json(createAppRoomAdmission({ userUuid: context.principal.userUuid, room }));
  } catch (error) {
    return appRoomErrorResponse(c, error);
  }
});

router.post("/:id/realtime/rooms/join", async (c) => {
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "app not found" }, 404);
  const context = await getPublishedAppForRoom(c, id);
  if (!context) return authzDenied(c);
  const body = await c.req.json().catch(() => null) as { code?: unknown } | null;
  const room = await getAppRoomByCode(id, body?.code);
  if (!room || room.appId !== id) return c.json({ code: "ROOM_NOT_FOUND", message: "room not found" }, 404);
  try {
    return c.json(createAppRoomAdmission({ userUuid: context.principal.userUuid, room }));
  } catch (error) {
    return appRoomErrorResponse(c, error);
  }
});

router.post("/:id/realtime/rooms/:roomId/invites", async (c) => {
  const id = c.req.param("id");
  const roomId = c.req.param("roomId");
  if (!requireValidId(id) || !requireValidId(roomId)) return c.json({ code: "ROOM_NOT_FOUND", message: "room not found" }, 404);
  const context = await getPublishedAppForRoom(c, id);
  if (!context) return authzDenied(c);
  const body = await c.req.json().catch(() => null) as { ticket?: unknown; expiresInSeconds?: unknown } | null;
  const ticket = typeof body?.ticket === "string" ? verifyAppRoomTicket(body.ticket) : null;
  if (!ticket || ticket.appId !== id || ticket.roomId !== roomId || ticket.userUuid !== context.principal.userUuid) {
    return c.json({ code: "ROOM_FORBIDDEN", message: "join the room before inviting" }, 403);
  }
  const seconds = body?.expiresInSeconds === undefined ? undefined : Number(body.expiresInSeconds);
  if (seconds !== undefined && (!Number.isInteger(seconds) || seconds < 60)) {
    return c.json({ code: "INVALID_REQUEST", message: "expiresInSeconds must be an integer of at least 60" }, 400);
  }
  const room = await getAppRoomById(roomId);
  if (!room || room.appId !== id) return c.json({ code: "ROOM_EXPIRED", message: "room expired" }, 410);
  return c.json(createAppRoomInvite(room, seconds));
});

  return router;
}
