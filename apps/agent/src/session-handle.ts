import { stat } from "node:fs/promises";
import type { SessionManager } from "./runtime/local-session-manager.js";
import type { ContentBlock } from "@cohub/protocol/core";
import type { getAgentTracer } from "@cohub/infra/tracing/agent";
import { getAgentSessionFilePath } from "./runtime/paths.js";
import type { CohubAgentSession } from "./runtime/session-runtime.js";
import type { Permission } from "@cohub/core/permissions";
import type { PromptAccessMode } from "@cohub/core/sessions";
import type { AssistantStreamState } from "./stream/assistant-stream-state.js";

export type PendingUserMessage = {
  userMessageId: string;
  turnId?: string | null;
  turnSeq?: number | null;
  content: ContentBlock[];
  meta?: Record<string, unknown> | null;
};

export function hasSessionUserMessage(handle: SessionHandle, userMessageId: string) {
  return handle.sessionManager.hasUserMessage(userMessageId);
}

export function ensurePendingUserMessage(handle: SessionHandle, pending: PendingUserMessage) {
  const normalizedUserMessageId = pending.userMessageId.trim();
  if (!normalizedUserMessageId) return false;
  if (hasSessionUserMessage(handle, normalizedUserMessageId)) return false;
  if (handle.pendingUserMessages.some((item) => item.userMessageId.trim() === normalizedUserMessageId)) return false;

  handle.pendingUserMessages.push({
    ...pending,
    userMessageId: normalizedUserMessageId,
  });
  return true;
}

export function removePendingUserMessage(handle: SessionHandle, userMessageId: string) {
  const normalizedUserMessageId = userMessageId.trim();
  if (!normalizedUserMessageId) return;
  handle.pendingUserMessages = handle.pendingUserMessages.filter((item) => item.userMessageId.trim() !== normalizedUserMessageId);
}

type AssistantMessageContext = {
  turnId: string | null;
  turnSeq: number | null;
  userMessageId: string | null;
  userMeta: Record<string, unknown> | null;
  assistantOrdinal: number;
  streamMessageId: string | null;
  patchSeq: number;
  streamStartedAt: string;
  startedAt: string;
};

export type SessionHandle = {
  spaceId: string;
  spaceOwnerUserId: string | null;
  sessionKey: string;
  sessionId: string;
  session: CohubAgentSession;
  sessionManager: SessionManager;
  turnTracer: ReturnType<typeof getAgentTracer>;
  currentTurnId?: string | null;
  currentTurnSeq?: number | null;
  currentExecutionTurnIds: Set<string>;
  currentTurnPatchSeq?: number | null;
  currentAssistantMessageOrdinal?: number | null;
  currentStreamMessageId?: string | null;
  currentLlmRound?: number | null;
  currentAccessMode: PromptAccessMode | null;
  ownerEpoch: number;
  lastActiveAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  onIdle?: ((handle: SessionHandle) => void) | null;
  pendingUserMessages: PendingUserMessage[];
  userMessageIdentityError: Error | null;
  pendingExecutionAuths: Array<{ turnId?: string | null; actorUserId: string | null; executionToken: string | null; executionScopes?: Permission[] | null }>;
  steerDrainPromise: Promise<void> | null;
  pendingSteerCompletions: Array<{
    ack: () => Promise<void>;
    reject: (reason: string) => Promise<void>;
    done: () => void;
  }>;
  activeDirectShellCommand: {
    turnId: string;
    abortController: AbortController;
  } | null;
  currentUserMessageId: string | null;
  currentUserMessageMeta: Record<string, unknown> | null;
  toolExecutionStartedAtById: Map<string, string>;
  activeAssistantContext: AssistantMessageContext | null;
  persistenceChain: Promise<void>;
  operationChain: Promise<void>;
  streamState: {
    assistantState: AssistantStreamState;
    content: ContentBlock[];
    preferredDisplayMode: "full" | "compact" | "minimal";
    /** Snapshot of the content sent in the last stream_update, used for delta computation. */
    lastSent?: ContentBlock[];
    dirty?: boolean;
    patchSeq?: number;
    pendingFlush?: boolean;
    pendingBoundary?: boolean;
    flushPromise?: Promise<void> | null;
    flushTimer?: ReturnType<typeof setTimeout> | null;
    /** Delay used by the currently armed flushTimer; used to escalate text over tool. */
    flushDelayMs?: number | null;
    assistantContext?: AssistantMessageContext | null;
  };
  interruptedSnapshotTurnIds: Set<string>;
  sessionFileSignature: SessionFileSignature | null;
  /** Workspace the prompt was built from: `cloud`, or the Local Runtime's reachability and mounts. */
  promptWorkspace: string;
};

type SessionFileSignature = {
  size: number;
  mtimeMs: number;
};

export function getSessionKey(spaceId: string, sessionId: string) {
  return `${spaceId}:${sessionId}`;
}

export function setSessionManagerFilePath(sessionManager: SessionManager, sessionFile: string) {
  ((sessionManager as unknown) as { sessionFile?: string }).sessionFile = sessionFile;
}

export async function getSessionFileSignature(path: string): Promise<SessionFileSignature | null> {
  try {
    const info = await stat(path);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

export function sameSessionFileSignature(a: SessionFileSignature | null, b: SessionFileSignature | null) {
  return a?.size === b?.size && a?.mtimeMs === b?.mtimeMs;
}

export async function refreshSessionHandleFileSignature(handle: SessionHandle) {
  handle.sessionFileSignature = await getSessionFileSignature(getAgentSessionFilePath(handle.spaceId, handle.sessionId));
}
