import { randomUUID } from "node:crypto";
import { context, trace, type Span } from "@opentelemetry/api";
import { Redis } from "ioredis";
import { z } from "zod";
import type { ContentBlock } from "@cohub/protocol/core";
import { AGENT_REALTIME_PATCH_CHANNEL, REALTIME_OUTBOUND_CHANNEL, SESSION_STREAM_SNAPSHOT_CLEAR_TURN_LUA, getSessionStreamSnapshotKey, type RealtimeEnvelope, type RealtimeRoom, type SessionStreamError, type SessionStreamEvent, type SessionTurnLifecycleOutput } from "@cohub/protocol/realtime";
import type { SpaceFsChangedPayload } from "@cohub/protocol/fs";
import type { SpacePortsChangedPayload } from "@cohub/protocol/ports";
import { injectTrace } from "@cohub/infra/tracing/propagator";
import type { SandboxBroadcast } from "@cohub/sandbox-client";
import { isSpaceHookableEvent } from "@cohub/protocol";
import { env } from "./env.js";
import { PUBLISH_ONCE_LUA, type PublishOnce, sandboxBroadcastOnce } from "./sandbox-broadcast.js";
import { enqueueSpaceHookFromEvent } from "./space-hooks.js";
import { buildPatchOpsForContentDelta, getAppendPathForStreamEvent } from "./stream/patch-delta.js";
import { createLogger } from "@cohub/infra/logging";


const logger = createLogger({ serviceName: "cohub-agent" });
export const redis = new Redis(env.REDIS_URL, { disableClientInfo: true });

export const xaddWithMaxlen = async (client: Redis, streamKey: string, ...args: (string | number)[]) => {
  return client.xadd(streamKey, "MAXLEN", "~", 2000, ...args);
};

export const getGatewayNodeOutboundStreamKey = (nodeId: string) => `stream:gateway:node:${nodeId}:outbound`;

const SESSION_STREAM_SNAPSHOT_TTL_SECONDS = 60 * 60;

type SessionStreamSnapshotMessage = {
  messageId: string | null;
  messageOrdinal: number | null;
  content: ContentBlock[];
};

type SessionStreamSnapshotLifecycle = {
  phase: "llm_call_started";
  llmRound: number;
  provider: string | null;
  model: string | null;
  at: string;
};

type SessionStreamSnapshot = {
  version: 2;
  spaceId: string;
  sessionId: string;
  turnId: string | null;
  anchorUserMessageId: string | null;
  seq: number;
  current: SessionStreamSnapshotMessage & { appendPath: string | null };
  intermediateMessages: SessionStreamSnapshotMessage[];
  lifecycle?: SessionStreamSnapshotLifecycle | null;
  updatedAt: number;
};

const getSnapshotIdentityKey = (
  message: Pick<SessionStreamSnapshotMessage, "messageId" | "messageOrdinal">,
) => {
  if (message.messageOrdinal != null) return `ordinal:${message.messageOrdinal}`;
  if (message.messageId) return `message:${message.messageId}`;
  return null;
};

const getSnapshotMessageKey = (message: SessionStreamSnapshotMessage) => {
  const identityKey = getSnapshotIdentityKey(message);
  if (identityKey) return identityKey;
  try {
    return `content:${JSON.stringify(message.content)}`;
  } catch {
    return null;
  }
};

const isSameSnapshotMessage = (
  a: Pick<SessionStreamSnapshotMessage, "messageId" | "messageOrdinal">,
  b: Pick<SessionStreamSnapshotMessage, "messageId" | "messageOrdinal">,
) => {
  const aKey = getSnapshotIdentityKey(a);
  const bKey = getSnapshotIdentityKey(b);
  if (!aKey && !bKey) return true;
  if (!aKey || !bKey) return false;
  return aKey === bKey;
};

const upsertSnapshotMessage = (
  messages: SessionStreamSnapshotMessage[],
  message: SessionStreamSnapshotMessage,
) => {
  const key = getSnapshotMessageKey(message);
  if (!key) return [...messages, message];
  const index = messages.findIndex((item) => getSnapshotMessageKey(item) === key);
  if (index < 0) return [...messages, message];
  return messages.map((item, itemIndex) => itemIndex === index ? { ...item, ...message } : item);
};

