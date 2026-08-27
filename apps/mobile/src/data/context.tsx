import type {
  CohubClient,
  ContentBlock,
  MessageRecord,
  SessionRecord,
  SpaceRecord,
  SpaceUsageSummary,
  UserSessionListItem,
} from "@neta-art/cohub";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState as NativeAppState, Platform } from "react-native";
import { File as ExpoFile } from "expo-file-system";
import { createMobileClient } from "@/src/data/client";
import {
  clearUserCache,
  hydrateHome,
  loadMessages,
  saveHome,
  saveMessages,
} from "@/src/data/local-db";
import type {
  ActivityItem,
  AppState,
  AttachmentDraft,
  ConnectionState,
  SessionView,
  StreamView,
} from "@/src/data/types";
import { getInstallationId } from "@/src/platform/installation";
import {
  displaySessionTitle,
  displaySpaceName,
  isNeedsAttentionStatus,
  isRunningStatus,
  newId,
  sortByRecent,
} from "@/src/utils";

const emptyView = (): SessionView => ({
  space: null,
  session: null,
  messages: [],
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
  spaces: [],
  sessions: [],
  sessionViews: {},
  usage: null,
};

type Action =
  | { type: "hydrate"; spaces: SpaceRecord[]; sessions: UserSessionListItem[] }
  | { type: "home-start" }
  | { type: "home-success"; spaces: SpaceRecord[]; sessions: UserSessionListItem[] }
  | { type: "home-error"; message: string }
  | { type: "usage"; usage: SpaceUsageSummary }
  | { type: "session-start"; sessionId: string; space?: SpaceRecord | null; session?: SessionRecord | null }
  | { type: "session-meta"; sessionId: string; space?: SpaceRecord | null; session: SessionRecord }
  | { type: "session-cache"; sessionId: string; messages: MessageRecord[] }
  | { type: "session-success"; sessionId: string; space: SpaceRecord; session: SessionRecord; messages: MessageRecord[] }
  | { type: "session-error"; sessionId: string; message: string }
  | { type: "session-refresh-start"; sessionId: string }
  | { type: "session-refresh-end"; sessionId: string; messages?: MessageRecord[]; error?: string }
  | { type: "message-add"; sessionId: string; message: MessageRecord }
  | { type: "message-optimistic"; sessionId: string; message: MessageRecord }
  | { type: "send-start"; sessionId: string }
  | { type: "send-end"; sessionId: string }
  | { type: "send-failed"; sessionId: string; clientMessageId: string; message: string }
  | { type: "stream-state"; sessionId: string; stream: StreamView }
  | { type: "stream-clear"; sessionId: string }
  | { type: "session-upsert"; session: UserSessionListItem }
  | { type: "space-upsert"; space: SpaceRecord };

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
      return { ...state, refreshing: true, error: null };
    case "home-success":
      return {
        ...state,
        booting: false,
        refreshing: false,
        error: null,
        spaces: sortByRecent(action.spaces),
        sessions: sortByRecent(action.sessions),
      };
    case "home-error":
      return { ...state, booting: false, refreshing: false, error: action.message };
    case "usage":
      return { ...state, usage: action.usage };
    case "session-start":
      return updateView(state, action.sessionId, {
        loading: true,
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
    case "session-success":
      return updateView(
        {
          ...state,
          sessions: state.sessions.map((item) =>
            item.id === action.session.id
              ? { ...item, ...action.session, space: item.space ?? { id: action.space.id, name: displaySpaceName(action.space), slug: action.space.slug, publicProfile: action.space.publicProfile ?? null } }
              : item,
          ),
        },
        action.sessionId,
        {
          loading: false,
          refreshing: false,
          error: null,
          space: action.space,
          session: action.session,
          messages: action.messages,
        },
      );
    case "session-error":
      return updateView(state, action.sessionId, { loading: false, refreshing: false, error: action.message });
    case "session-refresh-start":
      return updateView(state, action.sessionId, { refreshing: true, error: null });
    case "session-refresh-end":
      return updateView(state, action.sessionId, {
        refreshing: false,
        ...(action.messages ? { messages: action.messages } : {}),
        ...(action.error ? { error: action.error } : {}),
      });
    case "message-add": {
      const view = state.sessionViews[action.sessionId] ?? emptyView();
      return updateView(state, action.sessionId, {
        messages: mergeMessages(view.messages, action.message),
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
    case "stream-state":
      return updateView(state, action.sessionId, { stream: action.stream });
    case "stream-clear":
      return updateView(state, action.sessionId, { stream: null });
    case "session-upsert": {
      const exists = state.sessions.some((session) => session.id === action.session.id);
      return {
        ...state,
        sessions: sortByRecent(
          exists
            ? state.sessions.map((session) => (session.id === action.session.id ? { ...session, ...action.session } : session))
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
  openSession: (sessionId: string) => Promise<void>;
  closeSession: (sessionId: string) => void;
  refreshSession: (sessionId: string) => Promise<void>;
  sendMessage: (sessionId: string, text: string, attachments?: AttachmentDraft[]) => Promise<void>;
  abortSession: (sessionId: string) => Promise<void>;
  createChat: (spaceId: string, title?: string) => Promise<SessionRecord>;
  createSpace: (name: string, description?: string) => Promise<SpaceRecord>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  clearCache: () => Promise<void>;
  activityItems: ActivityItem[];
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  userUuid,
  getAccessToken,
  offline = false,
  children,
}: {
  userUuid: string;
  getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string | null>;
  offline?: boolean;
  children: ReactNode;
}) {
  const [installationId, setInstallationId] = useState<string | null>(null);
  const [client, setClient] = useState<CohubClient | null>(null);
  const [state, setState] = useState<AppState>(initialState);
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const stateRef = useRef(state);
  const subscriptions = useRef(new Map<string, () => void>());
  const openTokens = useRef(new Map<string, number>());
  const userKey = userUuid;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    let active = true;
    void getInstallationId().then((id) => {
      if (active) setInstallationId(id);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (offline) {
      setState((current) => ({ ...current, booting: false, refreshing: false }));
      setClient(null);
      return;
    }
    if (!installationId) return;
    setClient(createMobileClient(getAccessToken, installationId));
  }, [getAccessToken, installationId, offline]);

  const dispatch = useCallback((action: Action) => {
    setState((current) => reducer(current, action));
  }, []);

  const refreshHome = useCallback(async () => {
    if (!client) return;
    dispatch({ type: "home-start" });
    try {
      const [spaces, sessionResponse] = await Promise.all([
        client.spaces.list(),
        client.user.listSessions({ limit: 60 }),
      ]);
      const sessions = sessionResponse.sessions;
      dispatch({ type: "home-success", spaces, sessions });
      if (Platform.OS !== "web") {
        void saveHome(userKey, { spaces, sessions }).catch((error) => {
          console.warn("[mobile-cache] failed to save home", error);
        });
      }
      void client.user
        .getActivity({ days: 7 })
        .then((activity) => dispatch({ type: "usage", usage: activity.summary }))
        .catch(() => undefined);
    } catch (error) {
      if (Platform.OS === "web" && !(await getAccessToken())) {
        dispatch({ type: "home-success", spaces: [], sessions: [] });
        return;
      }
      const message = error instanceof Error ? error.message : "Unable to load Cohub";
      dispatch({ type: "home-error", message });
    }
  }, [client, dispatch, getAccessToken, userKey]);

  useEffect(() => {
    if (!client) return;
    let active = true;
    void (async () => {
      if (Platform.OS !== "web") {
        try {
          const cached = await hydrateHome(userKey);
          if (active && (cached.spaces.length > 0 || cached.sessions.length > 0)) {
            dispatch({ type: "hydrate", ...cached });
          }
        } catch (error) {
          console.warn("[mobile-cache] failed to hydrate home", error);
        }
      }
      if (active) await refreshHome();
    })();
    return () => {
      active = false;
      for (const stop of subscriptions.current.values()) stop();
      subscriptions.current.clear();
    };
  }, [client, dispatch, refreshHome, userKey]);

  useEffect(() => {
    if (!client) return;
    return client.onConnection((snapshot) => setConnectionState(snapshot.state));
  }, [client]);

  useEffect(() => {
    const subscription = NativeAppState.addEventListener("change", (next) => {
      if (next === "active") void refreshHome();
    });
    return () => subscription.remove();
  }, [refreshHome]);

  const refreshSession = useCallback(
    async (sessionId: string) => {
      if (!client) return;
      const view = stateRef.current.sessionViews[sessionId];
      const sessionSummary = stateRef.current.sessions.find((item) => item.id === sessionId);
      const spaceId = view?.session?.spaceId ?? sessionSummary?.spaceId;
      if (!spaceId) return;
      dispatch({ type: "session-refresh-start", sessionId });
      try {
        const response = await client.space(spaceId).session(sessionId).messages.list();
        dispatch({ type: "session-refresh-end", sessionId, messages: response.messages });
        if (Platform.OS !== "web") void saveMessages(userKey, sessionId, response.messages).catch(() => undefined);
      } catch (error) {
        dispatch({
          type: "session-refresh-end",
          sessionId,
          error: error instanceof Error ? error.message : "Unable to refresh Chat",
        });
      }
    },
    [client, dispatch, userKey],
  );

  const openSession = useCallback(
    async (sessionId: string) => {
      if (!client) return;
      const token = (openTokens.current.get(sessionId) ?? 0) + 1;
      openTokens.current.set(sessionId, token);
      const summary = stateRef.current.sessions.find((item) => item.id === sessionId);
      dispatch({ type: "session-start", sessionId, session: summary ?? null });

      if (Platform.OS !== "web") {
        try {
          const cachedMessages = await loadMessages(userKey, sessionId);
          if (openTokens.current.get(sessionId) === token && cachedMessages.length > 0) {
            dispatch({ type: "session-cache", sessionId, messages: cachedMessages });
          }
        } catch (error) {
          console.warn("[mobile-cache] failed to load Chat", error);
        }
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
        subscriptions.current.get(sessionId)?.();
        const sessionClient = client.space(spaceId).session(sessionId);
        const stopGeneration = sessionClient.subscribeGeneration(
          {
            state: (event) => {
              const stream: StreamView = {
                status: event.state.status === "idle" ? "pending" : event.state.status,
                contentBlocks: event.state.contentBlocks,
                intermediateMessages: event.intermediateMessages,
                turnId: event.state.turnId,
                messageId: event.messageId,
              };
              dispatch({ type: "stream-state", sessionId, stream });
            },
            commit: (event) => {
              dispatch({ type: "message-add", sessionId, message: event.commit.message });
              if (event.commit.isFinal) dispatch({ type: "stream-clear", sessionId });
            },
            finalized: () => {
              dispatch({ type: "stream-clear", sessionId });
              void refreshSession(sessionId);
            },
            turnUpdated: () => undefined,
            lifecycle: () => undefined,
            error: (event) => {
              dispatch({ type: "session-error", sessionId, message: event.message });
            },
            outOfSync: () => {
              void refreshSession(sessionId);
            },
          },
          { recover: true },
        );
        const stopPersisted = sessionClient.subscribe({
          persisted: (event) => {
            if (event.type !== "session.message.persisted") return;
            const message = (event.payload as { message?: MessageRecord }).message;
            if (!message) return;
            dispatch({ type: "message-add", sessionId, message });
          },
        });
        const stop = () => {
          stopGeneration();
          stopPersisted();
        };
        subscriptions.current.set(sessionId, stop);
        const response = await sessionClient.messages.list();
        if (openTokens.current.get(sessionId) !== token) return;
        dispatch({ type: "session-success", sessionId, space, session, messages: response.messages });
        if (Platform.OS !== "web") void saveMessages(userKey, sessionId, response.messages).catch(() => undefined);
      } catch (error) {
        if (openTokens.current.get(sessionId) !== token) return;
        dispatch({ type: "session-error", sessionId, message: error instanceof Error ? error.message : "Unable to open Chat" });
      }
    },
    [client, dispatch, refreshSession, userKey],
  );

  const closeSession = useCallback((sessionId: string) => {
    subscriptions.current.get(sessionId)?.();
    subscriptions.current.delete(sessionId);
  }, []);

  const abortSession = useCallback(
    async (sessionId: string) => {
      if (!client) throw new Error("Cohub is still connecting");
      const view = stateRef.current.sessionViews[sessionId];
      const summary = stateRef.current.sessions.find((item) => item.id === sessionId);
      const spaceId = view?.session?.spaceId ?? summary?.spaceId;
      if (!spaceId) throw new Error("Chat context is unavailable");
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
    async (sessionId: string, rawText: string, attachments: AttachmentDraft[] = []) => {
      if (!client) throw new Error("Cohub is still connecting");
      const text = rawText.trim();
      const view = stateRef.current.sessionViews[sessionId];
      const session = view?.session ?? stateRef.current.sessions.find((item) => item.id === sessionId);
      if (!session?.spaceId) throw new Error("Chat context is unavailable");
      if (!text && attachments.length === 0) return;

      const clientMessageId = newId();
      const optimisticText = text || attachments.map((item) => item.name).join(", ");
      const currentMax = Math.max(0, ...(view?.messages ?? []).map((message) => message.sequence));
      const optimistic: MessageRecord = {
        id: `local-${clientMessageId}`,
        sessionId,
        role: "user",
        content: [{ type: "text", text: optimisticText }],
        text: optimisticText,
        sequence: currentMax + 1,
        provider: null,
        model: null,
        stopReason: null,
        errorMessage: null,
        usage: null,
        meta: { optimistic: true, clientMessageId },
        authorUuid: userUuid,
        authorProfile: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        createdAt: new Date().toISOString(),
      };
      dispatch({ type: "message-optimistic", sessionId, message: optimistic });
      dispatch({ type: "send-start", sessionId });

      try {
        let promptText = text;
        const content: ContentBlock[] = [];
        const imageBlocks: ContentBlock[] = [];
        for (const attachment of attachments) {
          const blob: Blob = Platform.OS === "web"
            ? await (await fetch(attachment.uri)).blob()
            : new ExpoFile(attachment.uri);
          const uploaded = await client.publicAssets.uploadChatAttachment({
            spaceId: session.spaceId,
            sessionId,
            file: blob,
            mimeType: attachment.mimeType,
            filename: attachment.name,
          });
          if (attachment.mimeType.startsWith("image/")) {
            imageBlocks.push({
              type: "image",
              source: { type: "url", url: uploaded.publicUrl },
              _meta: { filename: attachment.name, mediaType: attachment.mimeType, size: attachment.size },
            });
          } else {
            promptText = [promptText, `Attached file: ${attachment.name}\n${uploaded.publicUrl}`].filter(Boolean).join("\n\n");
          }
        }
        if (promptText) content.push({ type: "text", text: promptText });
        content.push(...imageBlocks);
        await client.space(session.spaceId).prompt({
          mode: "agent",
          sessionId,
          content,
          source: "mobile",
          clientMessageId,
        });
        dispatch({ type: "send-end", sessionId });
      } catch (error) {
        dispatch({ type: "send-failed", sessionId, clientMessageId, message: error instanceof Error ? error.message : "Message failed to send" });
        throw error;
      }
    },
    [client, dispatch, userUuid],
  );

  const createSpace = useCallback(
    async (name: string, description?: string) => {
      if (!client) throw new Error("Cohub is still connecting");
      const trimmedName = name.trim();
      if (!trimmedName) throw new Error("Space name is required");
      const result = await client.spaces.create({
        name: trimmedName,
        description: description?.trim() || null,
        source: "mobile",
      });
      dispatch({ type: "space-upsert", space: result.space });
      if (Platform.OS !== "web") {
        const home = stateRef.current;
        void saveHome(userKey, {
          spaces: [result.space, ...home.spaces.filter((space) => space.id !== result.space.id)],
          sessions: home.sessions,
        }).catch(() => undefined);
      }
      return result.space;
    },
    [client, dispatch, userKey],
  );

  const createChat = useCallback(
    async (spaceId: string, title?: string) => {
      if (!client) throw new Error("Cohub is still connecting");
      const result = await client.space(spaceId).sessions.create({
        title: title?.trim() || null,
        source: "mobile",
      });
      const space = stateRef.current.spaces.find((item) => item.id === spaceId) ?? null;
      dispatch({
        type: "session-upsert",
        session: {
          ...result.session,
          space: space
            ? { id: space.id, name: displaySpaceName(space), slug: space.slug, publicProfile: space.publicProfile ?? null }
            : null,
        },
      });
      return result.session;
    },
    [client, dispatch],
  );

  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      if (!client) throw new Error("Cohub is still connecting");
      const view = stateRef.current.sessionViews[sessionId];
      const summary = stateRef.current.sessions.find((item) => item.id === sessionId);
      const spaceId = view?.session?.spaceId ?? summary?.spaceId;
      if (!spaceId) throw new Error("Chat context is unavailable");
      const result = await client.space(spaceId).session(sessionId).rename(title.trim() || null);
      dispatch({ type: "session-upsert", session: { ...result.session, space: summary?.space ?? null } });
      const currentView = stateRef.current.sessionViews[sessionId];
      if (currentView) dispatch({ type: "session-meta", sessionId, session: result.session, space: currentView.space });
    },
    [client, dispatch],
  );

  const clearCache = useCallback(async () => {
    await clearUserCache(userKey);
    setState(initialState);
  }, [userKey]);

  const activityItems = useMemo<ActivityItem[]>(() => {
    return state.sessions.slice(0, 30).map((session) => {
      const status = isRunningStatus(session.status)
        ? "running"
        : isNeedsAttentionStatus(session.status)
          ? "attention"
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
  }, [state.sessions]);

  const value = useMemo<AppContextValue>(
    () => ({
      state,
      client,
      connectionState,
      installationId,
      getAccessToken,
      refreshHome,
      openSession,
      closeSession,
      refreshSession,
      sendMessage,
      abortSession,
      createChat,
      createSpace,
      renameSession,
      clearCache,
      activityItems,
    }),
    [
      activityItems,
      abortSession,
      clearCache,
      client,
      closeSession,
      connectionState,
      createChat,
      createSpace,
      getAccessToken,
      installationId,
      openSession,
      refreshHome,
      refreshSession,
      renameSession,
      sendMessage,
      state,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
}

export function useSession(sessionId: string) {
  const { state, openSession, closeSession } = useApp();
  useEffect(() => {
    void openSession(sessionId);
    return () => closeSession(sessionId);
  }, [closeSession, openSession, sessionId]);
  return state.sessionViews[sessionId] ?? emptyView();
}
