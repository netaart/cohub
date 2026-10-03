import { randomUUID } from "node:crypto";
import { access, stat } from "node:fs/promises";
import { trace } from "@opentelemetry/api";
import { SessionManager } from "./runtime/local-session-manager.js";
import { and, asc, eq, sql } from "drizzle-orm";
import { sessionMessages, sessionTurns } from "@cohub/db";
import type { ContentBlock } from "@cohub/protocol/core";
import { normalizeContentBlocksSafe } from "@cohub/core/content/normalize";
import { getSpace } from "./api.js";
import { interruptSessionTurn, persistAssistantMessage, persistUserMessage } from "./persistence.js";
import { sendOutput } from "./redis.js";
import { logger } from "./logger.js";
import { getAgentTracer } from "@cohub/infra/tracing/agent";
import type { CohubModelRegistry } from "./runtime/model-registry.js";
import type { ImageToTextConfig } from "@cohub/infra/config-runtime/model-tasks";
import {
  ensureAgentSpaceSessionPath,
  getAgentSessionFilePath,
  getAgentSpaceSessionsPath,
  getAgentWorkspacePath,
} from "./runtime/paths.js";
import { clearCurrentSessionExecutionAuth, setCurrentSessionExecutionAuth } from "./runtime/session-execution-auth.js";
import { getCurrentToolExecutionContext } from "./tool-context.js";
import { listEnabledSpaceMods } from "@cohub/core/space-mods";
import { db } from "./db.js";
import { createCohubAgentSession, type CohubAgentSession } from "./runtime/session-runtime.js";
import type { AgentTurnAbortEvent } from "./abort.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextProjectionOptions } from "@cohub/protocol";
import { loadRequestedThinkingLevel, loadRuntimeContext } from "./runtime/context-store.js";
import { appendTerminalGenerationMessages } from "./generation-session-sync.js";
import { syncCloudContext } from "./runtime/cloud-context.js";
import { hydrateSessionImages } from "./runtime/context-images.js";
import { readPublicAssetImageUrl } from "./public-asset-storage.js";
import type { createSandboxCodingTools } from "./sandbox/tools.js";
import type { Permission } from "@cohub/core/permissions";
import type { PromptAccessMode } from "@cohub/core/sessions";
import {
  applyAssistantMessageEvent,
  applyToolExecutionEnd,
  applyToolExecutionStart,
  applyToolExecutionUpdate,
  createAssistantStreamState,
  mergeFinalAssistantContentWithStreamOrder,
  projectAssistantStreamState,
  type AssistantStreamState,
} from "./stream/assistant-stream-state.js";
import {
  resolveStreamFlushDelayMs,
  shouldReplaceStreamFlushTimer,
  type StreamFlushUrgency,
} from "./stream/flush-policy.js";


export type PendingUserMessage = {
  userMessageId: string;
  turnId?: string | null;
  turnSeq?: number | null;
  content: ContentBlock[];
  meta?: Record<string, unknown> | null;
};

async function syncGenerationMessagesToSessionFile(sessionId: string, sessionManager: SessionManager, beforeTurnSequence?: number | null) {
  const rows = await db.select({ message: sessionMessages }).from(sessionMessages)
    .innerJoin(sessionTurns, eq(sessionMessages.turnId, sessionTurns.id))
    .where(and(
      eq(sessionMessages.sessionId, sessionId), eq(sessionTurns.sessionId, sessionId), eq(sessionTurns.executionKind, "direct_generation"),
      ...(typeof beforeTurnSequence === "number" ? [sql`${sessionTurns.sequence} < ${beforeTurnSequence}`] : []),
      sql`${sessionMessages.meta}->>'messageKind' in ('generation_request', 'generation_result')`,
    )).orderBy(asc(sessionMessages.sequence));
  if (rows.length === 0) return [];
  return appendTerminalGenerationMessages(rows.map((row) => row.message), sessionManager);
}

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
  currentUserMessageContent: ContentBlock[] | null;
  currentUserMessageMeta: Record<string, unknown> | null;
  currentUserMessageStartedAt: string | null;
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
};

type SessionFileSignature = {
  size: number;
  mtimeMs: number;
};

export function getSessionKey(spaceId: string, sessionId: string) {
  return `${spaceId}:${sessionId}`;
}

function setSessionManagerFilePath(sessionManager: SessionManager, sessionFile: string) {
  ((sessionManager as unknown) as { sessionFile?: string }).sessionFile = sessionFile;
}

async function getSessionFileSignature(path: string): Promise<SessionFileSignature | null> {
  try {
    const info = await stat(path);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

function sameSessionFileSignature(a: SessionFileSignature | null, b: SessionFileSignature | null) {
  return a?.size === b?.size && a?.mtimeMs === b?.mtimeMs;
}

export async function refreshSessionHandleFileSignature(handle: SessionHandle) {
  handle.sessionFileSignature = await getSessionFileSignature(getAgentSessionFilePath(handle.spaceId, handle.sessionId));
}

function summarizeToolArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;

  if (toolName === "bash" && typeof record.command === "string") {
    return record.command.trim().slice(0, 120);
  }

  if (typeof record.path === "string") return record.path;
  if (typeof record.pattern === "string" && typeof record.path === "string") {
    return `${record.pattern} in ${record.path}`;
  }
  if (typeof record.query === "string") return record.query;

  const first = Object.entries(record)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 2)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  return first.slice(0, 120);
}

type SessionTraceContext = {
  turnId?: string;
  turnSeq?: number;
  llmRound?: number;
};