const parseSessionStreamSnapshot = (raw: string | null): SessionStreamSnapshot | null => {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SessionStreamSnapshot>;
    if (value.version !== 2) return null;
    if (!value.spaceId || !value.sessionId) return null;
    if (!Array.isArray(value.current?.content)) return null;
    if (!Array.isArray(value.intermediateMessages)) return null;
    return value as SessionStreamSnapshot;
  } catch {
    return null;
  }
};

type LocalSessionStreamSnapshotState = {
  snapshot: SessionStreamSnapshot;
  lastPersistedAt: number;
  persistTimer: ReturnType<typeof setTimeout> | null;
};

const SESSION_STREAM_SNAPSHOT_WRITE_INTERVAL_MS = Math.max(
  100,
  Number(process.env.AGENT_STREAM_SNAPSHOT_WRITE_INTERVAL_MS ?? 500),
);
const SESSION_STREAM_SNAPSHOT_LOCAL_TTL_MS = Math.max(
  60_000,
  Number(process.env.AGENT_STREAM_SNAPSHOT_LOCAL_TTL_MS ?? SESSION_STREAM_SNAPSHOT_TTL_SECONDS * 1000),
);
const SESSION_STREAM_SNAPSHOT_PRUNE_INTERVAL_MS = Math.max(
  10_000,
  Number(process.env.AGENT_STREAM_SNAPSHOT_PRUNE_INTERVAL_MS ?? 60_000),
);

const sessionStreamSnapshotStates = new Map<string, LocalSessionStreamSnapshotState>();
let lastSessionStreamSnapshotPruneAt = 0;

const clearSnapshotPersistTimer = (state: LocalSessionStreamSnapshotState) => {
  if (!state.persistTimer) return;
  clearTimeout(state.persistTimer);
  state.persistTimer = null;
};

const persistSessionStreamSnapshotNow = async (key: string) => {
  const state = sessionStreamSnapshotStates.get(key);
  if (!state) return;
  clearSnapshotPersistTimer(state);
  await redis.set(key, JSON.stringify(state.snapshot), "EX", SESSION_STREAM_SNAPSHOT_TTL_SECONDS);
  state.lastPersistedAt = Date.now();
};

const scheduleSessionStreamSnapshotPersist = async (key: string, force = false) => {
  const state = sessionStreamSnapshotStates.get(key);
  if (!state) return;

  if (force) {
    await persistSessionStreamSnapshotNow(key);
    return;
  }

  const elapsed = Date.now() - state.lastPersistedAt;
  if (elapsed >= SESSION_STREAM_SNAPSHOT_WRITE_INTERVAL_MS) {
    await persistSessionStreamSnapshotNow(key);
    return;
  }

  if (state.persistTimer) return;
  state.persistTimer = setTimeout(() => {
    state.persistTimer = null;
    void persistSessionStreamSnapshotNow(key).catch((error) => {
      logger.warn("[SessionStreamSnapshot] failed to persist snapshot:", error);
    });
  }, SESSION_STREAM_SNAPSHOT_WRITE_INTERVAL_MS - elapsed);
  state.persistTimer.unref?.();
};

const pruneLocalSessionStreamSnapshots = () => {
  const now = Date.now();
  if (now - lastSessionStreamSnapshotPruneAt < SESSION_STREAM_SNAPSHOT_PRUNE_INTERVAL_MS) return;
  lastSessionStreamSnapshotPruneAt = now;
  for (const [key, state] of sessionStreamSnapshotStates) {
    if (now - state.snapshot.updatedAt <= SESSION_STREAM_SNAPSHOT_LOCAL_TTL_MS) continue;
    clearSnapshotPersistTimer(state);
    sessionStreamSnapshotStates.delete(key);
  }
};

const getLocalSessionStreamSnapshot = async (key: string, event: Pick<SessionStreamEvent, "baseSeq">) => {
  const local = sessionStreamSnapshotStates.get(key);
  if (local) return local.snapshot;
  if (event.baseSeq === 0) return null;

  const existing = parseSessionStreamSnapshot(await redis.get(key).catch(() => null));
  if (!existing) return null;
  sessionStreamSnapshotStates.set(key, {
    snapshot: existing,
    lastPersistedAt: Date.now(),
    persistTimer: null,
  });
  return existing;
};

