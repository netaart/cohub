import type { ContentBlock, Usage } from "@cohub/protocol/core";
import { getRealtimeSpaceRoom } from "@cohub/protocol/realtime/types";
import type {
  MessageRecord,
  SessionTurnRecord,
} from "@cohub/protocol/model";
import { ensureRealtimeConnected } from "./realtime.js";
import {
  SessionPatchReducer,
  type SessionPatchApplyInput,
  type SessionPatchApplyResult,
  type SessionPatchState,
} from "./session-patch-reducer.js";
import type { SessionTurnStreamSnapshotResponse } from "./types.js";
import type { WebsocketClient, WebsocketEventPayload } from "./websocket.js";

export type AssistantMessageCommit =
  | {
      kind: "intermediate";
      message: MessageRecord;
      isFinal: false;
    }
  | {
      kind: "final";
      message: MessageRecord;
      isFinal: true;
    }
  | {
      kind: "error";
      message: MessageRecord;
      isFinal: true;
    }
  | {
      kind: "ignored";
      message: MessageRecord;
      isFinal: false;
    };

export type GenerationStreamIntermediateMessage = {
  id?: string;
  sessionId?: string;
  sequence?: number | null;
  role?: "user" | "assistant" | "system";
  messageId: string | null;
  messageOrdinal: number | null;
  content: ContentBlock[];
  text?: string | null;
  provider?: string | null;
  model?: string | null;
  stopReason?: string | null;
  errorMessage?: string | null;
  usage?: Usage | null;
  durationMs?: number | null;
  toolCallsObjectKey?: string | null;
  meta?: Record<string, unknown> | null;
  createdAt?: string;
};

export type GenerationStreamStateEvent = {
  type: "state";
  source: "patch" | "snapshot";
  state: SessionPatchState;
  messageId: string | null;
  messageOrdinal: number | null;
  intermediateMessages: GenerationStreamIntermediateMessage[];
  rawEvent: WebsocketEventPayload | null;
};

export type GenerationStreamCommitEvent = {
  type: "commit";
  commit: AssistantMessageCommit;
  rawEvent: WebsocketEventPayload;
};

export type GenerationStreamFinalizedEvent = {
  type: "finalized";
  turn: SessionTurnRecord;
  rawEvent: WebsocketEventPayload;
};

export type GenerationStreamTurnUpdatedEvent = {
  type: "turn_updated";
  turn: Partial<SessionTurnRecord>;
  rawEvent: WebsocketEventPayload;
};

export type GenerationStreamLifecycleEvent = {
  type: "lifecycle";
  phase: "llm_call_started";
  turnId: string | null;
  anchorUserMessageId: string | null;
  llmRound: number;
  provider: string | null;
  model: string | null;
  at: string;
  rawEvent: WebsocketEventPayload;
};

export type GenerationStreamErrorEvent = {
  type: "error";
  message: string;
  rawEvent: WebsocketEventPayload;
};

export type GenerationStreamOutOfSyncEvent = {
  type: "out_of_sync";
  source: "patch";
  reason: "duplicate" | "version_mismatch" | "invalid";
  state: SessionPatchState;
  rawEvent: WebsocketEventPayload;
};

export type GenerationStreamEvent =
  | GenerationStreamStateEvent
  | GenerationStreamCommitEvent
  | GenerationStreamFinalizedEvent
  | GenerationStreamTurnUpdatedEvent
  | GenerationStreamLifecycleEvent
  | GenerationStreamErrorEvent
  | GenerationStreamOutOfSyncEvent;

export type GenerationStreamSubscriptionHandlers = {
  event?: (event: GenerationStreamEvent) => void;
  state?: (event: GenerationStreamStateEvent) => void;
  commit?: (event: GenerationStreamCommitEvent) => void;
  finalized?: (event: GenerationStreamFinalizedEvent) => void;
  turnUpdated?: (event: GenerationStreamTurnUpdatedEvent) => void;
  lifecycle?: (event: GenerationStreamLifecycleEvent) => void;
  error?: (event: GenerationStreamErrorEvent) => void;
  outOfSync?: (event: GenerationStreamOutOfSyncEvent) => void;
};

