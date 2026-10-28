import "dotenv/config";
import "./tracing.js";
import { createLogger } from "@cohub/infra/logging";


import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { httpInstrumentationMiddleware } from "@hono/otel";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { isLocalHarness } from "@cohub/protocol/runtime";
import { sanitizeSessionStatsEvent } from "@cohub/protocol/model";
import type { ContentBlock } from "@cohub/protocol/core";
import { isModelThinkingLevel, MODEL_THINKING_LEVELS } from "@cohub/protocol";
import type {
  RealtimeCompactFrame,
  RealtimeEnvelope,
  RealtimePatchOperation,
  RealtimeRoom,
  RealtimeRoomRejection,
  RealtimeServerEvent,
  WsClientEvent,
} from "@cohub/protocol/realtime";

import type { PlannedGatewayOutboundCommand } from "@cohub/protocol/gateway";
import {
  getRealtimeBoardEventRoom,
  getRealtimeBoardRoom,
  getRealtimeRoom,
  getRealtimeSpaceRoom,
  getRealtimeUserRoom,
  getSessionTurnPatchStreamKey,
  normalizeRealtimeRooms,
  realtimeEnvelopeSchema,
  WS_BOARD_AWARENESS_CAPABILITY,
  WS_COMPACT_STREAM_CAPABILITY,
  WS_ROOM_SUBSCRIPTION_CAPABILITY,
  WS_REALTIME_ROOM_CAPABILITY,
  WS_REALTIME_ROOM_RTC_CAPABILITY,
  WS_REALTIME_ROOM_HISTORY_CAPABILITY,
  wsClientEventSchema,
} from "@cohub/protocol/realtime";
import { getOrCreateRequestId } from "@cohub/infra/tracing";
import {
  ANONYMOUS_IDLE_MS,
  ANONYMOUS_REAUTHORIZE_MS,
  anonymousEnvelope,
  anonymousRoomRequest,
  clientIp,
  createAnonymousAdmission,
} from "./anonymous-viewers.js";
import { authenticateRealtimeToken, authorizeBoardAwareness, authorizeRealtimeRooms, notifySpacePresenceUpdated, requestGatewayChannelReconcile, submitInternalSessionPrompt, InternalPromptError, type RealtimeAuthResult } from "./api-client.js";
import { listenOutboundCommands, initOutboundConsumerGroup } from "./bus.js";
import { summarizeRedisUrl } from "./logging.js";
import { gatewayConfig } from "./config.js";
import { GatewayManager } from "./manager/index.js";
import {
  consumeBoardAwarenessRate,
  hasBoardAwarenessCapacity,
  type BoardAwarenessRate,
} from "./board-awareness-admission.js";
import { markChannelDegraded, touchChannelOutbound } from "./channel-health.js";
import { handleAsrWebSocketConnection } from "./asr/session.js";
import { handleRelayControlConnection, handleRelayDataConnection, handleRelayDataForwardConnection, handleRelayPeerConnection } from "./relay/index.js";
import { closeRuntimeRelay, handleRuntimeConnection, handleRuntimePeer, startRuntimeStopSubscriber } from "./relay/runtime.js";
import {
  createPubSubRedisClient,
  redisCommandClient,
  REALTIME_OUTBOUND_CHANNEL,
  AGENT_REALTIME_PATCH_CHANNEL,
} from "./redis.js";
import { AppRoomError, AppRoomSeatLostError, type AppRoomSeatStatus } from "@cohub/infra/app-room";
import {
  APP_ROOM_MAX_PENDING_OPS,
  type AppRoomPresenceRate,
  appRoomStore,
  attachHostedRoomSeat,
  claimAppRoomSeat,
  connectionSeat,
  consumeAppRoomPresenceRate,
  isHostedRoomTicket,
  isHostedRoomMembership,
  releaseAppRoomSeat,
  renewAppRoomSeat,
} from "./app-room.js";

const logger = createLogger({ serviceName: "cohub-gateway" });
type WsConnectionContext = {
  connectionId: string;
  ip: string;
  anonymous?: { idleSince: number };
  userId?: string;
  userName?: string;
  userAvatarUrl?: string;
  token?: string;
  capabilities: Set<string>;
  rooms: Set<RealtimeRoom>;
  presenceMetaBySpace: Map<string, Record<string, unknown> | null>;
  compactStreamAliases: Map<string, string>;
  nextCompactStreamAlias: number;
  boardAwarenessSeqByBoard: Map<string, number>;
  boardAwarenessRate: BoardAwarenessRate;
  boardAwarenessPending: number;
  boardAwarenessTail: Promise<void>;
  appRooms: Map<string, { participantId: string; ticket: string; room: import("@cohub/protocol/realtime").RealtimeRoomDescriptor; hosted?: boolean }>;
  appRoomOpsPending: number;
  appRoomOpsTail: Promise<void>;
  appRoomPresenceRate: AppRoomPresenceRate;
};

type GatewayWsBroadcastPayload = RealtimeServerEvent & {
  rooms?: RealtimeRoom[];
};

const WS_CONNECTION_TTL_SECONDS = 60 * 5;
const WS_MAX_MESSAGE_BYTES = 64 * 1024;
const ROOM_AUTH_CACHE_TTL_MS = 30_000;
const PRESENCE_UPDATE_DEBOUNCE_MS = 200;
const ROOM_AUTH_CACHE_MAX_ENTRIES = 10_000;
const BOARD_AWARENESS_AUTH_TTL_MS = 30_000;

const wsConnections = new Map<string, WsConnectionContext>();
const wsConnectionIdsByRoom = new Map<RealtimeRoom, Set<string>>();
const wsSockets = new Map<string, WebSocket>();
const roomAuthCache = new Map<string, { expiresAt: number; accepted: boolean; rejection?: RealtimeRoomRejection }>();
const presenceUpdateTimers = new Map<string, ReturnType<typeof setTimeout>>();
const boardAwarenessAuthCache = new Map<string, { expiresAt: number; allowed: boolean }>();

const getWsConnectionKey = (connectionId: string) => `gateway:ws:connection:${connectionId}`;
const getSpacePresenceConnectionsKey = (spaceId: string) => `gateway:presence:space:${spaceId}:connections`;

const getSpaceIdFromRoom = (room: RealtimeRoom) => {
  if (!room.startsWith("space:")) return null;
  const spaceId = room.slice("space:".length).trim();
  return spaceId || null;
};

const getBoardIdFromRoom = (room: RealtimeRoom) => {
  if (!room.startsWith("board:")) return null;
  const boardId = room.slice("board:".length).trim();
  return boardId || null;
};

const canPublishBoardAwareness = async (
  ctx: WsConnectionContext,
  input: { boardId: string; spaceId: string; permission: "view" | "edit" },
) => {
  if (!ctx.token) return false;
  const tokenHash = createHash("sha256").update(ctx.token).digest("base64url");
  const key = `${tokenHash}:${input.spaceId}:${input.boardId}:${input.permission}`;
  const cached = boardAwarenessAuthCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.allowed;
  const allowed = await authorizeBoardAwareness({ authToken: ctx.token, ...input }).catch(() => false);
  boardAwarenessAuthCache.set(key, {
    allowed,
    expiresAt: Date.now() + BOARD_AWARENESS_AUTH_TTL_MS,
  });
  if (boardAwarenessAuthCache.size > ROOM_AUTH_CACHE_MAX_ENTRIES) {
    const oldest = boardAwarenessAuthCache.keys().next().value;
    if (oldest) boardAwarenessAuthCache.delete(oldest);
  }
  return allowed;
};

const scheduleSpacePresenceUpdate = (spaceId: string) => {
  const existing = presenceUpdateTimers.get(spaceId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    presenceUpdateTimers.delete(spaceId);
    notifySpacePresenceUpdated(spaceId).catch((error) => {
      logger.warn("[Gateway] failed to notify space presence update", { spaceId, error });
    });
  }, PRESENCE_UPDATE_DEBOUNCE_MS);
  presenceUpdateTimers.set(spaceId, timer);
};

