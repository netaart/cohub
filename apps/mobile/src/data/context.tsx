import type {
  CohubClient,
  ContentBlock,
  MessageRecord,
  ModelStatusResponse,
  SessionRecord,
  SessionTurnIndexItem,
  SessionTurnRecord,
  SpaceRecord,
  SpaceUsageSummary,
  UserSessionListItem,
} from "@neta-art/cohub";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState as NativeAppState } from "react-native";
import { File as ExpoFile } from "expo-file-system";
import { translate } from "@/src/i18n/core";
import { createMobileClient } from "@/src/data/client";
import { createStreamBatch } from "@/src/data/chat-rendering";
import {
  clearUserCache,
  hydrateHome,
  loadMessages,
  loadSessionReadSequence,
  saveHome,
  saveMessages,
  saveSessionReadSequence,
} from "@/src/data/local-db";
import type {
  ActivityItem,
  AppState,
  AttachmentDraft,
  ChatModelCatalogItem,
  ChatModelSelection,
  ConnectionState,
  SessionView,
  StreamView,
} from "@/src/data/types";
import { hasFinalAssistantForTurn, isActiveTurnStatus, isTerminalTurnStatus, liveStreamStatusFromPatch, pendingStreamForTurn, streamRecoveryFromTail } from "@/src/data/chat-stream";
import { mergeDisplayMessages, mergeTurns, messagesFromTurns, nextTurnSequence, turnSequenceForMessage, withFallbackUserContent } from "@/src/data/session-history";
import { forkSessionTurn } from "@/src/data/session-fork";
import { getResourcePinState, invalidateResourcePinReads, isResourcePinned, loadResourcePinStates, toggleResourcePin } from "@/src/data/resource-pins";
import { getInstallationId } from "@/src/platform/installation";
import { getSessionStatus, latestTurn, loadSessionLatestTurns, reconcileLatestTurn, reconcileTurnStatusPatch, type LatestSessionTurn } from "@/src/data/session-status";
import { connectionDisplayState, createSessionResyncCoordinator, isTransportRecovery, type SessionResyncReason } from "@/src/data/session-reconnect";
import {
  displaySessionTitle,
  displaySpaceName,
  newId,
  sortByRecent,
} from "@/src/utils";

const HOME_REQUEST_TIMEOUT_MS = 15_000;
// Reconnect `open` and AppState `active` usually fire together; collapse them into one resync.
const SESSION_RESYNC_DEBOUNCE_MS = 250;
// Mirrors the web client: never re-seed the same session's stream more than once per window.
const OUT_OF_SYNC_RESYNC_COOLDOWN_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(translate("data.timeout", { label, seconds: 15 }))), HOME_REQUEST_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function errorMessage(error: unknown, fallback: string) {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (status === 401) return translate("data.signInRejected");
    if (status === 403) return translate("data.noAccess");
  }
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

async function buildPromptContent(
  client: CohubClient,
  spaceId: string,
  sessionId: string | undefined,
  text: string,
  attachments: AttachmentDraft[],
) {
  let promptText = text;
  const content: ContentBlock[] = [];
  const imageBlocks: ContentBlock[] = [];
  for (const attachment of attachments) {
    const blob: Blob = new ExpoFile(attachment.uri);
    const uploaded = await client.publicAssets.uploadChatAttachment({
      spaceId,
      sessionId,
      file: blob,
      mimeType: attachment.mimeType,
      filename: attachment.name,
    });
    if (attachment.mimeType.startsWith("image/")) {
      imageBlocks.push({
        type: "image",
        source: { type: "url", url: uploaded.publicUrl },
        _meta: {
          filename: attachment.name,
          mediaType: attachment.mimeType,
          size: attachment.size,
        },
      });
    } else {
      promptText = [
        promptText,
        `Attached file: ${attachment.name}\n${uploaded.publicUrl}`,
      ].filter(Boolean).join("\n\n");
    }
  }
  if (promptText) content.push({ type: "text", text: promptText });
  content.push(...imageBlocks);
  return content;
}

