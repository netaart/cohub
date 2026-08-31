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
  ChatModelCatalogItem,
  ChatModelSelection,
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

const HOME_REQUEST_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after 15 seconds`)), HOME_REQUEST_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function errorMessage(error: unknown, fallback: string) {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (status === 401) return "Your sign-in session was rejected. Please sign in again and retry.";
    if (status === 403) return "Your account does not have access to this data.";
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
    const blob: Blob = Platform.OS === "web"
      ? await (await fetch(attachment.uri)).blob()
      : new ExpoFile(attachment.uri);
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
  sessionViews: {},
  usage: null,
};

type Action =
  | { type: "hydrate"; spaces: SpaceRecord[]; sessions: UserSessionListItem[] }
  | { type: "home-start" }
  | { type: "home-success"; spaces: SpaceRecord[]; sessions: UserSessionListItem[]; spacesError?: string; sessionsError?: string }
  | { type: "home-error"; message: string }
  | { type: "usage-start" }
  | { type: "usage"; usage: SpaceUsageSummary }
  | { type: "usage-error"; message: string }
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

function preferNewerSession(current: SessionRecord | null | undefined, incoming: SessionRecord) {
  if (!current) return incoming;
  const currentTime = Date.parse(current.updatedAt);
  const incomingTime = Date.parse(incoming.updatedAt);
  return Number.isFinite(currentTime) && Number.isFinite(incomingTime) && currentTime > incomingTime
    ? current
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
    case "home-success":
      return {
        ...state,
        booting: false,
        refreshing: false,
        error: null,
        spacesError: action.spacesError ?? null,
        sessionsError: action.sessionsError ?? null,
        lastSyncedAt: new Date().toISOString(),
        spaces: sortByRecent(action.spaces),
        sessions: sortByRecent(action.sessions),
      };
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
        {
          ...state,
          sessions: state.sessions.map((item) =>
            item.id === session.id
              ? { ...item, ...session, space: item.space ?? { id: action.space.id, name: displaySpaceName(action.space), slug: action.space.slug, publicProfile: action.space.publicProfile ?? null } }
              : item,
          ),
        },
        action.sessionId,
        {
          loading: false,
          refreshing: false,
          error: null,
          space: action.space,
          session,
          messages: action.messages,
        },
      );
    }
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
  sendMessage: (sessionId: string, text: string, attachments?: AttachmentDraft[], options?: { model?: ChatModelSelection | null }) => Promise<void>;
  sendNewMessage: (spaceId: string, text: string, attachments?: AttachmentDraft[], options?: { model?: ChatModelSelection | null }) => Promise<SessionRecord>;
  abortSession: (sessionId: string) => Promise<void>;
  models: ChatModelCatalogItem[];
  modelsLoading: boolean;
  modelsError: string | null;
  loadModels: (options?: { force?: boolean }) => Promise<ChatModelCatalogItem[]>;
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
  const [state, setState] = useState<AppState>(() =>
    offline ? { ...initialState, booting: false, refreshing: false } : initialState,
  );
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const stateRef = useRef(state);
  const subscriptions = useRef(new Map<string, () => void>());
  const openTokens = useRef(new Map<string, number>());
  const installationIdRef = useRef<string | null>(null);
  const installationRequestRef = useRef<Promise<string> | null>(null);
  const clientRef = useRef<CohubClient | null>(null);
  const homeRefreshGenerationRef = useRef(0);
  const [models, setModels] = useState<ChatModelCatalogItem[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const modelsRequestRef = useRef<Promise<ChatModelCatalogItem[]> | null>(null);
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
    () =>
      !offline && installationId
        ? createMobileClient(getAccessToken, installationId)
        : null,
    [getAccessToken, installationId, offline],
  );

  useEffect(() => {
    clientRef.current = client;
  }, [client]);

  const loadModels = useCallback(async (options: { force?: boolean } = {}) => {
    if (offline) return [];
    if (models.length > 0 && !options.force) return models;
    if (modelsRequestRef.current && !options.force) return modelsRequestRef.current;
    const activeClient = clientRef.current;
    if (!activeClient) throw new Error("Cohub is still connecting");

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
  }, [models, offline]);

  const refreshHome = useCallback(async () => {
    if (offline) return;
    const generation = homeRefreshGenerationRef.current + 1;
    homeRefreshGenerationRef.current = generation;
    dispatch({ type: "home-start" });
    try {
      const resolvedInstallationId = await ensureInstallation();
      const activeClient = clientRef.current ?? createMobileClient(getAccessToken, resolvedInstallationId);
      clientRef.current = activeClient;
      const token = await withAccessTokenTimeout(getAccessToken());
      if (!token) throw new Error("Your sign-in session is unavailable. Please sign in again.");
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
        throw new Error(errors.map((error) => errorMessage(error, "Request failed")).join("\n"));
      }
      const spaces = spacesResult.status === "fulfilled" ? spacesResult.value ?? [] : stateRef.current.spaces;
      const sessions = sessionsResult.status === "fulfilled" ? sessionsResult.value.sessions ?? [] : stateRef.current.sessions;
      const spacesError = spacesResult.status === "rejected"
        ? `Spaces could not be refreshed: ${errorMessage(spacesResult.reason, "Request failed")}`
        : undefined;
      const sessionsError = sessionsResult.status === "rejected"
        ? `Chats could not be refreshed: ${errorMessage(sessionsResult.reason, "Request failed")}`
        : undefined;
      dispatch({ type: "home-success", spaces, sessions, spacesError, sessionsError });
      dispatch({ type: "usage-start" });
      if (Platform.OS !== "web") {
        void saveHome(userKey, { spaces, sessions }).catch((error) => {
          console.warn("[mobile-cache] failed to save home", error);
        });
      }
      void withTimeout(activeClient.user.getActivity({ days: 7 }), "Loading activity")
        .then((activity) => {
          if (generation === homeRefreshGenerationRef.current) dispatch({ type: "usage", usage: activity.summary });
        })
        .catch((error) => {
          if (generation === homeRefreshGenerationRef.current) dispatch({ type: "usage-error", message: errorMessage(error, "Activity could not be refreshed") });
        });
    } catch (error) {
      if (generation === homeRefreshGenerationRef.current) {
        dispatch({ type: "home-error", message: errorMessage(error, "Unable to load Cohub") });
      }
    }
  }, [dispatch, ensureInstallation, getAccessToken, offline, userKey]);

  useEffect(() => {
    if (offline) return;
    let active = true;
    const activeSubscriptions = subscriptions.current;
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
      if (active) {
        await refreshHome();
      }
    })().catch((error) => {
      if (active) {
        dispatch({
          type: "home-error",
          message: errorMessage(error, "Unable to initialize Cohub"),
        });
      }
    });
    return () => {
      active = false;
      for (const stop of activeSubscriptions.values()) stop();
      activeSubscriptions.clear();
    };
  }, [dispatch, offline, refreshHome, userKey]);

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
          event: (event) => {
            if (event.type !== "session.updated") return;
            const currentSummary = stateRef.current.sessions.find((item) => item.id === sessionId);
            const current = stateRef.current.sessionViews[sessionId]?.session
              ?? currentSummary;
            if (!current) return;
            const payload = event.payload as { session?: Partial<SessionRecord> };
            if (!payload.session || payload.session.id !== sessionId) return;
            const updated = { ...current, ...payload.session };
            dispatch({
              type: "session-upsert",
              session: {
                ...updated,
                space: currentSummary?.space ?? null,
              },
            });
            const currentView = stateRef.current.sessionViews[sessionId];
            if (currentView) dispatch({ type: "session-meta", sessionId, session: updated, space: currentView.space });
          },
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
    async (
      sessionId: string,
      rawText: string,
      attachments: AttachmentDraft[] = [],
      options: { model?: ChatModelSelection | null } = {},
    ) => {
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
        provider: options.model?.provider ?? null,
        model: options.model?.id ?? null,
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
        const content = await buildPromptContent(client, session.spaceId, sessionId, text, attachments);
        await client.space(session.spaceId).prompt({
          mode: "agent",
          sessionId,
          content,
          source: "mobile",
          clientMessageId,
          accessMode: "full_access",
          intent: "followup",
          schedule: { mode: "immediate" },
          ...(options.model ? { model: options.model.id, provider: options.model.provider } : {}),
        });
        dispatch({ type: "send-end", sessionId });
      } catch (error) {
        dispatch({ type: "send-failed", sessionId, clientMessageId, message: error instanceof Error ? error.message : "Message failed to send" });
        throw error;
      }
    },
    [client, dispatch, userUuid],
  );

  const sendNewMessage = useCallback(
    async (
      spaceId: string,
      rawText: string,
      attachments: AttachmentDraft[] = [],
      options: { model?: ChatModelSelection | null } = {},
    ) => {
      if (!client) throw new Error("Cohub is still connecting");
      const text = rawText.trim();
      if (!spaceId) throw new Error("Space is required");
      if (!text && attachments.length === 0) throw new Error("Message cannot be empty");

      const clientMessageId = newId();
      const content = await buildPromptContent(client, spaceId, undefined, text, attachments);
      const result = await client.space(spaceId).prompt({
        mode: "agent",
        content,
        source: "mobile",
        clientMessageId,
        accessMode: "full_access",
        intent: "followup",
        schedule: { mode: "immediate" },
        ...(options.model ? { model: options.model.id, provider: options.model.provider } : {}),
      });
      if (result.mode !== "immediate" || !result.session) {
        throw new Error("The new Chat was not created");
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
      if (Platform.OS !== "web") {
        const home = stateRef.current;
        void saveHome(userKey, {
          spaces: home.spaces,
          sessions: [session, ...home.sessions.filter((item) => item.id !== session.id)],
        }).catch(() => undefined);
      }
      return result.session;
    },
    [client, dispatch, userKey],
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
    setModels([]);
    setModelsError(null);
    setState({ ...initialState, booting: false, refreshing: false });
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
      sendNewMessage,
      abortSession,
      models,
      modelsLoading,
      modelsError,
      loadModels,
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
      createSpace,
      getAccessToken,
      installationId,
      loadModels,
      models,
      modelsError,
      modelsLoading,
      openSession,
      refreshHome,
      refreshSession,
      renameSession,
      sendMessage,
      sendNewMessage,
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