const writeSpacePresenceConnection = async (ctx: WsConnectionContext, spaceId: string) => {
  if (!ctx.userId) return;
  await redisCommandClient.hset(
    getSpacePresenceConnectionsKey(spaceId),
    ctx.connectionId,
    JSON.stringify({
      connectionId: ctx.connectionId,
      userId: ctx.userId,
      lastSeenAt: Date.now(),
      meta: ctx.presenceMetaBySpace.get(spaceId) ?? null,
    }),
  );
  await redisCommandClient.expire(getSpacePresenceConnectionsKey(spaceId), WS_CONNECTION_TTL_SECONDS).catch(() => undefined);
};

const removeSpacePresenceConnection = async (connectionId: string, spaceId: string) => {
  await redisCommandClient.hdel(getSpacePresenceConnectionsKey(spaceId), connectionId).catch(() => undefined);
};

function logStartupInfo() {
  logger.info("=".repeat(60));
  logger.info("[Gateway] Starting with configuration:");
  logger.info(`  NODE_ID: ${process.env.POD_NAME || process.env.HOSTNAME || "unknown"}`);
  logger.info(`  ENV: ${process.env.ENV || "unknown"}`);
  logger.info(`  DEBUG_MODE: ${process.env.DEBUG_MODE || "false"}`);
  logger.info("  REDIS_URL", { redis: summarizeRedisUrl(process.env.REDIS_URL) });
  logger.info(`  API_BASE_URL: ${gatewayConfig.apiBaseUrl}`);
  logger.info(`  PORT: ${gatewayConfig.port}`);
  logger.info("=".repeat(60));
}

const subscribeConnectionToRoom = (ctx: WsConnectionContext, room: RealtimeRoom) => {
  if (ctx.rooms.has(room)) return;
  ctx.rooms.add(room);
  let connectionIds = wsConnectionIdsByRoom.get(room);
  if (!connectionIds) {
    connectionIds = new Set<string>();
    wsConnectionIdsByRoom.set(room, connectionIds);
  }
  connectionIds.add(ctx.connectionId);
  const spaceId = getSpaceIdFromRoom(room);
  if (spaceId) {
    void writeSpacePresenceConnection(ctx, spaceId)
      .then(() => scheduleSpacePresenceUpdate(spaceId))
      .catch((error) => logger.warn("[Gateway] failed to write space presence", { spaceId, error }));
  }
};

const unsubscribeConnectionFromRoom = (ctx: WsConnectionContext, room: RealtimeRoom) => {
  const hadRoom = ctx.rooms.delete(room);
  const connectionIds = wsConnectionIdsByRoom.get(room);
  if (connectionIds) {
    connectionIds.delete(ctx.connectionId);
    if (connectionIds.size === 0) wsConnectionIdsByRoom.delete(room);
  }
  const spaceId = hadRoom ? getSpaceIdFromRoom(room) : null;
  if (spaceId) {
    void removeSpacePresenceConnection(ctx.connectionId, spaceId)
      .then(() => scheduleSpacePresenceUpdate(spaceId))
      .catch((error) => logger.warn("[Gateway] failed to remove space presence", { spaceId, error }));
  }
};

const unsubscribeConnectionFromAllRooms = (ctx: WsConnectionContext) => {
  for (const room of [...ctx.rooms]) unsubscribeConnectionFromRoom(ctx, room);
};

const persistWsConnection = async (ctx: WsConnectionContext) => {
  await redisCommandClient.set(getWsConnectionKey(ctx.connectionId), JSON.stringify({
    connectionId: ctx.connectionId,
    userId: ctx.userId ?? null,
    userName: ctx.userName ?? null,
    userAvatarUrl: ctx.userAvatarUrl ?? null,
    capabilities: [...ctx.capabilities],
    rooms: [...ctx.rooms],
    connectedAt: Date.now(),
    nodeId: process.env.POD_NAME || process.env.HOSTNAME || "unknown",
  }), "EX", WS_CONNECTION_TTL_SECONDS);
};

const releaseAppRoomMemberships = async (ctx: WsConnectionContext) => {
  for (const roomId of [...ctx.appRooms.keys()]) {
    await releaseAppRoomSeat(ctx, roomId).catch((error) => {
      logger.warn("[Gateway] failed to release App room seat", { roomId, connectionId: ctx.connectionId, error });
    });
    unsubscribeConnectionFromRoom(ctx, getRealtimeRoom(roomId));
  }
};

const anonymousAdmission = createAnonymousAdmission();

const leaveAnonymous = (ctx: WsConnectionContext) => {
  if (!ctx.anonymous) return;
  ctx.anonymous = undefined;
  anonymousAdmission.release(ctx.ip);
};

/**
 * Release everything the previous identity held before adopting a new one:
 * room publishes authorize against the stored membership, so a leftover entry
 * would let the new identity publish into the previous identity's rooms.
 */
const resetConnectionIdentity = async (ctx: WsConnectionContext) => {
  await releaseAppRoomMemberships(ctx);
  unsubscribeConnectionFromAllRooms(ctx);
  ctx.compactStreamAliases.clear();
  ctx.presenceMetaBySpace.clear();
  ctx.boardAwarenessSeqByBoard.clear();
  ctx.userId = undefined;
  ctx.userName = undefined;
  ctx.userAvatarUrl = undefined;
  ctx.token = undefined;
};

const adoptAnonymousIdentity = async (ctx: WsConnectionContext, socket: WebSocket, requestId?: string) => {
  if (!ctx.anonymous && !anonymousAdmission.admit(ctx.ip)) {
    sendWsError(socket, "TOO_MANY_CONNECTIONS", "too many anonymous connections", requestId);
    socket.close(1008, "too many anonymous connections");
    return;
  }
  ctx.anonymous = { idleSince: Date.now() };
  await resetConnectionIdentity(ctx);
  if (wsConnections.get(ctx.connectionId) !== ctx) return;
  ctx.capabilities = new Set([WS_ROOM_SUBSCRIPTION_CAPABILITY]);
  await persistWsConnection(ctx);
  sendWsEnvelope(socket, buildRealtimeEnvelope({
    domain: "system",
    type: "system.auth.ok",
    requestId: requestId ?? null,
    payload: { connectionId: ctx.connectionId, user: null, anonymous: true, capabilities: [WS_ROOM_SUBSCRIPTION_CAPABILITY] },
  }));
};

const cleanupWsConnection = async (ctx: WsConnectionContext | undefined) => {
  if (!ctx) return;
  leaveAnonymous(ctx);
  unsubscribeConnectionFromAllRooms(ctx);
  await releaseAppRoomMemberships(ctx);
  wsSockets.delete(ctx.connectionId);
  wsConnections.delete(ctx.connectionId);
  await redisCommandClient.del(getWsConnectionKey(ctx.connectionId)).catch(() => undefined);
};

const sendWsEnvelope = (socket: WebSocket, envelope: RealtimeEnvelope) => {
  socket.send(JSON.stringify(envelope));
};

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const getPatchStreamId = (envelope: RealtimeEnvelope) => {
  if (envelope.type !== "session.turn.patch") return null;
  return getSessionTurnPatchStreamKey(envelope.payload);
};

const getPersistedTurnId = (envelope: RealtimeEnvelope) => {
  if (envelope.type !== "session.message.persisted") return null;
  const message = envelope.payload.message;
  if (!message || typeof message !== "object") return null;
  const meta = (message as { meta?: Record<string, unknown> | null }).meta;
  return typeof meta?.turnId === "string" && meta.turnId.trim()
    ? meta.turnId
    : null;
};

const buildCompactFrame = (envelope: RealtimeEnvelope, sid: string): RealtimeCompactFrame | null => {
  if (envelope.type !== "session.turn.patch") return null;
  const payload = envelope.payload as Record<string, unknown>;
  if (!isNonNegativeInteger(payload.seq) || !isNonNegativeInteger(payload.baseSeq)) return null;
  if (payload.baseSeq === 0) return null;
  if (!Array.isArray(payload.ops) || payload.ops.length !== 1) return null;

  const op = payload.ops[0] as Partial<RealtimePatchOperation> | undefined;
  if (!op || typeof op !== "object") return null;
  if (!("o" in op) && !("p" in op) && "v" in op) {
    return { t: "d", sid, s: payload.seq, b: payload.baseSeq, v: op.v };
  }
  if (op.o === "append" && typeof op.p === "string" && "v" in op) {
    return {
      t: "p",
      sid,
      s: payload.seq,
      b: payload.baseSeq,
      o: "append",
      p: op.p,
      v: op.v,
    };
  }
  return null;
};

