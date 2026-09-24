import type { ContentBlock } from "../core/content.js";
import type { BillingPayload } from "../billing.js";
import type { MessageRecord, SessionRecord, SessionTurnRecord } from "../model/session.js";
import type { ModelThinkingLevel } from "../model/completion.js";
import type { SessionTurnSummary } from "../model/turn.js";
import type { TaskRunStatus } from "../task/index.js";
import type { SpaceFsChangedPayload } from "../fs/index.js";
import type { SpacePortsChangedPayload } from "../ports/index.js";
import type { BoardMutationReceipt, BoardPlaybackSnapshot } from "../board.js";
import type { BoardComposition } from "../board-composition.js";
import type { BoardEffect } from "../board-effect.js";
import type { RequestSource } from "../provenance.js";
import type { DesktopCommandDispatchedPayload } from "../desktop-command.js";
import type { AppArtifactDescriptor, AppContentKind, AppVersionSource } from "../app.js";
import type {
  BoardAwarenessClientPayload,
  BoardAwarenessUpdate,
} from "./board-awareness.js";

export const WS_COMPACT_STREAM_CAPABILITY = "session.compact_stream.v1";
export const WS_ROOM_SUBSCRIPTION_CAPABILITY = "realtime.rooms.v1";
export const WS_BOARD_AWARENESS_CAPABILITY = "board.awareness.v1";
export const WS_REALTIME_ROOM_CAPABILITY = "realtime.room.v1";
export const REALTIME_OUTBOUND_CHANNEL = "pubsub:realtime:outbound";
export const AGENT_REALTIME_PATCH_CHANNEL = "pubsub:realtime:agent_patches";
export const REALTIME_ROOM_KEY_PREFIX = "cohub:realtime-room:v1";

export const REALTIME_DOMAINS = ["system", "session", "space", "label", "room", "ui", "desktop"] as const;
export type RealtimeDomain = (typeof REALTIME_DOMAINS)[number];

export const isRealtimeDomain = (value: unknown): value is RealtimeDomain =>
  typeof value === "string" && REALTIME_DOMAINS.some((domain) => domain === value);

/** Accepted room event names. Shared so a client can reject one before sending. */
export const REALTIME_ROOM_EVENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** Maximum encoded size of a room event payload. */
export const REALTIME_ROOM_MAX_PAYLOAD_BYTES = 16 * 1024;

export const getRealtimeRoomMetaKey = (roomId: string) => `${REALTIME_ROOM_KEY_PREFIX}:room:${roomId}`;
export const getRealtimeRoomCodeKey = (appId: string, code: string) => `${REALTIME_ROOM_KEY_PREFIX}:code:${appId}:${code}`;
export const getRealtimeRoomMembersKey = (roomId: string) => `${REALTIME_ROOM_KEY_PREFIX}:room:${roomId}:members`;
export const getRealtimeRoomLeasesKey = (roomId: string) => `${REALTIME_ROOM_KEY_PREFIX}:room:${roomId}:leases`;
export const getRealtimeRoomSequenceKey = (roomId: string) => `${REALTIME_ROOM_KEY_PREFIX}:room:${roomId}:sequence`;
export const getRealtimeRoomRateKey = (roomId: string) => `${REALTIME_ROOM_KEY_PREFIX}:room:${roomId}:rate`;
export const getRealtimeRoomIndexKey = (appId: string) => `${REALTIME_ROOM_KEY_PREFIX}:app:${appId}:rooms`;

export type RealtimeRoom =
  | `space:${string}`
  | `user:${string}`
  | `board:${string}`
  | `room:${string}`;

export const getRealtimeSpaceRoom = (spaceId: string): RealtimeRoom => `space:${spaceId}`;
export const getRealtimeUserRoom = (userId: string): RealtimeRoom => `user:${userId}`;
export const getRealtimeBoardRoom = (boardId: string): RealtimeRoom => `board:${boardId}`;
export const getRealtimeRoom = (roomId: string): RealtimeRoom => `room:${roomId}`;

export const parseRealtimeRoom = (room: string): { kind: "space" | "user" | "board" | "room"; id: string } | null => {
  const trimmed = room.trim();
  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex <= 0) return null;
  const kind = trimmed.slice(0, separatorIndex);
  const id = trimmed.slice(separatorIndex + 1).trim();
  if (!id) return null;
  if (kind !== "space" && kind !== "user" && kind !== "board" && kind !== "room") return null;
  return { kind, id };
};