const cacheSessionStreamSnapshot = async (event: SessionStreamEvent) => {
  if (!Array.isArray(event.snapshotContent) || event.seq <= 0) return;

  pruneLocalSessionStreamSnapshots();

  const key = getSessionStreamSnapshotKey(event.spaceId, event.sessionId);
  const existing = await getLocalSessionStreamSnapshot(key, event);
  const incoming: SessionStreamSnapshot["current"] = {
    messageId: event.messageId ?? null,
    messageOrdinal: event.messageOrdinal ?? null,
    content: event.snapshotContent,
    appendPath: getAppendPathForStreamEvent(event),
  };
  const sameTurnSnapshot = existing &&
    existing.spaceId === event.spaceId &&
    existing.sessionId === event.sessionId &&
    existing.turnId === (event.turnId ?? null)
    ? existing
    : null;
  const messageChanged = Boolean(sameTurnSnapshot && !isSameSnapshotMessage(sameTurnSnapshot.current, incoming));
  const intermediateMessages = sameTurnSnapshot
    ? messageChanged
      ? upsertSnapshotMessage(sameTurnSnapshot.intermediateMessages, {
          messageId: sameTurnSnapshot.current.messageId,
          messageOrdinal: sameTurnSnapshot.current.messageOrdinal,
          content: sameTurnSnapshot.current.content,
        })
      : sameTurnSnapshot.intermediateMessages
    : [];

  const snapshot: SessionStreamSnapshot = {
    version: 2,
    spaceId: event.spaceId,
    sessionId: event.sessionId,
    turnId: event.turnId ?? null,
    anchorUserMessageId: event.anchorUserMessageId ?? event.sourceMessageId ?? null,
    seq: event.seq,
    current: incoming,
    intermediateMessages,
    lifecycle: null,
    updatedAt: Date.now(),
  };

  const currentState = sessionStreamSnapshotStates.get(key);
  sessionStreamSnapshotStates.set(key, {
    snapshot,
    lastPersistedAt: currentState?.lastPersistedAt ?? 0,
    persistTimer: currentState?.persistTimer ?? null,
  });

  await scheduleSessionStreamSnapshotPersist(key, event.baseSeq === 0 || event.turnEnd === true || messageChanged);
};

const cacheSessionTurnLifecycleSnapshot = async (event: SessionTurnLifecycleOutput) => {
  pruneLocalSessionStreamSnapshots();

  const key = getSessionStreamSnapshotKey(event.spaceId, event.sessionId);
  const existing = await getLocalSessionStreamSnapshot(key, { baseSeq: 1 });
  const sameTurnSnapshot = existing &&
    existing.spaceId === event.spaceId &&
    existing.sessionId === event.sessionId &&
    existing.turnId === (event.turnId ?? null)
    ? existing
    : null;

  const snapshot: SessionStreamSnapshot = {
    version: 2,
    spaceId: event.spaceId,
    sessionId: event.sessionId,
    turnId: event.turnId ?? null,
    anchorUserMessageId: event.anchorUserMessageId ?? sameTurnSnapshot?.anchorUserMessageId ?? null,
    seq: sameTurnSnapshot?.seq ?? 0,
    current: sameTurnSnapshot?.current ?? {
      messageId: null,
      messageOrdinal: null,
      content: [],
      appendPath: null,
    },
    intermediateMessages: sameTurnSnapshot?.intermediateMessages ?? [],
    lifecycle: {
      phase: event.phase,
      llmRound: event.llmRound,
      provider: event.provider ?? null,
      model: event.model ?? null,
      at: event.at,
    },
    updatedAt: Date.now(),
  };

  const currentState = sessionStreamSnapshotStates.get(key);
  sessionStreamSnapshotStates.set(key, {
    snapshot,
    lastPersistedAt: currentState?.lastPersistedAt ?? 0,
    persistTimer: currentState?.persistTimer ?? null,
  });

  await scheduleSessionStreamSnapshotPersist(key, true);
};

const clearSessionStreamSnapshot = async (spaceId: string, sessionId: string, turnId?: string) => {
  const key = getSessionStreamSnapshotKey(spaceId, sessionId);
  const state = sessionStreamSnapshotStates.get(key);
  if (!turnId || state?.snapshot.turnId === turnId) {
    if (state) clearSnapshotPersistTimer(state);
    sessionStreamSnapshotStates.delete(key);
  }
  if (!turnId) { await redis.del(key); return; }
  // Old terminal deliveries can arrive after a new turn starts. Compare and delete atomically.
  await redis.eval(SESSION_STREAM_SNAPSHOT_CLEAR_TURN_LUA, 1, key, turnId);
};

