import {
  getRealtimeSpaceRoom,
  getSessionTurnPatchStreamKey,
  isRealtimeDomain,
  WS_BOARD_AWARENESS_CAPABILITY,
  WS_COMPACT_STREAM_CAPABILITY,
  WS_ROOM_SUBSCRIPTION_CAPABILITY,
  WS_REALTIME_ROOM_CAPABILITY,
  WS_REALTIME_ROOM_HISTORY_CAPABILITY,
  normalizeRealtimeRooms,
  type ChannelEnvelope,
  type RealtimeCompactFrame,
  type RealtimePatchOperation,
  type RealtimeRoom,
  type WsClientEvent,
} from "@cohub/protocol/realtime/types";
import type { BoardAwarenessUpdate } from "@cohub/protocol/realtime";
import type { ContentBlock } from "@cohub/protocol/core";
import type { ModelThinkingLevel } from "@cohub/protocol";
import type { CohubEnvironment } from "./environment.js";
import { extractBillingPayload } from "./http-error.js";
import type { BillingResponsePayload } from "./types.js";
import { resolveWebsocketUrl } from "./environment.js";

export type WebsocketEventPayload = ChannelEnvelope;

export type WebSocketLike = {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type WebSocketConstructor = new (url: string) => WebSocketLike;

export type WebsocketClientOptions = {
  env?: CohubEnvironment;
  url?: string;
  autoReconnect?: boolean;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  connectTimeoutMs?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  debug?: boolean;
  getAccessToken?: (options?: { forceRefresh?: boolean }) => Promise<string | null> | string | null;
  WebSocketImpl?: WebSocketConstructor;
};

export type WebsocketClientState = "idle" | "connecting" | "reconnecting" | "open" | "closed";

export type WebsocketClientEvents = {
  connecting: { isReconnect: boolean; attempt: number };
  reconnecting: { attempt: number; delayMs: number; reason?: string; code?: number };
  open: { connectionId?: string | null };
  close: { code: number; reason: string; willReconnect: boolean };
  error: { error: unknown; recoverable: boolean };
  event: WebsocketEventPayload;
  ready: { connectionId: string };
  auth: { connectionId: string; user: Record<string, unknown>; capabilities: string[] };
  messageAccepted: {
    requestId?: string | null;
    clientMessageId?: string | null;
    sessionId?: string | null;
    spaceId?: string | null;
    turnId?: string | null;
    userMessageId?: string | null;
    traceId?: string | null;
  };
  serverError: {
    code?: string;
    message?: string;
    requestId?: string | null;
    sessionId?: string | null;
    spaceId?: string | null;
    clientMessageId?: string | null;
    billing?: BillingResponsePayload | null;
  };
  subscribed: { rooms: RealtimeRoom[]; requestId?: string | null };
  subscribeError: { rejected: Array<{ room: string; code: string; message: string }>; requestId?: string | null };
  pong: { requestId?: string | null };
};

type EventHandler<T> = (payload: T) => void;

type EventMap = {
  [K in keyof WebsocketClientEvents]: Set<EventHandler<WebsocketClientEvents[K]>>;
};

const createEventMap = (): EventMap => ({
  connecting: new Set(),
  reconnecting: new Set(),
  open: new Set(),
  close: new Set(),
  error: new Set(),
  event: new Set(),
  ready: new Set(),
  auth: new Set(),
  messageAccepted: new Set(),
  serverError: new Set(),
  subscribed: new Set(),
  subscribeError: new Set(),
  pong: new Set(),
});

const toWebSocketUrl = (input?: string, env?: CohubEnvironment) =>
  resolveWebsocketUrl({ url: input, env });

const normalizeOptions = (options: WebsocketClientOptions = {}) => ({
  url: toWebSocketUrl(options.url, options.env),
  autoReconnect: options.autoReconnect !== false,
  reconnectBaseDelayMs: options.reconnectBaseDelayMs ?? 1000,
  reconnectMaxDelayMs: options.reconnectMaxDelayMs ?? 15000,
  connectTimeoutMs: normalizeConnectTimeoutMs(options.connectTimeoutMs ?? 15000),
  pingIntervalMs: options.pingIntervalMs ?? 20000,
  pongTimeoutMs: options.pongTimeoutMs ?? 15000,
  debug: options.debug === true,
});

const formatCloseMessage = (code?: number, reason?: string) =>
  `WebSocket closed: ${code ?? 0} ${reason || ""}`.trim();

const normalizeConnectTimeoutMs = (value: number): number => {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error("connectTimeoutMs must be an integer between 1 and 2147483647");
  }
  return value;
};