function getSessionTraceAttributes(handle: SessionHandle): Record<string, string | number> {
  return {
    ...(handle.currentTurnId ? { "agent.turn_id": handle.currentTurnId } : {}),
    ...(handle.currentTurnSeq != null ? { "agent.turn_seq": handle.currentTurnSeq } : {}),
    ...(handle.currentLlmRound != null ? { "agent.llm_round": handle.currentLlmRound } : {}),
  };
}

function getCurrentSessionTraceContext(handle: SessionHandle): SessionTraceContext {
  return {
    turnId: handle.currentTurnId ?? undefined,
    turnSeq: handle.currentTurnSeq ?? undefined,
    llmRound: handle.currentLlmRound ?? undefined,
  };
}

function addLifecycleEvent(name: string, attributes?: Record<string, string | number | boolean | undefined>) {
  const span = trace.getActiveSpan();
  if (!span) return;
  const cleanAttributes = Object.fromEntries(
    Object.entries(attributes ?? {}).filter(([, value]) => value !== undefined),
  );
  span.addEvent(name, cleanAttributes);
}

async function emitProviderRenderUpdate(handle: SessionHandle) {
  const assistantContext = handle.streamState.assistantContext ?? handle.activeAssistantContext;
  if (!assistantContext) return;
  const sourceMessageId = assistantContext.userMessageId?.trim() || null;
  if (!sourceMessageId) return;

  if (handle.streamState.flushPromise) {
    handle.streamState.pendingFlush = true;
    return;
  }

  // Capture the state reference at flush start. If resetStreamState() replaces
  // handle.streamState while we're in-flight, we detect it and avoid stale writes
  // or stale re-scheduling against the new state.
  const stateAtStart = handle.streamState;

  // The flush body runs the actual work. Note: it must NOT clear flushPromise
  // itself — that is owned by the outer finally block. Otherwise, if flush()
  // returns synchronously (e.g. empty delta early-return), the assignment
  // `stateAtStart.flushPromise = flush()` happens AFTER the inner clear, and
  // pins flushPromise to a resolved-but-truthy Promise forever, silencing all
  // subsequent stream output.
  const flush = async () => {
    if (stateAtStart.dirty) {
      ensureProjectedStreamContent(handle);
    }

    const full = stateAtStart.content;
    const last = stateAtStart.lastSent ?? [];
    const delta = computeDelta(full, last);
    const forceBoundary = stateAtStart.pendingBoundary === true;

    stateAtStart.lastSent = structuredClone(full);
    stateAtStart.pendingFlush = false;
    stateAtStart.pendingBoundary = false;

    if (delta.length === 0 && !forceBoundary) {
      return;
    }
    const startsFreshStream = (assistantContext?.patchSeq ?? stateAtStart.patchSeq ?? 0) === 0;
    const baseSeq = startsFreshStream ? 0 : (assistantContext?.patchSeq ?? handle.currentTurnPatchSeq ?? stateAtStart.patchSeq ?? 0);
    const seq = (assistantContext?.patchSeq ?? handle.currentTurnPatchSeq ?? 0) + 1;
    if (assistantContext) assistantContext.patchSeq = seq;
    handle.currentTurnPatchSeq = seq;
    stateAtStart.patchSeq = seq;

    const span = trace.getActiveSpan();

    try {
      await sendOutput({
        type: "stream_update",
        spaceId: handle.spaceId,
        sessionId: handle.sessionId,
        turnId: assistantContext.turnId,
        seq,
        baseSeq,
        content: delta,
        snapshotContent: full,
        messageId: assistantContext.streamMessageId,
        messageOrdinal: assistantContext.assistantOrdinal,
        sourceMessageId,
        anchorUserMessageId: sourceMessageId,
        timestamp: Date.now(),
      });
    } catch (error) {
      if (error instanceof Error) span?.recordException(error);
      throw error;
    }
  };

  stateAtStart.flushPromise = flush();
  try {
    await stateAtStart.flushPromise;
  } finally {
    // Always clear flushPromise after await, regardless of whether flush
    // completed synchronously, threw, or actually awaited a Promise. This is
    // the single source of truth for the flush lock.
    stateAtStart.flushPromise = null;
  }

  // Only re-schedule against the same state. If reset replaced it, the
  // pending data should already have been drained by drainStreamStateBeforeReset().
  if (handle.streamState === stateAtStart && stateAtStart.pendingFlush) {
    scheduleProviderRenderUpdate(handle, "flush_pending", { urgency: "immediate" });
  }
}

/**
 * Synchronously drain any pending stream content by awaiting in-flight flush
 * and triggering a final immediate flush if more data became available.
 * Call this BEFORE resetStreamState() to ensure no pending delta is lost.
 */
export async function drainStreamStateBeforeReset(handle: SessionHandle) {
  const inflight = handle.streamState.flushPromise;
  if (inflight) {
    try {
      await inflight;
    } catch {
      // sendOutput errors are already logged; we just need the wait.
    }
  }
  // After waiting, if there's still pending content (e.g. arrived during the
  // in-flight flush, or queued by debounce timer), flush it immediately.
  if (handle.streamState.pendingFlush || handle.streamState.dirty) {
    if (handle.streamState.flushTimer) {
      clearTimeout(handle.streamState.flushTimer);
      handle.streamState.flushTimer = null;
      handle.streamState.flushDelayMs = null;
    }
    try {
      await emitProviderRenderUpdate(handle);
    } catch (error) {
      logger.error(
        `[Agent] Final drain flush failed for session ${handle.sessionId}:`,
        error,
      );
    }
    // emitProviderRenderUpdate may have set a new flushPromise; await it too.
    if (handle.streamState.flushPromise) {
      try {
        await handle.streamState.flushPromise;
      } catch {
        // already logged
      }
    }
  }
}

