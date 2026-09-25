import type { ContentBlock } from "../core/content.js";
import type { Usage } from "../core/usage.js";

export type SessionForkRecord = {
  id: string;
  spaceId: string;
  parentSessionId: string;
  childSessionId: string;
  rootSessionId: string;
  depth: number;
  anchorSourceSessionId: string;
  anchorTurnId: string;
  anchorSequence: number;
  ancestorSessionIds: string[];
  sessionPath: string[];
  createdBy: string | null;
  createdAt: string;
};

export type SessionTurnSegmentRecord = {
  id: string;
  sessionId: string;
  ordinal: number;
  sourceSessionId: string;
  fromSequence: number;
  toSequence: number | null;
  createdAt: string;
};

export type {
  HarnessArchiveIndex,
  ContextCompactionMeta,
  ContextCompactionScope,
  ContextCompactionTriggerReason,
  MessageToolCallsFile,
  SessionTurnAuthorProfile,
  SessionTurnCompactionSummary,
  SessionTurnExecutionKind,
  SessionTurnIntent,
  SessionTurnIntermediateIndex,
  SessionTurnIntermediateSummary,
  SessionTurnIndexItem,
  SessionTurnRecord,
  SessionTurnStatus,
  SessionTurnSummary,
  SpaceTurnAuthorFilter,
  SpaceTurnListItem,
  SpaceTurnsResponse,
  StoredIntermediateMessage,
  StoredToolCall,
  TurnIntermediateMessagesFile,
} from "./turn.js";

export type SessionPromptInput = {
  spaceId: string;
  sessionId: string;
  userMessageId?: string | null;
  message: {
    content: ContentBlock[];
  };
  meta?: {
    source?: string;
    intent?: "auto" | "continue" | "new_session" | "fork" | "steer" | "followup";
    model?: string;
    provider?: string;
    thinkingLevel?: string;
    harness?: "cohub" | "pi" | "codex";
    runtime?: "cloud" | "local";
    turnId?: string;
  } | null;
};

export type RegisterSessionInput = {
  spaceId: string;
  sessionId: string;
  userUuid: string;
  title?: string | null;
  source?: string | null;
  externalSessionId?: string | null;
  meta?: Record<string, unknown> | null;
};

export type PersistMessageInput = {
  spaceId: string;
  sessionId: string;
  previousMessageId?: string | null;
  anchorUserMessageId?: string | null;
  userId?: string | null;
  idempotencyKey: string;
  message: {
    role?: "user" | "assistant" | "system";
    externalMessageId?: string | null;
    protocolMessageId?: string | null;
    content: ContentBlock[];
    text?: string | null;
    provider?: string | null;
    model?: string | null;
    stopReason?: string | null;
    errorMessage?: string | null;
    meta?: Record<string, unknown> | null;
    usage?: Usage | null;
    startedAt?: string | null;
    completedAt?: string | null;
    durationMs?: number | null;
  };
};

export type UpdateSessionInfoInput = {
  spaceId: string;
  sessionId: string;
  title?: string | null;
  updatedAt?: string | null;
  meta?: Record<string, unknown> | null;
};

export type SessionBindingRecord = {
  id: string;
  spaceId: string;
  spaceSessionId: string;
  spaceChannelId: string;
  provider: string;
  bindingKey: string;
  externalChatId: string;
  status: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
};

export type SessionUserProfile = {
  userUuid: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
};

export type SessionActiveTurn = {
  id: string;
  status: "queued" | "running" | "abort_requested";
  provider: string | null;
  model: string | null;
  startedAt: string | null;
  anchorUserMessageId: string | null;
};

export type SessionRecord = {
  id: string;
  spaceId: string;
  userUuid: string | null;
  userProfile?: SessionUserProfile | null;
  participantUserUuids?: string[];
  participantProfiles?: SessionUserProfile[];
  title: string | null;
  source: string | null;
  status: string | null;
  activeTurn?: SessionActiveTurn | null;
  externalSessionId: string | null;
  meta: Record<string, unknown> | null;
  latestMessageText: string | null;
  lastMessageAt: string | null;
  lastMessageId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MessageAuthorProfile = {
  userUuid: string;
  username?: string | null;
  displayName: string;
  avatarUrl: string | null;
};

export type MessageRecord = {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  text: string | null;
  sequence: number;
  provider: string | null;
  model: string | null;
  stopReason: string | null;
  errorMessage: string | null;
  usage: Usage | null;
  meta: Record<string, unknown> | null;
  authorUuid?: string | null;
  authorProfile?: MessageAuthorProfile | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  createdAt: string;
};

export type SessionFileChangeKind = "write" | "edit";

/** A Space file changed by a session's agent tools. */
export type SessionFileRecord = {
  /** Space workspace path, relative and without a leading slash. */
  path: string;
  lastKind: SessionFileChangeKind;
  kinds: SessionFileChangeKind[];
  changeCount: number;
  firstChangedAt: string;
  lastChangedAt: string;
  lastTurnId: string;
  lastTurnSequence: number;
};

export type SessionFilesResponse = {
  sessionId: string;
  files: SessionFileRecord[];
};