export type GenerationStreamSubscribeOptions = {
  /** Seed the stream reducer from the server-side active stream snapshot. */
  recover?: boolean;
  /** Optional host-provided snapshot to avoid an extra HTTP request. */
  initialSnapshot?: SessionTurnStreamSnapshotResponse["snapshot"] | null;
  /** Emit a state event after snapshot seed. Defaults to true. */
  emitSnapshotState?: boolean;
};

const SNAPSHOT_RECOVERY_TIMEOUT_MS = 2500;
const SNAPSHOT_RECOVERY_MAX_BUFFERED_EVENTS = 256;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const isContentBlockArray = (value: unknown): value is ContentBlock[] =>
  Array.isArray(value) &&
  value.every((item) => isRecord(item) && typeof item.type === "string");

const getMessageKind = (message: MessageRecord) => {
  const kind = message.meta?.messageKind;
  return typeof kind === "string" ? kind : null;
};

export function parseAssistantMessageCommit(
  message: MessageRecord,
): AssistantMessageCommit {
  const kind = getMessageKind(message);
  if (message.role === "system" && kind === "compacted") {
    return { kind: "intermediate", message, isFinal: false };
  }
  if (message.role !== "assistant") {
    return { kind: "ignored", message, isFinal: false };
  }

  if (kind === "assistant_intermediate") {
    return { kind: "intermediate", message, isFinal: false };
  }
  if (kind === "assistant_final") {
    return { kind: "final", message, isFinal: true };
  }
  if (kind === "assistant_error") {
    return { kind: "error", message, isFinal: true };
  }

  return { kind: "ignored", message, isFinal: false };
}

function messageRecordToIntermediate(
  message: MessageRecord,
): GenerationStreamIntermediateMessage | null {
  if (!isContentBlockArray(message.content) || message.content.length === 0) {
    return null;
  }
  const meta = isRecord(message.meta) ? message.meta : {};
  return {
    id: message.id,
    sessionId: message.sessionId,
    sequence: message.sequence,
    role: message.role,
    messageId:
      typeof meta.streamMessageId === "string"
        ? meta.streamMessageId
        : message.id ?? null,
    messageOrdinal:
      typeof meta.messageOrdinal === "number" ? meta.messageOrdinal : null,
    content: message.content,
    text: message.text,
    provider: message.provider,
    model: message.model,
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
    usage: message.usage,
    durationMs: message.durationMs,
    meta: message.meta,
    createdAt: message.createdAt,
  };
}

function resolveStreamMessageId(input: {
  sessionId: string;
  turnId?: string | null;
  anchorUserMessageId?: string | null;
  messageId?: string | null;
  messageOrdinal?: number | null;
}) {
  if (input.messageId?.trim()) return input.messageId.trim();
  if (input.messageOrdinal == null) return null;
  if (input.turnId?.trim()) {
    return `turn:${input.turnId.trim()}:assistant:${input.messageOrdinal}`;
  }
  return `session:${input.sessionId}:assistant:${input.messageOrdinal}:${
    input.anchorUserMessageId ?? "unknown"
  }`;
}

function getTurnIdFromMessage(message: MessageRecord) {
  const turnId = message.meta?.turnId;
  return typeof turnId === "string" ? turnId : null;
}

function isGenerationRealtimeEvent(event: WebsocketEventPayload) {
  return (
    event.type === "session.turn.patch" ||
    event.type === "session.message.persisted" ||
    event.type === "session.turn.finalized" ||
    event.type === "session.turn.updated" ||
    event.type === "session.turn.lifecycle" ||
    event.type === "session.turn.error"
  );
}