function scheduleProviderRenderUpdate(
  handle: SessionHandle,
  reason: string,
  options?: { urgency?: StreamFlushUrgency },
) {
  handle.streamState.pendingFlush = true;

  // Inflight send already owns the next pass via pendingFlush.
  if (handle.streamState.flushPromise) return;

  const urgency = options?.urgency ?? "text";
  const delayMs = resolveStreamFlushDelayMs(urgency);

  // Keep a coarser timer unless a more urgent request arrives (text over tool).
  if (
    handle.streamState.flushTimer
    && !shouldReplaceStreamFlushTimer(handle.streamState.flushDelayMs, delayMs)
  ) {
    return;
  }

  if (handle.streamState.flushTimer) {
    clearTimeout(handle.streamState.flushTimer);
    handle.streamState.flushTimer = null;
  }

  handle.streamState.flushDelayMs = delayMs;
  handle.streamState.flushTimer = setTimeout(() => {
    handle.streamState.flushTimer = null;
    handle.streamState.flushDelayMs = null;
    void emitProviderRenderUpdate(handle).catch((error) => {
      logger.error(`[Agent] Provider render update failed (${reason}) for session ${handle.sessionId}:`, error);
    });
  }, delayMs);
}

function flushProviderRenderUpdate(handle: SessionHandle, reason: string) {
  scheduleProviderRenderUpdate(handle, reason, { urgency: "immediate" });
}

function schedulePersistence(handle: SessionHandle, label: string, task: () => Promise<void>) {
  void enqueuePersistence(handle, label, task).catch((error) => {
    logger.error(`[Agent] Persistence scheduling failed (${label}) for session ${handle.sessionId}:`, error);
  });
}

function buildStreamMessageId(handle: SessionHandle, ordinal: number) {
  const turnId = handle.currentTurnId?.trim();
  if (turnId) return `turn:${turnId}:assistant:${ordinal}`;
  return `session:${handle.sessionId}:assistant:${ordinal}:${handle.currentUserMessageId ?? "unknown"}`;
}

function ensureProjectedStreamContent(handle: SessionHandle) {
  if (!handle.streamState.dirty) return;
  handle.streamState.content = projectAssistantStreamState(handle.streamState.assistantState);
  handle.streamState.dirty = false;
}

export function resetStreamState(handle: SessionHandle) {
  // Cancel any pending debounce timer to prevent stale flush after reset.
  if (handle.streamState.flushTimer) {
    clearTimeout(handle.streamState.flushTimer);
  }
  handle.streamState = {
    assistantState: createAssistantStreamState(),
    content: [],
    preferredDisplayMode: handle.streamState.preferredDisplayMode,
    lastSent: [],
    patchSeq: 0,
    pendingFlush: false,
    pendingBoundary: false,
    dirty: false,
    flushPromise: null,
    flushTimer: null,
    flushDelayMs: null,
    assistantContext: null,
  };
}

function resolveAssistantMessageStartedAt(fallback: string) {
  return getCurrentToolExecutionContext()?.assistantMessageTiming?.startedAt ?? fallback;
}

function clearAssistantMessageTiming() {
  const timing = getCurrentToolExecutionContext()?.assistantMessageTiming;
  if (timing) timing.startedAt = null;
}

function resolvePersistedAssistantContent(handle: SessionHandle, message: Record<string, unknown>) {
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : null;
  const rawContent = Array.isArray(message.content) ? message.content : [];
  if (stopReason === "error" || stopReason === "aborted") {
    return rawContent;
  }
  if (handle.streamState.content.length > 0) {
    return mergeFinalAssistantContentWithStreamOrder(rawContent, handle.streamState.content);
  }
  return rawContent;
}

function interruptedToolResultContent(value: unknown): string | ContentBlock[] {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value)) return value as ContentBlock[];
  return "Tool execution was interrupted.";
}

function closeInterruptedToolCalls(content: ContentBlock[], input: { reason: AgentTurnAbortEvent["reason"]; timestamp: string }) {
  const resultIds = new Set(content.filter((block) => block.type === "tool_result").map((block) => block.tool_use_id));
  const closed: ContentBlock[] = [];

  for (const block of content) {
    if (block.type !== "tool_use") {
      closed.push(block);
      continue;
    }

    const meta = block._meta ?? {};
    const nextMeta = {
      ...meta,
      partial: true,
      toolStatus: resultIds.has(block.id) ? meta.toolStatus : "failed",
    };
    closed.push({ ...block, _meta: nextMeta });

    if (resultIds.has(block.id)) continue;
    closed.push({
      type: "tool_result",
      tool_use_id: block.id,
      content: interruptedToolResultContent(meta.partialResult),
      is_error: true,
      _meta: {
        synthetic: true,
        partial: true,
        toolStatus: "failed",
        abortReason: input.reason,
        interruptedAt: input.timestamp,
      },
    });
  }

  return closed;
}