export const normalizeRealtimeRooms = (rooms: readonly string[]): RealtimeRoom[] => {
  const normalized = new Set<RealtimeRoom>();
  for (const room of rooms) {
    const parsed = typeof room === "string" ? parseRealtimeRoom(room) : null;
    if (!parsed) continue;
    normalized.add(`${parsed.kind}:${parsed.id}` as RealtimeRoom);
  }
  return [...normalized];
};

export type WsClientEvent =
  | { type: "auth"; requestId?: string; payload: { token: string; capabilities?: string[] } }
  | { type: "subscribe"; requestId?: string; payload: { rooms: string[] } }
  | { type: "unsubscribe"; requestId?: string; payload: { rooms: string[] } }
  | { type: "session.message.create"; requestId?: string; payload: { spaceId: string; sessionId: string; clientMessageId?: string; content: ContentBlock[]; model?: string; provider?: string; harness?: "cohub" | "pi" | "codex"; thinkingLevel?: ModelThinkingLevel } }
  | { type: "presence.update"; requestId?: string; payload: { spaceId: string; meta?: Record<string, unknown> | null } }
  | { type: "board.awareness.update"; requestId?: string; payload: BoardAwarenessClientPayload }
  | { type: "realtime.room.join"; requestId?: string; payload: { roomId: string; ticket: string } }
  | { type: "realtime.room.publish"; requestId?: string; payload: { roomId: string; event: string; data: unknown; clientEventId?: string } }
  | { type: "realtime.room.leave"; requestId?: string; payload: { roomId: string } }
  | { type: "realtime.room.presence.update"; requestId?: string; payload: { roomId: string; presence: Record<string, unknown> | null } }
  | { type: "ping"; requestId?: string; payload?: Record<string, unknown> }
  | { type: "ack"; requestId?: string; payload?: { eventId?: string } };

export type RealtimeEnvelope = {
  id: string;
  timestamp: number;
  domain: RealtimeDomain;
  type: string;
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  roomId?: string | null;
  rooms?: RealtimeRoom[];
  payload: Record<string, unknown>;
};

export type ChannelEnvelope = RealtimeEnvelope;
export type RealtimeEnvelopeBase = RealtimeEnvelope;

export type RealtimeRoomDescriptor = {
  id: string;
  code: string;
  createdAt: string;
  expiresAt: string;
  maxParticipants: number;
  /**
   * When true a viewer holds at most one seat: rejoining from another tab, or
   * after an unclean disconnect, takes over the existing seat instead of
   * consuming a second one. Default false, which gives every connection its own
   * seat (two tabs are two participants).
   */
  seatPerUser: boolean;
};

export type RealtimeRoomMember = {
  participantId: string;
  joinedAt: string;
  presence: Record<string, unknown> | null;
  /**
   * Opaque, stable per room and viewer. Connections of the same viewer share it,
   * so an application can group or de-duplicate participants without seeing the
   * underlying account id.
   */
  userKey?: string;
};

export type RealtimeRoomEvent = {
  id: string;
  timestamp: number;
  domain: "room";
  type: "realtime.room.event";
  requestId?: string | null;
  spaceId?: null;
  sessionId?: null;
  rooms: RealtimeRoom[];
  payload: {
    roomId: string;
    sequence: number;
    event: string;
    data: unknown;
    clientEventId: string | null;
    sender: { participantId: string };
  };
};

export type RealtimeRoomJoinedEvent = {
  id: string;
  timestamp: number;
  domain: "room";
  type: "realtime.room.joined";
  requestId?: string | null;
  spaceId?: null;
  sessionId?: null;
  rooms: RealtimeRoom[];
  payload: {
    room: RealtimeRoomDescriptor;
    participantId: string;
    members: RealtimeRoomMember[];
    sequence: number;
  };
};

export type RealtimeRoomMemberChangedEvent = {
  id: string;
  timestamp: number;
  domain: "room";
  type: "realtime.room.member.joined" | "realtime.room.member.left";
  requestId?: string | null;
  spaceId?: null;
  sessionId?: null;
  rooms: RealtimeRoom[];
  payload: {
    roomId: string;
    sequence: number;
    member: RealtimeRoomMember;
  };
};

export type RealtimeRoomPresenceUpdatedEvent = {
  id: string;
  timestamp: number;
  domain: "room";
  type: "realtime.room.presence.updated";
  requestId?: string | null;
  spaceId?: null;
  sessionId?: null;
  rooms: RealtimeRoom[];
  payload: {
    roomId: string;
    sequence: number;
    member: RealtimeRoomMember;
  };
};