function getPatchSeq(event: WebsocketEventPayload) {
  if (event.type !== "session.turn.patch") return null;
  const seq = event.payload.seq;
  return typeof seq === "number" ? seq : null;
}

function getPatchTurnId(event: WebsocketEventPayload) {
  if (event.type !== "session.turn.patch") return null;
  const turnId = event.payload.turnId;
  return typeof turnId === "string" ? turnId : null;
}

function getPatchMessageIdentity(event: WebsocketEventPayload) {
  if (event.type !== "session.turn.patch") {
    return { messageId: null, messageOrdinal: null };
  }
  return {
    messageId:
      typeof event.payload.messageId === "string"
        ? event.payload.messageId
        : null,
    messageOrdinal:
      typeof event.payload.messageOrdinal === "number"
        ? event.payload.messageOrdinal
        : null,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`stream snapshot recovery timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function getIntermediateMessageKey(message: GenerationStreamIntermediateMessage) {
  if (message.messageOrdinal != null) return `ordinal:${message.messageOrdinal}`;
  if (message.messageId) return `message:${message.messageId}`;
  if (message.id) return `id:${message.id}`;
  try {
    return `content:${JSON.stringify(message.content)}`;
  } catch {
    return null;
  }
}

function getToolUseIds(content: ContentBlock[]): string[] {
  return content
    .filter((block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use")
    .map((block) => block.id);
}

/**
 * Root cause (each_key_duplicate): assistant_intermediate messages persisted via
 * `session.message.persisted` never carried `meta.messageOrdinal` (the agent only
 * attached it to the `stream_update`/`session.turn.patch` payload, not to the
 * persisted message meta). `messageRecordToIntermediate` then falls back to
 * `messageId`/`message.id` (a DB UUID) for those records, while the stream-snapshot
 * REST API re-numbers messages by array index (`ordinal:N`). The same logical
 * message ends up under two incompatible dedupe keys when a snapshot-recovery path
 * (ordinal-keyed) and a persisted-message path (id-keyed) both feed into the same
 * intermediateMessages array — producing duplicate entries that crash Svelte's
 * `{#each ... (id)}` in ProcessCard/ToolCallList with each_key_duplicate.
 *
 * The backend fix (apps/agent/src/persistence.ts) now always writes messageOrdinal
 * into persisted meta so both paths share one key space going forward. This
 * cross-key pass stays as defense-in-depth for any message that still lacks an
 * ordinal (e.g. data persisted before the backend fix, or future gaps): if two
 * entries land under different dedupe keys but share a tool_use.id, they are the
 * same logical message and must be merged into one.
 */
function mergeMessagesSharingToolUseId(
  messages: GenerationStreamIntermediateMessage[],
): GenerationStreamIntermediateMessage[] {
  const indexByToolUseId = new Map<string, number>();
  const merged: GenerationStreamIntermediateMessage[] = [];
  for (const message of messages) {
    const toolUseIds = getToolUseIds(message.content ?? []);
    const existingIndex = toolUseIds
      .map((id) => indexByToolUseId.get(id))
      .find((idx): idx is number => idx != null);
    if (existingIndex == null) {
      const newIndex = merged.length;
      merged.push(message);
      for (const id of toolUseIds) indexByToolUseId.set(id, newIndex);
      continue;
    }
    merged[existingIndex] = { ...merged[existingIndex], ...message };
    for (const id of toolUseIds) indexByToolUseId.set(id, existingIndex);
  }
  return merged;
}

function getCompactionPlacement(message: GenerationStreamIntermediateMessage) {
  const meta = isRecord(message.meta) ? message.meta : null;
  const compaction = isRecord(meta?.compaction) ? meta.compaction : null;
  const placement = isRecord(compaction?.placement) ? compaction.placement : null;
  return meta?.messageKind === "compacted"
    ? {
        beforeMessageId:
          typeof placement?.beforeMessageId === "string" ? placement.beforeMessageId : null,
        sequence: typeof message.sequence === "number" ? message.sequence : null,
      }
    : null;
}

function placeCompactionMessages(messages: GenerationStreamIntermediateMessage[]) {
  const result = messages.filter((message) => !getCompactionPlacement(message));
  const compactions = messages.filter((message) => getCompactionPlacement(message));
  for (const message of compactions) {
    const placement = getCompactionPlacement(message);
    let index = placement?.beforeMessageId
      ? result.findIndex((candidate) =>
          candidate.id === placement.beforeMessageId || candidate.messageId === placement.beforeMessageId)
      : -1;
    const sequence = placement?.sequence;
    if (index < 0 && sequence != null) {
      index = result.findIndex(
        (candidate) => typeof candidate.sequence === "number" && candidate.sequence >= sequence,
      );
    }
    result.splice(index < 0 ? result.length : index, 0, message);
  }
  return result;
}

function compactIntermediateMessages(messages: GenerationStreamIntermediateMessage[]) {
  const merged: GenerationStreamIntermediateMessage[] = [];
  const indexByKey = new Map<string, number>();
  for (const message of messages) {
    const key = getIntermediateMessageKey(message);
    if (!key) {
      merged.push(message);
      continue;
    }
    const index = indexByKey.get(key);
    if (index == null) {
      indexByKey.set(key, merged.length);
      merged.push(message);
      continue;
    }
    merged[index] = { ...merged[index], ...message };
  }
  return placeCompactionMessages(mergeMessagesSharingToolUseId(merged));
}

function normalizeSnapshotIntermediateMessages(
  messages: NonNullable<SessionTurnStreamSnapshotResponse["snapshot"]>["intermediateMessages"],
): GenerationStreamIntermediateMessage[] {
  return compactIntermediateMessages(
    messages
      .filter((message) => Array.isArray(message.content))
      .map((message) => ({
        ...message,
        messageId: message.messageId ?? null,
        messageOrdinal: message.messageOrdinal ?? null,
        content: message.content,
      })),
  );
}

type StreamSnapshot = NonNullable<SessionTurnStreamSnapshotResponse["snapshot"]>;

type SnapshotRecovery = { events: WebsocketEventPayload[] };

export class SessionGenerationStreamClient {
  private readonly reducer = new SessionPatchReducer();
  private messageId: string | null = null;
  private messageOrdinal: number | null = null;
  private intermediateMessages: GenerationStreamIntermediateMessage[] = [];
  private patchState: SessionPatchState | null = null;
  private recovery: SnapshotRecovery | null = null;
  private resyncedMessageKey: string | null = null;
  private disposed = false;

  constructor(
    private readonly websocketClient: WebsocketClient | null,
    private readonly spaceId: string,
    private readonly sessionId: string,
    private readonly fetchStreamSnapshot?: () => Promise<SessionTurnStreamSnapshotResponse>,
  ) {}

  subscribe(
    handlers: GenerationStreamSubscriptionHandlers,
    options: GenerationStreamSubscribeOptions = {},
  ) {
    if (!this.websocketClient) {
      throw new Error("realtime transport is not configured for this client");
    }
    ensureRealtimeConnected(this.websocketClient);
    const stream = new SessionGenerationStreamClient(
      this.websocketClient,
      this.spaceId,
      this.sessionId,
      this.fetchStreamSnapshot,
    );
    const releaseRoom = this.websocketClient.retainRooms([getRealtimeSpaceRoom(this.spaceId)]);
    const unsubscribe = this.websocketClient.on("event", (event) => {
      if (event.spaceId !== this.spaceId || event.sessionId !== this.sessionId) {
        return;
      }
      stream.receive(event, handlers);
    });

    const { initialSnapshot } = options;
    if (initialSnapshot !== undefined) {
      void stream.recover(handlers, async () => initialSnapshot, options);
    } else if (options.recover === true) {
      void stream.recover(handlers, () => stream.loadSnapshot(), options);
    }

    return () => {
      stream.dispose();
      unsubscribe();
      releaseRoom();
    };
  }

  private receive(
    event: WebsocketEventPayload,
    handlers: GenerationStreamSubscriptionHandlers,
  ) {
    if (this.disposed) return;
    const recovery = this.recovery;
    if (recovery && isGenerationRealtimeEvent(event)) {
      recovery.events.push(event);
      if (recovery.events.length > SNAPSHOT_RECOVERY_MAX_BUFFERED_EVENTS) {
        this.finishRecovery(recovery, handlers);
      }
      return;
    }
    this.handleEvent(event, handlers);
  }

  private dispose() {
    this.disposed = true;
    this.recovery = null;
  }

  private async loadSnapshot(): Promise<StreamSnapshot | null> {
    if (!this.fetchStreamSnapshot) return null;
    try {
      const response = await withTimeout(this.fetchStreamSnapshot(), SNAPSHOT_RECOVERY_TIMEOUT_MS);
      return response.snapshot;
    } catch (error) {
      console.warn("[SessionGenerationStreamClient] Failed to recover stream snapshot:", error);
      return null;
    }
  }

  private async recover(
    handlers: GenerationStreamSubscriptionHandlers,
    load: () => Promise<StreamSnapshot | null>,
    options?: GenerationStreamSubscribeOptions,
    resync?: { turnId: string | null; event: WebsocketEventPayload },
  ) {
    const recovery: SnapshotRecovery = { events: resync ? [resync.event] : [] };
    this.recovery = recovery;
    const snapshot = await load().catch(() => null);
    if (this.recovery !== recovery) return;
    const expectedTurnId = resync?.turnId;
    if (snapshot && (!expectedTurnId || !snapshot.turnId || snapshot.turnId === expectedTurnId)) {
      this.seedFromSnapshot(snapshot, handlers, options);
    }
    this.finishRecovery(recovery, handlers);
  }

  private finishRecovery(
    recovery: SnapshotRecovery,
    handlers: GenerationStreamSubscriptionHandlers,
  ) {
    if (this.recovery !== recovery) return;
    this.recovery = null;
    this.replayBufferedEvents(recovery.events, handlers);
  }

  private shouldResync(turnId: string | null, messageId: string | null) {
    if (!this.fetchStreamSnapshot || this.recovery) return false;
    const key = `${turnId ?? ""}:${messageId ?? ""}`;
    if (key === this.resyncedMessageKey) return false;
    this.resyncedMessageKey = key;
    return true;
  }

  private liveState() {
    return this.reducer.get({ spaceId: this.spaceId, sessionId: this.sessionId });
  }

  private isForeignTurn(turnId: string | null | undefined) {
    if (!turnId) return false;
    const live = this.liveState();
    return (
      (live.status === "streaming" || live.status === "pending") &&
      live.turnId != null &&
      live.turnId !== turnId
    );
  }

  private isLiveMessage(message: MessageRecord) {
    if (this.messageId == null && this.messageOrdinal == null) return true;
    const meta = message.meta ?? {};
    if (typeof meta.messageOrdinal === "number" && this.messageOrdinal != null) {
      return meta.messageOrdinal === this.messageOrdinal;
    }
    return typeof meta.streamMessageId === "string" && meta.streamMessageId === this.messageId;
  }

  private seedFromSnapshot(
    snapshot: StreamSnapshot,
    handlers: GenerationStreamSubscriptionHandlers,
    options?: GenerationStreamSubscribeOptions,
  ) {
    if (snapshot.spaceId !== this.spaceId || snapshot.sessionId !== this.sessionId) return false;
    const intermediateMessages = normalizeSnapshotIntermediateMessages(
      snapshot.intermediateMessages,
    );
    const result = this.reducer.applySnapshot({
      spaceId: snapshot.spaceId,
      sessionId: snapshot.sessionId,
      turnId: snapshot.turnId,
      seq: snapshot.seq,
      contentBlocks: snapshot.current.content,
      anchorUserMessageId: snapshot.anchorUserMessageId,
      appendPath: snapshot.current.appendPath,
    });
    if (!result.applied) return false;
    this.patchState = result.state;
    this.messageId = snapshot.current.messageId;
    this.messageOrdinal = snapshot.current.messageOrdinal;
    this.intermediateMessages = intermediateMessages;
    if (options?.emitSnapshotState !== false) {
      this.emit(handlers, {
        type: "state",
        source: "snapshot",
        state: result.state,
        messageId: this.messageId,
        messageOrdinal: this.messageOrdinal,
        intermediateMessages: [...this.intermediateMessages],
        rawEvent: null,
      });
    }
    return true;
  }

  private replayBufferedEvents(
    events: WebsocketEventPayload[],
    handlers: GenerationStreamSubscriptionHandlers,
  ) {
    for (const event of events) {
      const seq = getPatchSeq(event);
      const turnId = getPatchTurnId(event);
      const identity = getPatchMessageIdentity(event);
      const sameTurn = Boolean(
        seq != null &&
          this.patchState?.turnId &&
          turnId &&
          this.patchState.turnId === turnId,
      );
      const sameMessage =
        sameTurn &&
        Boolean(
          this.messageId &&
            ((identity.messageId && identity.messageId === this.messageId) ||
              (identity.messageId == null &&
                identity.messageOrdinal != null &&
                identity.messageOrdinal === this.messageOrdinal)),
        );
      const olderMessageInSameTurn =
        sameTurn &&
        identity.messageOrdinal != null &&
        this.messageOrdinal != null &&
        identity.messageOrdinal < this.messageOrdinal;
      if (
        (sameMessage || olderMessageInSameTurn) &&
        this.patchState &&
        seq != null &&
        seq <= this.patchState.patchSeq
      ) {
        continue;
      }
      this.receive(event, handlers);
    }
  }

  private emit(
    handlers: GenerationStreamSubscriptionHandlers,
    event: GenerationStreamEvent,
  ) {
    handlers.event?.(event);
    if (event.type === "state") handlers.state?.(event);
    if (event.type === "commit") handlers.commit?.(event);
    if (event.type === "finalized") handlers.finalized?.(event);
    if (event.type === "turn_updated") handlers.turnUpdated?.(event);
    if (event.type === "lifecycle") handlers.lifecycle?.(event);
    if (event.type === "error") handlers.error?.(event);
    if (event.type === "out_of_sync") handlers.outOfSync?.(event);
  }

  private resetCurrentMessage() {
    this.messageId = null;
    this.messageOrdinal = null;
    this.patchState = null;
  }

  private appendCurrentMessage(state: SessionPatchState) {
    if (state.contentBlocks.length === 0) return;
    this.addIntermediateMessage({
      messageId: this.messageId,
      messageOrdinal: this.messageOrdinal,
      content: state.contentBlocks,
    });
  }

  private addIntermediateMessage(message: GenerationStreamIntermediateMessage) {
    this.intermediateMessages = compactIntermediateMessages([
      ...this.intermediateMessages,
      message,
    ]);
  }

  private handleAppliedState(
    handlers: GenerationStreamSubscriptionHandlers,
    source: "patch",
    result: SessionPatchApplyResult,
    rawEvent: WebsocketEventPayload,
    messageId: string | null,
    messageOrdinal: number | null,
  ) {
    if (!result.applied) {
      this.emit(handlers, {
        type: "out_of_sync",
        source,
        reason: result.reason,
        state: result.state,
        rawEvent,
      });
      return;
    }

    this.patchState = result.state;
    this.messageId = messageId;
    this.messageOrdinal = messageOrdinal;
    this.emit(handlers, {
      type: "state",
      source,
      state: result.state,
      messageId,
      messageOrdinal,
      intermediateMessages: [...this.intermediateMessages],
      rawEvent,
    });
  }

  private prepareMessageBoundary(input: {
    turnId: string | null;
    messageId: string | null;
    messageOrdinal: number | null;
    anchorUserMessageId: string | null;
  }) {
    const current =
      this.patchState ??
      this.reducer.get({
        spaceId: this.spaceId,
        sessionId: this.sessionId,
      });
    const nextMessageId = resolveStreamMessageId({
      sessionId: this.sessionId,
      turnId: input.turnId,
      anchorUserMessageId: input.anchorUserMessageId,
      messageId: input.messageId,
      messageOrdinal: input.messageOrdinal,
    });
    const differentTurn = Boolean(
      current.turnId && input.turnId && current.turnId !== input.turnId,
    );
    const messageChanged = Boolean(
      nextMessageId &&
        current.contentBlocks.length > 0 &&
        this.messageId &&
        nextMessageId !== this.messageId,
    );

    if (differentTurn) {
      this.intermediateMessages = [];
      this.resetCurrentMessage();
      this.reducer.start({
        spaceId: this.spaceId,
        sessionId: this.sessionId,
        turnId: input.turnId,
      });
    } else if (messageChanged) {
      this.appendCurrentMessage(current);
      this.resetCurrentMessage();
      this.reducer.start({
        spaceId: this.spaceId,
        sessionId: this.sessionId,
        turnId: input.turnId ?? current.turnId,
      });
    }

    return nextMessageId;
  }

  private handlePatch(
    event: WebsocketEventPayload,
    handlers: GenerationStreamSubscriptionHandlers,
  ) {
    const payload = event.payload;
    const seq = typeof payload.seq === "number" ? payload.seq : null;
    const baseSeq = typeof payload.baseSeq === "number" ? payload.baseSeq : null;
    if (seq === null || baseSeq === null || !Array.isArray(payload.ops)) {
      this.emit(handlers, {
        type: "out_of_sync",
        source: "patch",
        reason: "invalid",
        state: this.reducer.get({ spaceId: this.spaceId, sessionId: this.sessionId }),
        rawEvent: event,
      });
      return;
    }

    const turnId = typeof payload.turnId === "string" ? payload.turnId : null;
    const anchorUserMessageId =
      typeof payload.anchorUserMessageId === "string"
        ? payload.anchorUserMessageId
        : null;
    const messageOrdinal =
      typeof payload.messageOrdinal === "number" ? payload.messageOrdinal : null;
    const messageId = this.prepareMessageBoundary({
      turnId,
      messageId:
        typeof payload.messageId === "string" ? payload.messageId : null,
      messageOrdinal,
      anchorUserMessageId,
    });

    const input: SessionPatchApplyInput = {
      spaceId: this.spaceId,
      sessionId: this.sessionId,
      turnId,
      seq,
      baseSeq,
      ops: payload.ops as SessionPatchApplyInput["ops"],
      anchorUserMessageId,
    };
    const result = this.reducer.applyPatch(input);
    if (
      !result.applied &&
      result.reason === "version_mismatch" &&
      this.shouldResync(turnId, messageId)
    ) {
      // The snapshot is cached before a patch is published, so it covers this one.
      void this.recover(handlers, () => this.loadSnapshot(), undefined, { turnId, event });
      return;
    }
    this.handleAppliedState(
      handlers,
      "patch",
      result,
      event,
      messageId,
      messageOrdinal,
    );
  }

  private handlePersisted(
    event: WebsocketEventPayload,
    handlers: GenerationStreamSubscriptionHandlers,
  ) {
    const message = event.payload.message;
    if (!isRecord(message)) return;
    const commit = parseAssistantMessageCommit(message as MessageRecord);
    const turnId = getTurnIdFromMessage(commit.message);
    const key = { spaceId: this.spaceId, sessionId: this.sessionId, turnId };
    if (commit.kind !== "ignored" && !this.isForeignTurn(turnId)) {
      if (commit.kind === "intermediate") {
        const intermediate = messageRecordToIntermediate(commit.message);
        if (intermediate) this.addIntermediateMessage(intermediate);
        if (this.isLiveMessage(commit.message)) {
          this.reducer.start({ ...key, turnId: turnId ?? this.liveState().turnId });
          this.resetCurrentMessage();
        }
      } else {
        if (commit.kind === "final") this.reducer.complete(key);
        else this.reducer.fail(key);
        this.resetCurrentMessage();
      }
    }

    this.emit(handlers, {
      type: "commit",
      commit,
      rawEvent: event,
    });
  }

  private handleFinalized(
    event: WebsocketEventPayload,
    handlers: GenerationStreamSubscriptionHandlers,
  ) {
    const turn = event.payload.turn;
    if (!isRecord(turn)) return;
    const typedTurn = turn as SessionTurnRecord;
    if (!this.isForeignTurn(typedTurn.id)) {
      const key = { spaceId: this.spaceId, sessionId: this.sessionId, turnId: typedTurn.id };
      if (typedTurn.status === "interrupted") this.reducer.interrupt(key);
      else this.reducer.complete(key);
      this.resetCurrentMessage();
    }
    this.emit(handlers, {
      type: "finalized",
      turn: typedTurn,
      rawEvent: event,
    });
  }

  private handleEvent(
    event: WebsocketEventPayload,
    handlers: GenerationStreamSubscriptionHandlers,
  ) {
    switch (event.type) {
      case "session.turn.patch":
        this.handlePatch(event, handlers);
        return;
      case "session.message.persisted":
        this.handlePersisted(event, handlers);
        return;
      case "session.turn.finalized":
        this.handleFinalized(event, handlers);
        return;
      case "session.turn.updated": {
        const turn = event.payload.turn;
        if (!isRecord(turn)) return;
        this.emit(handlers, {
          type: "turn_updated",
          turn: turn as Partial<SessionTurnRecord>,
          rawEvent: event,
        });
        return;
      }
      case "session.turn.lifecycle": {
        const payload = event.payload;
        if (payload.phase !== "llm_call_started") return;
        this.emit(handlers, {
          type: "lifecycle",
          phase: "llm_call_started",
          turnId: typeof payload.turnId === "string" ? payload.turnId : null,
          anchorUserMessageId:
            typeof payload.anchorUserMessageId === "string"
              ? payload.anchorUserMessageId
              : null,
          llmRound: typeof payload.llmRound === "number" ? payload.llmRound : 1,
          provider: typeof payload.provider === "string" ? payload.provider : null,
          model: typeof payload.model === "string" ? payload.model : null,
          at: typeof payload.at === "string" ? payload.at : new Date(event.timestamp).toISOString(),
          rawEvent: event,
        });
        return;
      }
      case "session.turn.error": {
        const message =
          typeof event.payload.error === "string" && event.payload.error.trim()
            ? event.payload.error.trim()
            : "Generation failed";
        this.reducer.fail({ spaceId: this.spaceId, sessionId: this.sessionId });
        this.resetCurrentMessage();
        this.emit(handlers, {
          type: "error",
          message,
          rawEvent: event,
        });
        return;
      }
      default:
        return;
    }
  }
}

export function createSessionGenerationStreamClient(input: {
  websocketClient: WebsocketClient | null;
  spaceId: string;
  sessionId: string;
  fetchStreamSnapshot?: () => Promise<SessionTurnStreamSnapshotResponse>;
}) {
  return new SessionGenerationStreamClient(
    input.websocketClient,
    input.spaceId,
    input.sessionId,
    input.fetchStreamSnapshot,
  );
}