export const clearPersistedSessionStreamSnapshot = clearSessionStreamSnapshot;

type StreamTelemetryMetrics = {
  patchCount: number;
  publishErrorCount: number;
  bytesTotal: number;
  expiresAt: number;
};

const getStreamTelemetry = (span: Span) => {
  pruneExpiredStreamTelemetry();
  const key = span.spanContext().spanId;
  let metrics = streamTelemetryBySpanId.get(key);
  if (!metrics) {
    metrics = { patchCount: 0, publishErrorCount: 0, bytesTotal: 0, expiresAt: Date.now() + STREAM_TELEMETRY_TTL_MS };
    streamTelemetryBySpanId.set(key, metrics);
  } else {
    metrics.expiresAt = Date.now() + STREAM_TELEMETRY_TTL_MS;
  }
  return { key, metrics };
};

const clearStreamTelemetry = (span: Span) => {
  streamTelemetryBySpanId.delete(span.spanContext().spanId);
};

const pruneExpiredStreamTelemetry = () => {
  const now = Date.now();
  if (now - lastStreamTelemetryPruneAt < STREAM_TELEMETRY_PRUNE_INTERVAL_MS) return;
  lastStreamTelemetryPruneAt = now;
  for (const [key, metrics] of streamTelemetryBySpanId) {
    if (metrics.expiresAt <= now) streamTelemetryBySpanId.delete(key);
  }
};

const recordStreamPublishSuccess = (span: Span, event: SessionStreamEvent | SessionStreamError | SessionTurnLifecycleOutput, envelopeBytes = 0) => {
  const { metrics } = getStreamTelemetry(span);
  if (event.type === "stream_update") {
    metrics.patchCount += 1;
    metrics.bytesTotal += envelopeBytes;
    span.setAttribute("agent.output.patch_count", metrics.patchCount);
    span.setAttribute("agent.output.bytes_total", metrics.bytesTotal);
    span.setAttribute("agent.output.last_seq", event.seq);
    if (metrics.patchCount === 1) {
      span.addEvent("agent.output.first_publish", {
        "cohub.space_id": event.spaceId,
        "cohub.session_id": event.sessionId,
        "agent.turn_id": event.turnId ?? "",
        "agent.output.seq": event.seq,
      });
    } else if (event.turnEnd) {
      span.addEvent("agent.output.final_publish", {
        "cohub.space_id": event.spaceId,
        "cohub.session_id": event.sessionId,
        "agent.turn_id": event.turnId ?? "",
        "agent.output.seq": event.seq,
        "agent.output.patch_count": metrics.patchCount,
        "agent.output.bytes_total": metrics.bytesTotal,
      });
      streamTelemetryBySpanId.delete(span.spanContext().spanId);
    } else if (metrics.patchCount % STREAM_PUBLISH_SAMPLE_EVERY === 0) {
      span.addEvent("agent.output.publish_sampled", {
        "agent.output.seq": event.seq,
        "agent.output.patch_count": metrics.patchCount,
      });
    }
  } else if (event.type === "turn_lifecycle") {
    span.addEvent("agent.output.lifecycle_publish", {
      "cohub.space_id": event.spaceId,
      "cohub.session_id": event.sessionId,
      "agent.turn_id": event.turnId ?? "",
      "agent.lifecycle.phase": event.phase,
      "agent.llm_round": event.llmRound,
    });
  } else {
    span.addEvent("agent.output.error_publish", {
      "cohub.space_id": event.spaceId,
      "cohub.session_id": event.sessionId ?? "",
    });
    clearStreamTelemetry(span);
  }
};

const recordStreamPublishFailure = (span: Span, error: unknown) => {
  const { metrics } = getStreamTelemetry(span);
  metrics.publishErrorCount += 1;
  span.setAttribute("agent.output.publish_error_count", metrics.publishErrorCount);
  span.addEvent("agent.output.publish_failed");
  if (error instanceof Error) span.recordException(error);
};