export type RealtimeRoomRequestEvent = {
  id: string;
  timestamp: number;
  domain: "room";
  type: "realtime.room.request.ok";
  requestId?: string | null;
  spaceId?: null;
  sessionId?: null;
  roomId?: string | null;
  payload: {
    roomId: string;
    sequence?: number;
    eventId?: string | null;
    clientEventId?: string | null;
  };
};

export type RealtimeRoomRequestErrorEvent = {
  id: string;
  timestamp: number;
  domain: "room";
  type: "realtime.room.request.error";
  requestId?: string | null;
  spaceId?: null;
  sessionId?: null;
  roomId?: string | null;
  payload: {
    roomId: string;
    code: string;
    message: string;
  };
};

export type RealtimeRoomClosedEvent = {
  id: string;
  timestamp: number;
  domain: "room";
  type: "realtime.room.closed";
  requestId?: string | null;
  spaceId?: null;
  sessionId?: null;
  rooms: RealtimeRoom[];
  payload: { roomId: string; reason: "expired" | "left" | "revoked" | "superseded" };
};

export type RealtimeCompactFrame =
  | { t: "d"; sid: string; s: number; b: number; v: unknown }
  | { t: "p"; sid: string; s: number; b: number; o: "append" | "replace" | "add" | "merge" | "remove"; p: string; v?: unknown };

export type SystemReadyEvent = {
  id: string;
  timestamp: number;
  domain: "system";
  type: "system.ready";
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  payload: { connectionId: string };
};

export type SystemAuthOkEvent = {
  id: string;
  timestamp: number;
  domain: "system";
  type: "system.auth.ok";
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  payload: { connectionId: string; user: Record<string, unknown>; capabilities?: string[] };
};

export type SystemRequestErrorEvent = {
  id: string;
  timestamp: number;
  domain: "system";
  type: "system.request.error";
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  payload: { code?: string; message: string };
};

export type SystemPongEvent = {
  id: string;
  timestamp: number;
  domain: "system";
  type: "system.pong";
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  payload: Record<string, unknown>;
};

export type SystemAckOkEvent = {
  id: string;
  timestamp: number;
  domain: "system";
  type: "system.ack.ok";
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  payload: { eventId?: string };
};

export type SystemSubscribeOkEvent = {
  id: string;
  timestamp: number;
  domain: "system";
  type: "system.subscribe.ok";
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  payload: { rooms: RealtimeRoom[] };
};

export type SystemSubscribeErrorEvent = {
  id: string;
  timestamp: number;
  domain: "system";
  type: "system.subscribe.error";
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  payload: { rejected: Array<{ room: string; code: "BAD_ROOM" | "FORBIDDEN"; message: string }> };
};

export type RealtimeSessionRecord = Pick<
  SessionRecord,
  | "id"
  | "spaceId"
  | "userUuid"
  | "title"
  | "source"
  | "status"
  | "activeTurn"
  | "externalSessionId"
  | "latestMessageText"
  | "lastMessageAt"
  | "lastMessageId"
  | "createdAt"
  | "updatedAt"
>;

export type SessionCreatedEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.created";
  requestId?: string | null;
  spaceId: string;
  sessionId: string;
  payload: { session: RealtimeSessionRecord };
};

export type SessionUpdatedEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.updated";
  requestId?: string | null;
  spaceId: string;
  sessionId: string;
  payload: { session: RealtimeSessionRecord; changed: string[] };
};

export type SessionRequestAcceptedEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.request.accepted";
  requestId?: string | null;
  spaceId: string;
  sessionId: string;
  payload: { clientMessageId?: string | null; turnId?: string | null; userMessageId?: string | null; traceId?: string | null };
};

export type SessionRequestErrorEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.request.error";
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  payload: { code?: string; message: string; clientMessageId?: string | null; billing?: BillingPayload | null };
};

export type RealtimePatchOperation =
  | { o: "append"; p: string; v: unknown }
  | { o: "replace"; p: string; v: unknown }
  | { o: "add"; p: string; v: unknown }
  | { o: "merge"; p: string; v: Record<string, unknown> }
  | { o: "remove"; p: string }
  | { v: unknown; o?: undefined; p?: undefined };