const getOrCreateCompactStreamAlias = (ctx: WsConnectionContext, streamId: string) => {
  const existing = ctx.compactStreamAliases.get(streamId);
  if (existing) return existing;
  ctx.nextCompactStreamAlias += 1;
  const alias = ctx.nextCompactStreamAlias.toString(36);
  ctx.compactStreamAliases.set(streamId, alias);
  return alias;
};

const withCompactStreamMetadata = (
  envelope: RealtimeEnvelope,
  sid: string,
): RealtimeEnvelope => ({
  ...envelope,
  payload: {
    ...envelope.payload,
    _rt: { sid },
  },
});

const rememberRealtimeEnvelopeForConnection = (
  ctx: WsConnectionContext | undefined,
  envelope: RealtimeEnvelope,
) => {
  if (!ctx) return;
  const patchStreamId = getPatchStreamId(envelope);
  if (patchStreamId) {
    getOrCreateCompactStreamAlias(ctx, patchStreamId);
    return;
  }
  const persistedTurnId = getPersistedTurnId(envelope);
  if (persistedTurnId) ctx.compactStreamAliases.delete(persistedTurnId);
};

const sendWsRealtime = (
  socket: WebSocket,
  ctx: WsConnectionContext | undefined,
  envelope: RealtimeEnvelope,
) => {
  const streamId = ctx ? getPatchStreamId(envelope) : null;
  const canUseCompact = Boolean(
    ctx?.capabilities.has(WS_COMPACT_STREAM_CAPABILITY) && streamId,
  );
  const existingSid = canUseCompact && ctx && streamId
    ? ctx.compactStreamAliases.get(streamId)
    : null;
  if (ctx && streamId && existingSid) {
    const compactFrame = buildCompactFrame(envelope, existingSid);
    if (compactFrame) {
      socket.send(JSON.stringify(compactFrame));
      return;
    }
  }
  const envelopeToSend = ctx && streamId && canUseCompact
    ? withCompactStreamMetadata(envelope, getOrCreateCompactStreamAlias(ctx, streamId))
    : envelope;
  sendWsEnvelope(socket, envelopeToSend);
  rememberRealtimeEnvelopeForConnection(ctx, envelope);
};

const buildRealtimeEnvelope = (input: Omit<RealtimeEnvelope, "id" | "timestamp">): RealtimeEnvelope => ({
  id: randomUUID(),
  timestamp: Date.now(),
  ...input,
});

const sendWsError = (
  socket: WebSocket,
  code: string,
  message: string,
  requestId?: string,
  options?: { spaceId?: string | null; sessionId?: string | null; clientMessageId?: string | null },
) => {
  const isSessionScoped = Boolean(options?.sessionId);
  sendWsEnvelope(socket, buildRealtimeEnvelope({
    domain: isSessionScoped ? "session" : "system",
    type: isSessionScoped ? "session.request.error" : "system.request.error",
    requestId: requestId ?? null,
    spaceId: options?.spaceId ?? null,
    sessionId: options?.sessionId ?? null,
    payload: isSessionScoped
      ? { code, message, clientMessageId: options?.clientMessageId ?? null }
      : { code, message },
  }));
};

const publishBoardAwareness = async (
  ctx: WsConnectionContext,
  socket: WebSocket,
  payload: Extract<WsClientEvent, { type: "board.awareness.update" }>["payload"],
  requestId?: string,
) => {
  const { boardId, spaceId, seq, update } = payload;
  if (!ctx.userId || !ctx.capabilities.has(WS_BOARD_AWARENESS_CAPABILITY)) {
    sendWsError(socket, "UNSUPPORTED_CAPABILITY", "Board awareness is not enabled", requestId);
    return;
  }
  if (!ctx.rooms.has(getRealtimeBoardRoom(boardId))) {
    sendWsError(socket, "SUBSCRIPTION_REQUIRED", "Join the Board room before publishing awareness", requestId);
    return;
  }
  const previousSeq = ctx.boardAwarenessSeqByBoard.get(boardId) ?? -1;
  if (seq <= previousSeq) return;

  const permission = update.type === "state" ? "view" : "edit";
  const allowed = await canPublishBoardAwareness(ctx, { boardId, spaceId, permission });
  if (!allowed) {
    sendWsError(socket, "FORBIDDEN", `Missing Board ${permission} permission`, requestId);
    return;
  }

  ctx.boardAwarenessSeqByBoard.set(boardId, seq);
  const envelope = buildRealtimeEnvelope({
    domain: "space",
    type: "board.awareness.updated",
    requestId: requestId ?? null,
    spaceId,
    sessionId: null,
    rooms: [getRealtimeBoardRoom(boardId)],
    payload: {
      boardId,
      connectionId: ctx.connectionId,
      actorId: ctx.userId,
      actorName: ctx.userName?.trim() || "Collaborator",
      seq,
      update,
    },
  });
  await redisCommandClient.publish(REALTIME_OUTBOUND_CHANNEL, JSON.stringify(envelope));
};

class WsClientInputError extends Error {
  readonly requestId?: string;

  constructor(message: string, requestId?: string) {
    super(message);
    this.name = "WsClientInputError";
    this.requestId = requestId;
  }
}

const getWsRequestId = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const requestId = (value as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? requestId : undefined;
};

