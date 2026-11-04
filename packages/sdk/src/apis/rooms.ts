import type {
  RealtimeRoomDescriptor,
  RealtimeRoomHistoryEvent,
  RealtimeRoomMember,
} from "@cohub/protocol/realtime";
import { HttpError, type HttpTransport } from "../transport.js";
import type { WebsocketClient } from "../websocket.js";
import type { AppRoom, AppRoomAdmissionResponse, AppRoomCreateInput } from "./app-realtime.js";
import type { AppSessionResponse } from "./apps.js";

export type RoomView = {
  room: RealtimeRoomDescriptor;
  participantId: string;
  members: RealtimeRoomMember[];
  sequence: number;
};

export type RoomInvite = { invite: string; expiresAt: string };

export type RoomCreated = RoomInvite & {
  room: RealtimeRoomDescriptor;
  url: string | null;
};

export type RoomEvent = RealtimeRoomHistoryEvent & { self: boolean };

export type RoomEvents = {
  events: RoomEvent[];
  cursor: number;
  truncated: boolean;
};

export type RoomEventsQuery = {
  after?: number;
  types?: string[];
  waitMs?: number;
  limit?: number;
  signal?: AbortSignal;
};

const MAX_WAIT_PER_READ_MS = 25_000;

export class RoomsApi {
  constructor(private readonly transport: HttpTransport, private readonly websocket?: WebsocketClient) {}

  create(input: { appId: string; code?: string; expiresInSeconds?: number; maxParticipants?: number; seatPerUser?: boolean }) {
    return this.post<RoomCreated>("", input);
  }

  join(input: { invite: string; presence?: Record<string, unknown> | null; idleSeconds?: number }) {
    return this.post<RoomView>("/join", input);
  }

  get(roomId: string) {
    return this.transport.request<RoomView>(this.path(roomId));
  }

  async connect(roomId: string, options: { after?: number; onRoom?: (room: AppRoom<Record<string, unknown>>) => void } = {}) {
    if (!this.websocket) throw new Error("Room realtime requires CohubClient; CohubHttpClient supports HTTP only");
    if (options.after !== undefined && (!Number.isSafeInteger(options.after) || options.after < 0)) throw new Error("after must be a non-negative safe integer");
    const admission = await this.post<AppRoomAdmissionResponse & { appId: string }>(`/${encodeURIComponent(roomId)}/connect`, {});
    const { AppRoom } = await import("./app-realtime.js");
    const room = new AppRoom<Record<string, unknown>>(this.websocket, admission, { transport: this.transport, appId: admission.appId, hosted: true });
    try {
      options.onRoom?.(room);
      return await room.connect({ after: options.after });
    } catch (error) {
      await room.disconnect();
      throw error;
    }
  }

  /** Joins an App's room by code on the viewer's behalf, creating it with `create` when nobody has. */
  async open(input: { appId: string; code: string; create?: Omit<AppRoomCreateInput, "code"> }) {
    if (!this.websocket) throw new Error("Room realtime requires CohubClient; CohubHttpClient supports HTTP only");
    const base = `/api/apps/${encodeURIComponent(input.appId)}`;
    const { token } = await this.transport.request<AppSessionResponse>(`${base}/session`, { method: "POST" });
    const admit = (path: string, body: object) =>
      this.transport.request<AppRoomAdmissionResponse>(`${base}/realtime/rooms${path}`, {
        method: "POST",
        accessToken: token,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const join = () => admit("/join", { code: input.code });
    const admission = await join().catch((error: unknown) => {
      if (!(error instanceof HttpError) || error.status !== 404) throw error;
      return admit("", { ...input.create, code: input.code }).catch((created: unknown) => {
        if (created instanceof HttpError && created.code === "ROOM_CODE_TAKEN") return join();
        throw created;
      });
    });
    const { AppRoom } = await import("./app-realtime.js");
    const room = new AppRoom<Record<string, unknown>>(this.websocket, admission);
    try {
      return await room.connect();
    } catch (error) {
      await room.disconnect().catch(() => undefined);
      throw error;
    }
  }

  signalRtc<T = unknown>(roomId: string, input: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path?: string; body?: unknown }) {
    const path = input.path ?? "";
    if (path && !/^\/[A-Za-z0-9_-]{8,64}(?:\/(?:publish|unpublish|subscribe|unsubscribe|media))?$/.test(path)) {
      throw new Error("Invalid RTC signaling path");
    }
    return this.transport.request<T>(`${this.path(roomId)}/rtc${path}`, {
      method: input.method,
      ...(input.body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input.body) }),
    });
  }

  async events(roomId: string, query: RoomEventsQuery = {}): Promise<RoomEvents> {
    const deadline = Date.now() + Math.max(0, query.waitMs ?? 0);
    const result: RoomEvents = { events: [], cursor: query.after ?? 0, truncated: false };
    if (query.limit !== undefined && query.limit <= 0) return result;
    let after = query.after;
    for (;;) {
      const waitMs = Math.min(Math.max(0, deadline - Date.now()), MAX_WAIT_PER_READ_MS);
      const params = new URLSearchParams();
      if (after !== undefined) params.set("after", String(after));
      if (query.types?.length) params.set("types", query.types.join(","));
      if (query.limit !== undefined) params.set("limit", String(query.limit - result.events.length));
      if (waitMs > 0) params.set("wait", String(waitMs));
      const page = await this.transport.request<RoomEvents>(`${this.path(roomId)}/events?${params}`, { signal: query.signal });
      result.events.push(...page.events);
      result.cursor = page.cursor;
      result.truncated ||= page.truncated;
      const woken = result.events.some((event) => !event.self);
      if (woken || result.events.length >= (query.limit ?? Number.POSITIVE_INFINITY) || waitMs === 0 || Date.now() >= deadline || query.signal?.aborted) return result;
      after = page.cursor;
    }
  }

  publish(roomId: string, type: string, data?: unknown) {
    return this.post<{ sequence: number; eventId: string }>(`/${encodeURIComponent(roomId)}/events`, { type, data: data ?? null });
  }

  setPresence(roomId: string, presence: Record<string, unknown> | null) {
    return this.transport.request<{ member: RealtimeRoomMember; sequence: number }>(`${this.path(roomId)}/presence`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ presence }),
    });
  }

  invite(roomId: string, input: { expiresInSeconds?: number } = {}) {
    return this.post<RoomInvite>(`/${encodeURIComponent(roomId)}/invites`, input);
  }

  leave(roomId: string) {
    return this.transport.request<{ left: boolean }>(`${this.path(roomId)}/seat`, { method: "DELETE" });
  }

  private path(roomId: string) {
    return `/api/rooms/${encodeURIComponent(roomId)}`;
  }

  private post<T>(path: string, body: unknown) {
    return this.transport.request<T>(`/api/rooms${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}