export type RealtimePatchIdentityInput = {
  turnId?: unknown;
  messageId?: unknown;
  sourceMessageId?: unknown;
  anchorUserMessageId?: unknown;
  messageOrdinal?: unknown;
  sessionId?: unknown;
};

const getNonEmptyString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : null;

/** Shared by the API and the Agent: one Redis key holds the live stream state per Session. */
export const getSessionStreamSnapshotKey = (spaceId: string, sessionId: string) =>
  `session:stream:snapshot:${spaceId}:${sessionId}`;

/**
 * Delete a stream snapshot only when it still belongs to the given turn.
 * A delayed terminal delivery for an older turn must not drop the current stream state.
 */
export const SESSION_STREAM_SNAPSHOT_CLEAR_TURN_LUA =
  `local raw = redis.call('GET', KEYS[1])\n` +
  `if not raw then return 0 end\n` +
  `local ok, snapshot = pcall(cjson.decode, raw)\n` +
  `if ok and type(snapshot) == 'table' and snapshot.turnId == ARGV[1] then return redis.call('DEL', KEYS[1]) end\n` +
  `return 0`;

export const getSessionTurnPatchStreamKey = (
  input: RealtimePatchIdentityInput,
  options: { includeSessionFallback?: boolean } = {},
) => {
  const turnId = getNonEmptyString(input.turnId);
  const messageKey =
    getNonEmptyString(input.messageId) ??
    getNonEmptyString(input.sourceMessageId) ??
    getNonEmptyString(input.anchorUserMessageId) ??
    (typeof input.messageOrdinal === "number" && Number.isFinite(input.messageOrdinal)
      ? `ordinal:${input.messageOrdinal}`
      : null);

  if (turnId && messageKey) return `${turnId}:${messageKey}`;
  const streamKey = messageKey ?? turnId;
  if (streamKey) return streamKey;
  return options.includeSessionFallback ? getNonEmptyString(input.sessionId) : null;
};

export type SessionTurnPatchEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.turn.patch";
  requestId?: string | null;
  spaceId: string;
  sessionId: string;
  payload: {
    turnId: string | null;
    messageId: string | null;
    messageOrdinal?: number | null;
    sourceMessageId?: string | null;
    anchorUserMessageId: string | null;
    seq: number;
    baseSeq: number;
    ops: RealtimePatchOperation[];
  };
};

export type SessionTurnErrorEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.turn.error";
  requestId?: string | null;
  spaceId: string;
  sessionId: string;
  payload: { turnId?: string | null; anchorUserMessageId: string | null; error: string };
};

export type SessionTurnLifecyclePhase = "llm_call_started";

export type SessionTurnLifecycleEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.turn.lifecycle";
  requestId?: string | null;
  spaceId: string;
  sessionId: string;
  payload: {
    turnId: string | null;
    anchorUserMessageId: string | null;
    phase: SessionTurnLifecyclePhase;
    llmRound: number;
    provider: string | null;
    model: string | null;
    at: string;
  };
};

export type RealtimeTurnRecord = Partial<Pick<
  SessionTurnRecord,
  | "id"
  | "sessionId"
  | "sequence"
  | "executionKind"
  | "status"
  | "intent"
  | "userUuid"
  | "authorProfile"
  | "userContent"
  | "userText"
  | "assistantContent"
  | "assistantText"
  | "provider"
  | "model"
  | "stopReason"
  | "errorMessage"
  | "finalUsage"
  | "totalUsage"
  | "summary"
  | "intermediateIndex"
  | "intermediateSummary"
  | "harnessIndex"
  | "meta"
  | "thinkingLevel"
  | "startedAt"
  | "completedAt"
  | "durationMs"
  | "createdAt"
  | "updatedAt"
>>;

export type RealtimeMessageRecord = Pick<
  MessageRecord,
  | "id"
  | "sessionId"
  | "role"
  | "content"
  | "text"
  | "sequence"
  | "provider"
  | "model"
  | "stopReason"
  | "errorMessage"
  | "usage"
  | "meta"
  | "startedAt"
  | "completedAt"
  | "durationMs"
  | "createdAt"
>;

export type SessionTurnCreatedEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.turn.created";
  requestId?: string | null;
  spaceId: string;
  sessionId: string;
  payload: { turn: RealtimeTurnRecord };
};

export type SessionTurnUpdatedEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.turn.updated";
  requestId?: string | null;
  spaceId: string;
  sessionId: string;
  payload: { turn: RealtimeTurnRecord };
};