const STREAM_TELEMETRY_TTL_MS = Math.max(60_000, Number(process.env.AGENT_STREAM_TELEMETRY_TTL_MS ?? 10 * 60_000));
const STREAM_TELEMETRY_PRUNE_INTERVAL_MS = Math.max(10_000, Number(process.env.AGENT_STREAM_TELEMETRY_PRUNE_INTERVAL_MS ?? 60_000));
const STREAM_PUBLISH_SAMPLE_EVERY = Math.max(1, Number(process.env.AGENT_STREAM_TELEMETRY_SAMPLE_EVERY ?? 20));
const streamTelemetryBySpanId = new Map<string, StreamTelemetryMetrics>();
let lastStreamTelemetryPruneAt = 0;

export function extractContentText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text" && "text" in b)
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export function extractContentImages(blocks: ContentBlock[]): Array<{ type: "image"; data: string; mimeType: string }> {
  const results: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const b of blocks) {
    if (b.type !== "image") continue;
    const img = b as { type: "image"; source: { type: "url"; url: string } | { type: "base64"; media_type: string; data: string } };
    if (img.source.type !== "base64") continue;
    results.push({ type: "image", data: img.source.data, mimeType: img.source.media_type });
  }
  return results;
}

const sendOutputSchema = z.union([
  z.object({
    type: z.literal("stream_update"),
    spaceId: z.string().uuid(),
    sessionId: z.string().uuid(),
    turnId: z.string().uuid().nullable().optional(),
    seq: z.number().int().positive(),
    baseSeq: z.number().int().min(0),
    content: z.array(z.unknown()),
    snapshotContent: z.array(z.unknown()).optional(),
    messageId: z.string().nullable().optional(),
    messageOrdinal: z.number().int().min(0).nullable().optional(),
    sourceMessageId: z.string().uuid().nullable(),
    timestamp: z.number(),
    turnEnd: z.boolean().optional(),
    anchorUserMessageId: z.string().uuid().nullable().optional(),
  }),
  z.object({
    type: z.literal("turn_lifecycle"),
    spaceId: z.string().uuid(),
    sessionId: z.string().uuid(),
    turnId: z.string().uuid().nullable().optional(),
    anchorUserMessageId: z.string().uuid().nullable().optional(),
    phase: z.literal("llm_call_started"),
    llmRound: z.number().int().positive(),
    provider: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    at: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("error"),
    spaceId: z.string().uuid(),
    sessionId: z.string().uuid().nullable(),
    error: z.string(),
  }),
]);

export async function sendOutput(data: SessionStreamEvent | SessionStreamError | SessionTurnLifecycleOutput) {
  const parsed = sendOutputSchema.safeParse(data);
  if (!parsed.success) {
    logger.error("[Redis] Invalid session output event:", parsed.error.issues);
    return;
  }

  if (parsed.data.type === "error" && !parsed.data.sessionId) {
    logger.warn("[Redis] Skipping session error output without sessionId");
    return;
  }

  const activeSpan = trace.getActiveSpan();
  const event = parsed.data as SessionStreamEvent | SessionStreamError | SessionTurnLifecycleOutput;

  try {
    const traceCarrier = injectTrace();
    let envelope: RealtimeEnvelope;

    if (event.type === "stream_update") {
      const streamEvent = event as SessionStreamEvent;
      const ops = buildPatchOpsForContentDelta(streamEvent);
      await cacheSessionStreamSnapshot(streamEvent).catch((error) => {
        logger.warn("[SessionStreamSnapshot] failed to cache snapshot:", error);
      });
      envelope = {
        id: randomUUID(),
        timestamp: Date.now(),
        domain: "session",
        type: "session.turn.patch",
        spaceId: event.spaceId,
        sessionId: event.sessionId,
        payload: {
          turnId: event.turnId ?? null,
          messageId: event.messageId ?? null,
          messageOrdinal: event.messageOrdinal ?? null,
          sourceMessageId: event.sourceMessageId ?? null,
          anchorUserMessageId: event.anchorUserMessageId ?? event.sourceMessageId ?? null,
          seq: event.seq,
          baseSeq: event.baseSeq,
          ops,
        },
      };
    } else if (event.type === "turn_lifecycle") {
      await cacheSessionTurnLifecycleSnapshot(event).catch((error) => {
        logger.warn("[SessionStreamSnapshot] failed to cache lifecycle snapshot:", error);
      });
      envelope = {
        id: randomUUID(),
        timestamp: Date.now(),
        domain: "session",
        type: "session.turn.lifecycle",
        spaceId: event.spaceId,
        sessionId: event.sessionId,
        payload: {
          turnId: event.turnId ?? null,
          anchorUserMessageId: event.anchorUserMessageId ?? null,
          phase: event.phase,
          llmRound: event.llmRound,
          provider: event.provider ?? null,
          model: event.model ?? null,
          at: event.at,
        },
      };
    } else {
      if (event.sessionId) await clearSessionStreamSnapshot(event.spaceId, event.sessionId);
      envelope = {
        id: randomUUID(),
        timestamp: Date.now(),
        domain: "session",
        type: "session.turn.error",
        spaceId: event.spaceId,
        sessionId: event.sessionId ?? "unknown",
        payload: {
          turnId: null,
          anchorUserMessageId: null,
          error: event.error,
        },
      };
    }

    const payload = JSON.stringify({ ...envelope, ...traceCarrier });
    const span = trace.getActiveSpan();
    await redis.publish(AGENT_REALTIME_PATCH_CHANNEL, payload).catch((err) => {
      if (span) recordStreamPublishFailure(span, err);
      logger.error("[Redis] Failed to publish realtime output:", err);
      throw err;
    });
    if (span) recordStreamPublishSuccess(span, event, Buffer.byteLength(payload));
  } catch (error) {
    if (error instanceof Error) activeSpan?.recordException(error);
    throw error;
  }
}

