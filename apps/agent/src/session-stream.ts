import { randomUUID } from "node:crypto";
import { trace } from "@opentelemetry/api";
import type { ContentBlock } from "@cohub/protocol/core";
import { persistAssistantMessage } from "./persistence.js";
import { sendOutput } from "./redis.js";
import { logger } from "./logger.js";
import type { CohubModel } from "./runtime/model-registry.js";
import { getCurrentToolExecutionContext } from "./tool-context.js";
import type { AgentTurnAbortEvent } from "@cohub/protocol";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAssistantStreamState,
  mergeFinalAssistantContentWithStreamOrder,
  projectAssistantStreamState,
} from "./stream/assistant-stream-state.js";
import {
  resolveStreamFlushDelayMs,
  shouldReplaceStreamFlushTimer,
  type StreamFlushUrgency,
} from "./stream/flush-policy.js";
import { type SessionHandle, removePendingUserMessage } from "./session-handle.js";
import { computeDelta } from "./stream/content-delta.js";

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

export function scheduleProviderRenderUpdate(
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

export function flushProviderRenderUpdate(handle: SessionHandle, reason: string) {
  scheduleProviderRenderUpdate(handle, reason, { urgency: "immediate" });
}

export function schedulePersistence(handle: SessionHandle, label: string, task: () => Promise<void>) {
  void enqueuePersistence(handle, label, task).catch((error) => {
    logger.error(`[Agent] Persistence scheduling failed (${label}) for session ${handle.sessionId}:`, error);
  });
}

export function buildStreamMessageId(handle: SessionHandle, ordinal: number) {
  const turnId = handle.currentTurnId?.trim();
  if (turnId) return `turn:${turnId}:assistant:${ordinal}`;
  return `session:${handle.sessionId}:assistant:${ordinal}:${handle.currentUserMessageId ?? "unknown"}`;
}

export function ensureProjectedStreamContent(handle: SessionHandle) {
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

export function resolveAssistantMessageStartedAt(fallback: string) {
  return getCurrentToolExecutionContext()?.assistantMessageTiming?.startedAt ?? fallback;
}

export function clearAssistantMessageTiming() {
  const timing = getCurrentToolExecutionContext()?.assistantMessageTiming;
  if (timing) timing.startedAt = null;
}

export function resolvePersistedAssistantContent(handle: SessionHandle, message: Record<string, unknown>) {
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
      contextWindow: handle.session.agent.state.model.contextWindow,
      contextWindowSource: (handle.session.agent.state.model as CohubModel).contextWindowSource,
      modelRegistry: handle.session.modelRegistry,
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