export type SessionTurnFinalizedEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.turn.finalized";
  requestId?: string | null;
  spaceId: string;
  sessionId: string;
  payload: {
    turn: RealtimeTurnRecord;
    sessionLabelRefs: string[] | null;
  };
};

export type SessionTurnNotifyEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.turn.notify";
  requestId?: string | null;
  spaceId: string;
  sessionId: string;
  payload: {
    spaceId: string;
    sessionId: string;
    turnId: string;
    status: SessionTurnRecord["status"];
    finishReason?: SessionTurnSummary["finishReason"] | null;
    userPreview: string | null;
    durationMs: number | null;
    stepCount: number | null;
    sequence: number | null;
    provider: string | null;
    model: string | null;
    completedAt: string | null;
  };
};

export type SessionMessagePersistedEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.message.persisted";
  requestId?: string | null;
  spaceId: string;
  sessionId: string;
  payload: { message: RealtimeMessageRecord };
};

export type SpaceFsChangedEvent = {
  id: string;
  timestamp: number;
  domain: "space";
  type: "space.fs.changed";
  requestId?: string | null;
  spaceId: string;
  sessionId?: string | null;
  payload: SpaceFsChangedPayload;
};

export type SpacePortsChangedEvent = {
  id: string;
  timestamp: number;
  domain: "space";
  type: "space.ports.changed";
  requestId?: string | null;
  spaceId: string;
  sessionId?: string | null;
  payload: SpacePortsChangedPayload;
};

export type SpacePresenceUser = {
  userId: string;
  connectionCount: number;
  lastSeenAt: string;
  meta: Record<string, unknown> | null;
  metas: Record<string, unknown>[];
  profile: {
    userUuid: string;
    username: string | null;
    displayName: string;
    avatarUrl: string | null;
  };
};

export type SpacePresenceSnapshot = {
  spaceId: string;
  users: SpacePresenceUser[];
  updatedAt: string;
};

export type SpacePresenceUpdatedEvent = {
  id: string;
  timestamp: number;
  domain: "space";
  type: "space.presence.updated";
  requestId?: string | null;
  spaceId: string;
  sessionId?: string | null;
  payload: SpacePresenceSnapshot;
};

export type BoardChangedEvent = {
  id: string;
  timestamp: number;
  domain: "space";
  type: "board.changed";
  requestId?: string | null;
  spaceId: string;
  sessionId?: string | null;
  payload: {
    boardId: string;
    actorId: string;
    mutationId: string;
    version: number;
    changed: BoardMutationReceipt["changed"];
    /** Server-authored animation rows for a small, pure animation mutation. */
    animationPatch?: {
      effects: BoardEffect[];
      compositions: BoardComposition[];
      playback?: BoardPlaybackSnapshot | null;
    };
    source?: RequestSource;
  };
};

export type BoardAwarenessUpdatedEvent = {
  id: string;
  timestamp: number;
  domain: "space";
  type: "board.awareness.updated";
  requestId?: string | null;
  spaceId: string;
  sessionId?: string | null;
  rooms?: RealtimeRoom[];
  payload: {
    boardId: string;
    connectionId: string;
    actorId: string;
    actorName: string;
    seq: number;
    update: BoardAwarenessUpdate;
  };
};

export type BoardPlaybackChangedEvent = {
  id: string;
  timestamp: number;
  domain: "space";
  type: "board.playback.changed";
  requestId?: string | null;
  spaceId: string;
  sessionId?: string | null;
  payload: BoardPlaybackSnapshot;
};

export type RealtimeAppStatus = "published" | "disabled";
export type RealtimeAppVisibility = "public" | "space";
export type RealtimeAppTargetType = "file" | "directory" | "port";

/**
 * Canonical wire shape of an app record: realtime events and `/api/apps`
 * responses. The legacy `/api/works` mount serves the work-era field names
 * (`workScopes`) until the next breaking protocol version.
 */
export type RealtimeAppRecord = {
  id: string;
  spaceId: string;
  userUuid: string;
  slug: string;
  status: RealtimeAppStatus;
  visibility: RealtimeAppVisibility;
  targetType: RealtimeAppTargetType;
  targetRef: string;
  assetKey: string | null;
  currentVersionId: string | null;
  latestVersion: number;
  publishedAt: string | null;
  appScopes: string[];
  allowedViewerScopes: string[];
  meta: Record<string, unknown> | null;
  createdAt: string | null;
  updatedAt: string | null;
};