const AUTH_CLOSE_CODE = 4003;
const AUTH_CLOSE_REASON = "authentication failed";

const isRetryableCloseCode = (code: number) => {
  if (code === 1000) return false;
  if (code === AUTH_CLOSE_CODE) return false;
  return true;
};
const PATCH_STREAM_BUFFER_MAX_PENDING = 128;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const isRealtimeCompactFrame = (value: unknown): value is RealtimeCompactFrame => {
  if (!isRecord(value)) return false;
  if (value.t !== "d" && value.t !== "p") return false;
  if (typeof value.sid !== "string" || !value.sid) return false;
  if (typeof value.s !== "number" || !Number.isInteger(value.s) || value.s < 0) return false;
  if (typeof value.b !== "number" || !Number.isInteger(value.b) || value.b < 0) return false;
  if (value.t === "d") return "v" in value;
  return (
    (value.o === "append" ||
      value.o === "replace" ||
      value.o === "add" ||
      value.o === "merge" ||
      value.o === "remove") &&
    typeof value.p === "string" &&
    value.p.length > 0
  );
};

const isRealtimeEnvelope = (value: unknown): value is ChannelEnvelope => {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string") return false;
  if (typeof value.timestamp !== "number") return false;
  if (!isRealtimeDomain(value.domain)) return false;
  if (typeof value.type !== "string") return false;
  if (!isRecord(value.payload)) return false;
  return true;
};

const compactFrameToPatchOperation = (
  frame: RealtimeCompactFrame,
): RealtimePatchOperation | null => {
  if (frame.t === "d") return { v: frame.v };
  if (frame.o === "remove") return { o: "remove", p: frame.p };
  if (frame.o === "merge") {
    return isRecord(frame.v) ? { o: "merge", p: frame.p, v: frame.v } : null;
  }
  if (!("v" in frame)) return null;
  switch (frame.o) {
    case "append":
      return { o: "append", p: frame.p, v: frame.v };
    case "replace":
      return { o: "replace", p: frame.p, v: frame.v };
    case "add":
      return { o: "add", p: frame.p, v: frame.v };
    default:
      return null;
  }
};

class WebsocketAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebsocketAuthError";
  }
}

type CompactStreamContext = {
  spaceId: string | null;
  sessionId: string | null;
  turnId: string | null;
  messageId: string | null;
  messageOrdinal: number | null;
  anchorUserMessageId: string | null;
};

type PatchStreamBuffer = {
  nextSeq: number;
  pending: Map<number, ChannelEnvelope>;
};

type RoomSubscriptionState = {
  refCount: number;
  subscribed: boolean;
  pending: boolean;
};

export class WebsocketClient {
  private readonly url: string;
  private readonly autoReconnect: boolean;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly connectTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly debug: boolean;
  private readonly getAccessToken?: WebsocketClientOptions["getAccessToken"];
  private readonly WebSocketImpl: WebSocketConstructor;

  private ws: WebSocketLike | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimerResolver: (() => void) | null = null;
  private reconnectAttempt = 0;
  private authReconnectAttempted = false;
  private forceRefreshOnNextAuth = false;
  private retryAuthClose = false;
  private manuallyClosed = false;
  private connectPromise: Promise<void> | null = null;
  private pendingConnectReject: ((error: Error) => void) | null = null;
  private authWaiter: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;
  private awaitingPong = false;
  private lastPingRequestId: string | null = null;
  private pongDeadlineAt = 0;
  private readonly compactStreamContexts = new Map<string, CompactStreamContext>();
  private readonly patchStreamBuffers = new Map<string, PatchStreamBuffer>();
  private readonly roomSubscriptions = new Map<RealtimeRoom, RoomSubscriptionState>();
  private readonly serverCapabilities = new Set<string>();

  public state: WebsocketClientState = "idle";
  public connectionId: string | null = null;

  supportsCapability(capability: string) {
    return this.serverCapabilities.has(capability);
  }

  private readonly listeners = createEventMap();

  constructor(options: WebsocketClientOptions = {}) {
    const normalized = normalizeOptions(options);
    this.url = normalized.url;
    this.autoReconnect = normalized.autoReconnect;
    this.reconnectBaseDelayMs = normalized.reconnectBaseDelayMs;
    this.reconnectMaxDelayMs = normalized.reconnectMaxDelayMs;
    this.connectTimeoutMs = normalized.connectTimeoutMs;
    this.pingIntervalMs = normalized.pingIntervalMs;
    this.pongTimeoutMs = normalized.pongTimeoutMs;
    this.debug = normalized.debug;
    this.getAccessToken = options.getAccessToken;
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  }

