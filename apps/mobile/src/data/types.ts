import type {
  ContentBlock,
  MessageRecord,
  ModelCatalogEntry,
  ModelThinkingLevel,
  SessionRecord,
  SessionTurnIndexItem,
  SessionTurnRecord,
  SpaceRecord,
  SpaceUsageSummary,
  UserSessionListItem,
} from "@neta-art/cohub";

export type ConnectionState = "idle" | "connecting" | "reconnecting" | "open" | "closed" | "error";

export type AttachmentDraft = {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
};

export type ChatModelSelection = {
  provider: string;
  id: string;
  name?: string;
  thinkingLevel?: ModelThinkingLevel | null;
};

export type ChatModelCatalogItem = ModelCatalogEntry;

export type StreamView = {
  status: "pending" | "streaming" | "completed" | "failed" | "interrupted";
  contentBlocks: ContentBlock[];
  intermediateMessages: {
    id?: string;
    messageId: string | null;
    messageOrdinal: number | null;
    content: ContentBlock[];
    text?: string | null;
    meta?: Record<string, unknown> | null;
  }[];
  turnId: string | null;
  messageId: string | null;
};

export type SessionView = {
  space: SpaceRecord | null;
  session: SessionRecord | null;
  /** Live message events and the short-lived optimistic send overlay. */
  messages: MessageRecord[];
  /** Authoritative turn history loaded from the paginated session API. */
  turns: SessionTurnRecord[];
  /** True after the first authoritative turn response has arrived. */
  historyLoaded: boolean;
  turnIndex: SessionTurnIndexItem[];
  turnIndexLoading: boolean;
  hasMoreOlder: boolean;
  hasMoreNewer: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  oldestCursor: number | null;
  newestCursor: number | null;
  loading: boolean;
  refreshing: boolean;
  sending: boolean;
  error: string | null;
  stream: StreamView | null;
};

export type UsageSummary = SpaceUsageSummary | null;

export type AppState = {
  booting: boolean;
  refreshing: boolean;
  error: string | null;
  spacesError: string | null;
  sessionsError: string | null;
  activityLoading: boolean;
  activityError: string | null;
  lastSyncedAt: string | null;
  spaces: SpaceRecord[];
  sessions: UserSessionListItem[];
  sessionsHasMore: boolean;
  sessionsCursor: string | null;
  sessionsLoadingMore: boolean;
  sessionViews: Record<string, SessionView>;
  usage: UsageSummary;
};

export type ActivityItem = {
  id: string;
  sessionId: string;
  spaceId: string;
  title: string;
  spaceName: string;
  preview: string;
  status: "running" | "attention" | "complete";
  updatedAt: string;
};