/**
 * Canonical wire shape of a published app version. The legacy `/api/works`
 * mount serves the work-era `workId` field name until the next breaking
 * protocol version.
 */
export type RealtimeAppVersionRecord = {
  id: string;
  appId: string;
  version: number;
  targetType: RealtimeAppTargetType;
  targetRef: string;
  assetKey: string | null;
  contentKind: AppContentKind;
  artifact: AppArtifactDescriptor | null;
  meta: Record<string, unknown> | null;
  /** Version provenance; session identity is gated on `session.view`. */
  source: AppVersionSource | null;
  createdAt: string | null;
};

export type AppVersionPublishedEvent = {
  id: string;
  timestamp: number;
  domain: "space";
  type: "app.version.published";
  requestId?: string | null;
  spaceId: string;
  sessionId?: null;
  payload: {
    app: RealtimeAppRecord;
    version: RealtimeAppVersionRecord;
    previousVersionId: string | null;
    actor: { userId: string };
    source: RequestSource | null;
  };
};

export type RealtimeTaskRecord = {
  id: string;
  type: string;
  status: TaskRunStatus;
  jobId: string;
  cronJobId: string | null;
  spaceId: string | null;
  sessionId: string | null;
  turnId: string | null;
  userId: string | null;
  attemptCount: number;
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskCreatedEvent = {
  id: string;
  timestamp: number;
  domain: "space";
  type: "task.created";
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  payload: { task: RealtimeTaskRecord };
};

export type TaskUpdatedEvent = {
  id: string;
  timestamp: number;
  domain: "space";
  type: "task.updated";
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  payload: { task: RealtimeTaskRecord; changed: string[] };
};

export type LabelAssignmentsUpdatedEvent = {
  id: string;
  timestamp: number;
  domain: "label";
  type: "label.assignments.updated";
  requestId?: string | null;
  /** Space room target; null for user-scoped label events (delivered to user room). */
  spaceId: string | null;
  sessionId?: string | null;
  payload: {
    resourceType: "session" | "checkpoint" | "file" | "space";
    resourceRef: string;
    labels: unknown[];
    assignments: unknown[];
    items?: unknown[];
    affectedLabelIds: string[];
  };
};

/**
 * A desktop command addressed at one frontend instance of the acting user.
 * Delivered to the user room; every client compares `targetClientId` with its
 * own client id and ignores commands that are not for it.
 */
export type DesktopCommandDispatchedEvent = {
  id: string;
  timestamp: number;
  domain: "desktop";
  type: "desktop.command.dispatched";
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  rooms?: RealtimeRoom[];
  payload: DesktopCommandDispatchedPayload;
};

export type RealtimeServerEvent =
  | SystemReadyEvent
  | SystemAuthOkEvent
  | SystemRequestErrorEvent
  | SystemPongEvent
  | SystemAckOkEvent
  | SystemSubscribeOkEvent
  | SystemSubscribeErrorEvent
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | SessionRequestAcceptedEvent
  | SessionRequestErrorEvent
  | SessionTurnCreatedEvent
  | SessionTurnPatchEvent
  | SessionTurnErrorEvent
  | SessionTurnLifecycleEvent
  | SessionTurnUpdatedEvent
  | SessionTurnFinalizedEvent
  | SessionTurnNotifyEvent
  | SessionMessagePersistedEvent
  | SpaceFsChangedEvent
  | SpacePortsChangedEvent
  | SpacePresenceUpdatedEvent
  | BoardChangedEvent
  | BoardAwarenessUpdatedEvent
  | BoardPlaybackChangedEvent
  | AppVersionPublishedEvent
  | TaskCreatedEvent
  | TaskUpdatedEvent
  | LabelAssignmentsUpdatedEvent
  | DesktopCommandDispatchedEvent
  | RealtimeRoomEvent
  | RealtimeRoomJoinedEvent
  | RealtimeRoomMemberChangedEvent
  | RealtimeRoomPresenceUpdatedEvent
  | RealtimeRoomRequestEvent
  | RealtimeRoomRequestErrorEvent
  | RealtimeRoomClosedEvent;

type Assert<T extends true> = T;
export type RealtimeServerEventDomainsAreValid = Assert<
  RealtimeServerEvent extends { domain: RealtimeDomain } ? true : false
>;

export type WsServerEnvelope = RealtimeEnvelope;
export type ChannelServerEnvelope = ChannelEnvelope;