function withAccessTokenTimeout(
  promise: Promise<string | null>,
  timeoutMs = 10_000,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const emptyView = (): SessionView => ({
  space: null,
  session: null,
  messages: [],
  turns: [],
  historyLoaded: false,
  turnIndex: [],
  turnIndexLoading: false,
  hasMoreOlder: false,
  hasMoreNewer: false,
  loadingOlder: false,
  loadingNewer: false,
  oldestCursor: null,
  newestCursor: null,
  loading: false,
  refreshing: false,
  sending: false,
  error: null,
  stream: null,
});

const initialState: AppState = {
  booting: true,
  refreshing: false,
  error: null,
  spacesError: null,
  sessionsError: null,
  activityLoading: false,
  activityError: null,
  lastSyncedAt: null,
  spaces: [],
  sessions: [],
  sessionsHasMore: false,
  sessionsCursor: null,
  sessionsLoadingMore: false,
  sessionLatestTurns: {},
  sessionStatusRequests: 0,
  sessionStatusError: null,
  sessionViews: {},
  usage: null,
};

type Action =
  | { type: "hydrate"; spaces: SpaceRecord[]; sessions: UserSessionListItem[] }
  | { type: "home-start" }
  | { type: "home-success"; spaces: SpaceRecord[]; sessions: UserSessionListItem[]; sessionsHasMore?: boolean; sessionsCursor?: string | null; spacesError?: string; sessionsError?: string }
  | { type: "sessions-more-start" }
  | { type: "sessions-more-success"; sessions: UserSessionListItem[]; hasMore: boolean; cursor: string | null }
  | { type: "sessions-more-error"; message: string }
  | { type: "session-status-start" }
  | { type: "session-status-reset" }
  | { type: "session-status-end"; error?: string | null }
  | { type: "session-latest-turn"; sessionId: string; turn: LatestSessionTurn | null }
  | { type: "home-error"; message: string }
  | { type: "usage-start" }
  | { type: "usage"; usage: SpaceUsageSummary }
  | { type: "usage-error"; message: string }
  | { type: "session-start"; sessionId: string; space?: SpaceRecord | null; session?: SessionRecord | null }
  | { type: "session-meta"; sessionId: string; space?: SpaceRecord | null; session: SessionRecord }
  | { type: "session-cache"; sessionId: string; messages: MessageRecord[] }
  | { type: "session-success"; sessionId: string; space: SpaceRecord; session: SessionRecord; messages: MessageRecord[]; turns: SessionTurnRecord[]; hasMoreOlder: boolean; hasMoreNewer?: boolean; oldestCursor?: number | null; newestCursor?: number | null }
  | { type: "session-error"; sessionId: string; message: string }
  | { type: "session-refresh-start"; sessionId: string; silent?: boolean }
  | { type: "session-refresh-end"; sessionId: string; silent?: boolean; session?: SessionRecord; messages?: MessageRecord[]; turns?: SessionTurnRecord[]; hasMoreOlder?: boolean; hasMoreNewer?: boolean; oldestCursor?: number | null; newestCursor?: number | null; error?: string }
  | { type: "session-page-start"; sessionId: string; direction: "older" | "newer" }
  | { type: "session-page-success"; sessionId: string; session?: SessionRecord | null; turns: SessionTurnRecord[]; hasMore: boolean; direction: "older" | "newer" }
  | { type: "session-page-error"; sessionId: string; message: string }
  | { type: "session-page-end"; sessionId: string; direction: "older" | "newer" }
  | { type: "session-window-success"; sessionId: string; session?: SessionRecord | null; turns: SessionTurnRecord[]; hasMoreOlder: boolean; hasMoreNewer: boolean; oldestCursor?: number | null; newestCursor?: number | null }
  | { type: "turn-upsert"; sessionId: string; session?: SessionRecord | null; turn: SessionTurnRecord }
  | { type: "turn-patch"; sessionId: string; turn: Partial<SessionTurnRecord> }
  | { type: "turn-index-start"; sessionId: string }
  | { type: "turn-index"; sessionId: string; turnIndex: SessionTurnIndexItem[] }
  | { type: "turn-index-end"; sessionId: string }
  | { type: "message-add"; sessionId: string; message: MessageRecord }
  | { type: "message-optimistic"; sessionId: string; message: MessageRecord }
  | { type: "send-start"; sessionId: string }
  | { type: "send-end"; sessionId: string }
  | { type: "send-failed"; sessionId: string; clientMessageId: string; message: string }
  | { type: "stream-state"; sessionId: string; stream: StreamView }
  | { type: "stream-lifecycle"; sessionId: string; provider: string | null; model: string | null }
  | { type: "stream-clear"; sessionId: string }
  | { type: "session-upsert"; session: UserSessionListItem }
  | { type: "space-upsert"; space: SpaceRecord };

function isLiveMessage(message: MessageRecord) {
  return message.meta?.optimistic === true || message.meta?._mobileLive === true;
}

function mergeMessages(messages: MessageRecord[], incoming: MessageRecord) {
  const clientMessageId = incoming.meta?.clientMessageId;
  const optimisticId = clientMessageId
    ? messages.find((message) => message.meta?.clientMessageId === clientMessageId)?.id
    : null;
  const byId = new Map(messages.map((message) => [message.id, message]));
  if (optimisticId && optimisticId !== incoming.id) byId.delete(optimisticId);
  const previous = byId.get(incoming.id);
  byId.set(incoming.id, previous ? { ...previous, ...incoming } : incoming);
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

function turnClientMessageId(turn: { meta?: Record<string, unknown> | null }) {
  const value = turn.meta?.clientMessageId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function mergeTurnRecords(existing: SessionTurnRecord[], incoming: SessionTurnRecord[]) {
  const byId = new Map(existing.map((turn) => [turn.id, turn]));
  for (const turn of incoming) {
    const clientMessageId = turnClientMessageId(turn);
    const previous = byId.get(turn.id) ?? (clientMessageId ? [...byId.values()].find((item) => turnClientMessageId(item) === clientMessageId) : undefined);
    if (previous && previous.id !== turn.id) byId.delete(previous.id);
    byId.set(turn.id, previous ? { ...previous, ...turn, meta: turn.meta ? { ...(previous.meta ?? {}), ...turn.meta } : previous.meta } : turn);
  }
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

function patchTurnRecords(existing: SessionTurnRecord[], patch: Partial<SessionTurnRecord>) {
  const clientMessageId = turnClientMessageId(patch);
  const index = existing.findIndex((turn) => turn.id === patch.id || (clientMessageId !== null && turnClientMessageId(turn) === clientMessageId));
  if (index < 0) return existing;
  const previous = existing[index];
  if (!previous) return existing;
  const next = [...existing];
  next[index] = { ...previous, ...patch, meta: patch.meta ? { ...(previous.meta ?? {}), ...patch.meta } : previous.meta };
  return next.sort((a, b) => a.sequence - b.sequence);
}

function updateLatestTurn(state: AppState, sessionId: string, turn: LatestSessionTurn | null): AppState {
  return {
    ...state,
    sessionLatestTurns: { ...state.sessionLatestTurns, [sessionId]: reconcileLatestTurn(state.sessionLatestTurns[sessionId], turn) },
  };
}

function updateView(state: AppState, sessionId: string, update: Partial<SessionView>) {
  const current = state.sessionViews[sessionId] ?? emptyView();
  return {
    ...state,
    sessionViews: {
      ...state.sessionViews,
      [sessionId]: { ...current, ...update },
    },
  };
}

function preferNewerSession(current: SessionRecord | null | undefined, incoming: SessionRecord) {
  if (!current) return incoming;
  const currentTime = Date.parse(current.updatedAt);
  const incomingTime = Date.parse(incoming.updatedAt);
  return Number.isFinite(currentTime) && Number.isFinite(incomingTime) && currentTime > incomingTime
    ? current
    : incoming;
}

function mergeSessionItem(current: UserSessionListItem | undefined, incoming: UserSessionListItem) {
  if (!current) return incoming;
  const preferred = preferNewerSession(current, incoming);
  return preferred === current
    ? { ...current, space: current.space ?? incoming.space }
    : { ...current, ...incoming, space: incoming.space ?? current.space };
}

function preserveSpacePin(current: SpaceRecord | undefined, incoming: SpaceRecord) {
  return incoming.isPinned === undefined && current?.isPinned !== undefined
    ? { ...incoming, isPinned: current.isPinned }
    : incoming;
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "hydrate":
      return {
        ...state,
        spaces: sortByRecent(action.spaces),
        sessions: sortByRecent(action.sessions),
        booting: false,
      };
    case "home-start":
      return { ...state, refreshing: true, error: null, spacesError: null, sessionsError: null, activityLoading: true, activityError: null };
    case "home-success": {
      const existingSpaces = new Map(state.spaces.map((space) => [space.id, space]));
      const refreshedSpaces = action.spaces.map((space) => preserveSpacePin(existingSpaces.get(space.id), space));
      const existingSessions = new Map(state.sessions.map((session) => [session.id, session]));
      const refreshedSessions = action.sessions.map((session) => mergeSessionItem(existingSessions.get(session.id), session));
      return {
        ...state,
        booting: false,
        refreshing: false,
        error: null,
        spacesError: action.spacesError ?? null,
        sessionsError: action.sessionsError ?? null,
        lastSyncedAt: new Date().toISOString(),
        spaces: sortByRecent(refreshedSpaces),
        sessions: sortByRecent(refreshedSessions),
        sessionsHasMore: action.sessionsHasMore ?? false,
        sessionsCursor: action.sessionsCursor ?? null,
        sessionsLoadingMore: false,
      };
    }
    case "sessions-more-start":
      return { ...state, sessionsLoadingMore: true, sessionsError: null };
    case "sessions-more-success": {
      const incomingById = new Map(action.sessions.map((session) => [session.id, session]));
      const existingIds = new Set(state.sessions.map((session) => session.id));
      const merged = [
        ...state.sessions.map((session) => {
          const incoming = incomingById.get(session.id);
          return incoming ? mergeSessionItem(session, incoming) : session;
        }),
        ...action.sessions.filter((session) => !existingIds.has(session.id)),
      ];
      return { ...state, sessionsLoadingMore: false, sessions: sortByRecent(merged), sessionsHasMore: action.hasMore, sessionsCursor: action.cursor };
    }
    case "sessions-more-error":
      return { ...state, sessionsLoadingMore: false, sessionsError: action.message };
    case "session-status-start":
      return { ...state, sessionStatusRequests: state.sessionStatusRequests + 1, sessionStatusError: state.sessionStatusRequests === 0 ? null : state.sessionStatusError };
    case "session-status-reset":
      return { ...state, sessionLatestTurns: {}, sessionStatusRequests: 0, sessionStatusError: null };
    case "session-status-end":
      return { ...state, sessionStatusRequests: state.sessionStatusRequests - 1, sessionStatusError: action.error ?? null };
    case "session-latest-turn":
      return updateLatestTurn(state, action.sessionId, action.turn);
    case "home-error":
      return { ...state, booting: false, refreshing: false, activityLoading: false, error: action.message, spacesError: action.message, sessionsError: action.message, activityError: action.message };
    case "usage-start":
      return { ...state, activityLoading: true, activityError: null };
    case "usage":
      return { ...state, activityLoading: false, activityError: null, usage: action.usage };
    case "usage-error":
      return { ...state, activityLoading: false, activityError: action.message };
    case "session-start":
      return updateView(state, action.sessionId, {
        loading: true,
        historyLoaded: false,
        loadingOlder: false,
        loadingNewer: false,
        error: null,
        space: action.space ?? state.sessionViews[action.sessionId]?.space ?? null,
        session: action.session ?? state.sessionViews[action.sessionId]?.session ?? null,
      });
    case "session-meta":
      return updateView(state, action.sessionId, {
        space: action.space ?? state.sessionViews[action.sessionId]?.space ?? null,
        session: action.session,
      });
    case "session-cache":
      return updateView(state, action.sessionId, { messages: action.messages, loading: false });
    case "session-success": {
      const session = preferNewerSession(
        state.sessionViews[action.sessionId]?.session,
        action.session,
      );
      return updateView(
        updateLatestTurn(
          {
            ...state,
            sessions: state.sessions.map((item) =>
              item.id === session.id
                ? { ...mergeSessionItem(item, session as UserSessionListItem), space: item.space ?? { id: action.space.id, name: displaySpaceName(action.space), slug: action.space.slug, publicProfile: action.space.publicProfile ?? null } }
                : item,
            ),
          },
          action.sessionId,
          latestTurn(action.turns),
        ),
        action.sessionId,
        {
          loading: false,
          refreshing: false,
          error: null,
          space: action.space,
          session,
          messages: action.messages,
          turns: action.turns,
          historyLoaded: true,
          hasMoreOlder: action.hasMoreOlder,
          hasMoreNewer: action.hasMoreNewer ?? false,
          loadingOlder: false,
          loadingNewer: false,
          oldestCursor: action.oldestCursor ?? action.turns[0]?.sequence ?? null,
          newestCursor: action.newestCursor ?? action.turns.at(-1)?.sequence ?? null,
        },
      );
    }
    case "session-error":
      return updateView(state, action.sessionId, { loading: false, refreshing: false, error: action.message });
    case "session-refresh-start":
      return updateView(state, action.sessionId, action.silent ? { error: null } : { refreshing: true, error: null });
    case "session-refresh-end": {
      const current = state.sessionViews[action.sessionId];
      const session = action.session && current?.session
        ? preferNewerSession(current.session, action.session)
        : action.session;
      const tail = action.turns ? latestTurn(action.turns) : null;
      // After a gap the local stream can be stale either way: the turn finished
      // while we were away, or it is still running and the overlay was lost.
      const streamRecovery = streamRecoveryFromTail({
        stream: current?.stream,
        tail,
        turns: action.turns ?? current?.turns ?? [],
        messages: action.messages ?? current?.messages ?? [],
      });
      return updateView(action.turns ? updateLatestTurn(state, action.sessionId, tail) : state, action.sessionId, {
        ...(action.silent ? {} : { refreshing: false }),
        ...(session ? { session } : {}),
        ...(action.messages ? { messages: action.messages } : {}),
        ...(action.turns ? { turns: action.turns, historyLoaded: true } : {}),
        ...(streamRecovery === "clear" ? { stream: null } : streamRecovery === "pending" && tail ? { stream: pendingStreamForTurn(tail.id) } : {}),
        ...(action.hasMoreOlder !== undefined ? { hasMoreOlder: action.hasMoreOlder } : {}),
        ...(action.hasMoreNewer !== undefined ? { hasMoreNewer: action.hasMoreNewer } : {}),
        ...(action.oldestCursor !== undefined ? { oldestCursor: action.oldestCursor } : {}),
        ...(action.newestCursor !== undefined ? { newestCursor: action.newestCursor } : {}),
        ...(action.error ? { error: action.error } : {}),
      });
    }
    case "session-page-start":
      return updateView(state, action.sessionId, action.direction === "older" ? { loadingOlder: true, error: null } : { loadingNewer: true, error: null });
    case "session-page-success": {
      const current = state.sessionViews[action.sessionId] ?? emptyView();
      const turns = mergeTurns(current.turns, action.turns);
      const session = action.session && current.session ? preferNewerSession(current.session, action.session) : action.session;
      return updateView(updateLatestTurn(state, action.sessionId, latestTurn(turns)), action.sessionId, {
        error: null,
        ...(session ? { session } : {}),
        turns,
        historyLoaded: true,
        messages: mergeDisplayMessages(messagesFromTurns(turns), current.messages.filter(isLiveMessage)),
        hasMoreOlder: action.direction === "older" ? action.hasMore : current.hasMoreOlder,
        hasMoreNewer: action.direction === "newer" ? action.hasMore : current.hasMoreNewer,
        loadingOlder: action.direction === "older" ? false : current.loadingOlder,
        loadingNewer: action.direction === "newer" ? false : current.loadingNewer,
        oldestCursor: turns[0]?.sequence ?? current.oldestCursor,
        newestCursor: turns.at(-1)?.sequence ?? current.newestCursor,
      });
    }
    case "session-page-error":
      return updateView(state, action.sessionId, { loadingOlder: false, loadingNewer: false, error: action.message });
    case "session-page-end":
      return updateView(state, action.sessionId, action.direction === "older" ? { loadingOlder: false } : { loadingNewer: false });
    case "session-window-success": {
      const current = state.sessionViews[action.sessionId] ?? emptyView();
      const turns = mergeTurns(current.turns, action.turns);
      const session = action.session && current.session ? preferNewerSession(current.session, action.session) : action.session;
      return updateView(updateLatestTurn(state, action.sessionId, latestTurn(turns)), action.sessionId, {
        error: null,
        ...(session ? { session } : {}),
        turns,
        historyLoaded: true,
        messages: mergeDisplayMessages(messagesFromTurns(turns), current.messages.filter(isLiveMessage)),
        hasMoreOlder: action.hasMoreOlder,
        hasMoreNewer: action.hasMoreNewer,
        loadingOlder: false,
        loadingNewer: false,
        oldestCursor: turns[0]?.sequence ?? action.oldestCursor ?? null,
        newestCursor: turns.at(-1)?.sequence ?? action.newestCursor ?? null,
      });
    }
    case "turn-upsert": {
      const current = state.sessionViews[action.sessionId] ?? emptyView();
      const turns = mergeTurnRecords(current.turns, [action.turn]);
      const clientMessageId = turnClientMessageId(action.turn);
      const projected = messagesFromTurns(turns);
      const hasProjectedUser = projected.some((message) => message.role === "user" && (turnSequenceForMessage(message) === action.turn.sequence || message.meta?.turnId === action.turn.id));
      const liveMessages = current.messages.filter((message) => {
        if (!isLiveMessage(message)) return false;
        if (clientMessageId && message.meta?.clientMessageId === clientMessageId && hasProjectedUser) return false;
        return !(hasProjectedUser && message.meta?.optimistic === true && message.role === "user" && turnSequenceForMessage(message) === action.turn.sequence);
      });
      const session = action.session
        ? current.session
          ? preferNewerSession(current.session, action.session)
          : action.session
        : current.session;
      const sessions = action.session
        ? state.sessions.map((item) => item.id === action.session?.id ? mergeSessionItem(item, { ...action.session, space: item.space }) : item)
        : state.sessions;
      return updateView(updateLatestTurn({ ...state, sessions: sortByRecent(sessions) }, action.sessionId, latestTurn(turns)), action.sessionId, {
        ...(session ? { session } : {}),
        turns,
        historyLoaded: true,
        messages: mergeDisplayMessages(projected, liveMessages),
        oldestCursor: turns[0]?.sequence ?? current.oldestCursor,
        newestCursor: turns.at(-1)?.sequence ?? current.newestCursor,
        ...(isTerminalTurnStatus(action.turn.status) && (current.stream?.turnId === action.turn.id || !current.stream) ? { stream: null } : {}),
        ...(isActiveTurnStatus(action.turn.status) && !current.stream ? { stream: pendingStreamForTurn(action.turn.id) } : {}),
      });
    }
    case "turn-patch": {
      const current = state.sessionViews[action.sessionId] ?? emptyView();
      const turns = patchTurnRecords(current.turns, action.turn);
      const nextState = updateLatestTurn(state, action.sessionId, reconcileTurnStatusPatch(state.sessionLatestTurns[action.sessionId], action.turn));
      if (turns === current.turns) return nextState;
      const patched = turns.find((turn) => turn.id === action.turn.id || turn.id === current.stream?.turnId);
      return updateView(nextState, action.sessionId, {
        turns,
        historyLoaded: true,
        messages: mergeDisplayMessages(messagesFromTurns(turns), current.messages.filter(isLiveMessage)),
        oldestCursor: turns[0]?.sequence ?? current.oldestCursor,
        newestCursor: turns.at(-1)?.sequence ?? current.newestCursor,
        ...(isTerminalTurnStatus(patched?.status) && current.stream?.turnId === patched?.id ? { stream: null } : {}),
      });
    }
    case "turn-index-start":
      return updateView(state, action.sessionId, { turnIndexLoading: true });
    case "turn-index":
      return updateView(updateLatestTurn(state, action.sessionId, latestTurn(action.turnIndex)), action.sessionId, { turnIndex: action.turnIndex });
    case "turn-index-end":
      return updateView(state, action.sessionId, { turnIndexLoading: false });
    case "message-add": {
      const view = state.sessionViews[action.sessionId] ?? emptyView();
      const incomingMeta = action.message.meta ?? {};
      const turnId = typeof incomingMeta.turnId === "string" ? incomingMeta.turnId : null;
      const turnSequence = typeof incomingMeta.turnSequence === "number" ? incomingMeta.turnSequence : view.turns.find((turn) => turn.id === turnId)?.sequence;
      const message = { ...action.message, meta: { ...incomingMeta, ...(turnSequence != null ? { turnSequence } : {}), _mobileLive: true } };
      const messages = mergeMessages(view.messages, message);
      const streamDone = action.message.role === "assistant" && incomingMeta.messageKind !== "assistant_intermediate" && hasFinalAssistantForTurn(messages, view.stream?.turnId ?? turnId);
      return updateView(state, action.sessionId, {
        messages,
        ...(streamDone ? { stream: null } : {}),
      });
    }
    case "message-optimistic": {
      const view = state.sessionViews[action.sessionId] ?? emptyView();
      return updateView(state, action.sessionId, {
        messages: mergeMessages(view.messages, action.message),
      });
    }
    case "send-start":
      return updateView(state, action.sessionId, { sending: true, error: null });
    case "send-end":
      return updateView(state, action.sessionId, { sending: false });
    case "send-failed": {
      const view = state.sessionViews[action.sessionId] ?? emptyView();
      const messages = view.messages.map((message) => {
        if (message.meta?.clientMessageId !== action.clientMessageId) return message;
        return { ...message, errorMessage: action.message };
      });
      return updateView(state, action.sessionId, { sending: false, error: action.message, messages });
    }
    case "stream-state": {
      const view = state.sessionViews[action.sessionId] ?? emptyView();
      if (!liveStreamStatusFromPatch(action.stream.status)) {
        return view.stream ? updateView(state, action.sessionId, { stream: null }) : state;
      }
      if (hasFinalAssistantForTurn(view.messages, action.stream.turnId)) return view.stream ? updateView(state, action.sessionId, { stream: null }) : state;
      return updateView(state, action.sessionId, { stream: action.stream });
    }
    case "stream-lifecycle":
      return state.sessionViews[action.sessionId]?.stream
        ? updateView(state, action.sessionId, { stream: { ...state.sessionViews[action.sessionId]!.stream!, runtimePhase: "llm_call_started", runtimeProvider: action.provider, runtimeModel: action.model } })
        : state;
    case "stream-clear":
      return updateView(state, action.sessionId, { stream: null });
    case "session-upsert": {
      const exists = state.sessions.some((session) => session.id === action.session.id);
      return {
        ...state,
        sessions: sortByRecent(
          exists
            ? state.sessions.map((session) => (session.id === action.session.id ? mergeSessionItem(session, action.session) : session))
            : [action.session, ...state.sessions],
        ),
      };
    }
    case "space-upsert": {
      const exists = state.spaces.some((space) => space.id === action.space.id);
      return {
        ...state,
        spaces: sortByRecent(
          exists
            ? state.spaces.map((space) => (space.id === action.space.id ? { ...space, ...action.space } : space))
            : [action.space, ...state.spaces],
        ),
      };
    }
    default:
      return state;
  }
}

export type AppContextValue = {
  state: AppState;
  client: CohubClient | null;
  connectionState: ConnectionState;
  installationId: string | null;
  getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string | null>;
  refreshHome: () => Promise<void>;
  refreshSessionStatuses: (sessions: Pick<UserSessionListItem, "id" | "spaceId" | "updatedAt">[]) => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  openSession: (sessionId: string) => Promise<void>;
  closeSession: (sessionId: string) => void;
  refreshSession: (sessionId: string) => Promise<void>;
  loadOlderTurns: (sessionId: string) => Promise<void>;
  loadNewerTurns: (sessionId: string) => Promise<void>;
  loadTurnIndex: (sessionId: string, options?: { force?: boolean }) => Promise<void>;
  jumpToTurn: (sessionId: string, target: number | { turnId: string }) => Promise<number>;
  sendMessage: (sessionId: string, text: string, attachments?: AttachmentDraft[], options?: { model?: ChatModelSelection | null }) => Promise<void>;
  sendNewMessage: (spaceId: string, text: string, attachments?: AttachmentDraft[], options?: { model?: ChatModelSelection | null }) => Promise<SessionRecord>;
  abortSession: (sessionId: string) => Promise<void>;
  models: ChatModelCatalogItem[];
  modelsLoading: boolean;
  modelsError: string | null;
  modelStatus: ModelStatusResponse | null;
  modelStatusLoading: boolean;
  modelStatusError: string | null;
  loadModels: (options?: { force?: boolean }) => Promise<ChatModelCatalogItem[]>;
  loadModelStatus: (options?: { force?: boolean }) => Promise<ModelStatusResponse | null>;
  createSpace: (name: string, description?: string) => Promise<SpaceRecord>;
  refreshSpacePin: (spaceId: string) => Promise<boolean>;
  toggleSpacePin: (spaceId: string) => Promise<boolean>;
  upsertSpace: (space: SpaceRecord) => void;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  forkSession: (spaceId: string, sessionId: string, turn: Pick<SessionTurnRecord, "id" | "sourceTurnId">) => Promise<SessionRecord>;
  clearCache: () => Promise<void>;
  loadSessionReadSequence: (sessionId: string) => Promise<number | null>;
  saveSessionReadSequence: (sessionId: string, sequence: number) => Promise<void>;
  activityItems: ActivityItem[];
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  userUuid,
  getAccessToken,
  children,
}: {
  userUuid: string;
  getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string | null>;
  children: ReactNode;
}) {
  const [installationId, setInstallationId] = useState<string | null>(null);
  const [state, setState] = useState<AppState>(initialState);
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const connectionStateRef = useRef<ConnectionState>("idle");
  const stateRef = useRef(state);
  const subscriptions = useRef(new Map<string, () => void>());
  const sessionSpaces = useRef(new Map<string, string>());
  const openTokens = useRef(new Map<string, number>());
  const installationIdRef = useRef<string | null>(null);
  const installationRequestRef = useRef<Promise<string> | null>(null);
  const clientRef = useRef<CohubClient | null>(null);
  const homeRefreshGenerationRef = useRef(0);
  const statusGenerationRef = useRef(0);
  const resyncRunRef = useRef<(sessionId: string, reason: SessionResyncReason) => Promise<void>>(async () => undefined);
  // A ref keeps one coordinator instance for the provider without participating in hook dependencies.
  const resyncCoordinatorRef = useRef(createSessionResyncCoordinator({
    debounceMs: SESSION_RESYNC_DEBOUNCE_MS,
    cooldowns: { "out-of-sync": OUT_OF_SYNC_RESYNC_COOLDOWN_MS },
    run: (sessionId, reason) => resyncRunRef.current(sessionId, reason),
  }));
  const [models, setModels] = useState<ChatModelCatalogItem[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const modelsRequestRef = useRef<Promise<ChatModelCatalogItem[]> | null>(null);
  const [modelStatus, setModelStatus] = useState<ModelStatusResponse | null>(null);
  const [modelStatusLoading, setModelStatusLoading] = useState(false);
  const [modelStatusError, setModelStatusError] = useState<string | null>(null);
  const modelStatusRequestRef = useRef<Promise<ModelStatusResponse | null> | null>(null);
  const modelStatusLoadedAtRef = useRef(0);
  const paginationRequestsRef = useRef(new Map<string, Promise<void>>());
  const optimisticMessageSequenceRef = useRef(new Map<string, number>());
  const sessionsMoreRequestRef = useRef<Promise<void> | null>(null);
  const spacePinMutationVersionsRef = useRef(new Map<string, number>());
  const spacePinPendingMutationsRef = useRef(new Map<string, number>());
  const spacePinMutationSequenceRef = useRef(0);
  const userKey = userUuid;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const dispatch = useCallback((action: Action) => {
    setState((current) => reducer(current, action));
  }, []);

  const ensureInstallation = useCallback(async () => {
    const existing = installationIdRef.current;
    if (existing) return existing;
    const pending = installationRequestRef.current;
    if (pending) return pending;

    const request = getInstallationId().then((id) => {
      installationIdRef.current = id;
      setInstallationId(id);
      return id;
    });
    installationRequestRef.current = request;
    void request.finally(() => {
      if (installationRequestRef.current === request) installationRequestRef.current = null;
    }).catch(() => undefined);
    return request;
  }, []);

  useEffect(() => {
    installationIdRef.current = installationId;
  }, [installationId]);

  const client = useMemo(
    () => installationId ? createMobileClient(getAccessToken, installationId) : null,
[getAccessToken, installationId],
  );

  useEffect(() => {
    clientRef.current = client;
  }, [client]);

  const loadModels = useCallback(async (options: { force?: boolean } = {}) => {
    if (models.length > 0 && !options.force) return models;
    if (modelsRequestRef.current && !options.force) return modelsRequestRef.current;
    const activeClient = clientRef.current;
    if (!activeClient) throw new Error(translate("data.stillConnecting"));

    setModelsLoading(true);
    setModelsError(null);
    const request = activeClient.models.list()
      .then((catalog) => {
        const next = Object.values(catalog).flat();
        setModels(next);
        return next;
      })
      .catch((error) => {
        const message = errorMessage(error, "Unable to load models");
        setModelsError(message);
        throw error;
      })
      .finally(() => {
        setModelsLoading(false);
        if (modelsRequestRef.current === request) modelsRequestRef.current = null;
      });
    modelsRequestRef.current = request;
    return request;
  }, [models]);

  const loadModelStatus = useCallback(async (options: { force?: boolean } = {}) => {
    if (!options.force && modelStatus && Date.now() - modelStatusLoadedAtRef.current < 60_000) return modelStatus;
    if (modelStatusRequestRef.current && !options.force) return modelStatusRequestRef.current;
    const activeClient = clientRef.current;
    if (!activeClient) throw new Error(translate("data.stillConnecting"));

    setModelStatusLoading(true);
    setModelStatusError(null);
    const request = activeClient.models.status()
      .then((next) => {
        setModelStatus(next);
        modelStatusLoadedAtRef.current = Date.now();
        return next;
      })
      .catch((error) => {
        const message = errorMessage(error, "Unable to load model status");
        setModelStatusError(message);
        throw error;
      })
      .finally(() => {
        setModelStatusLoading(false);
        if (modelStatusRequestRef.current === request) modelStatusRequestRef.current = null;
      });
    modelStatusRequestRef.current = request;
    return request;
  }, [modelStatus]);

  const refreshSessionStatuses = useCallback(async (sessions: Pick<UserSessionListItem, "id" | "spaceId" | "updatedAt">[]) => {
    const activeClient = clientRef.current;
    if (!activeClient || sessions.length === 0) return;
    const generation = statusGenerationRef.current;
    dispatch({ type: "session-status-start" });
    let statusError: string | undefined;
    try {
      await loadSessionLatestTurns(activeClient, sessions, (sessionId, turn) => {
        if (generation === statusGenerationRef.current) dispatch({ type: "session-latest-turn", sessionId, turn });
      });
    } catch (error) {
      statusError = errorMessage(error, "Unable to refresh Chat statuses. Pull to refresh and retry.");
    } finally {
      if (generation === statusGenerationRef.current) dispatch({ type: "session-status-end", error: statusError });
    }
  }, [dispatch]);

  const refreshHome = useCallback(async () => {
    const generation = homeRefreshGenerationRef.current + 1;
    homeRefreshGenerationRef.current = generation;
    dispatch({ type: "home-start" });
    try {
      const resolvedInstallationId = await ensureInstallation();
      const activeClient = clientRef.current ?? createMobileClient(getAccessToken, resolvedInstallationId);
      clientRef.current = activeClient;
      const token = await withAccessTokenTimeout(getAccessToken());
      if (!token) throw new Error(translate("data.signInUnavailable"));
      const [spacesResult, sessionsResult] = await Promise.all([
        withTimeout(activeClient.spaces.list(), "Loading Spaces").then(
          (spaces) => ({ status: "fulfilled" as const, value: spaces }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        ),
        withTimeout(activeClient.user.listSessions({ limit: 60 }), "Loading Chats").then(
          (sessions) => ({ status: "fulfilled" as const, value: sessions }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        ),
      ]);
      if (generation !== homeRefreshGenerationRef.current) return;
      const errors = [spacesResult, sessionsResult].flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (errors.length === 2) {
        throw new Error(errors.map((error) => errorMessage(error, translate("data.requestFailed"))).join("\n"));
      }
      const existingSpaces = new Map(stateRef.current.spaces.map((space) => [space.id, space]));
      const remoteSpaces = spacesResult.status === "fulfilled" ? spacesResult.value ?? [] : null;
      let spaces = remoteSpaces
        ? remoteSpaces.map((space) => preserveSpacePin(existingSpaces.get(space.id), space))
        : stateRef.current.spaces;
      const spacesError = spacesResult.status === "rejected"
        ? `Spaces could not be refreshed: ${errorMessage(spacesResult.reason, translate("data.requestFailed"))}`
        : undefined;
      const pinRequestVersions = new Map(spaces.map((space) => [space.id, spacePinMutationVersionsRef.current.get(space.id) ?? 0]));
      const spacesMissingPinState = remoteSpaces?.filter((space) => space.isPinned === undefined).map((space) => space.id) ?? [];
      let pinStates: Record<string, boolean> = {};
      if (spacesMissingPinState.length > 0) {
        try {
          pinStates = await withTimeout(
            loadResourcePinStates(activeClient, "space", spacesMissingPinState, { force: true }),
            "Loading Space pins",
          );
        } catch (error) {
          invalidateResourcePinReads(activeClient, "space", spacesMissingPinState);
          console.warn("[mobile-pins] failed to refresh Space pins", error);
        }
      }
      if (generation !== homeRefreshGenerationRef.current) return;
      spaces = spaces.map((space) => {
        const mutationVersion = spacePinMutationVersionsRef.current.get(space.id) ?? 0;
        if (spacePinPendingMutationsRef.current.has(space.id) || mutationVersion !== pinRequestVersions.get(space.id)) {
          const current = stateRef.current.spaces.find((item) => item.id === space.id);
          return current?.isPinned === undefined ? space : { ...space, isPinned: current.isPinned };
        }
        const pinned = pinStates[space.id];
        return pinned === undefined ? space : { ...space, isPinned: pinned };
      });
      const sessions = sessionsResult.status === "fulfilled" ? sessionsResult.value.sessions ?? [] : stateRef.current.sessions;
      const sessionsHasMore = sessionsResult.status === "fulfilled" ? Boolean(sessionsResult.value.pageInfo?.hasMore) : stateRef.current.sessionsHasMore;
      const sessionsCursor = sessionsResult.status === "fulfilled" ? (sessionsResult.value.pageInfo?.nextCursor ?? null) : stateRef.current.sessionsCursor;
      const sessionsError = sessionsResult.status === "rejected"
        ? `Chats could not be refreshed: ${errorMessage(sessionsResult.reason, translate("data.requestFailed"))}`
        : undefined;
      dispatch({ type: "home-success", spaces, sessions, sessionsHasMore, sessionsCursor, spacesError, sessionsError });
      void refreshSessionStatuses(sessions);
      dispatch({ type: "usage-start" });
      void saveHome(userKey, { spaces, sessions }).catch((error) => {
        console.warn("[mobile-cache] failed to save home", error);
      });
      void withTimeout(activeClient.user.getActivity({ days: 7 }), "Loading activity")
        .then((activity) => {
          if (generation === homeRefreshGenerationRef.current) dispatch({ type: "usage", usage: activity.summary });
        })
        .catch((error) => {
          if (generation === homeRefreshGenerationRef.current) dispatch({ type: "usage-error", message: errorMessage(error, translate("data.activityRefreshFailed")) });
        });
    } catch (error) {
      if (generation === homeRefreshGenerationRef.current) {
        dispatch({ type: "home-error", message: errorMessage(error, translate("data.loadCohubFailed")) });
      }
    }
  }, [dispatch, ensureInstallation, getAccessToken, refreshSessionStatuses, userKey]);

  const loadMoreSessions = useCallback(async () => {
    if (sessionsMoreRequestRef.current) return sessionsMoreRequestRef.current;
    const current = stateRef.current;
    if (!client || !current.sessionsHasMore || !current.sessionsCursor || current.sessionsLoadingMore) return;
    const task = (async () => {
      dispatch({ type: "sessions-more-start" });
      try {
        const response = await client.user.listSessions({ limit: 60, cursor: current.sessionsCursor });
        if (stateRef.current.sessionsCursor !== current.sessionsCursor) {
          dispatch({ type: "sessions-more-success", sessions: [], hasMore: stateRef.current.sessionsHasMore, cursor: stateRef.current.sessionsCursor });
          return;
        }
        const nextSessions = response.sessions ?? [];
        dispatch({ type: "sessions-more-success", sessions: nextSessions, hasMore: Boolean(response.pageInfo?.hasMore), cursor: response.pageInfo?.nextCursor ?? null });
        void refreshSessionStatuses(nextSessions);
        const merged = [...stateRef.current.sessions, ...nextSessions.filter((item) => !stateRef.current.sessions.some((currentItem) => currentItem.id === item.id))];
        void saveHome(userKey, { spaces: stateRef.current.spaces, sessions: merged }).catch(() => undefined);
      } catch (error) {
        dispatch({ type: "sessions-more-error", message: errorMessage(error, translate("data.chatsLoadFailed")) });
      }
    })();
    sessionsMoreRequestRef.current = task;
    void task.finally(() => {
      if (sessionsMoreRequestRef.current === task) sessionsMoreRequestRef.current = null;
    }).catch(() => undefined);
    return task;
  }, [client, dispatch, refreshSessionStatuses, userKey]);

  useEffect(() => {
    let active = true;
    const activeSubscriptions = subscriptions.current;
    const activeSessionSpaces = sessionSpaces.current;
    const activeResyncCoordinator = resyncCoordinatorRef.current;
    void (async () => {
      try {
        const cached = await hydrateHome(userKey);
        if (active && (cached.spaces.length > 0 || cached.sessions.length > 0)) {
          dispatch({ type: "hydrate", ...cached });
        }
      } catch (error) {
        console.warn("[mobile-cache] failed to hydrate home", error);
      }
      if (active) {
        await refreshHome();
      }
    })().catch((error) => {
      if (active) {
        dispatch({
          type: "home-error",
          message: errorMessage(error, translate("data.initFailed")),
        });
      }
    });
    return () => {
      active = false;
      homeRefreshGenerationRef.current += 1;
      statusGenerationRef.current += 1;
      dispatch({ type: "session-status-reset" });
      for (const sessionId of activeSubscriptions.keys()) activeResyncCoordinator.cancel(sessionId);
      for (const stop of activeSubscriptions.values()) stop();
      activeSubscriptions.clear();
      activeSessionSpaces.clear();
    };
  }, [dispatch, refreshHome, userKey]);

  useEffect(() => {
    if (!client) return;
    return client.onConnection((snapshot) => {
      const previous = connectionStateRef.current;
      connectionStateRef.current = snapshot.state;
      const displayState = connectionDisplayState(snapshot);
      if (displayState) setConnectionState(displayState);
      if (!isTransportRecovery(previous, snapshot.state)) return;
      for (const sessionId of subscriptions.current.keys()) resyncCoordinatorRef.current.request(sessionId, "transport-open");
      // Running badges on the list are derived from turn status; refresh them for recent Chats.
      void refreshSessionStatuses(stateRef.current.sessions);
    });
  }, [client, refreshSessionStatuses]);

  useEffect(() => {
    const subscription = NativeAppState.addEventListener("change", (next) => {
      if (next !== "active") return;
      void refreshHome();
      // iOS suspends the socket in the background without a close event; the
      // stream reducer is stale even when the transport still reports `open`.
      for (const sessionId of subscriptions.current.keys()) resyncCoordinatorRef.current.request(sessionId, "foreground");
    });
    return () => subscription.remove();
  }, [refreshHome]);

  useEffect(() => {
    const coordinator = resyncCoordinatorRef.current;
    return () => coordinator.dispose();
  }, []);

  const refreshSession = useCallback(
    async (sessionId: string, options: { silent?: boolean } = {}) => {
      if (!client) return;
      const view = stateRef.current.sessionViews[sessionId];
      const sessionSummary = stateRef.current.sessions.find((item) => item.id === sessionId);
      const spaceId = view?.session?.spaceId ?? sessionSummary?.spaceId;
      if (!spaceId) return;
      // Recovery resyncs must not flash the pull-to-refresh spinner.
      dispatch({ type: "session-refresh-start", sessionId, ...(options.silent ? { silent: true } : {}) });
      try {
        const response = await client.space(spaceId).session(sessionId).turns.listPaginated({ limit: 30 });
        const current = stateRef.current.sessionViews[sessionId];
        const turns = mergeTurns(current?.turns ?? [], response.turns);
        const messages = mergeDisplayMessages(messagesFromTurns(turns), current?.messages.filter(isLiveMessage) ?? []);
        const keptOlderWindow = Boolean(current?.turns.some((turn) => turn.sequence < (response.turns[0]?.sequence ?? Number.MAX_SAFE_INTEGER)));
        dispatch({
          type: "session-refresh-end",
          sessionId,
          ...(options.silent ? { silent: true } : {}),
          session: response.session,
          messages,
          turns,
          hasMoreOlder: keptOlderWindow ? current?.hasMoreOlder ?? true : response.hasMore,
          hasMoreNewer: current?.hasMoreNewer ?? false,
          oldestCursor: turns[0]?.sequence ?? null,
          newestCursor: turns.at(-1)?.sequence ?? null,
        });
        void saveMessages(userKey, sessionId, messages).catch(() => undefined);
      } catch (error) {
        dispatch({
          type: "session-refresh-end",
          sessionId,
          ...(options.silent ? { silent: true } : {}),
          error: error instanceof Error ? error.message : translate("data.refreshChatFailed"),
        });
      }
    },
    [client, dispatch, userKey],
  );

  const loadTurnIndex = useCallback(async (sessionId: string, options: { force?: boolean } = {}) => {
    const current = stateRef.current.sessionViews[sessionId];
    if (!options.force && current?.turnIndex.length) return;
    const sessionSummary = stateRef.current.sessions.find((item) => item.id === sessionId);
    const spaceId = current?.session?.spaceId ?? sessionSummary?.spaceId;
    const activeClient = clientRef.current;
    if (!activeClient || !spaceId) return;
    const key = `${sessionId}:index`;
    const pending = paginationRequestsRef.current.get(key);
    if (pending && !options.force) return pending;

    const task = (async () => {
      dispatch({ type: "turn-index-start", sessionId });
      try {
        let cursor: number | undefined;
        const collected: SessionTurnIndexItem[] = [];
        for (;;) {
          const response = await activeClient.space(spaceId).session(sessionId).turns.index({ cursor, limit: 500 });
          collected.push(...response.turns);
          if (!response.hasMore || response.nextCursor == null) break;
          cursor = response.nextCursor;
        }
        const bySequence = new Map<number, SessionTurnIndexItem>();
        for (const item of collected) bySequence.set(item.sequence, item);
        dispatch({ type: "turn-index", sessionId, turnIndex: [...bySequence.values()].sort((a, b) => a.sequence - b.sequence) });
      } catch (error) {
        console.warn("[mobile-session] failed to load turn index", error);
      } finally {
        dispatch({ type: "turn-index-end", sessionId });
      }
    })();
    paginationRequestsRef.current.set(key, task);
    void task.finally(() => {
      if (paginationRequestsRef.current.get(key) === task) paginationRequestsRef.current.delete(key);
    }).catch(() => undefined);
    return task;
  }, [dispatch]);

  const loadOlderTurns = useCallback(async (sessionId: string) => {
    const key = `${sessionId}:older`;
    const pending = paginationRequestsRef.current.get(key);
    if (pending) return pending;
    const task = (async () => {
      const view = stateRef.current.sessionViews[sessionId];
      const sessionSummary = stateRef.current.sessions.find((item) => item.id === sessionId);
      const spaceId = view?.session?.spaceId ?? sessionSummary?.spaceId;
      const activeClient = clientRef.current;
      if (!activeClient || !spaceId || !view || !view.hasMoreOlder || view.loadingOlder) return;
      const openToken = openTokens.current.get(sessionId);
      const isCurrentRequest = () => openToken === undefined || openTokens.current.get(sessionId) === openToken;
      dispatch({ type: "session-page-start", sessionId, direction: "older" });
      try {
        const response = await activeClient.space(spaceId).session(sessionId).turns.listPaginated({ ...(view.oldestCursor != null ? { cursor: view.oldestCursor } : {}), direction: "older", limit: 30 });
        if (!isCurrentRequest()) {
          dispatch({ type: "session-page-end", sessionId, direction: "older" });
          return;
        }
        dispatch({ type: "session-page-success", sessionId, session: response.session, turns: response.turns, hasMore: response.hasMore, direction: "older" });
        const merged = mergeTurns(stateRef.current.sessionViews[sessionId]?.turns ?? [], response.turns);
        void saveMessages(userKey, sessionId, messagesFromTurns(merged)).catch(() => undefined);
      } catch (error) {
        if (!isCurrentRequest()) {
          dispatch({ type: "session-page-end", sessionId, direction: "older" });
          return;
        }
        dispatch({ type: "session-page-error", sessionId, message: errorMessage(error, translate("data.loadOlderFailed")) });
      }
    })();
    paginationRequestsRef.current.set(key, task);
    void task.finally(() => {
      if (paginationRequestsRef.current.get(key) === task) paginationRequestsRef.current.delete(key);
    }).catch(() => undefined);
    return task;
  }, [dispatch, userKey]);

  const loadNewerTurns = useCallback(async (sessionId: string) => {
    const key = `${sessionId}:newer`;
    const pending = paginationRequestsRef.current.get(key);
    if (pending) return pending;
    const task = (async () => {
      const view = stateRef.current.sessionViews[sessionId];
      const sessionSummary = stateRef.current.sessions.find((item) => item.id === sessionId);
      const spaceId = view?.session?.spaceId ?? sessionSummary?.spaceId;
      const activeClient = clientRef.current;
      if (!activeClient || !spaceId || !view || !view.hasMoreNewer || view.loadingNewer) return;
      const openToken = openTokens.current.get(sessionId);
      const isCurrentRequest = () => openToken === undefined || openTokens.current.get(sessionId) === openToken;
      dispatch({ type: "session-page-start", sessionId, direction: "newer" });
      try {
        const response = await activeClient.space(spaceId).session(sessionId).turns.listPaginated({ ...(view.newestCursor != null ? { cursor: view.newestCursor } : {}), direction: "newer", limit: 100 });
        if (!isCurrentRequest()) {
          dispatch({ type: "session-page-end", sessionId, direction: "newer" });
          return;
        }
        dispatch({ type: "session-page-success", sessionId, session: response.session, turns: response.turns, hasMore: response.hasMore, direction: "newer" });
        const merged = mergeTurns(stateRef.current.sessionViews[sessionId]?.turns ?? [], response.turns);
        void saveMessages(userKey, sessionId, messagesFromTurns(merged)).catch(() => undefined);
      } catch (error) {
        if (!isCurrentRequest()) {
          dispatch({ type: "session-page-end", sessionId, direction: "newer" });
          return;
        }
        dispatch({ type: "session-page-error", sessionId, message: errorMessage(error, translate("data.loadNewerFailed")) });
      }
    })();
    paginationRequestsRef.current.set(key, task);
    void task.finally(() => {
      if (paginationRequestsRef.current.get(key) === task) paginationRequestsRef.current.delete(key);
    }).catch(() => undefined);
    return task;
  }, [dispatch, userKey]);

  const jumpToTurn = useCallback(async (sessionId: string, target: number | { turnId: string }) => {
    const view = stateRef.current.sessionViews[sessionId];
    const targetTurn = typeof target === "number"
      ? view?.turns.find((turn) => turn.sequence === target)
      : view?.turns.find((turn) => turn.id === target.turnId || turn.sourceTurnId === target.turnId);
    if (targetTurn) return targetTurn.sequence;
    const sessionSummary = stateRef.current.sessions.find((item) => item.id === sessionId);
    const spaceId = view?.session?.spaceId ?? sessionSummary?.spaceId;
    const activeClient = clientRef.current;
    if (!activeClient || !spaceId) throw new Error(translate("data.chatContextUnavailable"));
    const response = await activeClient.space(spaceId).session(sessionId).turns.window({ ...(typeof target === "number" ? { sequence: target } : { turnId: target.turnId }), before: 10, after: 20 });
    const sequence = response.anchorSequence ?? response.turns.find((turn) => (typeof target === "number" && turn.sequence === target) || (typeof target !== "number" && (turn.id === target.turnId || turn.sourceTurnId === target.turnId)))?.sequence;
    if (sequence == null) throw new Error(translate("data.turnUnavailable"));
    dispatch({ type: "session-window-success", sessionId, session: response.session, turns: response.turns, hasMoreOlder: response.hasMoreOlder, hasMoreNewer: response.hasMoreNewer, oldestCursor: response.oldestCursor, newestCursor: response.newestCursor });
    void saveMessages(userKey, sessionId, messagesFromTurns(mergeTurns(view?.turns ?? [], response.turns))).catch(() => undefined);
    return sequence;
  }, [dispatch, userKey]);

  /**
   * (Re)attach realtime subscriptions for an open Chat. `recover: true` seeds the
   * stream reducer from the server snapshot, which is what lets a resubscribe pick
   * up mid-turn streaming after the socket dropped or the app was backgrounded.
   */
  const attachSessionRealtime = useCallback((client: CohubClient, spaceId: string, sessionId: string) => {
    subscriptions.current.get(sessionId)?.();
    sessionSpaces.current.set(sessionId, spaceId);
    const sessionClient = client.space(spaceId).session(sessionId);
    const streamBatch = createStreamBatch<StreamView>((stream) => dispatch({ type: "stream-state", sessionId, stream }));
    const stopGeneration = sessionClient.subscribeGeneration(
      {
        state: (event) => {
          const status = liveStreamStatusFromPatch(event.state.status);
          if (!status) {
            streamBatch.cancel();
            dispatch({ type: "stream-clear", sessionId });
            return;
          }
          const stream: StreamView = {
            status,
            contentBlocks: event.state.contentBlocks,
            intermediateMessages: event.intermediateMessages,
            turnId: event.state.turnId,
            messageId: event.messageId,
            runtimePhase: null,
            runtimeProvider: null,
            runtimeModel: null,
          };
          if (stream.status === "streaming") streamBatch.push(stream);
          else {
            streamBatch.cancel();
            dispatch({ type: "stream-state", sessionId, stream });
          }
        },
        commit: (event) => {
          if (event.commit.isFinal) streamBatch.cancel();
          else streamBatch.flush();
          dispatch({ type: "message-add", sessionId, message: event.commit.message });
          if (event.commit.isFinal) dispatch({ type: "stream-clear", sessionId });
        },
        finalized: (event) => {
          streamBatch.cancel();
          dispatch({ type: "turn-upsert", sessionId, turn: event.turn });
          dispatch({ type: "stream-clear", sessionId });
          void refreshSession(sessionId);
        },
        turnUpdated: (event) => {
          dispatch({ type: "turn-patch", sessionId, turn: event.turn });
        },
        lifecycle: (event) => {
          if (event.phase !== "llm_call_started") return;
          streamBatch.flush();
          dispatch({ type: "stream-lifecycle", sessionId, provider: event.provider, model: event.model });
        },
        error: (event) => {
          streamBatch.flush();
          dispatch({ type: "session-error", sessionId, message: event.message });
        },
        outOfSync: (event) => {
          // Only a patch whose base sequence drifted needs a fresh snapshot-seeded
          // subscription; anything else just needs the turn tail reconciled.
          const drifted = event.reason === "version_mismatch" && event.source === "patch";
          if (!drifted || !resyncCoordinatorRef.current.request(sessionId, "out-of-sync")) {
            void refreshSession(sessionId, { silent: true });
          }
        },
      },
      { recover: true },
    );
    const stopPersisted = sessionClient.subscribe({
      event: (event) => {
        if (event.type !== "session.updated") return;
        const currentSummary = stateRef.current.sessions.find((item) => item.id === sessionId);
        const current = stateRef.current.sessionViews[sessionId]?.session
          ?? currentSummary;
        if (!current) return;
        const payload = event.payload as { session?: Partial<SessionRecord> };
        if (!payload.session || payload.session.id !== sessionId) return;
        const updated = preferNewerSession(current, { ...current, ...payload.session });
        const nextSummary = {
          ...updated,
          space: currentSummary?.space ?? null,
        };
        dispatch({ type: "session-upsert", session: nextSummary });
        const nextSessions = stateRef.current.sessions.map((item) => item.id === sessionId ? nextSummary : item);
        void saveHome(userKey, { spaces: stateRef.current.spaces, sessions: nextSessions }).catch(() => undefined);
        const currentView = stateRef.current.sessionViews[sessionId];
        if (currentView) dispatch({ type: "session-meta", sessionId, session: updated, space: currentView.space });
      },
      persisted: (event) => {
        if (event.type !== "session.message.persisted") return;
        const message = (event.payload as { message?: MessageRecord }).message;
        if (!message) return;
        const currentMessages = stateRef.current.sessionViews[sessionId]?.messages ?? [];
        dispatch({ type: "message-add", sessionId, message });
        void saveMessages(userKey, sessionId, mergeMessages(currentMessages, message)).catch(() => undefined);
      },
    });
    const stop = () => {
      streamBatch.cancel();
      stopGeneration();
      stopPersisted();
    };
    subscriptions.current.set(sessionId, stop);
  }, [dispatch, refreshSession, userKey]);

  /**
   * Recover an open Chat after a transport/foreground gap: rebuild the generation
   * subscription (snapshot-seeded) so mid-turn streaming resumes, then reconcile the
   * turn tail so anything that finished while offline lands as history.
   */
  const resyncSession = useCallback(async (sessionId: string, _reason: SessionResyncReason) => {
    const activeClient = clientRef.current;
    const spaceId = sessionSpaces.current.get(sessionId);
    if (!activeClient || !spaceId || !subscriptions.current.has(sessionId)) return;
    attachSessionRealtime(activeClient, spaceId, sessionId);
    await refreshSession(sessionId, { silent: true });
  }, [attachSessionRealtime, refreshSession]);

  useEffect(() => {
    resyncRunRef.current = resyncSession;
  }, [resyncSession]);

  const openSession = useCallback(
    async (sessionId: string) => {
      if (!client) return;
      const token = (openTokens.current.get(sessionId) ?? 0) + 1;
      openTokens.current.set(sessionId, token);
      const summary = stateRef.current.sessions.find((item) => item.id === sessionId);
      dispatch({ type: "session-start", sessionId, session: summary ?? null });

      try {
        const cachedMessages = await loadMessages(userKey, sessionId);
        if (openTokens.current.get(sessionId) === token && cachedMessages.length > 0) {
          dispatch({ type: "session-cache", sessionId, messages: cachedMessages });
        }
      } catch (error) {
        console.warn("[mobile-cache] failed to load Chat", error);
      }

      let spaceId = summary?.spaceId;
      let space = stateRef.current.spaces.find((item) => item.id === spaceId) ?? null;
      let session = summary as SessionRecord | undefined;
      try {
        if (!spaceId || !space || !session) {
          const detail = await client.user.getSession(sessionId);
          spaceId = detail.space.id;
          space = detail.space;
          session = detail.session;
          dispatch({
            type: "session-upsert",
            session: {
              ...detail.session,
              space: {
                id: detail.space.id,
                name: displaySpaceName(detail.space),
                slug: detail.space.slug,
                publicProfile: detail.space.publicProfile ?? null,
              },
            },
          });
        }
        if (!spaceId || !space || !session || openTokens.current.get(sessionId) !== token) return;
        dispatch({ type: "session-start", sessionId, space, session });
        attachSessionRealtime(client, spaceId, sessionId);
   const sessionClient = client.space(spaceId).session(sessionId);
        const response = await sessionClient.turns.listPaginated({ limit: 30 });
        if (openTokens.current.get(sessionId) !== token) return;
        const messages = messagesFromTurns(response.turns);
        const cachedMessages = stateRef.current.sessionViews[sessionId]?.messages ?? [];
        const liveMessages = cachedMessages.filter(isLiveMessage);
        dispatch({ type: "session-success", sessionId, space, session: response.session ?? session, messages: mergeDisplayMessages(messages, liveMessages), turns: response.turns, hasMoreOlder: response.hasMore, hasMoreNewer: false, oldestCursor: response.turns[0]?.sequence ?? null, newestCursor: response.turns.at(-1)?.sequence ?? null });
        void loadTurnIndex(sessionId).catch(() => undefined);
        void saveMessages(userKey, sessionId, messages).catch(() => undefined);
      } catch (error) {
        if (openTokens.current.get(sessionId) !== token) return;
        dispatch({ type: "session-error", sessionId, message: error instanceof Error ? error.message : translate("data.openChatFailed") });
      }
    },
    [attachSessionRealtime, client, dispatch, loadTurnIndex, userKey],
  );

  const closeSession = useCallback((sessionId: string) => {
    resyncCoordinatorRef.current.cancel(sessionId);
    subscriptions.current.get(sessionId)?.();
    subscriptions.current.delete(sessionId);
    sessionSpaces.current.delete(sessionId);
    openTokens.current.set(sessionId, (openTokens.current.get(sessionId) ?? 0) + 1);
    optimisticMessageSequenceRef.current.delete(sessionId);
  }, []);

  const abortSession = useCallback(
    async (sessionId: string) => {
      if (!client) throw new Error(translate("data.stillConnecting"));
      const view = stateRef.current.sessionViews[sessionId];
      const summary = stateRef.current.sessions.find((item) => item.id === sessionId);
      const spaceId = view?.session?.spaceId ?? summary?.spaceId;
      if (!spaceId) throw new Error(translate("data.chatContextUnavailable"));
      await client.space(spaceId).session(sessionId).abort({
        turnId: view?.stream?.turnId ?? null,
      });
      dispatch({ type: "stream-clear", sessionId });
      dispatch({ type: "send-end", sessionId });
      await refreshSession(sessionId);
    },
    [client, dispatch, refreshSession],
  );

  const sendMessage = useCallback(
    async (
      sessionId: string,
      rawText: string,
      attachments: AttachmentDraft[] = [],
      options: { model?: ChatModelSelection | null } = {},
    ) => {
      if (!client) throw new Error(translate("data.stillConnecting"));
      const text = rawText.trim();
      const view = stateRef.current.sessionViews[sessionId];
      const session = view?.session ?? stateRef.current.sessions.find((item) => item.id === sessionId);
      if (!session?.spaceId) throw new Error(translate("data.chatContextUnavailable"));
      if (!text && attachments.length === 0) return;

      const clientMessageId = newId();
      const optimisticText = text || attachments.map((item) => item.name).join(", ");
      const turnSequence = nextTurnSequence(view?.turns ?? [], view?.messages ?? []);
      const currentMax = Math.max(
        0,
        ...(view?.messages ?? []).map((message) => message.sequence),
        (view?.turns.at(-1)?.sequence ?? 0) * 2,
        optimisticMessageSequenceRef.current.get(sessionId) ?? 0,
        turnSequence * 2 - 1,
      );
      optimisticMessageSequenceRef.current.set(sessionId, currentMax);
      const optimistic: MessageRecord = {
        id: `local-${clientMessageId}`,
        sessionId,
        role: "user",
        content: [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...attachments.filter((item) => item.mimeType.startsWith("image/")).map((item) => ({
            type: "image" as const,
            source: { type: "url" as const, url: item.uri },
            _meta: { filename: item.name, mediaType: item.mimeType, size: item.size },
          })),
          ...(!text && attachments.some((item) => !item.mimeType.startsWith("image/")) ? [{ type: "text" as const, text: optimisticText }] : []),
        ],
        text: optimisticText,
        sequence: turnSequence * 2 - 1,
        provider: options.model?.provider ?? null,
        model: options.model?.id ?? null,
        stopReason: null,
        errorMessage: null,
        usage: null,
        meta: { optimistic: true, clientMessageId, turnSequence, ...(options.model?.thinkingLevel ? { requestedThinkingLevel: options.model.thinkingLevel } : {}) },
        authorUuid: userUuid,
        authorProfile: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        createdAt: new Date().toISOString(),
      };
      dispatch({ type: "message-optimistic", sessionId, message: optimistic });
      void saveMessages(userKey, sessionId, [...(view?.messages ?? []), optimistic]).catch(() => undefined);
      dispatch({ type: "send-start", sessionId });

      try {
        const content = await buildPromptContent(client, session.spaceId, sessionId, text, attachments);
        const optimisticWithContent = { ...optimistic, content, text: text || optimistic.text };
        dispatch({ type: "message-optimistic", sessionId, message: optimisticWithContent });
        void saveMessages(userKey, sessionId, [...(stateRef.current.sessionViews[sessionId]?.messages ?? []), optimisticWithContent]).catch(() => undefined);
        const response = await client.space(session.spaceId).prompt({
          mode: "agent",
          sessionId,
          content,
          // First-party app sessions belong to the Web App source bucket; request provenance still reports via=mobile.
          source: "web",
          clientMessageId,
          accessMode: "full_access",
          intent: "followup",
          schedule: { mode: "immediate" },
          ...(options.model ? { model: options.model.id, provider: options.model.provider, ...(options.model.thinkingLevel ? { thinkingLevel: options.model.thinkingLevel } : {}) } : {}),
        });
        if (response.mode !== "immediate") throw new Error(translate("data.messageNotAccepted"));
        dispatch({ type: "turn-upsert", sessionId, session: response.session, turn: withFallbackUserContent(response.turn, content, text) });
        dispatch({ type: "send-end", sessionId });
      } catch (error) {
        dispatch({ type: "send-failed", sessionId, clientMessageId, message: error instanceof Error ? error.message : translate("data.messageSendFailed") });
        throw error;
      }
    },
    [client, dispatch, userKey, userUuid],
  );

  const sendNewMessage = useCallback(
    async (
      spaceId: string,
      rawText: string,
      attachments: AttachmentDraft[] = [],
      options: { model?: ChatModelSelection | null } = {},
    ) => {
      if (!client) throw new Error(translate("data.stillConnecting"));
      const text = rawText.trim();
      if (!spaceId) throw new Error(translate("data.spaceRequired"));
      if (!text && attachments.length === 0) throw new Error(translate("data.messageEmpty"));

      const clientMessageId = newId();
      const content = await buildPromptContent(client, spaceId, undefined, text, attachments);
      const result = await client.space(spaceId).prompt({
        mode: "agent",
        content,
        source: "web",
        clientMessageId,
        accessMode: "full_access",
        intent: "followup",
        schedule: { mode: "immediate" },
        ...(options.model ? { model: options.model.id, provider: options.model.provider, ...(options.model.thinkingLevel ? { thinkingLevel: options.model.thinkingLevel } : {}) } : {}),
      });
      if (result.mode !== "immediate" || !result.session) {
        throw new Error(translate("data.newChatNotCreated"));
      }

      const space = stateRef.current.spaces.find((item) => item.id === spaceId) ?? null;
      const session = {
        ...result.session,
        space: space
          ? {
              id: space.id,
              name: displaySpaceName(space),
              slug: space.slug,
              publicProfile: space.publicProfile ?? null,
            }
          : null,
      };
      dispatch({ type: "session-upsert", session });
      const home = stateRef.current;
      void saveHome(userKey, {
        spaces: home.spaces,
        sessions: [session, ...home.sessions.filter((item) => item.id !== session.id)],
      }).catch(() => undefined);
      return result.session;
    },
    [client, dispatch, userKey],
  );

  const createSpace = useCallback(
    async (name: string, description?: string) => {
      if (!client) throw new Error(translate("data.stillConnecting"));
      const trimmedName = name.trim();
      if (!trimmedName) throw new Error(translate("data.spaceNameRequired"));
      const result = await client.spaces.create({
        name: trimmedName,
        description: description?.trim() || null,
        source: "mobile",
      });
      dispatch({ type: "space-upsert", space: result.space });
      const home = stateRef.current;
      void saveHome(userKey, {
        spaces: [result.space, ...home.spaces.filter((space) => space.id !== result.space.id)],
        sessions: home.sessions,
      }).catch(() => undefined);
      return result.space;
    },
    [client, dispatch, userKey],
  );

  const refreshSpacePin = useCallback(async (spaceId: string) => {
    if (!client) throw new Error(translate("data.stillConnecting"));
    const currentBeforeRequest = stateRef.current.spaces.find((space) => space.id === spaceId);
    if (spacePinPendingMutationsRef.current.has(spaceId)) return currentBeforeRequest?.isPinned ?? false;
    const requestVersion = spacePinMutationVersionsRef.current.get(spaceId) ?? 0;
    const pinned = await getResourcePinState(client, "space", spaceId, { force: true });
    if (spacePinPendingMutationsRef.current.has(spaceId)) {
      return stateRef.current.spaces.find((space) => space.id === spaceId)?.isPinned ?? pinned;
    }
    if ((spacePinMutationVersionsRef.current.get(spaceId) ?? 0) !== requestVersion) {
      return stateRef.current.spaces.find((space) => space.id === spaceId)?.isPinned ?? pinned;
    }
    const current = stateRef.current.spaces.find((space) => space.id === spaceId);
    if (current) {
      const next = { ...current, isPinned: pinned };
      dispatch({ type: "space-upsert", space: next });
      const home = stateRef.current;
      void saveHome(userKey, {
        spaces: [next, ...home.spaces.filter((space) => space.id !== spaceId)],
        sessions: home.sessions,
      }).catch(() => undefined);
    }
    return pinned;
  }, [client, dispatch, userKey]);

  const toggleSpacePin = useCallback(async (spaceId: string) => {
    if (!client) throw new Error(translate("data.stillConnecting"));
    const mutationVersion = ++spacePinMutationSequenceRef.current;
    spacePinMutationVersionsRef.current.set(spaceId, mutationVersion);
    spacePinPendingMutationsRef.current.set(spaceId, mutationVersion);
    let current: SpaceRecord | null = null;
    let wasPinned = false;
    try {
      current = stateRef.current.spaces.find((space) => space.id === spaceId) ?? null;
      wasPinned = current?.isPinned ?? await getResourcePinState(client, "space", spaceId, { force: true });
      if ((spacePinMutationVersionsRef.current.get(spaceId) ?? 0) !== mutationVersion) {
        return stateRef.current.spaces.find((space) => space.id === spaceId)?.isPinned ?? wasPinned;
      }
      if (current) dispatch({ type: "space-upsert", space: { ...current, isPinned: !wasPinned } });
      const pinned = await toggleResourcePin(client, "space", spaceId, wasPinned);
      if ((spacePinMutationVersionsRef.current.get(spaceId) ?? 0) !== mutationVersion) {
        return stateRef.current.spaces.find((space) => space.id === spaceId)?.isPinned ?? pinned;
      }
      const latest = stateRef.current.spaces.find((space) => space.id === spaceId) ?? current;
      if (latest) {
        const next = { ...latest, isPinned: pinned };
        dispatch({ type: "space-upsert", space: next });
        const home = stateRef.current;
        void saveHome(userKey, {
          spaces: [next, ...home.spaces.filter((space) => space.id !== spaceId)],
          sessions: home.sessions,
        }).catch(() => undefined);
      }
      return pinned;
    } catch (error) {
      if ((spacePinMutationVersionsRef.current.get(spaceId) ?? 0) !== mutationVersion) {
        return stateRef.current.spaces.find((space) => space.id === spaceId)?.isPinned ?? !wasPinned;
      }
      if (current) dispatch({ type: "space-upsert", space: current });
      throw error;
    } finally {
      if (spacePinPendingMutationsRef.current.get(spaceId) === mutationVersion) {
        spacePinPendingMutationsRef.current.delete(spaceId);
      }
    }
  }, [client, dispatch, userKey]);

  useEffect(() => {
    if (!client) return;
    return client.onUserEvent((event) => {
      if (event.type !== "label.assignments.updated") return;
      const payload = event.payload as {
        resourceType?: unknown;
        resourceRef?: unknown;
        assignments?: unknown;
      };
      if (payload.resourceType !== "space" || typeof payload.resourceRef !== "string" || !Array.isArray(payload.assignments)) return;
      const current = stateRef.current.spaces.find((space) => space.id === payload.resourceRef);
      if (!current) return;
      const pinned = isResourcePinned(payload.assignments as { labelSystemKey?: string | null }[]);
      const next = { ...current, isPinned: pinned };
      dispatch({ type: "space-upsert", space: next });
      const home = stateRef.current;
      void saveHome(userKey, {
        spaces: [next, ...home.spaces.filter((space) => space.id !== next.id)],
        sessions: home.sessions,
      }).catch(() => undefined);
    });
  }, [client, dispatch, userKey]);

  const upsertSpace = useCallback((space: SpaceRecord) => {
    dispatch({ type: "space-upsert", space });
    const home = stateRef.current;
    void saveHome(userKey, {
      spaces: [space, ...home.spaces.filter((item) => item.id !== space.id)],
      sessions: home.sessions,
    }).catch(() => undefined);
  }, [dispatch, userKey]);

  const forkSession = useCallback(async (spaceId: string, sessionId: string, turn: Pick<SessionTurnRecord, "id" | "sourceTurnId">) => {
    if (!client) throw new Error(translate("data.stillConnecting"));
    const result = await forkSessionTurn(client, spaceId, sessionId, turn);
    const parent = stateRef.current.sessions.find((item) => item.id === sessionId);
    const session = { ...result, space: parent?.space ?? null };
    dispatch({ type: "session-upsert", session });
    const home = stateRef.current;
    void saveHome(userKey, { spaces: home.spaces, sessions: [session, ...home.sessions.filter((item) => item.id !== session.id)] }).catch(() => undefined);
    return result;
  }, [client, dispatch, userKey]);

  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      if (!client) throw new Error(translate("data.stillConnecting"));
      const view = stateRef.current.sessionViews[sessionId];
      const summary = stateRef.current.sessions.find((item) => item.id === sessionId);
      const spaceId = view?.session?.spaceId ?? summary?.spaceId;
      if (!spaceId) throw new Error(translate("data.chatContextUnavailable"));
      const result = await client.space(spaceId).session(sessionId).rename(title.trim() || null);
      dispatch({ type: "session-upsert", session: { ...result.session, space: summary?.space ?? null } });
      const currentView = stateRef.current.sessionViews[sessionId];
      if (currentView) dispatch({ type: "session-meta", sessionId, session: result.session, space: currentView.space });
    },
    [client, dispatch],
  );

  const loadSessionReadSequenceForUser = useCallback(
    (sessionId: string) => loadSessionReadSequence(userKey, sessionId),
    [userKey],
  );

  const saveSessionReadSequenceForUser = useCallback(
    (sessionId: string, sequence: number) => saveSessionReadSequence(userKey, sessionId, sequence),
    [userKey],
  );

  const clearCache = useCallback(async () => {
    homeRefreshGenerationRef.current += 1;
    statusGenerationRef.current += 1;
    await clearUserCache(userKey);
    setModels([]);
    setModelsError(null);
    setModelStatus(null);
    setModelStatusError(null);
    modelStatusLoadedAtRef.current = 0;
    paginationRequestsRef.current.clear();
    spacePinMutationVersionsRef.current.clear();
    spacePinPendingMutationsRef.current.clear();
    setState({ ...initialState, booting: false, refreshing: false });
  }, [userKey]);

  const activityItems = useMemo<ActivityItem[]>(() => {
    return state.sessions.slice(0, 30).flatMap((session) => {
      const normalizedStatus = getSessionStatus(state.sessionLatestTurns[session.id]?.status);
      if (normalizedStatus === "idle") return [];
      const status = normalizedStatus === "running"
        ? "running"
        : normalizedStatus === "failed"
          ? "failed"
          : normalizedStatus === "stopped"
            ? "stopped"
            : "complete";
      return {
        id: session.id,
        sessionId: session.id,
        spaceId: session.spaceId,
        title: displaySessionTitle(session),
        spaceName: session.space?.name?.trim() || "Space",
        preview: session.latestMessageText?.trim() || "No messages yet",
        status,
        updatedAt: session.lastMessageAt ?? session.updatedAt,
      };
    });
  }, [state.sessionLatestTurns, state.sessions]);

  const value = useMemo<AppContextValue>(
    () => ({
      state,
      client,
      connectionState,
      installationId,
      getAccessToken,
      refreshHome,
      refreshSessionStatuses,
      loadMoreSessions,
      openSession,
      closeSession,
      refreshSession,
      loadOlderTurns,
      loadNewerTurns,
      loadTurnIndex,
      jumpToTurn,
      sendMessage,
      sendNewMessage,
      abortSession,
      models,
      modelsLoading,
      modelsError,
      modelStatus,
      modelStatusLoading,
      modelStatusError,
      loadModels,
      loadModelStatus,
      createSpace,
      refreshSpacePin,
      toggleSpacePin,
      upsertSpace,
      renameSession,
      forkSession,
      clearCache,
      loadSessionReadSequence: loadSessionReadSequenceForUser,
      saveSessionReadSequence: saveSessionReadSequenceForUser,
      activityItems,
    }),
    [
      activityItems,
      abortSession,
      clearCache,
      client,
      loadSessionReadSequenceForUser,
      saveSessionReadSequenceForUser,
      closeSession,
      connectionState,
      createSpace,
      getAccessToken,
      refreshSpacePin,
      toggleSpacePin,
      installationId,
      jumpToTurn,
      loadModelStatus,
      loadModels,
      loadMoreSessions,
      loadNewerTurns,
      loadOlderTurns,
      loadTurnIndex,
      models,
      modelsError,
      modelsLoading,
      modelStatus,
      modelStatusError,
      modelStatusLoading,
      openSession,
      refreshHome,
      refreshSessionStatuses,
      refreshSession,
      renameSession,
      forkSession,
      sendMessage,
      sendNewMessage,
      state,
      upsertSpace,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error(translate("data.useAppProvider"));
  return value;
}

export function useSession(sessionId: string) {
  const { state, openSession, closeSession } = useApp();
  useEffect(() => {
    void openSession(sessionId);
    return () => closeSession(sessionId);
  }, [closeSession, openSession, sessionId]);
  return state.sessionViews[sessionId] ?? { ...emptyView(), loading: true };
}