  on<K extends keyof WebsocketClientEvents>(
    type: K,
    handler: EventHandler<WebsocketClientEvents[K]>,
  ) {
    (this.listeners[type] as Set<EventHandler<WebsocketClientEvents[K]>>).add(handler);
    return () => this.off(type, handler);
  }

  off<K extends keyof WebsocketClientEvents>(
    type: K,
    handler: EventHandler<WebsocketClientEvents[K]>,
  ) {
    (this.listeners[type] as Set<EventHandler<WebsocketClientEvents[K]>>).delete(handler);
  }

  private emit<K extends keyof WebsocketClientEvents>(
    type: K,
    payload: WebsocketClientEvents[K],
  ) {
    for (const handler of this.listeners[type]) {
      handler(payload);
    }
  }

  private log(...args: unknown[]) {
    if (this.debug) console.log("[WebsocketClient]", ...args);
  }

  async connect() {
    if (this.connectPromise) return this.connectPromise;
    if (this.state === "open" && this.ws?.readyState === WebSocket.OPEN) return;

    const isReconnect = this.reconnectAttempt > 0 || this.state === "reconnecting";
    this.manuallyClosed = false;
    this.clearReconnectTimer();
    this.state = isReconnect ? "reconnecting" : "connecting";
    this.emit("connecting", { isReconnect, attempt: this.reconnectAttempt });
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new this.WebSocketImpl(this.url);
      this.ws = ws;
      let settled = false;
      let closed = false;
      let connectTimer: ReturnType<typeof setTimeout> | null = null;

      const clearConnectTimer = () => {
        if (connectTimer === null) return;
        clearTimeout(connectTimer);
        connectTimer = null;
      };

      const rejectOnce = (error: Error) => {
        if (settled) return;
        clearConnectTimer();
        settled = true;
        this.connectPromise = null;
        if (this.pendingConnectReject === rejectOnce) {
          this.pendingConnectReject = null;
        }
        reject(error);
      };

      const resolveOnce = () => {
        if (settled) return;
        clearConnectTimer();
        settled = true;
        this.connectPromise = null;
        if (this.pendingConnectReject === rejectOnce) {
          this.pendingConnectReject = null;
        }
        resolve();
      };

      const isCurrentConnection = () => this.ws === ws && !closed;

      const cleanupSocket = () => {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
      };

      const handleClose = (event: { code: number; reason: string }) => {
        if (closed || this.ws !== ws) return;
        closed = true;
        clearConnectTimer();
        this.stopPingLoop();
        const wasConnecting = this.state === "connecting" || this.state === "reconnecting";
        this.state = "closed";
        this.ws = null;
        this.compactStreamContexts.clear();
        this.patchStreamBuffers.clear();
        this.resetRoomSubscriptions();
        const closeError = new Error(formatCloseMessage(event.code, event.reason));
        this.rejectAuthWaiter(closeError);
        const retryAuthClose = event.code === AUTH_CLOSE_CODE && this.retryAuthClose;
        this.retryAuthClose = false;
        const willReconnect = !this.manuallyClosed && this.autoReconnect && (
          retryAuthClose || isRetryableCloseCode(event.code)
        );
        this.log("closed", { code: event.code, reason: event.reason, willReconnect, wasConnecting });
        this.emit("close", {
          code: event.code,
          reason: event.reason,
          willReconnect,
        });
        cleanupSocket();
        if (wasConnecting) {
          rejectOnce(closeError);
        }
        if (willReconnect) {
          void this.scheduleReconnect(event.code, event.reason);
        }
      };

      ws.onopen = async () => {
        if (!isCurrentConnection()) return;
        clearConnectTimer();
        try {
          this.log("connected", { url: this.url, isReconnect, attempt: this.reconnectAttempt });
          this.startPingLoop();
          await this.authenticate();
          if (!isCurrentConnection()) return;
          this.state = "open";
          this.restoreRoomSubscriptions();
          this.reconnectAttempt = 0;
          this.emit("open", { connectionId: this.connectionId });
          resolveOnce();
        } catch (error) {
          if (!isCurrentConnection()) return;
          const authError =
            error instanceof Error ? error : new Error("authentication failed");
          const recoverable = Boolean(
            this.getAccessToken &&
            this.autoReconnect &&
            !this.manuallyClosed &&
            !this.authReconnectAttempted
          );
          this.retryAuthClose = recoverable;
          if (recoverable) {
            this.authReconnectAttempted = true;
            this.forceRefreshOnNextAuth = true;
          }
          this.emit("error", { error: authError, recoverable });
          rejectOnce(authError);
          ws.close(AUTH_CLOSE_CODE, AUTH_CLOSE_REASON);
        }
      };

      ws.onmessage = (event) => {
        if (!isCurrentConnection()) return;
        this.handleMessage(event.data);
      };

      ws.onerror = (error) => {
        if (!isCurrentConnection()) return;
        this.emit("error", { error, recoverable: !this.manuallyClosed });
      };

      ws.onclose = (event) => {
        handleClose(event);
      };

      this.pendingConnectReject = rejectOnce;
      connectTimer = setTimeout(() => {
        if (!isCurrentConnection() || settled) return;
        const reason = "connect timeout";
        const error = new Error(`WebSocket ${reason} after ${this.connectTimeoutMs}ms`);
        this.emit("error", {
          error,
          recoverable: !this.manuallyClosed && this.autoReconnect,
        });
        try {
          ws.close(4002, reason);
        } finally {
          handleClose({ code: 4002, reason });
        }
      }, this.connectTimeoutMs);
    });

    return this.connectPromise;
  }

  async disconnect(code = 1000, reason = "manual") {
    this.manuallyClosed = true;
    this.clearReconnectTimer();
    this.stopPingLoop();
    this.state = "closed";
    this.rejectAuthWaiter(new Error("disconnected"));
    const ws = this.ws;
    this.ws = null;
    ws?.close(code, reason);
    this.pendingConnectReject?.(new Error(`WebSocket disconnected: ${reason}`));
    this.pendingConnectReject = null;
    this.connectPromise = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      this.emit("close", { code, reason, willReconnect: false });
    }
    this.authReconnectAttempted = false;
    this.forceRefreshOnNextAuth = false;
    this.retryAuthClose = false;
    this.compactStreamContexts.clear();
    this.patchStreamBuffers.clear();
    this.resetRoomSubscriptions();
  }

  async updatePresence(input: {
    spaceId: string;
    meta?: Record<string, unknown> | null;
    requestId?: string;
  }) {
    await this.ensureOpen();
    this.send({
      type: "presence.update",
      requestId: input.requestId,
      payload: {
        spaceId: input.spaceId,
        meta: input.meta ?? null,
      },
    });
  }

  async updateBoardAwareness(input: {
    spaceId: string;
    boardId: string;
    seq: number;
    update: BoardAwarenessUpdate;
    requestId?: string;
  }) {
    await this.ensureOpen();
    this.send({
      type: "board.awareness.update",
      requestId: input.requestId,
      payload: {
        spaceId: input.spaceId,
        boardId: input.boardId,
        seq: input.seq,
        update: input.update,
      },
    });
  }

  async joinRealtimeRoom(input: { roomId: string; ticket: string; instanceId?: string; after?: number; requestId?: string }) {
    await this.ensureOpen();
    this.send({
      type: "realtime.room.join",
      requestId: input.requestId,
      payload: {
        roomId: input.roomId,
        ticket: input.ticket,
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        ...(input.after !== undefined ? { after: input.after } : {}),
      },
    });
  }

  async readRealtimeRoomHistory(input: { roomId: string; after?: number; limit?: number; requestId?: string }) {
    await this.ensureOpen();
    this.send({
      type: "realtime.room.history",
      requestId: input.requestId,
      payload: {
        roomId: input.roomId,
        ...(input.after !== undefined ? { after: input.after } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
    });
  }

  async publishRealtimeRoom(input: {
    roomId: string;
    event: string;
    data: unknown;
    clientEventId?: string;
    requestId?: string;
  }) {
    await this.ensureOpen();
    this.send({
      type: "realtime.room.publish",
      requestId: input.requestId,
      payload: {
        roomId: input.roomId,
        event: input.event,
        data: input.data,
        clientEventId: input.clientEventId,
      },
    });
  }

  async detachRealtimeRoom(input: { roomId: string; requestId?: string }) {
    await this.ensureOpen();
    this.send({ type: "realtime.room.detach", requestId: input.requestId, payload: { roomId: input.roomId } });
  }

  async leaveRealtimeRoom(input: { roomId: string; requestId?: string }) {
    await this.ensureOpen();
    this.send({
      type: "realtime.room.leave",
      requestId: input.requestId,
      payload: { roomId: input.roomId },
    });
  }

  async updateRealtimeRoomPresence(input: {
    roomId: string;
    presence: Record<string, unknown> | null;
    requestId?: string;
  }) {
    await this.ensureOpen();
    this.send({
      type: "realtime.room.presence.update",
      requestId: input.requestId,
      payload: { roomId: input.roomId, presence: input.presence },
    });
  }

  async sendMessage(input: {
    spaceId: string;
    sessionId: string;
    content: ContentBlock[];
    clientMessageId?: string;
    requestId?: string;
    model?: string;
    provider?: string;
    harness?: "cohub" | "pi" | "codex";
    serviceTier?: "priority" | null;
    thinkingLevel?: ModelThinkingLevel;
  }) {
    await this.ensureOpen();
    this.send({
      type: "session.message.create",
      requestId: input.requestId,
      payload: {
        spaceId: input.spaceId,
        sessionId: input.sessionId,
        content: input.content,
        clientMessageId: input.clientMessageId,
        model: input.model,
        provider: input.provider,
        harness: input.harness,
        serviceTier: input.serviceTier,
        thinkingLevel: input.thinkingLevel,
      },
    });
  }

  retainRooms(rooms: readonly string[]) {
    const normalized = normalizeRealtimeRooms(rooms);
    if (normalized.length === 0) return () => undefined;
    for (const room of normalized) {
      const state = this.roomSubscriptions.get(room) ?? { refCount: 0, subscribed: false, pending: false };
      state.refCount += 1;
      this.roomSubscriptions.set(room, state);
    }
    this.flushRoomSubscriptions();
    if (this.state !== "open" && this.state !== "connecting" && this.state !== "reconnecting") {
      void this.connect()
        .then(() => this.flushRoomSubscriptions())
        .catch((error) => this.emit("error", { error, recoverable: true }));
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const roomsToRelease: RealtimeRoom[] = [];
      for (const room of normalized) {
        const state = this.roomSubscriptions.get(room);
        if (!state) continue;
        state.refCount -= 1;
        if (state.refCount > 0) {
          this.roomSubscriptions.set(room, state);
          continue;
        }
        this.roomSubscriptions.delete(room);
        if (state.subscribed) roomsToRelease.push(room);
      }
      if (roomsToRelease.length === 0) return;
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: "unsubscribe", payload: { rooms: roomsToRelease } });
      }
    };
  }

  subscribeRooms(rooms: readonly string[]) {
    return this.retainRooms(rooms);
  }

  subscribeSpace(spaceId: string) {
    return this.retainRooms([getRealtimeSpaceRoom(spaceId)]);
  }

  ack(eventId?: string, requestId?: string) {
    this.send({
      type: "ack",
      requestId,
      payload: eventId ? { eventId } : undefined,
    });
  }

  ping(requestId?: string) {
    const effectiveRequestId = requestId ?? `ping-${Date.now()}`;
    this.awaitingPong = true;
    this.lastPingRequestId = effectiveRequestId;
    this.pongDeadlineAt = Date.now() + this.pongTimeoutMs;
    this.send({ type: "ping", requestId: effectiveRequestId, payload: {} });
  }

  private async ensureOpen() {
    if (this.state === "open" && this.ws?.readyState === WebSocket.OPEN) return;
    await this.connect();
  }

  private send(event: WsClientEvent) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("websocket is not open");
    }
    ws.send(JSON.stringify(event));
  }

  private async authenticate() {
    const forceRefresh = this.forceRefreshOnNextAuth;
    this.forceRefreshOnNextAuth = false;
    const token = this.getAccessToken
      ? await this.getAccessToken(forceRefresh ? { forceRefresh: true } : undefined)
      : null;
    if (!token) throw new WebsocketAuthError("missing access token");

    const waiter = this.createAuthWaiter();
    this.send({
      type: "auth",
      payload: { token, capabilities: [WS_COMPACT_STREAM_CAPABILITY, WS_ROOM_SUBSCRIPTION_CAPABILITY, WS_BOARD_AWARENESS_CAPABILITY, WS_REALTIME_ROOM_CAPABILITY, WS_REALTIME_ROOM_HISTORY_CAPABILITY] },
    });
    await waiter.promise;
    this.authReconnectAttempted = false;
  }

  private flushRoomSubscriptions() {
    if (this.state !== "open" || this.ws?.readyState !== WebSocket.OPEN) return;
    const rooms = [...this.roomSubscriptions.entries()]
      .filter(([, state]) => state.refCount > 0 && !state.subscribed && !state.pending)
      .map(([room]) => room);
    if (rooms.length === 0) return;
    this.send({ type: "subscribe", payload: { rooms } });
    for (const room of rooms) {
      const state = this.roomSubscriptions.get(room);
      if (state) state.pending = true;
    }
  }

  private restoreRoomSubscriptions() {
    this.resetRoomSubscriptions();
    this.flushRoomSubscriptions();
  }

  private resetRoomSubscriptions() {
    for (const state of this.roomSubscriptions.values()) {
      state.subscribed = false;
      state.pending = false;
    }
  }

  private createAuthWaiter() {
    this.rejectAuthWaiter(new Error("superseded auth waiter"));
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.authWaiter = { promise, resolve, reject };
    return this.authWaiter;
  }

  private resolveAuthWaiter() {
    if (!this.authWaiter) return;
    this.authWaiter.resolve();
    this.authWaiter = null;
  }

  private rejectAuthWaiter(error: Error) {
    if (!this.authWaiter) return;
    this.authWaiter.reject(error);
    this.authWaiter = null;
  }

  private handleMessage(raw: unknown) {
    let parsed: unknown;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(String(raw));
    } catch {
      this.emit("error", { error: new Error("invalid websocket payload"), recoverable: true });
      return;
    }

    if (isRealtimeCompactFrame(parsed)) {
      this.handleCompactFrame(parsed);
      return;
    }

    if (!isRealtimeEnvelope(parsed)) {
      this.emit("error", { error: new Error("invalid realtime envelope"), recoverable: true });
      return;
    }

    const envelope = parsed;
    this.rememberCompactStreamContext(envelope);
    if (envelope.type === "session.turn.patch") {
      this.handlePatchEnvelope(envelope);
      return;
    }
    switch (envelope.type) {
      case "system.ready": {
        const connectionId = typeof envelope.payload.connectionId === "string"
          ? envelope.payload.connectionId
          : null;
        if (connectionId) {
          this.connectionId = connectionId;
          this.emit("ready", { connectionId });
        }
        this.emit("event", envelope);
        return;
      }
      case "system.auth.ok": {
        const connectionId = typeof envelope.payload.connectionId === "string"
          ? envelope.payload.connectionId
          : this.connectionId;
        const user = envelope.payload.user && typeof envelope.payload.user === "object"
          ? (envelope.payload.user as Record<string, unknown>)
          : {};
        const capabilities = Array.isArray(envelope.payload.capabilities)
          ? envelope.payload.capabilities.filter((value): value is string => typeof value === "string")
          : [];
        this.serverCapabilities.clear();
        for (const capability of capabilities) this.serverCapabilities.add(capability);
        if (connectionId) {
          this.connectionId = connectionId;
          this.emit("auth", { connectionId, user, capabilities });
        }
        this.resolveAuthWaiter();
        this.emit("event", envelope);
        return;
      }
      case "system.request.error": {
        const message = typeof envelope.payload.message === "string"
          ? envelope.payload.message
          : "request failed";
        const code = typeof envelope.payload.code === "string"
          ? envelope.payload.code
          : undefined;
        const error = new WebsocketAuthError(message);
        this.rejectAuthWaiter(error);
        this.emit("serverError", {
          code,
          message,
          requestId: envelope.requestId ?? null,
          sessionId: envelope.sessionId ?? null,
          spaceId: envelope.spaceId ?? null,
        });
        this.emit("event", envelope);
        return;
      }
      case "session.request.accepted": {
        const payload = envelope.payload as Record<string, unknown>;
        this.emit("messageAccepted", {
          requestId: envelope.requestId ?? null,
          sessionId: envelope.sessionId ?? null,
          spaceId: envelope.spaceId ?? null,
          clientMessageId:
            typeof payload.clientMessageId === "string" ? payload.clientMessageId : null,
          turnId: typeof payload.turnId === "string" ? payload.turnId : null,
          userMessageId: typeof payload.userMessageId === "string" ? payload.userMessageId : null,
          traceId: typeof payload.traceId === "string" ? payload.traceId : null,
        });
        this.emit("event", envelope);
        return;
      }
      case "session.request.error": {
        const payload = envelope.payload as Record<string, unknown>;
        this.emit("serverError", {
          code: typeof payload.code === "string" ? payload.code : undefined,
          message: typeof payload.message === "string" ? payload.message : undefined,
          requestId: envelope.requestId ?? null,
          sessionId: envelope.sessionId ?? null,
          spaceId: envelope.spaceId ?? null,
          clientMessageId:
            typeof payload.clientMessageId === "string" ? payload.clientMessageId : null,
          billing: extractBillingPayload(payload.billing),
        });
        this.emit("event", envelope);
        return;
      }
      case "system.pong": {
        const requestId = envelope.requestId ?? null;
        if (!requestId || requestId === this.lastPingRequestId) {
          this.awaitingPong = false;
          this.lastPingRequestId = null;
          this.pongDeadlineAt = 0;
        }
        this.emit("pong", { requestId });
        return;
      }
      case "system.subscribe.ok": {
        const payload = envelope.payload as Record<string, unknown>;
        const rooms = normalizeRealtimeRooms(Array.isArray(payload.rooms) ? payload.rooms.filter((room): room is string => typeof room === "string") : []);
        for (const room of rooms) {
          const state = this.roomSubscriptions.get(room);
          if (state) {
            state.subscribed = true;
            state.pending = false;
          }
        }
        this.emit("subscribed", { rooms, requestId: envelope.requestId ?? null });
        this.emit("event", envelope);
        return;
      }
      case "system.subscribe.error": {
        const payload = envelope.payload as Record<string, unknown>;
        const rejected = Array.isArray(payload.rejected)
          ? payload.rejected
              .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
              .map((entry) => ({
                room: typeof entry.room === "string" ? entry.room : "",
                code: typeof entry.code === "string" ? entry.code : "UNKNOWN",
                message: typeof entry.message === "string" ? entry.message : "Subscription failed",
              }))
              .filter((entry) => entry.room)
          : [];
        for (const item of rejected) {
          const room = normalizeRealtimeRooms([item.room])[0];
          if (!room) continue;
          this.roomSubscriptions.delete(room);
        }
        this.emit("subscribeError", { rejected, requestId: envelope.requestId ?? null });
        this.emit("event", envelope);
        return;
      }
      case "system.ack.ok": {
        return;
      }
      default: {
        this.emit("event", envelope);
        return;
      }
    }
  }

  private rememberCompactStreamContext(envelope: ChannelEnvelope) {
    if (envelope.type === "session.turn.patch") {
      const payload = envelope.payload;
      const turnId = typeof payload.turnId === "string" ? payload.turnId : null;
      const messageId = typeof payload.messageId === "string" ? payload.messageId : null;
      const realtimeMeta = payload._rt && typeof payload._rt === "object"
        ? payload._rt as Record<string, unknown>
        : null;
      const sid = typeof realtimeMeta?.sid === "string" && realtimeMeta.sid.trim()
        ? realtimeMeta.sid
        : turnId ?? messageId;
      if (!sid) return;
      this.compactStreamContexts.set(sid, {
        spaceId: envelope.spaceId ?? null,
        sessionId: envelope.sessionId ?? null,
        turnId,
        messageId,
        messageOrdinal:
          typeof payload.messageOrdinal === "number"
            ? payload.messageOrdinal
            : null,
        anchorUserMessageId:
          typeof payload.anchorUserMessageId === "string"
            ? payload.anchorUserMessageId
            : null,
      });
      return;
    }

    if (envelope.type !== "session.message.persisted") return;
    const message = envelope.payload.message;
    if (!message || typeof message !== "object") return;
    const meta = (message as { meta?: Record<string, unknown> | null }).meta;
    const turnId = typeof meta?.turnId === "string" ? meta.turnId : null;
    if (!turnId) return;
    for (const [sid, context] of this.compactStreamContexts.entries()) {
      if (context.turnId === turnId) {
        this.compactStreamContexts.delete(sid);
        this.patchStreamBuffers.delete(sid);
      }
    }
  }

  private getPatchStreamBufferKey(envelope: ChannelEnvelope): string | null {
    if (envelope.type !== "session.turn.patch") return null;
    const payload = envelope.payload;
    const realtimeMeta = payload._rt && typeof payload._rt === "object"
      ? payload._rt as Record<string, unknown>
      : null;
    if (typeof realtimeMeta?.sid === "string" && realtimeMeta.sid.trim()) {
      return realtimeMeta.sid;
    }
    return getSessionTurnPatchStreamKey(payload, { includeSessionFallback: true });
  }

  private handlePatchEnvelope(envelope: ChannelEnvelope) {
    const payload = envelope.payload;
    if (
      typeof payload.seq !== "number" ||
      typeof payload.baseSeq !== "number" ||
      !Number.isInteger(payload.seq) ||
      !Number.isInteger(payload.baseSeq) ||
      payload.seq < 0 ||
      payload.baseSeq < 0
    ) {
      this.emit("event", envelope);
      return;
    }

    const key = this.getPatchStreamBufferKey(envelope);
    if (!key) {
      this.emit("event", envelope);
      return;
    }

    if (payload.baseSeq === 0) {
      const buffer: PatchStreamBuffer = { nextSeq: payload.seq + 1, pending: new Map() };
      this.patchStreamBuffers.set(key, buffer);
      this.emit("event", envelope);
      this.flushPatchStreamBuffer(buffer);
      return;
    }

    const buffer = this.patchStreamBuffers.get(key);
    if (!buffer) {
      const newBuffer: PatchStreamBuffer = {
        nextSeq: payload.baseSeq + 1,
        pending: new Map([[payload.seq, envelope]]),
      };
      this.patchStreamBuffers.set(key, newBuffer);
      this.flushPatchStreamBuffer(newBuffer);
      return;
    }

    if (payload.seq < buffer.nextSeq) return;
    buffer.pending.set(payload.seq, envelope);
    if (!this.enforcePatchStreamBufferLimit(key, buffer)) return;
    this.flushPatchStreamBuffer(buffer);
  }

  private enforcePatchStreamBufferLimit(key: string, buffer: PatchStreamBuffer) {
    if (buffer.pending.size <= PATCH_STREAM_BUFFER_MAX_PENDING) return true;
    this.patchStreamBuffers.delete(key);
    this.emit("error", {
      error: new Error(`patch stream buffer overflow: ${key}`),
      recoverable: true,
    });
    return false;
  }

  private flushPatchStreamBuffer(buffer: PatchStreamBuffer) {
    while (true) {
      const envelope = buffer.pending.get(buffer.nextSeq);
      if (!envelope) return;
      const seq = envelope.payload.seq;
      if (typeof seq !== "number" || !Number.isInteger(seq)) return;
      buffer.pending.delete(buffer.nextSeq);
      buffer.nextSeq = seq + 1;
      this.emit("event", envelope);
    }
  }

  private handleCompactFrame(frame: RealtimeCompactFrame) {
    const context = this.compactStreamContexts.get(frame.sid);
    if (!context?.sessionId) {
      this.emit("error", {
        error: new Error(`unknown compact stream: ${frame.sid}`),
        recoverable: true,
      });
      return;
    }

    const op = compactFrameToPatchOperation(frame);
    if (!op) {
      this.emit("error", {
        error: new Error(`invalid compact stream frame: ${frame.sid}`),
        recoverable: true,
      });
      return;
    }

    const envelope: ChannelEnvelope = {
      id: `compact:${frame.sid}:${frame.s}`,
      timestamp: Date.now(),
      domain: "session",
      type: "session.turn.patch",
      spaceId: context.spaceId,
      sessionId: context.sessionId,
      payload: {
        turnId: context.turnId,
        messageId: context.messageId,
        messageOrdinal: context.messageOrdinal,
        sourceMessageId: context.messageId,
        anchorUserMessageId: context.anchorUserMessageId,
        seq: frame.s,
        baseSeq: frame.b,
        ops: [op],
        _rt: { sid: frame.sid },
      },
    };

    this.handlePatchEnvelope(envelope);
  }

  private startPingLoop() {
    this.stopPingLoop();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      if (
        this.awaitingPong &&
        this.pongDeadlineAt > 0 &&
        Date.now() > this.pongDeadlineAt
      ) {
        this.emit("error", { error: new Error("websocket pong timeout"), recoverable: true });
        this.ws.close(4002, "pong timeout");
        return;
      }
      this.ping();
    }, this.pingIntervalMs);
  }

  private stopPingLoop() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.awaitingPong = false;
    this.lastPingRequestId = null;
    this.pongDeadlineAt = 0;
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.reconnectTimerResolver) {
      const resolve = this.reconnectTimerResolver;
      this.reconnectTimerResolver = null;
      resolve();
    }
  }

  private async scheduleReconnect(code?: number, reason?: string) {
    this.clearReconnectTimer();
    const attempt = this.reconnectAttempt + 1;
    const delay = Math.min(
      this.reconnectBaseDelayMs * 2 ** this.reconnectAttempt,
      this.reconnectMaxDelayMs,
    );
    this.reconnectAttempt = attempt;
    this.state = "reconnecting";
    this.log("schedule reconnect", { attempt, delay, code, reason });
    this.emit("reconnecting", {
      attempt,
      delayMs: delay,
      code,
      reason,
    });
    await new Promise<void>((resolve) => {
      this.reconnectTimerResolver = resolve;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.reconnectTimerResolver = null;
        resolve();
      }, delay);
    });
    if (this.manuallyClosed) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      await new Promise<void>((resolve) => {
        const fallbackTimer = setTimeout(resolve, this.reconnectMaxDelayMs);
        const handleOnline = () => {
          clearTimeout(fallbackTimer);
          globalThis.removeEventListener?.("online", handleOnline);
          resolve();
        };
        globalThis.addEventListener?.("online", handleOnline, { once: true });
      });
      if (this.manuallyClosed) return;
    }
    await this.connect().catch((error) => {
      this.emit("error", { error, recoverable: this.state === "reconnecting" });
    });
  }
}

export const createWebsocketClient = (options?: WebsocketClientOptions) =>
  new WebsocketClient(options);