const formatWsValidationError = (issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }>) => {
  const details = issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue.message}`;
  }).join("; ");
  return details ? `invalid websocket message: ${details}` : "invalid websocket message";
};

const parseWsJson = (value: string): WsClientEvent => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new WsClientInputError("invalid JSON");
  }

  const requestId = getWsRequestId(parsed);
  const result = wsClientEventSchema.safeParse(parsed);
  if (!result.success) {
    throw new WsClientInputError(formatWsValidationError(result.error.issues), requestId);
  }
  return result.data as WsClientEvent;
};

const touchWsConnection = async (ctx: WsConnectionContext) => {
  await redisCommandClient.expire(getWsConnectionKey(ctx.connectionId), WS_CONNECTION_TTL_SECONDS).catch(() => undefined);
  const spaceIds = [...ctx.rooms]
    .map(getSpaceIdFromRoom)
    .filter((spaceId): spaceId is string => Boolean(spaceId));
  if (spaceIds.length === 0 || !ctx.userId) return;
  await Promise.all(spaceIds.map((spaceId) => writeSpacePresenceConnection(ctx, spaceId))).catch(() => undefined);
};

/**
 * Single teardown path for a lost membership, reached from the heartbeat or from
 * whichever operation noticed first, so the client is always unsubscribed and told.
 */
const closeAppRoomMembership = async (
  ctx: WsConnectionContext,
  socket: WebSocket,
  roomId: string,
  status: Exclude<AppRoomSeatStatus, "active">,
) => {
  const membership = ctx.appRooms.get(roomId);
  if (!membership) return;
  ctx.appRooms.delete(roomId);
  unsubscribeConnectionFromRoom(ctx, getRealtimeRoom(roomId));
  // Only "revoked" leaves peers with a stale member list: "expired" means the room is
  // gone, "superseded" means the participant is still there on a newer connection.
  if (status === "revoked" && !membership.hosted) {
    await appRoomStore.announce({
      roomId,
      type: "realtime.room.member.left",
      payload: { roomId, member: { participantId: membership.participantId } },
    }).catch((error) => {
      logger.warn("[Gateway] failed to announce App room seat loss", { roomId, connectionId: ctx.connectionId, error });
    });
  }
  sendWsEnvelope(socket, buildRealtimeEnvelope({
    domain: "room",
    type: "realtime.room.closed",
    rooms: [getRealtimeRoom(roomId)],
    payload: { roomId, reason: status },
  }));
};

const touchAppRoomMemberships = async (ctx: WsConnectionContext, socket: WebSocket) => {
  for (const roomId of [...ctx.appRooms.keys()]) {
    // Fail open on Redis errors: a transient failure should not tear down a live room.
    const status = await renewAppRoomSeat(ctx, roomId).catch(() => "active" as const);
    if (status === "active") {
      // Announce peers whose lease lapsed without a clean close, so a crashed
      // gateway or an idle CLI seat does not linger in everyone's member list.
      await appRoomStore.sweep(roomId).catch((error) => {
        logger.warn("[Gateway] failed to sweep app room leases", { roomId, connectionId: ctx.connectionId, error });
      });
      continue;
    }
    await closeAppRoomMembership(ctx, socket, roomId, status);
  }
};

/**
 * Room-domain so a client can tell which of its rooms failed. A fire-and-forget
 * publish has no requestId, so a system-domain error would be unroutable.
 */
const sendAppRoomError = (
  socket: WebSocket,
  roomId: string,
  code: string,
  message: string,
  requestId?: string,
) => {
  sendWsEnvelope(socket, buildRealtimeEnvelope({
    domain: "room",
    type: "realtime.room.request.error",
    requestId: requestId ?? null,
    roomId,
    rooms: [getRealtimeRoom(roomId)],
    payload: { roomId, code, message },
  }));
};

const failAppRoomOp = async (
  ctx: WsConnectionContext,
  socket: WebSocket,
  roomId: string,
  fallback: string,
  error: unknown,
  requestId?: string,
) => {
  const message = error instanceof Error ? error.message : "room request failed";
  const code = error instanceof AppRoomError
    ? error.code
    : error instanceof AppRoomSeatLostError
      ? (error.status === "expired" ? "ROOM_EXPIRED" : "ROOM_MEMBERSHIP_STALE")
      : fallback;
  sendAppRoomError(socket, roomId, code, message, requestId);
  if (error instanceof AppRoomSeatLostError) await closeAppRoomMembership(ctx, socket, roomId, error.status);
};

/**
 * Serialises the Redis-mutating room operations of one connection and bounds how
 * many can be waiting, so a client cannot pile up unbounded work. Publishes and
 * presence updates share the queue, which also keeps them ordered relative to
 * each other. The operation reports its own failures; only the depth counter is
 * managed here.
 */
const enqueueAppRoomOp = (
  ctx: WsConnectionContext,
  socket: WebSocket,
  roomId: string,
  requestId: string | undefined,
  label: "publish" | "presence" | "history",
  run: () => Promise<void>,
) => {
  if (ctx.appRoomOpsPending >= APP_ROOM_MAX_PENDING_OPS) {
    sendAppRoomError(socket, roomId, "BACKPRESSURE", `room ${label} queue is full`, requestId);
    return;
  }
  ctx.appRoomOpsPending += 1;
  const queued = ctx.appRoomOpsTail.then(async () => {
    try {
      await run();
    } finally {
      ctx.appRoomOpsPending = Math.max(0, ctx.appRoomOpsPending - 1);
    }
  });
  ctx.appRoomOpsTail = queued.catch(() => undefined);
};

const getRoomAuthCacheKey = (authToken: string | null, room: RealtimeRoom) => {
  if (authToken === null) return `anonymous:${room}`;
  const tokenHash = createHash("sha256").update(authToken).digest("base64url");
  return `${tokenHash}:${room}`;
};

const getCachedRoomAuth = (authToken: string | null, room: RealtimeRoom) => {
  const key = getRoomAuthCacheKey(authToken, room);
  const cached = roomAuthCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    roomAuthCache.delete(key);
    return null;
  }
  return cached;
};

const pruneRoomAuthCache = () => {
  const now = Date.now();
  for (const [key, value] of roomAuthCache) {
    if (value.expiresAt <= now) roomAuthCache.delete(key);
  }
  while (roomAuthCache.size >= ROOM_AUTH_CACHE_MAX_ENTRIES) {
    const firstKey = roomAuthCache.keys().next().value;
    if (!firstKey) break;
    roomAuthCache.delete(firstKey);
  }
};

const setCachedRoomAuth = (authToken: string | null, room: RealtimeRoom, value: { accepted: boolean; rejection?: RealtimeRoomRejection }) => {
  if (roomAuthCache.size >= ROOM_AUTH_CACHE_MAX_ENTRIES) pruneRoomAuthCache();
  roomAuthCache.set(getRoomAuthCacheKey(authToken, room), {
    ...value,
    expiresAt: Date.now() + ROOM_AUTH_CACHE_TTL_MS,
  });
};

const authorizeRooms = async (authToken: string | null, rooms: RealtimeRoom[]) => {
  const accepted: RealtimeRoom[] = [];
  const rejected: RealtimeRoomRejection[] = [];
  const misses: RealtimeRoom[] = [];

  for (const room of rooms) {
    const cached = getCachedRoomAuth(authToken, room);
    if (!cached) {
      misses.push(room);
      continue;
    }
    if (cached.accepted) accepted.push(room);
    else if (cached.rejection) rejected.push(cached.rejection);
  }

  if (misses.length > 0) {
    const result = await authorizeRealtimeRooms({ authToken, rooms: misses });
    accepted.push(...result.rooms);
    rejected.push(...result.rejected);
    for (const room of result.rooms) setCachedRoomAuth(authToken, room, { accepted: true });
    for (const rejection of result.rejected) {
      const room = normalizeRealtimeRooms([rejection.room])[0];
      if (room && rejection.code !== "UNAVAILABLE") setCachedRoomAuth(authToken, room, { accepted: false, rejection });
    }
  }

  return { rooms: accepted, rejected };
};

const authorizeRoomsForConnection = async (ctx: WsConnectionContext, rooms: RealtimeRoom[]) => {
  if (ctx.anonymous) {
    const { boards, rejected } = anonymousRoomRequest(rooms, ctx.rooms);
    const result = boards.length > 0 ? await authorizeRooms(null, boards) : { rooms: [], rejected: [] };
    return { rooms: result.rooms, rejected: [...rejected, ...result.rejected] };
  }
  if (!ctx.token) throw new Error("authentication required");
  return authorizeRooms(ctx.token, rooms);
};

const startAnonymousReauthorization = () => {
  setInterval(async () => {
    const followers = new Map<RealtimeRoom, WsConnectionContext[]>();
    for (const ctx of wsConnections.values()) {
      if (!ctx.anonymous) continue;
      for (const room of ctx.rooms) {
        const list = followers.get(room);
        if (list) list.push(ctx);
        else followers.set(room, [ctx]);
      }
    }
    if (followers.size === 0) return;
    const { rejected } = await authorizeRooms(null, [...followers.keys()]).catch((error) => {
      logger.warn("[Gateway] Anonymous Board reauthorization failed", { error });
      return { rejected: [] as RealtimeRoomRejection[] };
    });
    for (const rejection of rejected) {
      const room = normalizeRealtimeRooms([rejection.room])[0];
      if (!room || rejection.code === "UNAVAILABLE") continue;
      for (const ctx of followers.get(room) ?? []) {
        if (!ctx.anonymous || wsConnections.get(ctx.connectionId) !== ctx) continue;
        unsubscribeConnectionFromRoom(ctx, room);
        if (ctx.anonymous && ctx.rooms.size === 0) ctx.anonymous.idleSince = Date.now();
        void persistWsConnection(ctx).catch(() => undefined);
        const socket = wsSockets.get(ctx.connectionId);
        if (socket) sendWsEnvelope(socket, buildRealtimeEnvelope({
          domain: "system",
          type: "system.subscribe.error",
          requestId: null,
          payload: { rejected: [rejection] },
        }));
      }
    }
  }, ANONYMOUS_REAUTHORIZE_MS);
};

const startWsConnectionSweeper = () => {
  setInterval(async () => {
    const now = Date.now();
    for (const [connectionId, ctx] of wsConnections.entries()) {
      if (ctx.anonymous && ctx.rooms.size === 0 && now - ctx.anonymous.idleSince > ANONYMOUS_IDLE_MS) {
        wsSockets.get(connectionId)?.close(1000, "idle");
        await cleanupWsConnection(ctx);
        continue;
      }
      const raw = await redisCommandClient.get(getWsConnectionKey(connectionId)).catch(() => null);
      if (raw) continue;
      const socket = wsSockets.get(connectionId);
      if (socket && socket.readyState === socket.OPEN) {
        socket.close(4001, `expired:${now}`);
      }
      await cleanupWsConnection(ctx);
    }
  }, 30_000);
};

const resolveRealtimeRoomsForEnvelope = (payload: GatewayWsBroadcastPayload): RealtimeRoom[] => {
  const payloadRecord = (payload.payload ?? {}) as Record<string, unknown>;
  const explicitRooms = normalizeRealtimeRooms(Array.isArray(payload.rooms) ? payload.rooms : []);
  if (explicitRooms.length > 0) return explicitRooms;
  const boardRoom = getRealtimeBoardEventRoom(payload);
  if (boardRoom) return [boardRoom];

  if (typeof payload.spaceId === "string" && payload.spaceId.trim()) {
    return [getRealtimeSpaceRoom(payload.spaceId.trim())];
  }

  const task = payloadRecord.task;
  if (task && typeof task === "object") {
    const taskRecord = task as { spaceId?: unknown; userId?: unknown };
    if (typeof taskRecord.spaceId === "string" && taskRecord.spaceId.trim()) {
      return [getRealtimeSpaceRoom(taskRecord.spaceId.trim())];
    }
    if (typeof taskRecord.userId === "string" && taskRecord.userId.trim()) {
      return [getRealtimeUserRoom(taskRecord.userId.trim())];
    }
  }

  const userId = typeof payloadRecord.userId === "string" ? payloadRecord.userId.trim() : "";
  return userId ? [getRealtimeUserRoom(userId)] : [];
};

async function fanOutBroadcastToLocalSockets(payload: GatewayWsBroadcastPayload) {
  const envelope = sanitizeSessionStatsEvent(payload as RealtimeEnvelope);
  const deliveredConnectionIds = new Set<string>();

  const deliverConnection = (connectionId: string) => {
    if (deliveredConnectionIds.has(connectionId)) return;
    const socket = wsSockets.get(connectionId);
    if (!socket) return;
    deliveredConnectionIds.add(connectionId);
    const ctx = wsConnections.get(connectionId);
    const visible = ctx?.anonymous ? anonymousEnvelope(envelope) : envelope;
    if (!visible) return;
    sendWsRealtime(socket, ctx, visible);
    if (ctx && envelope.type === "realtime.room.member.left") {
      const roomId = (envelope.payload as { roomId?: unknown }).roomId;
      const participantId = (envelope.payload as { member?: { participantId?: unknown } }).member?.participantId;
      if (typeof roomId === "string" && isHostedRoomMembership(ctx, roomId) && ctx.appRooms.get(roomId)?.participantId === participantId) {
        void closeAppRoomMembership(ctx, socket, roomId, "revoked");
      }
    }
  };

  for (const room of resolveRealtimeRoomsForEnvelope(payload)) {
    const connectionIds = wsConnectionIdsByRoom.get(room);
    if (!connectionIds) continue;
    for (const connectionId of connectionIds) deliverConnection(connectionId);
  }
}

async function startSpaceOutputSubscriber() {
  const client = createPubSubRedisClient();
  if (client.status === "wait") {
    await client.connect();
  }

  await client.subscribe(REALTIME_OUTBOUND_CHANNEL, AGENT_REALTIME_PATCH_CHANNEL);
  client.on("message", (channel, message) => {
    if (![REALTIME_OUTBOUND_CHANNEL, AGENT_REALTIME_PATCH_CHANNEL].includes(channel)) return;
    try {
      const parsed = realtimeEnvelopeSchema.safeParse(JSON.parse(message));
      if (!parsed.success) {
        logger.error("[Gateway] Invalid realtime payload:", parsed.error.issues);
        return;
      }
      void fanOutBroadcastToLocalSockets(parsed.data as GatewayWsBroadcastPayload).catch((error) => {
        logger.error("[Gateway] Failed to fan out realtime payload:", error);
      });
    } catch (error) {
      logger.error("[Gateway] Failed to handle realtime payload:", error);
    }
  });
}

const submitWebsocketSessionMessage = async (ctx: WsConnectionContext, requestId: string | undefined, payload: Record<string, unknown>) => {
  const spaceId = typeof payload.spaceId === "string" ? payload.spaceId.trim() : "";
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
  const clientMessageId = typeof payload.clientMessageId === "string" && payload.clientMessageId.trim()
    ? payload.clientMessageId.trim()
    : randomUUID();
  const content = Array.isArray(payload.content)
    ? payload.content as ContentBlock[]
    : [];
  const model = typeof payload.model === "string" && payload.model.trim()
    ? payload.model.trim()
    : null;
  const provider = typeof payload.provider === "string" && payload.provider.trim()
    ? payload.provider.trim()
    : null;
  const thinkingLevel = typeof payload.thinkingLevel === "string" && payload.thinkingLevel.trim()
    ? payload.thinkingLevel.trim()
    : null;
  // WS schema already validates enum; reject if non-empty but invalid
  if (thinkingLevel && !isModelThinkingLevel(thinkingLevel)) {
    throw new WsClientInputError(`thinkingLevel must be one of: ${MODEL_THINKING_LEVELS.join(", ")}`);
  }

  if (!ctx.userId) throw new WsClientInputError("authentication required");
  if (!spaceId || !sessionId) throw new WsClientInputError("spaceId and sessionId are required");
  if (content.length === 0) throw new WsClientInputError("content is required");

  const effectiveRequestId = getOrCreateRequestId(requestId);
  const result = await submitInternalSessionPrompt({
    spaceId,
    sessionId,
    userId: ctx.userId,
    authToken: ctx.token,
    clientMessageId,
    content,
    source: "websocket",
    model,
    provider,
    harness: isLocalHarness(payload.harness) ? payload.harness : "cohub",
    thinkingLevel,
    context: {
      kind: "websocket",
      requestId: effectiveRequestId,
      connectionId: ctx.connectionId,
    },
  });

  return { ...result, spaceId, sessionId, clientMessageId, requestId: effectiveRequestId };
};

async function main() {
  logStartupInfo();

  startWsConnectionSweeper();
  startAnonymousReauthorization();
  await startSpaceOutputSubscriber();
  await startRuntimeStopSubscriber();

  const reconcileRetryDelaysMs = [1_000, 3_000, 10_000, 30_000];
  let reconcileInFlight = false;
  let pendingReconcileReason: string | null = null;
  let lastChannelReconcileOk = false;
  let lastChannelReconcileAt: number | null = null;
  const sleep = (delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs));
  const requestChannelReconcileOnce = async (reason: string) => {
    for (let attempt = 0; attempt <= reconcileRetryDelaysMs.length; attempt += 1) {
      try {
        const { stats } = await requestGatewayChannelReconcile();
        lastChannelReconcileOk = true;
        lastChannelReconcileAt = Date.now();
        logger.info("[Gateway] Channel reconcile requested", { reason, attempt: attempt + 1, stats });
        return true;
      } catch (error) {
        const retryDelayMs = reconcileRetryDelaysMs[attempt];
        if (retryDelayMs == null) {
          lastChannelReconcileOk = false;
          lastChannelReconcileAt = Date.now();
          logger.error("[Gateway] Failed to request channel reconcile", { reason, attempt: attempt + 1, error });
          return false;
        }
        logger.warn("[Gateway] Failed to request channel reconcile; retrying", { reason, attempt: attempt + 1, retryDelayMs, error });
        await sleep(retryDelayMs);
      }
    }
    return false;
  };

  const requestChannelReconcile = async (reason: string) => {
    if (reconcileInFlight) {
      pendingReconcileReason = pendingReconcileReason ? `${pendingReconcileReason},${reason}` : reason;
      return false;
    }

    reconcileInFlight = true;
    let currentReason = reason;
    let lastResult = false;
    try {
      while (true) {
        lastResult = await requestChannelReconcileOnce(currentReason);
        if (!pendingReconcileReason) break;
        currentReason = pendingReconcileReason;
        pendingReconcileReason = null;
      }
      return lastResult;
    } finally {
      reconcileInFlight = false;
    }
  };

  const manager = new GatewayManager({
    onStaleNodesPruned: (nodeIds) => requestChannelReconcile(`stale_nodes_pruned:${nodeIds.join(",")}`),
  });
  await initOutboundConsumerGroup(manager.nodeId);
  await manager.start();
  void requestChannelReconcile("node_started");

  logger.info("[Gateway] Listening for outbound commands from API...");

  const outboundController = new AbortController();
  const outboundListener = listenOutboundCommands(manager.nodeId, async (cmd: PlannedGatewayOutboundCommand, context) => {
    logger.info("[Gateway] Received outbound command:", {
      commandId: cmd.commandId,
      channelId: cmd.channelId,
      provider: cmd.provider,
      externalChatId: cmd.externalChatId,
      contentPreview: cmd.content.map((c: { type: string }) => c.type).join(", "),
    });

    const provider = manager.getProvider(cmd.channelId);
    if (!provider) {
      logger.warn(`[Gateway] Command rejected: provider not found for channel ${cmd.channelId}`);
      logger.warn(`[Gateway] Active channels: ${manager.getActiveChannelIds().join(", ") || "none"}`);
      // Routing flap — don't thrash channel health to degraded.
      return { success: false, deferred: true, error: `Provider not found for channel ${cmd.channelId}` };
    }

    logger.info(`[Gateway] Routing command ${cmd.commandId} to ${cmd.provider} provider`);
    try {
      const result = await provider.handleOutbound(cmd, context);
      if (result.success) {
        // Only stamp outbound activity when a message was actually delivered.
        if (result.externalMessageId) {
          void touchChannelOutbound(cmd.channelId).catch(() => undefined);
        }
      } else {
        void markChannelDegraded(cmd.channelId, result.error ?? "Outbound failed").catch(() => undefined);
      }
      logger.info(`[Gateway] Command ${cmd.commandId} result:`, result.success ? "success" : `failed: ${result.error}`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[Gateway] Command ${cmd.commandId} threw:`, error);
      void markChannelDegraded(cmd.channelId, message).catch(() => undefined);
      throw error;
    }
  }, outboundController.signal).catch((error) => {
    logger.error("[Gateway] Fatal error listening to outbound stream:", error);
  });

  const app = new Hono();
  app.use(
    "*",
    httpInstrumentationMiddleware({
      serviceName: "cohub-gateway",
    }),
  );
  app.use("*", cors());

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/readyz", async (c) => {
    const checks: Record<string, boolean> = {};
    try {
      await redisCommandClient.ping();
      checks.redis = true;
    } catch {
      checks.redis = false;
    }
    checks.manager = manager.started;
    return c.json({
      ready: Object.values(checks).every(Boolean),
      checks,
      channelReconcile: {
        ok: lastChannelReconcileOk,
        inFlight: reconcileInFlight,
        pendingReason: pendingReconcileReason,
        checkedAt: lastChannelReconcileAt,
      },
    }, Object.values(checks).every(Boolean) ? 200 : 503);
  });

  const server = serve({ fetch: app.fetch, port: gatewayConfig.port }) as unknown as import("node:http").Server;
  const wss = new WebSocketServer({ noServer: true });
  const asrWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  // Local sandbox relay: control (runner⇒gateway), data (runner dial-out), and
  // peer (agent/worker⇒gateway) channels. Large payloads flow on data channels.
  const relayControlWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const relayDataWss = new WebSocketServer({ noServer: true, maxPayload: 50 * 1024 * 1024 });
  const relayPeerWss = new WebSocketServer({ noServer: true, maxPayload: 50 * 1024 * 1024 });
  const runtimeWss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

  const websocketRoutes = new Map<string, WebSocketServer>([
    ["/ws", wss],
    ["/asr/ws", asrWss],
    ["/sandbox/relay", relayControlWss],
    ["/sandbox/relay/data", relayDataWss],
    ["/runtime/relay", runtimeWss],
  ]);

  // Match /internal/sandbox-relay/:spaceId for cloud peers.
  const RELAY_PEER_PREFIX = "/internal/sandbox-relay/";

  server.on("upgrade", (request, socket, head) => {
    const pathname = request.url ? new URL(request.url, "http://localhost").pathname : "";

    if (/^\/internal\/runtime-relay\/[0-9a-f-]{36}$/.test(pathname)) {
      const spaceId = pathname.slice("/internal/runtime-relay/".length);
      runtimeWss.handleUpgrade(request, socket, head, (websocket) => handleRuntimePeer(websocket, request, spaceId));
      return;
    }

    if (pathname.startsWith(RELAY_PEER_PREFIX)) {
      const spaceId = decodeURIComponent(pathname.slice(RELAY_PEER_PREFIX.length)).trim();
      if (!spaceId) {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      relayPeerWss.handleUpgrade(request, socket, head, (websocket) => {
        handleRelayPeerConnection(websocket, request, spaceId);
      });
      return;
    }

    // Cross-replica forward of a runner data dial toward the pod holding the
    // pending peer. Same upgrade surface as the data route; the worker-secret
    // gate lives in the handler itself.
    const forwardChannel = /^\/internal\/sandbox-relay-forward\/([0-9a-f-]{36})$/.exec(pathname)?.[1];
    if (forwardChannel) {
      relayDataWss.handleUpgrade(request, socket, head, (websocket) => {
        handleRelayDataForwardConnection(websocket, request);
      });
      return;
    }

    const websocketServer = websocketRoutes.get(pathname);
    if (!websocketServer) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });

  runtimeWss.on("connection", (socket, request) => handleRuntimeConnection(socket, request));
  asrWss.on("connection", handleAsrWebSocketConnection);
  relayControlWss.on("connection", (socket, request) => void handleRelayControlConnection(socket, request));
  relayDataWss.on("connection", (socket, request) => handleRelayDataConnection(socket, request));

  wss.on("connection", (socket: WebSocket, request?: IncomingMessage) => {
    const connectionId = randomUUID();
    const ctx: WsConnectionContext = {
      connectionId,
      ip: clientIp(request),
      capabilities: new Set(),
      rooms: new Set(),
      presenceMetaBySpace: new Map(),
      compactStreamAliases: new Map(),
      nextCompactStreamAlias: 0,
      boardAwarenessSeqByBoard: new Map(),
      boardAwarenessRate: { startedAt: Date.now(), count: 0 },
      boardAwarenessPending: 0,
      boardAwarenessTail: Promise.resolve(),
      appRooms: new Map(),
      appRoomOpsPending: 0,
      appRoomOpsTail: Promise.resolve(),
      appRoomPresenceRate: { startedAt: Date.now(), count: 0 },
    };
    wsConnections.set(connectionId, ctx);
    wsSockets.set(connectionId, socket);
    sendWsEnvelope(socket, buildRealtimeEnvelope({
      domain: "system",
      type: "system.ready",
      payload: { connectionId },
    }));

    socket.on("message", async (data: RawData) => {
      let requestId: string | undefined;
      try {
        const raw = typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf-8")
            : Array.isArray(data)
              ? Buffer.concat(data.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).toString("utf-8")
              : Buffer.from(data).toString("utf-8");
        if (Buffer.byteLength(raw, "utf-8") > WS_MAX_MESSAGE_BYTES) {
          sendWsError(socket, "MESSAGE_TOO_LARGE", "message too large");
          return;
        }

        const message = parseWsJson(raw);
        requestId = typeof message.requestId === "string" ? message.requestId : undefined;

        if (message.type === "ping") {
          await touchWsConnection(ctx);
          await touchAppRoomMemberships(ctx, socket);
          sendWsEnvelope(socket, buildRealtimeEnvelope({
            domain: "system",
            type: "system.pong",
            requestId: requestId ?? null,
            payload: {},
          }));
          return;
        }

        if (message.type === "auth") {
          if ("anonymous" in message.payload) {
            await adoptAnonymousIdentity(ctx, socket, requestId);
            return;
          }
          const token = message.payload.token.trim();
          if (!token) {
            sendWsError(socket, "UNAUTHORIZED", "token is required", requestId);
            return;
          }
          const result: RealtimeAuthResult = await authenticateRealtimeToken({ token });
          if (!result.ok) {
            sendWsError(socket, "UNAUTHORIZED", result.error.message, requestId);
            return;
          }
          leaveAnonymous(ctx);
          await resetConnectionIdentity(ctx);
          ctx.userId = result.user.uuid;
          ctx.userName = typeof result.user.nick_name === "string" ? result.user.nick_name : undefined;
          ctx.userAvatarUrl = typeof result.user.avatar_url === "string" ? result.user.avatar_url : undefined;
          ctx.token = token;
          ctx.capabilities = new Set(
            Array.isArray(message.payload.capabilities)
              ? message.payload.capabilities.filter((value) => typeof value === "string" && value.trim())
              : [],
          );
          subscribeConnectionToRoom(ctx, getRealtimeUserRoom(result.user.uuid));
          await persistWsConnection(ctx);
          sendWsEnvelope(socket, buildRealtimeEnvelope({
            domain: "system",
            type: "system.auth.ok",
            requestId: requestId ?? null,
            payload: { connectionId, user: result.user, capabilities: [WS_ROOM_SUBSCRIPTION_CAPABILITY, WS_BOARD_AWARENESS_CAPABILITY, WS_REALTIME_ROOM_CAPABILITY, WS_REALTIME_ROOM_RTC_CAPABILITY, WS_REALTIME_ROOM_HISTORY_CAPABILITY] },
          }));
          return;
        }

        const anonymousRooms = ctx.anonymous && (message.type === "subscribe" || message.type === "unsubscribe");
        if (!anonymousRooms && (!ctx.userId || !ctx.token)) {
          sendWsError(socket, "UNAUTHORIZED", "authentication required", requestId);
          return;
        }

        await touchWsConnection(ctx);

        if (message.type === "subscribe") {
          const rooms = normalizeRealtimeRooms(message.payload.rooms);
          if (rooms.length === 0) {
            sendWsError(socket, "BAD_REQUEST", "rooms are required", requestId);
            return;
          }
          try {
            const result = await authorizeRoomsForConnection(ctx, rooms);
            for (const room of result.rooms) subscribeConnectionToRoom(ctx, room);
            await persistWsConnection(ctx);
            sendWsEnvelope(socket, buildRealtimeEnvelope({
              domain: "system",
              type: "system.subscribe.ok",
              requestId: requestId ?? null,
              payload: { rooms: result.rooms },
            }));
            if (result.rejected.length > 0) {
              sendWsEnvelope(socket, buildRealtimeEnvelope({
                domain: "system",
                type: "system.subscribe.error",
                requestId: requestId ?? null,
                payload: { rejected: result.rejected },
              }));
            }
          } catch (error) {
            logger.warn("[Gateway] Realtime room authorization failed", { connectionId, error });
            sendWsEnvelope(socket, buildRealtimeEnvelope({
              domain: "system",
              type: "system.subscribe.error",
              requestId: requestId ?? null,
              payload: {
                rejected: rooms.map((room) => ({
                  room,
                  code: "UNAVAILABLE",
                  message: "Failed to authorize realtime room",
                })),
              },
            }));
          }
          return;
        }

        if (message.type === "unsubscribe") {
          for (const room of normalizeRealtimeRooms(message.payload.rooms)) {
            if (ctx.userId && room === getRealtimeUserRoom(ctx.userId)) continue;
            const boardId = getBoardIdFromRoom(room);
            if (boardId) ctx.boardAwarenessSeqByBoard.delete(boardId);
            const spaceId = getSpaceIdFromRoom(room);
            if (spaceId) ctx.presenceMetaBySpace.delete(spaceId);
            unsubscribeConnectionFromRoom(ctx, room);
          }
          if (ctx.anonymous && ctx.rooms.size === 0) ctx.anonymous.idleSince = Date.now();
          await persistWsConnection(ctx);
          sendWsEnvelope(socket, buildRealtimeEnvelope({
            domain: "system",
            type: "system.subscribe.ok",
            requestId: requestId ?? null,
            payload: { rooms: [...ctx.rooms] },
          }));
          return;
        }

        if (message.type === "realtime.room.join") {
          if (!ctx.capabilities.has(WS_REALTIME_ROOM_CAPABILITY)) {
            sendAppRoomError(socket, message.payload.roomId, "UNSUPPORTED_CAPABILITY", "Realtime rooms are not enabled", requestId);
            return;
          }
          const { roomId } = message.payload;
          const roomRef = getRealtimeRoom(roomId);
          let seated = false;
          try {
            // Claim the seat before entering the public routing table, so a connection
            // that never gets a seat (a full room) cannot receive room events meanwhile.
            const hosted = isHostedRoomTicket(message.payload.ticket);
            if (ctx.appRooms.has(roomId)) throw new Error("room is already connected");
            const result = hosted
              ? await attachHostedRoomSeat(ctx, message.payload)
              : await claimAppRoomSeat(ctx, message.payload);
            seated = true;
            subscribeConnectionToRoom(ctx, roomRef);
            // A seatPerUser takeover reuses a seat that peers already know about, so
            // announcing it would show a spurious join and burn a sequence number.
            if (!hosted && (result.isNew || result.droppedPublications)) {
              await appRoomStore.announce({
                roomId,
                type: result.isNew ? "realtime.room.member.joined" : "realtime.room.publications.updated",
                payload: { roomId, member: result.member },
              });
            }
            await persistWsConnection(ctx);
            // Read the snapshot after subscribing: a member that joins in between is then
            // delivered over pub/sub and buffered by the client, rather than missing from
            // both the snapshot and this connection's stream. Its sequence is the client's
            // baseline for dropping deltas it already reflects.
            const snapshot = await appRoomStore.snapshot(roomId);
            const { after } = message.payload;
            const missed = after !== undefined && after < snapshot.sequence
              ? await appRoomStore.history(roomId, { after })
              : undefined;
            sendWsEnvelope(socket, buildRealtimeEnvelope({
              domain: "room",
              type: "realtime.room.joined",
              requestId: requestId ?? null,
              rooms: [roomRef],
              payload: {
                room: result.room,
                participantId: result.member.participantId,
                members: snapshot.members,
                sequence: snapshot.sequence,
                ...(missed ? { missed } : {}),
              },
            }));
          } catch (error) {
            if (seated) {
              await releaseAppRoomSeat(ctx, roomId).catch(() => null);
              unsubscribeConnectionFromRoom(ctx, roomRef);
            }
            await failAppRoomOp(ctx, socket, roomId, "ROOM_JOIN_FAILED", error, requestId);
          }
          return;
        }

        if (message.type === "realtime.room.publish") {
          const { roomId } = message.payload;
          enqueueAppRoomOp(ctx, socket, roomId, requestId, "publish", async () => {
            try {
              const seat = connectionSeat(ctx, roomId);
              if (!seat) throw new AppRoomSeatLostError("room membership is required", "revoked");
              const result = await appRoomStore.publish(seat, { ...message.payload, record: Boolean(requestId) });
              if (requestId) {
                sendWsEnvelope(socket, buildRealtimeEnvelope({
                  domain: "room",
                  type: "realtime.room.request.ok",
                  requestId,
                  roomId,
                  payload: { roomId, sequence: result.sequence, eventId: result.eventId, clientEventId: result.clientEventId },
                }));
              }
            } catch (error) {
              await failAppRoomOp(ctx, socket, roomId, "ROOM_PUBLISH_FAILED", error, requestId);
            }
          });
          return;
        }

        if (message.type === "realtime.room.history") {
          const { roomId, after, limit } = message.payload;
          enqueueAppRoomOp(ctx, socket, roomId, requestId, "history", async () => {
            try {
              if (await renewAppRoomSeat(ctx, roomId) !== "active") throw new AppRoomSeatLostError("room membership is required", "revoked");
              const history = await appRoomStore.history(roomId, { after, limit });
              sendWsEnvelope(socket, buildRealtimeEnvelope({
                domain: "room",
                type: "realtime.room.history",
                requestId: requestId ?? null,
                rooms: [getRealtimeRoom(roomId)],
                payload: { roomId, ...history },
              }));
            } catch (error) {
              await failAppRoomOp(ctx, socket, roomId, "ROOM_HISTORY_FAILED", error, requestId);
            }
          });
          return;
        }

        if (message.type === "realtime.room.presence.update") {
          if (!consumeAppRoomPresenceRate(ctx.appRoomPresenceRate)) {
            sendAppRoomError(socket, message.payload.roomId, "ROOM_PRESENCE_RATE_EXCEEDED", "room presence rate exceeded", requestId);
            return;
          }
          const { roomId, presence } = message.payload;
          enqueueAppRoomOp(ctx, socket, roomId, requestId, "presence", async () => {
            try {
              const seat = connectionSeat(ctx, roomId);
              if (!seat) throw new AppRoomSeatLostError("room membership is required", "revoked");
              const { sequence } = await appRoomStore.setPresence(seat, presence);
              if (requestId) {
                sendWsEnvelope(socket, buildRealtimeEnvelope({
                  domain: "room",
                  type: "realtime.room.request.ok",
                  requestId,
                  roomId,
                  payload: { roomId, sequence },
                }));
              }
            } catch (error) {
              await failAppRoomOp(ctx, socket, roomId, "ROOM_PRESENCE_FAILED", error, requestId);
            }
          });
          return;
        }

        if (message.type === "realtime.room.leave" || message.type === "realtime.room.detach") {
          const { roomId } = message.payload;
          try {
            if (message.type === "realtime.room.detach" && !isHostedRoomMembership(ctx, roomId)) {
              throw new AppRoomSeatLostError("hosted room membership is required", "revoked");
            }
            await releaseAppRoomSeat(ctx, roomId, { releaseHosted: message.type === "realtime.room.leave" });
            unsubscribeConnectionFromRoom(ctx, getRealtimeRoom(roomId));
            await persistWsConnection(ctx);
            sendWsEnvelope(socket, buildRealtimeEnvelope({
              domain: "room",
              type: "realtime.room.request.ok",
              requestId: requestId ?? null,
              roomId,
              payload: { roomId },
            }));
          } catch (error) {
            await failAppRoomOp(ctx, socket, roomId, "ROOM_LEAVE_FAILED", error, requestId);
          }
          return;
        }

        if (message.type === "presence.update") {
          const spaceId = typeof message.payload.spaceId === "string" ? message.payload.spaceId : "";
          const room = getRealtimeSpaceRoom(spaceId);
          if (!ctx.rooms.has(room)) {
            const result = await authorizeRoomsForConnection(ctx, [room]);
            if (result.rooms.length === 0) {
              sendWsEnvelope(socket, buildRealtimeEnvelope({
                domain: "system",
                type: "system.subscribe.error",
                requestId: requestId ?? null,
                payload: { rejected: result.rejected },
              }));
              return;
            }
            subscribeConnectionToRoom(ctx, room);
            await persistWsConnection(ctx);
          }
          ctx.presenceMetaBySpace.set(spaceId, message.payload.meta ?? null);
          await writeSpacePresenceConnection(ctx, spaceId);
          scheduleSpacePresenceUpdate(spaceId);
          return;
        }

        if (message.type === "board.awareness.update") {
          if (
            !consumeBoardAwarenessRate(ctx.boardAwarenessRate) ||
            !hasBoardAwarenessCapacity(ctx.boardAwarenessPending)
          ) return;

          ctx.boardAwarenessPending += 1;
          const awarenessRun = ctx.boardAwarenessTail.then(() =>
            publishBoardAwareness(ctx, socket, message.payload, requestId),
          );
          ctx.boardAwarenessTail = awarenessRun.catch(() => undefined);
          try {
            await awarenessRun;
          } finally {
            ctx.boardAwarenessPending = Math.max(0, ctx.boardAwarenessPending - 1);
          }
          return;
        }

        if (message.type === "session.message.create") {
          try {
            const result = await submitWebsocketSessionMessage(ctx, requestId, message.payload ?? {});
            sendWsEnvelope(socket, buildRealtimeEnvelope({
              domain: "session",
              type: "session.request.accepted",
              requestId: result.requestId,
              spaceId: result.spaceId,
              sessionId: result.sessionId,
              payload: {
                clientMessageId: result.clientMessageId,
                turnId: result.turnId,
                userMessageId: result.userMessageId,
                traceId: result.trace.traceId,
              },
            }));
          } catch (error) {
            if (error instanceof WsClientInputError) throw error;
            const payload = message.payload ?? {};
            const isBillingError = error instanceof InternalPromptError;
            sendWsEnvelope(socket, buildRealtimeEnvelope({
              domain: "session",
              type: "session.request.error",
              requestId: requestId ?? null,
              spaceId: typeof payload.spaceId === "string" ? payload.spaceId : null,
              sessionId: typeof payload.sessionId === "string" ? payload.sessionId : null,
              payload: {
                code: isBillingError ? error.code : "SUBMIT_FAILED",
                message: error instanceof Error ? error.message : String(error),
                clientMessageId: typeof payload.clientMessageId === "string" ? payload.clientMessageId : null,
                billing: isBillingError ? error.billing : null,
              },
            }));
          }
          return;
        }

        if (message.type === "ack") {
          sendWsEnvelope(socket, buildRealtimeEnvelope({
            domain: "system",
            type: "system.ack.ok",
            requestId: requestId ?? null,
            payload: {},
          }));
          return;
        }

        sendWsError(socket, "UNSUPPORTED_EVENT", "unsupported event type", requestId);
      } catch (error) {
        if (error instanceof WsClientInputError) {
          sendWsError(socket, "BAD_REQUEST", error.message, error.requestId ?? requestId);
          return;
        }
        logger.error("[Gateway] WebSocket message handling failed:", error);
        sendWsError(socket, "INTERNAL_ERROR", "internal error", requestId);
      }
    });

    socket.on("close", () => {
      void cleanupWsConnection(wsConnections.get(connectionId));
    });
    socket.on("error", () => {
      void cleanupWsConnection(wsConnections.get(connectionId));
    });
  });

  logger.info(`@cohub/gateway listening on :${gatewayConfig.port}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("[Gateway] Received shutdown signal, stopping...");
    outboundController.abort();
    const drainTimeout = setTimeout(() => {
      logger.error("[Gateway] Outbound shutdown timed out; unfinished commands remain pending");
      process.exit(1);
    }, 30_000);
    await outboundListener;
    const results = await Promise.allSettled([manager.stop(), closeRuntimeRelay()]);
    clearTimeout(drainTimeout);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) logger.error("[Gateway] Shutdown failed", failed.reason);
    else logger.info("[Gateway] Shutdown complete");
    process.exit(failed ? 1 : 0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  if (process.env.DEBUG_MODE === "true") {
    logger.info("[Gateway] DEBUG_MODE enabled.");

    const startDebugProvider = async (channelId: string, providerType: string, credential: string | { appId: string; appSecret: string; brand?: string }) => {
      logger.info(`[Debug] Initializing test channel: ${channelId} (${providerType})`);

      if (providerType === "discord" && typeof credential === "string") {
        const { DiscordProvider } = await import("./providers/discord/index.js");
        const provider = new DiscordProvider(channelId, credential);
        // @ts-expect-error
        manager.providers.set(channelId, provider);
      } else if (providerType === "feishu" && typeof credential === "object") {
        const { FeishuProvider } = await import("./providers/feishu/index.js");
        const provider = new FeishuProvider(channelId, {
          appId: credential.appId,
          appSecret: credential.appSecret,
          brand: (credential.brand as "feishu" | "lark") ?? "feishu",
        });
        // @ts-expect-error
        manager.providers.set(channelId, provider);
      }
    };

    if (process.env.DEBUG_DISCORD_BOT_TOKEN) {
      await startDebugProvider("debug-discord", "discord", process.env.DEBUG_DISCORD_BOT_TOKEN);
    }
    if (process.env.DEBUG_TELEGRAM_BOT_TOKEN) {
      await startDebugProvider("debug-telegram", "telegram", process.env.DEBUG_TELEGRAM_BOT_TOKEN);
    }
    if (process.env.DEBUG_FEISHU_APP_ID) {
      await startDebugProvider("debug-feishu", "feishu", {
        appId: process.env.DEBUG_FEISHU_APP_ID,
        appSecret: process.env.DEBUG_FEISHU_APP_SECRET ?? "",
        brand: process.env.DEBUG_FEISHU_BRAND ?? "feishu",
      });
    }

  }
}

main().catch((error) => logger.error("[Gateway] main failed", error));