export async function persistInterruptedAssistantSnapshot(
  handle: SessionHandle,
  input: {
    abortEvent: AgentTurnAbortEvent | null;
    actorUserId?: string | null;
    fallbackTurnId?: string | null;
    fallbackUserMessageId?: string | null;
  },
) {
  const turnId = handle.activeAssistantContext?.turnId ?? handle.currentTurnId ?? input.fallbackTurnId ?? null;
  const userMessageId = handle.activeAssistantContext?.userMessageId ?? handle.currentUserMessageId ?? input.fallbackUserMessageId ?? null;
  if (!turnId || !userMessageId || handle.interruptedSnapshotTurnIds.has(turnId)) return false;

  await drainStreamStateBeforeReset(handle);
  ensureProjectedStreamContent(handle);
  if (handle.streamState.content.length === 0) return false;

  handle.interruptedSnapshotTurnIds.add(turnId);
  const now = new Date().toISOString();
  const reason = input.abortEvent?.reason ?? "abort";
  const content = closeInterruptedToolCalls(structuredClone(handle.streamState.content), { reason, timestamp: now });
  const model = handle.session.agent.state.model;
  const entryId = randomUUID().slice(0, 8);
  const assistantMessage = {
    role: "assistant",
    content,
    timestamp: Date.now(),
    stopReason: "aborted",
    provider: model.provider,
    model: model.id,
    sessionEntryId: entryId,
    meta: {
      turnId,
      partial: true,
      abortReason: reason,
      actorUserId: input.actorUserId ?? input.abortEvent?.actorUserId ?? null,
      continuedByTurnId: input.abortEvent?.continuedByTurnId ?? null,
      streamSnapshotPersistedAt: now,
      agentSessionEntryId: entryId,
    },
  } as unknown as AgentMessage & { sessionEntryId?: string; meta?: Record<string, unknown> };

  await enqueuePersistence(handle, `interrupted-assistant:${turnId}`, async () => {
    await persistAssistantMessage({
      spaceId: handle.spaceId,
      spaceSessionId: handle.sessionId,
      userMessageId,
      event: { type: "turn_end", message: assistantMessage, toolResults: [] },
      userId: ((handle.activeAssistantContext?.userMeta as Record<string, unknown> | null | undefined)?.userId as string | null | undefined) ?? null,
      turnId,
      startedAt: handle.activeAssistantContext?.startedAt ?? null,
      completedAt: now,
      messageOrdinal: handle.activeAssistantContext?.assistantOrdinal ?? null,
      thinkingLevel: handle.session.agent.state.thinkingLevel,
    });
  });

  handle.sessionManager.appendMessage(assistantMessage as never, { id: entryId });
  handle.session.agent.state.messages.push(assistantMessage as never);
  await handle.sessionManager.flush();
  handle.interruptedSnapshotTurnIds.add(turnId);

  resetStreamState(handle);
  if (handle.activeAssistantContext?.turnId === turnId) handle.activeAssistantContext = null;
  clearAssistantMessageTiming();
  removePendingUserMessage(handle, userMessageId);
  return true;
}

function getStreamIndex(block: ContentBlock): number | null {
  const value = block._meta?.streamIndex;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildBlockIdentity(block: ContentBlock, fallbackIndex: number): string {
  if (block.type === "tool_use") return `tool_use:${block.id}`;
  if (block.type === "tool_result") return `tool_result:${block.tool_use_id}`;
  const streamIndex = getStreamIndex(block);
  return `${block.type}:${streamIndex ?? fallbackIndex}`;
}

function shallowRecordEqual(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined) {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(b, key)) return false;
    const av = a[key];
    const bv = b[key];
    if (av === bv) continue;
    if (Array.isArray(av) || Array.isArray(bv)) return false;
    if (av && bv && typeof av === "object" && typeof bv === "object") return false;
    return false;
  }
  return true;
}

