import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AppRtcError, type AppRtcService } from "@cohub/core/app-rtc";
import {
  appRtcAnswerRequestSchema,
  appRtcMediaUpdateRequestSchema,
  appRtcOpenRequestSchema,
  appRtcPublishRequestSchema,
  appRtcSubscribeRequestSchema,
  appRtcUnpublishRequestSchema,
  appRtcUnsubscribeRequestSchema,
  RTC_SDP_MAX,
} from "@cohub/protocol/rtc";
import type * as z from "zod";
import { getAppRoomById, verifyAppRoomTicket, deriveAppRoomUserKey } from "../app-rooms.js";
import { resolveHostedCaller, requireSeat, HostedRoomError } from "../app-room-seats.js";
import { authzDenied, getAppSessionPrincipal, requireValidId } from "../lib/middleware.js";

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const rtcBodyLimit = bodyLimit({
  maxSize: RTC_SDP_MAX + 16 * 1024,
  onError: (c) => c.json({ code: "RTC_BAD_REQUEST", message: "request body is too large" }, 413),
});

type RtcContext = {
  caller: { appId: string; userUuid: string; participantId?: string };
  userKey?: string;
  spaceId: string;
  roomId: string;
};

export type AppRtcRouterDeps = {
  service: AppRtcService;
  loadApp(appId: string): Promise<{ status: string; spaceId: string } | null>;
};

async function readBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T> | Response> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ code: "RTC_BAD_REQUEST", message: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
  return parsed.data;
}

const sessionIdOf = (c: Context) => {
  const sessionId = c.req.param("sessionId");
  return sessionId && SESSION_ID_RE.test(sessionId) ? sessionId : null;
};

const rtcError = (c: Context, error: unknown) => {
  if (error instanceof AppRtcError) {
    return c.json({ code: error.code, message: error.message }, error.status as never);
  }
  throw error;
};