export async function publishRealtimeEnvelope(input: {
  domain: "session" | "space" | "system" | string;
  type: string;
  spaceId?: string | null;
  sessionId?: string | null;
  payload: Record<string, unknown>;
  requestId?: string | null;
  rooms?: RealtimeRoom[];
  once?: PublishOnce;
}) {
  const id = input.once?.id ?? randomUUID();
  const timestamp = Date.now();
  const message = JSON.stringify({
    id,
    timestamp,
    domain: input.domain,
    type: input.type,
    requestId: input.requestId ?? null,
    spaceId: input.spaceId ?? null,
    sessionId: input.sessionId ?? null,
    rooms: input.rooms,
    payload: input.payload,
    trace: injectTrace(),
  });

  // Always keep direct realtime publish for UI reliability and tracing.
  // Hook enqueue runs concurrently — both are lightweight Redis ops.
  const hookPromise = input.spaceId && isSpaceHookableEvent(input.type)
    ? enqueueSpaceHookFromEvent({
        id,
        type: input.type,
        timestamp,
        spaceId: input.spaceId,
        sessionId: input.sessionId ?? null,
        payload: input.payload,
      }, redis)
    : Promise.resolve(null);
  const { once } = input;
  const publish = () => once
    ? redis.eval(PUBLISH_ONCE_LUA, 1, once.key, once.ttlMs, REALTIME_OUTBOUND_CHANNEL, message)
    : redis.publish(REALTIME_OUTBOUND_CHANNEL, message);

  await Promise.all([
    context.with(trace.deleteSpan(context.active()), publish),
    hookPromise,
  ]);
}

export async function sendSpaceFsChanged(spaceId: string, payload: SpaceFsChangedPayload, broadcast?: SandboxBroadcast) {
  try {
    await publishRealtimeEnvelope({
      domain: "space",
      type: "space.fs.changed",
      spaceId,
      sessionId: null,
      payload: payload as unknown as Record<string, unknown>,
      once: sandboxBroadcastOnce({ spaceId, type: "space.fs.changed", payload, broadcast }),
    });
  } catch (err) {
    logger.error("[Redis] Failed to send space fs changed event:", err);
  }
}

export async function sendSpacePortsChanged(spaceId: string, payload: SpacePortsChangedPayload, broadcast?: SandboxBroadcast) {
  try {
    await publishRealtimeEnvelope({
      domain: "space",
      type: "space.ports.changed",
      spaceId,
      sessionId: null,
      payload: payload as unknown as Record<string, unknown>,
      once: sandboxBroadcastOnce({ spaceId, type: "space.ports.changed", payload, broadcast }),
    });
  } catch (err) {
    logger.error("[Redis] Failed to send space ports changed event:", err);
  }
}

export async function closeRedisConnections() {
  await redis.quit();
}