function contentEqual(a: unknown, b: unknown) {
  if (a === b) return true;
  if (typeof a === "string" || typeof b === "string") return a === b;
  // Tool results are usually strings. Keep rare structured results correct via a fallback.
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Compute the minimal delta between the current full content and the last-sent snapshot. */
function computeDelta(full: ContentBlock[], last: ContentBlock[]): ContentBlock[] {
  const delta: ContentBlock[] = [];
  const lastByIdentity = new Map(last.map((block, index) => [buildBlockIdentity(block, index), block]));

  for (let index = 0; index < full.length; index += 1) {
    const block = full[index];
    if (!block) continue;
    const prev = lastByIdentity.get(buildBlockIdentity(block, index));

    if (block.type === "text") {
      const prevText = prev?.type === "text" ? prev.text : null;
      if (prevText == null) {
        delta.push(block);
      } else if (block.text.length > prevText.length) {
        const suffix = block.text.slice(prevText.length);
        if (suffix) {
          delta.push({
            type: "text",
            text: suffix,
            ...(block._meta ? { _meta: block._meta } : {}),
          });
        }
      }
    } else if (block.type === "thinking") {
      const prevThinking = prev?.type === "thinking" ? prev.thinking : null;
      if (prevThinking == null) {
        delta.push(block);
      } else if (block.thinking.length > prevThinking.length) {
        const suffix = block.thinking.slice(prevThinking.length);
        if (suffix) {
          delta.push({
            type: "thinking",
            thinking: suffix,
            ...(block.signature ? { signature: block.signature } : {}),
            ...(block._meta ? { _meta: block._meta } : {}),
          });
        }
      }
    } else if (block.type === "tool_use") {
      if (
        prev?.type !== "tool_use" ||
        !shallowRecordEqual(prev._meta, block._meta) ||
        !contentEqual(prev.input, block.input) ||
        prev.name !== block.name
      ) {
        delta.push(block);
      }
    } else if (block.type === "tool_result") {
      if (
        prev?.type !== "tool_result" ||
        !contentEqual(prev.content, block.content) ||
        prev.is_error !== block.is_error
      ) {
        delta.push(block);
      }
    } else {
      if (!prev || JSON.stringify(prev) !== JSON.stringify(block)) {
        delta.push(block);
      }
    }
  }

  return delta;
}

function enqueuePersistence(handle: SessionHandle, label: string, task: () => Promise<void>) {
  const next = handle.persistenceChain
    .catch((error) => {
      logger.error(`[Agent] Previous persistence task failed for session ${handle.sessionId}:`, error);
    })
    .then(task)
    .catch((error) => {
      logger.error(`[Agent] Persistence task failed (${label}) for session ${handle.sessionId}:`, error);
      throw error;
    });

  handle.persistenceChain = next;
  return next;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function warnInvalidToolResultBlock(issue: { message: string; block: unknown }) {
  logger.warn(`[Normalize] tool result content: ${issue.message}`, { block: issue.block });
}

type NormalizedToolResultContent = {
  content: string | ContentBlock[];
  isError: boolean;
  errorMessage?: string;
};

function normalizeToolResultBlocks(blocks: unknown[]): NormalizedToolResultContent {
  const issues: Array<{ message: string; block: unknown }> = [];
  const content = normalizeContentBlocksSafe(blocks, {
    onInvalid: (issue) => {
      issues.push(issue);
      warnInvalidToolResultBlock(issue);
    },
  });
  if (issues.length === 0) return { content, isError: false };
  const message = `Tool result content error: ${issues.map((issue) => issue.message).join("; ")}`;
  return { content: message, isError: true, errorMessage: message };
}

function extractToolResultContent(result: unknown): NormalizedToolResultContent {
  if (typeof result === "string") return { content: result, isError: false };
  if (!result || typeof result !== "object") return { content: "", isError: false };
  const record = result as Record<string, unknown>;
  const details = record.details && typeof record.details === "object" && !Array.isArray(record.details)
    ? record.details as Record<string, unknown>
    : null;
  if (typeof details?.rawOutput === "string") return { content: details.rawOutput, isError: false };
  if (typeof record.content === "string") return { content: record.content, isError: false };
  if (Array.isArray(record.content)) return normalizeToolResultBlocks(record.content);
  if (typeof record.text === "string") return { content: record.text, isError: false };
  return { content: safeStringify(result), isError: false };
}

function extractTextFromToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const record = result as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  // Handle structured content array: [{type: "text", text: "..."}, ...]
  if (Array.isArray(record.content)) {
    const texts: string[] = [];
    for (const item of record.content) {
      if (item && typeof item === "object" && "type" in item) {
        const block = item as Record<string, unknown>;
        if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
      }
    }
    if (texts.length > 0) return texts.join("");
  }
  return "";
}

export function subscribeSessionEvents(handle: SessionHandle) {
  handle.session.subscribe(async (event) => {
    if (event.type === "message_start") {
      const traceCtx = getCurrentSessionTraceContext(handle);
      if (event.message.role === "assistant") {
        handle.currentLlmRound = traceCtx.llmRound ?? handle.currentLlmRound ?? 1;
      }
      const message = event.message as unknown as Record<string, unknown>;
      if (message.role === "assistant") {
        const ordinal = (handle.currentAssistantMessageOrdinal ?? -1) + 1;
        const streamStartedAt = new Date().toISOString();
        handle.currentAssistantMessageOrdinal = ordinal;
        handle.currentStreamMessageId = buildStreamMessageId(handle, ordinal);
        handle.activeAssistantContext = {
          turnId: handle.currentTurnId ?? null,
          turnSeq: handle.currentTurnSeq ?? null,
          userMessageId: handle.currentUserMessageId ?? null,
          userMeta: handle.currentUserMessageMeta ?? null,
          assistantOrdinal: ordinal,
          streamMessageId: handle.currentStreamMessageId,
          patchSeq: 0,
          streamStartedAt,
          startedAt: resolveAssistantMessageStartedAt(streamStartedAt),
        };
      }
      logger.debug(`[Session] message:start role=${message.role} sessionId=${handle.sessionId}`);
      addLifecycleEvent("session.message_start", {
        "message.role": typeof message.role === "string" ? message.role : undefined,
      });
      if (message.role === "user") {
        const previousTurnId = handle.currentTurnId;
        const pending = handle.pendingUserMessages.shift();
        if (pending) {
          const nextTurnId = pending.turnId ?? (typeof pending.meta?.turnId === "string" ? pending.meta.turnId : null);
          const sameExecutionBatch = previousTurnId && nextTurnId && handle.currentExecutionTurnIds.has(previousTurnId) && handle.currentExecutionTurnIds.has(nextTurnId);
          if (previousTurnId && nextTurnId && previousTurnId !== nextTurnId && !sameExecutionBatch) {
            void interruptSessionTurn({
              spaceId: handle.spaceId,
              sessionId: handle.sessionId,
              turnId: previousTurnId,
              continuedByTurnId: nextTurnId,
            }).catch((error) => logger.warn("[SessionTurn] failed to interrupt previous turn", error));
          }
          handle.currentTurnId = nextTurnId;
          handle.currentTurnSeq = pending.turnSeq ?? handle.currentTurnSeq ?? null;
          handle.currentTurnPatchSeq = 0;
          handle.currentAssistantMessageOrdinal = null;
          handle.currentStreamMessageId = null;
          handle.currentUserMessageId = pending.userMessageId;
          handle.currentUserMessageContent = pending.content;
          handle.currentUserMessageMeta = pending.meta ?? null;
          handle.currentUserMessageStartedAt = new Date().toISOString();
        }
        const nextExecutionAuth = handle.pendingExecutionAuths.shift();
        if (nextExecutionAuth) {
          setCurrentSessionExecutionAuth({
            sessionId: handle.sessionId,
            turnId: nextExecutionAuth.turnId ?? handle.currentTurnId,
            actorUserId: nextExecutionAuth.actorUserId,
            executionToken: nextExecutionAuth.executionToken,
            executionScopes: nextExecutionAuth.executionScopes ?? [],
          });
        }
      }
      if (message.role === "assistant") {
        await drainStreamStateBeforeReset(handle);
        resetStreamState(handle);
        handle.streamState.assistantContext = handle.activeAssistantContext;
        handle.streamState.pendingBoundary = true;
        flushProviderRenderUpdate(handle, "assistant_message_start");
      }
    }

    if (event.type === "agent_start") {
      logger.debug(`[Session] agent:start sessionId=${handle.sessionId}`);
      addLifecycleEvent("session.agent_start");
    }

    if (event.type === "message_update") {
      handle.streamState.assistantState = applyAssistantMessageEvent(
        handle.streamState.assistantState,
        event.assistantMessageEvent as Parameters<typeof applyAssistantMessageEvent>[1],
      );
      handle.streamState.dirty = true;
      scheduleProviderRenderUpdate(handle, "message_update", { urgency: "text" });
    }

    if (event.type === "message_end") {
      const message = event.message as unknown as Record<string, unknown>;
      addLifecycleEvent("session.message_end", {
        "message.role": typeof message.role === "string" ? message.role : undefined,
      });
      if (message.role === "user" && handle.currentUserMessageId && handle.currentUserMessageContent) {
        const userMessageId = handle.currentUserMessageId;
        const content = handle.currentUserMessageContent;
        const meta = handle.currentUserMessageMeta;
        const startedAt = handle.currentUserMessageStartedAt;
        const agentSessionEntryId = typeof message.sessionEntryId === "string"
          ? message.sessionEntryId
          : null;
        handle.currentUserMessageContent = null;
        handle.currentUserMessageStartedAt = null;

        schedulePersistence(handle, `user:${userMessageId}`, async () => {
          const span = handle.turnTracer.startSpan("agent.persistence.user_message", {
            attributes: {
              "cohub.space_id": handle.spaceId,
              "cohub.session_id": handle.sessionId,
              "agent.input_message_id": userMessageId,
              ...(handle.currentUserMessageId ? { "agent.anchor_user_message_id": handle.currentUserMessageId } : {}),
              ...getSessionTraceAttributes(handle),
            },
          });
          try {
            const turnId = handle.currentTurnId;
            if (!turnId) throw new Error("User message turn id is required");
            await persistUserMessage({
              spaceId: handle.spaceId,
              sessionId: handle.sessionId,
              userMessageId,
              turnId,
              agentSessionEntryId,
              content,
              meta,
              startedAt,
            });
          } catch (error) {
            if (error instanceof Error) span.recordException(error);
            throw error;
          } finally {
            span.end();
          }
        });
      }
      flushProviderRenderUpdate(handle, "message_end");
    }

    if (event.type === "tool_execution_start") {
      logger.debug(`[Session] tool:start tool=${event.toolName} toolCallId=${event.toolCallId.slice(0, 8)}`);
      addLifecycleEvent("session.tool_execution_start", {
        "tool.name": event.toolName,
        "agent.tool_call_id": event.toolCallId,
      });
      handle.currentLlmRound = handle.currentLlmRound ?? 1;
      const toolStartedAt = new Date().toISOString();
      handle.toolExecutionStartedAtById.set(event.toolCallId, toolStartedAt);
      handle.streamState.assistantState = applyToolExecutionStart(handle.streamState.assistantState, {
        toolCallId: event.toolCallId,
        summary: summarizeToolArgs(event.toolName, event.args),
        startedAt: toolStartedAt,
      });
      handle.streamState.dirty = true;
      flushProviderRenderUpdate(handle, "tool_execution_start");
    }

    if (event.type === "tool_execution_update") {
      const resultContent = event.partialResult ? extractTextFromToolResult(event.partialResult) : "";
      if (resultContent) {
        handle.streamState.assistantState = applyToolExecutionUpdate(handle.streamState.assistantState, {
          toolCallId: event.toolCallId,
          content: resultContent,
        });
        handle.streamState.dirty = true;
        scheduleProviderRenderUpdate(handle, "tool_execution_update", { urgency: "tool" });
      }
    }

    if (event.type === "tool_execution_end") {
      logger.debug(`[Session] tool:end tool=${event.toolName} toolCallId=${event.toolCallId.slice(0, 8)} error=${event.isError}`);
      addLifecycleEvent("session.tool_execution_end", {
        "tool.name": event.toolName,
        "agent.tool_call_id": event.toolCallId,
        "tool.is_error": event.isError,
      });
      const normalizedResult = event.result != null ? extractToolResultContent(event.result) : { content: "", isError: false };
      const fallbackContent = event.result == null ? "" : safeStringify(event.result);
      const completedAt = new Date().toISOString();
      const startedAt = handle.toolExecutionStartedAtById.get(event.toolCallId) ?? completedAt;
      const durationMs = Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime());
      handle.streamState.assistantState = applyToolExecutionEnd(handle.streamState.assistantState, {
        toolCallId: event.toolCallId,
        content: normalizedResult.content === "" ? fallbackContent : normalizedResult.content,
        isError: event.isError || normalizedResult.isError,
        startedAt,
        completedAt,
        durationMs,
      });
      handle.toolExecutionStartedAtById.delete(event.toolCallId);
      handle.streamState.dirty = true;
      flushProviderRenderUpdate(handle, "tool_execution_end");
    }

    if (event.type === "turn_end" && (handle.activeAssistantContext?.userMessageId || handle.currentUserMessageId)) {
      const toolCount = (event as unknown as { toolResults?: unknown[] }).toolResults?.length ?? 0;
      logger.debug(`[Session] turn:end toolResults=${toolCount} sessionId=${handle.sessionId}`);
      addLifecycleEvent("session.turn_end", {
        "agent.tool_count": toolCount,
      });
      const completedAt = new Date().toISOString();
      const assistantContext = handle.activeAssistantContext ?? handle.streamState.assistantContext ?? null;
      if (!assistantContext?.userMessageId) return;
      const currentUserMessageId = assistantContext.userMessageId;
      const currentModel = handle.session.agent.state.model;
      const rawMessage = event.message as unknown as Record<string, unknown>;
      const rawMeta = rawMessage.meta && typeof rawMessage.meta === "object" && !Array.isArray(rawMessage.meta)
        ? rawMessage.meta as Record<string, unknown>
        : {};
      const rawTurnId = typeof rawMeta.turnId === "string" ? rawMeta.turnId : null;
      if (rawTurnId && assistantContext.turnId && rawTurnId !== assistantContext.turnId) {
        logger.error("[Session] assistant turn identity mismatch; refusing to persist", {
          sessionId: handle.sessionId,
          eventTurnId: rawTurnId,
          contextTurnId: assistantContext.turnId,
          userMessageId: currentUserMessageId,
        });
        await drainStreamStateBeforeReset(handle);
        resetStreamState(handle);
        if (handle.activeAssistantContext === assistantContext) handle.activeAssistantContext = null;
        clearAssistantMessageTiming();
        return;
      }

      if (handle.session.shouldDeferErrorPersistence(rawMessage)) {
        await drainStreamStateBeforeReset(handle);
        resetStreamState(handle);
        if (handle.activeAssistantContext === assistantContext) handle.activeAssistantContext = null;
        clearAssistantMessageTiming();
        removePendingUserMessage(handle, currentUserMessageId);
        return;
      }

      ensureProjectedStreamContent(handle);
      const enrichedMessage = {
        ...rawMessage,
        content: resolvePersistedAssistantContent(handle, rawMessage),
        provider: currentModel.provider,
        model: currentModel.id,
      };
      const enrichedEvent = { ...event, message: enrichedMessage };

      schedulePersistence(handle, `assistant:${currentUserMessageId}`, async () => {
        const span = handle.turnTracer.startSpan("agent.persistence.assistant_message", {
          attributes: {
            "cohub.space_id": handle.spaceId,
            "cohub.session_id": handle.sessionId,
            "agent.input_message_id": currentUserMessageId,
            "agent.tool_count": toolCount,
            ...getSessionTraceAttributes(handle),
          },
        });
        try {
          await persistAssistantMessage({
            spaceId: handle.spaceId,
            spaceSessionId: handle.sessionId,
            userMessageId: currentUserMessageId,
            event: enrichedEvent as Record<string, unknown>,
            userId: ((assistantContext.userMeta as Record<string, unknown> | null | undefined)?.userId as string | null | undefined) ?? null,
            turnId: assistantContext.turnId,
            startedAt: assistantContext.startedAt,
            completedAt,
            messageOrdinal: assistantContext.assistantOrdinal,
            thinkingLevel: handle.session.agent.state.thinkingLevel,
          });
        } catch (error) {
          if (error instanceof Error) span.recordException(error);
          throw error;
        } finally {
          span.end();
        }
      });

      await drainStreamStateBeforeReset(handle);
      resetStreamState(handle);
      if (handle.activeAssistantContext === assistantContext) handle.activeAssistantContext = null;
      clearAssistantMessageTiming();
      removePendingUserMessage(handle, currentUserMessageId);
    }

    if (event.type === "agent_end") {
      logger.debug(`[Session] agent:end sessionId=${handle.sessionId}`);
      addLifecycleEvent("session.agent_end");
      if (handle.session.isRetrying) {
        return;
      }
      handle.currentLlmRound = null;
      handle.currentTurnId = null;
      handle.currentTurnSeq = null;
      handle.currentExecutionTurnIds.clear();
      handle.currentTurnPatchSeq = null;
      handle.currentAssistantMessageOrdinal = null;
      handle.currentStreamMessageId = null;
      handle.currentUserMessageId = null;
      handle.currentUserMessageMeta = null;
      handle.activeAssistantContext = null;
      clearCurrentSessionExecutionAuth(handle.sessionId);
      handle.onIdle?.(handle);
    }
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function loadOrCreateSessionHandle(input: {
  spaceId: string;
  sessionId: string;
  userId?: string | null;
  modelRegistry: CohubModelRegistry;
  imageToTextConfig?: ImageToTextConfig | null;
  tools: ReturnType<typeof createSandboxCodingTools>;
  model?: { provider: string; id: string };
  beforeTurnSequence?: number | null;
  sessionHandles: Map<string, SessionHandle>;
}) {
  const sessionKey = getSessionKey(input.spaceId, input.sessionId);
  await ensureAgentSpaceSessionPath(input.spaceId);

  const existingSessionFile = getAgentSessionFilePath(input.spaceId, input.sessionId);
  const spaceWorkspaceDir = getAgentWorkspacePath(input.spaceId);
  const spaceSessionsDir = getAgentSpaceSessionsPath(input.spaceId);
  const fileSignature = await getSessionFileSignature(existingSessionFile);
  const cachedHandle = input.sessionHandles.get(sessionKey);
  const projectionOptions: ContextProjectionOptions = {
    resolveApi: ({ provider, model }) => provider && model ? input.modelRegistry.find(provider, model)?.api ?? null : null,
  };
  const durableHead = await loadRuntimeContext({ spaceId: input.spaceId, sessionId: input.sessionId, beforeSequence: input.beforeTurnSequence ?? undefined, headOnly: true });
  const cachedMarker = cachedHandle?.sessionManager.getCustomEntries("cohub.context").at(-1)?.data as { revision?: string } | undefined;
  const spaceInfo = await getSpace({ spaceId: input.spaceId }).catch((error: unknown) => {
    logger.warn(`[Agent] Failed to load space info for ${input.spaceId}; falling back to platform config`, error);
    return null;
  });
  const spaceOwnerUserId = spaceInfo?.space?.userUuid?.trim() || null;
  const durableContext = cachedMarker?.revision === durableHead.revision && fileSignature
    && sameSessionFileSignature(cachedHandle?.sessionFileSignature ?? null, fileSignature)
    ? durableHead
    : await loadRuntimeContext({ spaceId: input.spaceId, sessionId: input.sessionId, beforeSequence: input.beforeTurnSequence ?? undefined });
  const imageOptions = { userId: input.userId?.trim() || spaceOwnerUserId };

  const existing = input.sessionHandles.get(sessionKey);
  if (existing) {
    if (sameSessionFileSignature(existing.sessionFileSignature, fileSignature)) {
      existing.spaceOwnerUserId = spaceOwnerUserId;
      if (!existing.currentUserMessageId) {
        const contextChanged = syncCloudContext(existing.sessionManager, durableContext, projectionOptions);
        const appended = contextChanged ? await syncGenerationMessagesToSessionFile(input.sessionId, existing.sessionManager, input.beforeTurnSequence) : [];
        try {
          const recovered = await hydrateSessionImages(existing.sessionManager, readPublicAssetImageUrl, imageOptions);
          if (contextChanged || appended.length > 0 || recovered.changed) await existing.session.reload(recovered.messages);
          else existing.session.agent.state.messages = recovered.messages;
        } catch (error) {
          existing.session.dispose();
          await existing.sessionManager.close().catch(() => undefined);
          clearCurrentSessionExecutionAuth(existing.sessionId);
          input.sessionHandles.delete(sessionKey);
          throw error;
        }
      }
      logger.debug(`[Session] reuse sessionId=${input.sessionId} spaceId=${input.spaceId}`);
      return existing;
    }

    logger.debug(`[Session] reload stale sessionId=${input.sessionId} spaceId=${input.spaceId}`);
    existing.session.dispose();
    await existing.sessionManager.close().catch(() => undefined);
    clearCurrentSessionExecutionAuth(existing.sessionId);
    input.sessionHandles.delete(sessionKey);
  }

  const spaceMods = await listEnabledSpaceMods(db, input.spaceId).catch((error: unknown) => {
    logger.warn(`[Agent] Failed to load space mods for ${input.spaceId}; continuing without mods`, error);
    return [];
  });

  let sessionManager: SessionManager;
  if (await pathExists(existingSessionFile)) {
    logger.debug(`[Session] restore sessionId=${input.sessionId} spaceId=${input.spaceId}`);
    sessionManager = await SessionManager.open(existingSessionFile, spaceSessionsDir, { recoverTrailingPartial: true });
  } else {
    const tmpManager = SessionManager.create(spaceWorkspaceDir, spaceSessionsDir);
    tmpManager.newSession({ id: input.sessionId });
    setSessionManagerFilePath(tmpManager, existingSessionFile);
    sessionManager = tmpManager;
  }

  syncCloudContext(sessionManager, durableContext, projectionOptions);
  await syncGenerationMessagesToSessionFile(input.sessionId, sessionManager, input.beforeTurnSequence).catch((error) => {
    logger.warn(`[Session] failed to project generation messages sessionId=${input.sessionId}:`, error);
  });

  const recovered = await hydrateSessionImages(sessionManager, readPublicAssetImageUrl, imageOptions).catch(async (error: unknown) => {
    await sessionManager.close().catch(() => undefined);
    throw error;
  });

  const resolvedModel = input.model
    ? input.modelRegistry.find(input.model.provider, input.model.id)
    : undefined;

  const { session } = await createCohubAgentSession({
    cwd: spaceWorkspaceDir,
    userId: input.userId?.trim() || spaceOwnerUserId,
    spaceOwnerUserId,
    sessionManager,
    modelRegistry: input.modelRegistry,
    imageToTextConfig: input.imageToTextConfig,
    tools: input.tools,
    spaceMods,
    ...(resolvedModel ? { model: resolvedModel } : {}),
    loadSelectedThinkingLevel: () => loadRequestedThinkingLevel({ sessionId: input.sessionId, beforeSequence: input.beforeTurnSequence ?? undefined }).catch((error: unknown) => {
      logger.warn(`[Session] failed to load selected thinking level sessionId=${input.sessionId}; using the lowest supported level`, error);
      return null;
    }),
  });

  await session.reload(recovered.messages);

  const handle: SessionHandle = {
    spaceId: input.spaceId,
    spaceOwnerUserId,
    sessionKey,
    sessionId: input.sessionId,
    session,
    sessionManager,
    turnTracer: getAgentTracer(),
    currentTurnId: null,
    currentTurnSeq: null,
    currentExecutionTurnIds: new Set(),
    currentTurnPatchSeq: null,
    currentAssistantMessageOrdinal: null,
    currentStreamMessageId: null,
    currentLlmRound: null,
    currentAccessMode: null,
    ownerEpoch: 0,
    lastActiveAt: Date.now(),
    idleTimer: null,
    onIdle: null,
    pendingUserMessages: [],
    pendingExecutionAuths: [],
    steerDrainPromise: null,
    pendingSteerCompletions: [],
    activeDirectShellCommand: null,
    currentUserMessageId: null,
    currentUserMessageContent: null,
    currentUserMessageMeta: null,
    currentUserMessageStartedAt: null,
    toolExecutionStartedAtById: new Map(),
    activeAssistantContext: null,
    persistenceChain: Promise.resolve(),
    operationChain: Promise.resolve(),
    streamState: {
      assistantState: createAssistantStreamState(),
      content: [],
      preferredDisplayMode: "compact",
      lastSent: [],
      patchSeq: 0,
      pendingFlush: false,
      pendingBoundary: false,
      dirty: false,
      flushPromise: null,
      flushTimer: null,
      flushDelayMs: null,
      assistantContext: null,
    },
    interruptedSnapshotTurnIds: new Set(),
    sessionFileSignature: fileSignature,
  };

  subscribeSessionEvents(handle);
  input.sessionHandles.set(sessionKey, handle);
  logger.debug(`[Session] ready sessionId=${input.sessionId} spaceId=${input.spaceId}`);
  return handle;
}
