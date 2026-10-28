import type { ContentBlock } from "../core/content.js";
import type { Usage } from "../core/usage.js";
import type { ModelThinkingLevel } from "./thinking.js";
import type { BillingPayload } from "../billing.js";
import type { HarnessArchiveIndex } from "../runtime/index.js";
export type { HarnessArchiveIndex } from "../runtime/index.js";

export type SessionTurnStatus =
  | "queued"
  | "running"
  | "abort_requested"
  | "completed"
  | "failed"
  | "interrupted"
  | "merged"
  | "cancelled";
export type SessionTurnIntent = "steer" | "followup" | "compact";
export type SessionTurnExecutionKind = "agent" | "direct_generation" | "note";

export const isAgentTurn = (turn: { executionKind?: SessionTurnExecutionKind }) =>
  (turn.executionKind ?? "agent") === "agent";

export type SessionTurnSummary = {
  text?: string | null;
  finishReason?: "completed" | "failed" | "interrupted" | "merged" | "cancelled";
  reason?: "steer" | "abort" | "billing" | "merge" | string;
  billing?: BillingPayload | null;
  continuedByTurnId?: string | null;
  interruptedByTurnId?: string | null;
  mergedIntoTurnId?: string | null;
};

export type SessionTurnIntermediateIndex = {
  version: 1;
  messagesObjectKey: string | null;
  messagesSizeBytes?: number | null;
  toolCallsBaseObjectKey?: string | null;
};

export type ContextCompactionScope = "between_turns" | "within_turn";
export type ContextCompactionTriggerReason = "threshold" | "overflow_recovery";

export type ContextCompactionProviderCalls = {
  total: number;
  succeeded: number;
  failed: number;
};

export type ContextCompactionMeta = {
  version: 1;
  compactionId: string;
  scope: ContextCompactionScope;
  ownerTurnId: string | null;
  ordinalInTurn: number | null;
  llmRound: number | null;
  triggerReason: ContextCompactionTriggerReason;
  contextWindow: number;
  tokensBefore: number;
  estimatedTokensAfter: number | null;
  provider: string;
  model: string;
  keepRecentTokens: number;
  summarizedMessageCount: number;
  attemptCount: number;
  providerCalls?: ContextCompactionProviderCalls;
  /** Legacy metadata written before per-call outcomes were tracked. */
  providerCallCount?: number;
  isSplitTurn: boolean;
  firstKeptEntryId: string;
  archivePath: string | null;
  compactedAt: string;
  placement: {
    beforeSessionEntryId: string;
    beforeMessageId: string | null;
  };
};

export type SessionTurnCompactionSummary = {
  count: number;
  summarizedMessageCountTotal: number;
  attemptCountTotal: number;
  usage: Usage | null;
  durationMsTotal: number | null;
  last: {
    compactionId: string;
    tokensBefore: number;
    estimatedTokensAfter: number | null;
    compactedAt: string;
  } | null;
};

export type ImageToTextUsageSummary = {
  callCount: number;
  successCount: number;
  errorCount: number;
  sourceCount: number;
  usage: Usage | null;
};

export type SessionTurnIntermediateSummary = {
  messageCount: number;
  toolCallCount: number;
  usage?: Usage | null;
  durationMs?: number | null;
  lastMessageText?: string | null;
  hasError?: boolean;
  compaction?: SessionTurnCompactionSummary | null;
  imageToText?: ImageToTextUsageSummary | null;
};

export type StoredIntermediateMessage = {
  id: string;
  sessionId: string;
  sequence?: number | null;
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  text: string | null;
  provider: string | null;
  model: string | null;
  stopReason: string | null;
  errorMessage: string | null;
  usage: Usage | null;
  durationMs: number | null;
  toolCallsObjectKey: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
};

export type StoredToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  meta: Record<string, unknown> | null;
  result: {
    content: string | ContentBlock[] | null;
    isError: boolean;
    meta: Record<string, unknown> | null;
  } | null;
};

export type MessageToolCallsFile = {
  version: 1;
  spaceId: string;
  sessionId: string;
  turnId: string;
  messageId: string;
  toolCalls: StoredToolCall[];
};

export type TurnIntermediateMessagesFile = {
  version: 1;
  spaceId: string;
  sessionId: string;
  turnId: string;
  summary: SessionTurnIntermediateSummary;
  messages: StoredIntermediateMessage[];
};

export type SessionTurnAuthorProfile = {
  userUuid: string;
  username?: string | null;
  displayName: string;
  avatarUrl: string | null;
};

export type SessionTurnIndexItem = {
  id: string;
  sessionId: string;
  sourceSessionId?: string;
  sourceTurnId?: string;
  sequence: number;
  status: SessionTurnStatus;
  executionKind?: SessionTurnExecutionKind;
  /** Present on current turn index payloads; older caches may omit it. */
  intent?: SessionTurnIntent;
  userUuid?: string | null;
  authorProfile?: SessionTurnAuthorProfile | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
  userPreview: string | null;
  assistantPreview: string | null;
  provider: string | null;
  model: string | null;
  finalUsage: Usage | null;
  totalUsage: Usage | null;
  errorMessage: string | null;
};

export type SpaceTurnAuthorFilter = "any" | "self" | "others";

export type SpaceTurnListItem = SessionTurnIndexItem & {
  session: {
    id: string;
    title: string | null;
    source: string | null;
  };
};

export type SpaceTurnsResponse = {
  turns: SpaceTurnListItem[];
  snapshotAt: string;
  snapshotCursor: string;
  pageInfo: {
    hasMore: boolean;
    nextCursor: string | null;
  };
};

export type SessionTurnRecord = {
  id: string;
  sessionId: string;
  sourceSessionId?: string;
  sourceTurnId?: string;
  userUuid: string | null;
  sequence: number;
  executionKind?: SessionTurnExecutionKind;
  status: SessionTurnStatus;
  intent: SessionTurnIntent;
  userContent: ContentBlock[];
  userText: string | null;
  assistantContent: ContentBlock[] | null;
  assistantText: string | null;
  provider: string | null;
  model: string | null;
  stopReason: string | null;
  errorMessage: string | null;
  finalUsage: Usage | null;
  totalUsage: Usage | null;
  summary: SessionTurnSummary | null;
  intermediateIndex: SessionTurnIntermediateIndex | null;
  intermediateSummary: SessionTurnIntermediateSummary | null;
  harnessIndex?: HarnessArchiveIndex | null;
  meta: Record<string, unknown> | null;
  /** Effective thinking level used for this turn (derived from meta.effectiveThinkingLevel). */
  thinkingLevel?: ModelThinkingLevel | null;
  authorProfile?: SessionTurnAuthorProfile | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
};