export function createAppRtcRouter(deps: AppRtcRouterDeps, hosted = false): Hono {
  const router = new Hono();
  const base = hosted ? "/:roomId/rtc" : "/:id/realtime/rooms/:roomId/rtc";
  const appRtc = deps.service;

  async function resolveCaller(c: Context): Promise<RtcContext | Response> {
    const appId = c.req.param("id");
    const roomId = c.req.param("roomId");
    if (hosted) {
      if (!roomId || !requireValidId(roomId)) return c.json({ code: "ROOM_NOT_FOUND", message: "room not found" }, 404);
      const caller = await resolveHostedCaller(c);
      if (caller instanceof Response) return caller;
      try {
        const seat = await requireSeat(roomId, caller);
        const room = await getAppRoomById(roomId);
        const app = room ? await deps.loadApp(room.appId) : null;
        if (!room || app?.status !== "published") return authzDenied(c);
        return { caller: { appId: room.appId, userUuid: caller.userUuid, participantId: seat.participantId }, userKey: deriveAppRoomUserKey(roomId, caller.userUuid), spaceId: app.spaceId, roomId };
      } catch (error) {
        if (!(error instanceof HostedRoomError)) throw error;
        return c.json({ code: "RTC_FORBIDDEN", message: "an active room seat is required" }, 403);
      }
    }
    if (!appId || !roomId || !requireValidId(appId) || !requireValidId(roomId)) return c.json({ message: "not found" }, 404);
    const principal = getAppSessionPrincipal(c);
    if (!principal || principal.appId !== appId) return authzDenied(c);
    const app = await deps.loadApp(appId);
    if (app?.status !== "published" || app.spaceId !== principal.spaceId) return authzDenied(c);
    return { caller: { appId, userUuid: principal.userUuid }, spaceId: app.spaceId, roomId };
  }

  router.post(base, rtcBodyLimit, async (c) => {
    const context = await resolveCaller(c);
    if (context instanceof Response) return context;
    const body = await readBody(c, appRtcOpenRequestSchema);
    if (body instanceof Response) return body;
    const ticket = hosted ? null : verifyAppRoomTicket(body.ticket);
    if (!hosted && (
      !ticket ||
      ticket.appId !== context.caller.appId ||
      ticket.roomId !== context.roomId ||
      ticket.userUuid !== context.caller.userUuid
    )) return c.json({ code: "RTC_FORBIDDEN", message: "invalid room admission" }, 403);
    const room = await getAppRoomById(context.roomId);
    if (!room || room.appId !== context.caller.appId) return c.json({ code: "ROOM_NOT_FOUND", message: "room not found" }, 404);
    try {
      c.header("Cache-Control", "private, no-store");
      return c.json(await appRtc.open({
        caller: context.caller,
        spaceId: context.spaceId,
        room: { id: room.id, expiresAtMs: room.expiresAtMs },
        participantId: context.caller.participantId ?? body.participantId,
        userKey: context.userKey ?? ticket?.userKey ?? "",
      }), 201);
    } catch (error) {
      return rtcError(c, error);
    }
  });

  router.get(`${base}/:sessionId`, async (c) => {
    const context = await resolveCaller(c);
    if (context instanceof Response) return context;
    const sessionId = sessionIdOf(c);
    if (!sessionId) return c.json({ code: "RTC_SESSION_NOT_FOUND", message: "RTC session not found" }, 404);
    try {
      await appRtc.check({ ...context, sessionId });
      return c.json({ ok: true });
    } catch (error) {
      return rtcError(c, error);
    }
  });

  router.put(`${base}/:sessionId`, rtcBodyLimit, async (c) => {
    const context = await resolveCaller(c);
    if (context instanceof Response) return context;
    const sessionId = sessionIdOf(c);
    if (!sessionId) return c.json({ code: "RTC_SESSION_NOT_FOUND", message: "RTC session not found" }, 404);
    const body = await readBody(c, appRtcAnswerRequestSchema);
    if (body instanceof Response) return body;
    try {
      await appRtc.answer({ ...context, sessionId, answer: body.answer });
      return c.json({ ok: true });
    } catch (error) {
      return rtcError(c, error);
    }
  });

  router.delete(`${base}/:sessionId`, async (c) => {
    const context = await resolveCaller(c);
    if (context instanceof Response) return context;
    const sessionId = sessionIdOf(c);
    if (!sessionId) return c.json({ ok: true });
    try {
      await appRtc.closeOwned({ ...context, sessionId });
      return c.json({ ok: true });
    } catch (error) {
      return rtcError(c, error);
    }
  });

  router.post(`${base}/:sessionId/publish`, rtcBodyLimit, async (c) => {
    const context = await resolveCaller(c);
    if (context instanceof Response) return context;
    const sessionId = sessionIdOf(c);
    if (!sessionId) return c.json({ code: "RTC_SESSION_NOT_FOUND", message: "RTC session not found" }, 404);
    const body = await readBody(c, appRtcPublishRequestSchema);
    if (body instanceof Response) return body;
    try {
      return c.json(await appRtc.publish({ ...context, sessionId, request: body }));
    } catch (error) {
      return rtcError(c, error);
    }
  });

  router.post(`${base}/:sessionId/unpublish`, rtcBodyLimit, async (c) => {
    const context = await resolveCaller(c);
    if (context instanceof Response) return context;
    const sessionId = sessionIdOf(c);
    if (!sessionId) return c.json({ code: "RTC_SESSION_NOT_FOUND", message: "RTC session not found" }, 404);
    const body = await readBody(c, appRtcUnpublishRequestSchema);
    if (body instanceof Response) return body;
    try {
      return c.json(await appRtc.unpublish({ ...context, sessionId, ids: body.ids, offer: body.offer }));
    } catch (error) {
      return rtcError(c, error);
    }
  });

  router.post(`${base}/:sessionId/subscribe`, rtcBodyLimit, async (c) => {
    const context = await resolveCaller(c);
    if (context instanceof Response) return context;
    const sessionId = sessionIdOf(c);
    if (!sessionId) return c.json({ code: "RTC_SESSION_NOT_FOUND", message: "RTC session not found" }, 404);
    const body = await readBody(c, appRtcSubscribeRequestSchema);
    if (body instanceof Response) return body;
    try {
      return c.json(await appRtc.subscribe({ ...context, sessionId, kind: body.kind, items: body.items }));
    } catch (error) {
      return rtcError(c, error);
    }
  });

  router.patch(`${base}/:sessionId/media`, rtcBodyLimit, async (c) => {
    const context = await resolveCaller(c);
    if (context instanceof Response) return context;
    const sessionId = sessionIdOf(c);
    if (!sessionId) return c.json({ code: "RTC_SESSION_NOT_FOUND", message: "RTC session not found" }, 404);
    const body = await readBody(c, appRtcMediaUpdateRequestSchema);
    if (body instanceof Response) return body;
    try {
      return c.json(await appRtc.updateMedia({ ...context, sessionId, items: body.items }));
    } catch (error) {
      return rtcError(c, error);
    }
  });

  router.post(`${base}/:sessionId/unsubscribe`, rtcBodyLimit, async (c) => {
    const context = await resolveCaller(c);
    if (context instanceof Response) return context;
    const sessionId = sessionIdOf(c);
    if (!sessionId) return c.json({ code: "RTC_SESSION_NOT_FOUND", message: "RTC session not found" }, 404);
    const body = await readBody(c, appRtcUnsubscribeRequestSchema);
    if (body instanceof Response) return body;
    try {
      return c.json(await appRtc.unsubscribe({ ...context, sessionId, items: body.items, offer: body.offer }));
    } catch (error) {
      return rtcError(c, error);
    }
  });

  return router;
}
