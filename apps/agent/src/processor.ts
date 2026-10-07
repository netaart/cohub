import { randomUUID } from "node:crypto";
import { UnrecoverableError, type Job } from "bullmq";
import type { ContentBlock } from "@cohub/protocol/core";
import { ModelUnavailableError } from "@cohub/core/sessions";
import type { ImageContent } from "@earendil-works/pi-ai";
import { readPublicAssetImageUrl } from "./public-asset-storage.js";
import { imageOmittedText, normalizeAgentImage, normalizeContentBlocksImages } from "./image-normalizer.js";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { context, trace } from "@opentelemetry/api";
import { getActiveTraceIdentifiers, getOrCreateRequestId, setRequestContextAttributes } from "@cohub/infra/tracing";
import { wrapAgentTurn } from "@cohub/infra/tracing/agent";
import { runInActiveSpan, extractTrace } from "@cohub/infra/tracing/propagator";
import { getAgentTracer } from "@cohub/infra/tracing/agent";
import { getSpace } from "./api.js";
import { abortSessionTurn, failSessionTurn, interruptSessionTurn, persistAssistantMessage, persistUserMessage, publishSessionTurnsUpdated } from "./persistence.js";
import { ensureSandboxConnection } from "./sandbox-pool.js";
import { createSandboxCodingTools } from "./sandbox/tools.js";
import { CohubModelRegistry } from "./runtime/model-registry.js";
import { loadRuntimeModelsConfigs } from "./runtime/models-loader.js";
import { loadImageToTextConfig } from "./runtime/image-to-text-config.js";
import { loadSpaceEnvSnapshot } from "./runtime/env-cache.js";
import { CompactionStateRecoveryError, maybeAutoCompact, OverflowRecoveryError, type CompactionOutcome } from "./runtime/compaction.js";
import { clearCurrentSessionExecutionAuth, setCurrentSessionExecutionAuth } from "./runtime/session-execution-auth.js";
import { resolveSpaceFileVisibility } from "./runtime/cross-space-query-access.js";
import { normalizeGenerationPolicy } from "@cohub/protocol/generation";
import { runWithToolExecutionContext } from "./tool-context.js";
import { loadOrCreateSessionHandle, ensurePendingUserMessage, hasSessionUserMessage, removePendingUserMessage, resetStreamState, drainStreamStateBeforeReset, persistInterruptedAssistantSnapshot, refreshSessionHandleFileSignature, type SessionHandle } from "./session.js";
import { claimNextTurnBatch, buildUserMessagesForBatch, enqueueNextRunnableTurn, resolveBatchAccessMode, type ClaimedTurnBatch } from "./batch.js";
import { acquireSessionLock } from "./session-lock.js";
import { defaultJobRetention } from "@cohub/infra/bullmq";
import { enqueueRuntimeRecovery } from "@cohub/infra/agent-queue";
import { agentTurnQueue, enqueueAgentTurnJob, type AgentTurnJobData } from "./queue.js";
import { getAbortEvent } from "./abort.js";
import { setActiveAbortController, clearActiveAbortController, getActiveAbortEvent, setActiveAbortEvent } from "./active-turns.js";
import { sendOutput } from "./redis.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { getPromptAuthScopes, parsePromptEnv, readRuntimeRecovery, type PromptAccessMode } from "@cohub/core/sessions";
import { createAgentExecutionToken } from "./execution-grants.js";
import { isLocalHarness, resolveHarness } from "@cohub/protocol";
import { executeRemoteHarnessTurn, markRuntimeRecovery, RuntimeExecutionUncertainError } from "./runtime/remote-runtime.js";
import { loadRuntimeContext } from "./runtime/context-store.js";


const sessionHandles = new Map<string, SessionHandle>();
const tools = createSandboxCodingTools();
const agentTracer = getAgentTracer();
type RetryReason = "session_busy";

const retryAttemptsByKey = new Map<string, number>();
const BUSY_RETRY_BASE_DELAY_MS = env.AGENT_BUSY_RETRY_BASE_DELAY_MS;
const BUSY_RETRY_MAX_DELAY_MS = env.AGENT_BUSY_RETRY_MAX_DELAY_MS;

function getRetryKey(data: AgentTurnJobData, reason: RetryReason) {
  return `${reason}:${data.sessionId}`;
}

function nextRetryDelayMs(key: string) {
  const attempt = (retryAttemptsByKey.get(key) ?? 0) + 1;
  retryAttemptsByKey.set(key, attempt);
  return Math.min(BUSY_RETRY_MAX_DELAY_MS, BUSY_RETRY_BASE_DELAY_MS * 2 ** Math.min(attempt - 1, 12));
}

function clearRetryState(data: AgentTurnJobData) {
  retryAttemptsByKey.delete(getRetryKey(data, "session_busy"));
}

async function requeueTurnJob(data: AgentTurnJobData, reason: RetryReason, job?: Job<AgentTurnJobData>, meta?: Record<string, unknown>) {
  const retryKey = getRetryKey(data, reason);
  const delay = nextRetryDelayMs(retryKey);
  await enqueueAgentTurnJob({ ...data, reason: "retry" }, {
    jobId: `agent-session-retry-${reason}-${data.sessionId}-${Math.max(1, Math.ceil(Date.now() / delay))}`,
    delay,
    removeOnComplete: true,
    removeOnFail: defaultJobRetention.removeOnFail,
  });
  return { skipped: reason, retryInMs: delay, jobId: job?.id ?? null, ...meta };
}

type DrainNextQueuedResult = { enqueued: boolean; turnId: string | null };

type SessionSettleMode = "strict" | "best_effort";

async function settleSessionHandle(handle: SessionHandle, mode: SessionSettleMode) {
  const awaitOrWarn = async (label: "persistence" | "close" | "signature", task: () => Promise<void>) => {
    if (mode === "strict") {
      await task();
      return;
    }
    await task().catch((error) => {
      logger.warn(`[Agent] failed to settle session ${handle.sessionId} (${label}):`, error);
    });
  };

  await awaitOrWarn("persistence", async () => {
    await handle.persistenceChain;
  });
  await awaitOrWarn("close", async () => {
    // close() flushes pending writes then releases the append stream fd,
    // so the fd is only held during an active turn — not across idle periods.
    await handle.sessionManager.close();
  });
  await awaitOrWarn("signature", async () => {
    await refreshSessionHandleFileSignature(handle);
  });
}

async function drainNextQueuedTurn(input: { spaceId: string; sessionId: string; reason: string }): Promise<DrainNextQueuedResult> {
  try {
    const turnId = await enqueueNextRunnableTurn({
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      enqueue: enqueueAgentTurnJob,
    });
    if (turnId) {
      logger.info(`[Agent] enqueued next runnable turn sessionId=${input.sessionId} turnId=${turnId} reason=${input.reason}`);
    }
    return { enqueued: Boolean(turnId), turnId: turnId ?? null };
  } catch (error) {
    logger.warn(`[Agent] failed to enqueue next queued turn spaceId=${input.spaceId} sessionId=${input.sessionId} reason=${input.reason}:`, error);
    throw error;
  }
}

function warmupSandboxConnection(spaceId: string) {
  void ensureSandboxConnection(spaceId).catch((error) => {
    logger.warn(`[Agent] sandbox warmup failed spaceId=${spaceId}:`, error);
  });
}

async function getModelRegistryForUser(userId: string | null | undefined) {
  const configs = await loadRuntimeModelsConfigs(userId?.trim() || null);
  const registry = new CohubModelRegistry({ configs });
  if (registry.getError()) {
    logger.warn(`[Agent] Model registry warning for ${userId?.trim() || "__platform__"}:`, registry.getError());
  }
  return registry;
}

function contentBlockToBase64ImageContent(block: ContentBlock): ImageContent | null {
  if (block.type !== "image" || block.source.type !== "base64") return null;
  return {
    type: "image",
    data: block.source.data.replace(/^data:[^;,]+;base64,/, ""),
    mimeType: block.source.media_type || "application/octet-stream",
  };
}

async function fetchUrlImageContent(url: string): Promise<ImageContent | null> {
  const publicAsset = await readPublicAssetImageUrl(url).catch(() => null);
  if (!publicAsset) return null;
  const normalized = await normalizeAgentImage({
    data: publicAsset.data,
    mimeType: publicAsset.mimeType,
    sourceKind: "public_asset",
    originalSource: "url",
    originalUrl: url,
  });
  return normalized ? { type: "image", data: normalized.data, mimeType: normalized.mimeType } : null;
}

async function contentBlockToImageContent(block: ContentBlock): Promise<ImageContent | null> {
  if (block.type !== "image") return null;
  if (block.source.type === "base64") return contentBlockToBase64ImageContent(block);
  return fetchUrlImageContent(block.source.url).catch(() => null);
}

async function contentBlockToAgentContent(block: ContentBlock): Promise<{ type: "text"; text: string } | ImageContent | null> {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "image") {
    const image = await contentBlockToImageContent(block);
    return image ?? { type: "text", text: imageOmittedText("image could not be loaded") };
  }
  return null;
}

async function contentToAgentMessage(content: ContentBlock[], meta: Record<string, unknown> | null): Promise<AgentMessage> {
  const resolved = await Promise.all(content.map(contentBlockToAgentContent));
  const agentContent = resolved.filter((block): block is { type: "text"; text: string } | ImageContent => Boolean(block));
  return {
    role: "user",
    content: agentContent.length > 0 ? agentContent : [{ type: "text", text: "" }],
    timestamp: Date.now(),
    meta: meta ?? null,
  } as unknown as AgentMessage;
}

function getShellCommandBlock(content: ContentBlock[]): Extract<ContentBlock, { type: "shell_command" }> | null {
  if (content.length !== 1) return null;
  const block = content[0];
  return block?.type === "shell_command" ? block : null;
}

function extractToolResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const record = result as Record<string, unknown>;
  const details = record.details && typeof record.details === "object" && !Array.isArray(record.details)
    ? record.details as Record<string, unknown>
    : null;
  if (typeof details?.rawOutput === "string") return details.rawOutput;
  if (Array.isArray(record.content)) {
    return record.content
      .map((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "text"
        ? String((item as Record<string, unknown>).text ?? "")
        : "")
      .join("");
  }
  return typeof record.content === "string" ? record.content : "";
}

function formatShellCommandResultForLlm(input: {
  command: string;
  output: string;
  exitCode?: number | null;
  cancelled?: boolean;
  timedOut?: boolean;
  timeoutSecs?: number | null;
}) {
  let text = `Ran \`${input.command}\``;
  text += input.output ? `\n\`\`\`\n${input.output}\n\`\`\`` : "\n(no output)";
  if (input.timedOut) {
    text += `\n\n(command timed out${input.timeoutSecs ? ` after ${input.timeoutSecs}s` : ""})`;
  } else if (input.cancelled) {
    text += "\n\n(command cancelled)";
  } else if (input.exitCode != null && input.exitCode !== 0) {
    text += `\n\nCommand exited with code ${input.exitCode}`;
  }
  return text;
}

type TurnUserMessage = {
  turnId: string;
  turnSeq: number;
  userMessageId: string;
  content: ContentBlock[];
  meta: Record<string, unknown>;
};

function normalizeTurnUserMeta(input: TurnUserMessage, patch?: Record<string, unknown>) {
  return {
    ...input.meta,
    ...(patch ?? {}),
    userMessageId: input.userMessageId,
    messageId: input.userMessageId,
    turnId: input.turnId,
    anchorUserMessageId: input.userMessageId,
  };
}

function setActiveTurnContext(handle: SessionHandle, input: {
  turnId: string;
  turnSeq: number;
  userMessageId: string | null;
  userMeta: Record<string, unknown> | null;
  llmRound?: number | null;
}) {
  handle.currentTurnId = input.turnId;
  handle.currentTurnSeq = input.turnSeq;
  handle.currentTurnPatchSeq = 0;
  handle.currentAssistantMessageOrdinal = null;
  handle.currentStreamMessageId = null;
  handle.currentUserMessageId = input.userMessageId;
  handle.currentUserMessageMeta = input.userMeta;
  handle.currentLlmRound = input.llmRound ?? 0;
}

function clearActiveTurnContext(handle: SessionHandle, sessionId: string) {
  clearCurrentSessionExecutionAuth(sessionId);
  handle.currentLlmRound = null;
  handle.currentTurnId = null;
  handle.currentTurnSeq = null;
  handle.currentExecutionTurnIds.clear();
  handle.currentTurnPatchSeq = null;
  handle.currentAssistantMessageOrdinal = null;
  handle.currentStreamMessageId = null;
  handle.currentUserMessageId = null;
  handle.currentUserMessageMeta = null;
  handle.currentUserMessageContent = null;
  handle.lastActiveAt = Date.now();
}

async function runWithRoundAutoCompaction<T>(
  handle: SessionHandle,
  input: {
    actorUserId: string | null;
    abortSignal?: AbortSignal;
    onCompacted?: (outcome: Extract<CompactionOutcome, { compacted: true }>) => void;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const previousTransform = handle.session.agent.transformContext;
  let compacting = false;

  handle.session.agent.transformContext = async (_messages, signal) => {
    if (!compacting) {
      compacting = true;
      try {
        const force = handle.session.consumePendingForcedCompaction();
        const compactOutcome = await maybeAutoCompact(handle, {
          actorUserId: input.actorUserId,
          abortSignal: signal ?? input.abortSignal,
          force,
        }).catch((error) => {
          // Recovery failures are fatal for both threshold and forced compaction.
          if (force || error instanceof CompactionStateRecoveryError) throw error;
          logger.warn(`[Agent] auto-compact check failed sessionId=${handle.sessionId}:`, error);
          return { compacted: false, reason: "error" } as const;
        });
        if (compactOutcome.compacted) {
          input.onCompacted?.(compactOutcome);
        } else if (force) {
          logger.warn(
            `[Agent] overflow-compact did not compact sessionId=${handle.sessionId} reason=${compactOutcome.reason}`,
          );
          throw new OverflowRecoveryError(compactOutcome.reason);
        }
      } finally {
        compacting = false;
      }
    }

    const sessionMessages = handle.sessionManager.buildSessionContext().messages;
    if (!previousTransform) return sessionMessages;
    return await Promise.resolve(previousTransform(sessionMessages, signal));
  };

  try {
    return await fn();
  } finally {
    handle.session.agent.transformContext = previousTransform;
  }
}

async function appendAndPersistUserMessage(input: {
  handle: SessionHandle;
  spaceId: string;
  sessionId: string;
  user: TurnUserMessage;
  meta: Record<string, unknown>;
}) {
  const content = await normalizeContentBlocksImages(input.user.content, { readUrlImage: readPublicAssetImageUrl });
  const message = await contentToAgentMessage(content, input.meta);
  const startedAt = new Date().toISOString();
  input.handle.session.agent.state.messages.push(message);
  const entryId = input.handle.sessionManager.appendMessage(message);
  (message as unknown as Record<string, unknown>).sessionEntryId = entryId;

  await persistUserMessage({
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    userMessageId: input.user.userMessageId,
    turnId: input.user.turnId,
    agentSessionEntryId: entryId,
    content,
    meta: input.meta,
    startedAt,
  });

  return message;
}

async function runDirectShellCommandTurn(input: {
  handle: SessionHandle;
  tools: ReturnType<typeof createSandboxCodingTools>;
  spaceId: string;
  sessionId: string;
  user: TurnUserMessage;
  command: string;
  rawText: string;
  actorUserId: string | null;
  executionToken: string | null;
  executionScopes?: ReturnType<typeof getPromptAuthScopes>;
  turnMetrics: { llmRoundCount: number; toolCallCount: number };
  abortSignal?: AbortSignal;
}) {
  const { user } = input;
  const userMessageId = user.userMessageId;

  const bashTool = input.tools.find((tool) => tool.name === "bash");
  if (!bashTool) throw new Error("bash tool is not available");

  const handle = input.handle;
  setActiveTurnContext(handle, {
    turnId: user.turnId,
    turnSeq: user.turnSeq,
    userMessageId,
    userMeta: user.meta,
    llmRound: 0,
  });
  handle.currentAssistantMessageOrdinal = 0;
  handle.currentStreamMessageId = `turn:${user.turnId}:assistant:0`;
  handle.currentUserMessageContent = user.content;

  setCurrentSessionExecutionAuth({
    sessionId: input.sessionId,
    turnId: user.turnId,
    actorUserId: input.actorUserId,
    executionToken: input.executionToken,
    executionScopes: input.executionScopes ?? [],
  });

  let cleanupParentAbort: (() => void) | null = null;

  try {
    const userMeta = normalizeTurnUserMeta(user, {
      intent: "shell_command",
      llm: false,
      rawText: input.rawText,
      command: input.command,
    });
    handle.currentUserMessageMeta = userMeta;
    await appendAndPersistUserMessage({
      handle,
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      user,
      meta: userMeta,
    });

    const toolUseId = `direct_shell_${randomUUID()}`;
    const toolStartedAt = new Date().toISOString();
    const abortController = new AbortController();
    const abortFromParent = () => abortController.abort();
    if (input.abortSignal?.aborted) {
      abortFromParent();
    } else {
      input.abortSignal?.addEventListener("abort", abortFromParent, { once: true });
      cleanupParentAbort = () => input.abortSignal?.removeEventListener("abort", abortFromParent);
    }
    handle.activeDirectShellCommand = { turnId: user.turnId, abortController };

    const toolUseBlock: ContentBlock = {
      type: "tool_use",
      id: toolUseId,
      name: "bash",
      input: { command: input.command },
      _meta: { direct: true, source: "shell_command", toolStatus: "running", timing: { startedAt: toolStartedAt } },
    };
    let patchSeq = 0;
    let latestOutput = "";
    let publishChain = Promise.resolve();

    const publish = async (blocks: ContentBlock[], final = false) => {
      patchSeq += 1;
      handle.currentTurnPatchSeq = patchSeq;
      await sendOutput({
        type: "stream_update",
        spaceId: input.spaceId,
        sessionId: input.sessionId,
        turnId: user.turnId,
        seq: patchSeq,
        baseSeq: Math.max(0, patchSeq - 1),
        content: blocks,
        snapshotContent: blocks,
        messageId: handle.currentStreamMessageId,
        messageOrdinal: 0,
        sourceMessageId: userMessageId,
        anchorUserMessageId: userMessageId,
        timestamp: Date.now(),
        ...(final ? { turnEnd: true } : {}),
      });
    };

    await publish([toolUseBlock]);

    let exitCode: number | null | undefined;
    let cancelled = false;
    let timedOut = false;
    let termination: Record<string, unknown> | null = null;
    let truncated = false;
    let outputTruncated = false;
    let executionFailed = false;
    let errorMessage: string | null = null;
    try {
      const result = await bashTool.execute(
        toolUseId,
        { command: input.command } as never,
        abortController.signal,
        (partialResult: unknown) => {
          const partialText = extractToolResultText(partialResult);
          if (partialText) latestOutput = partialText;
          const partialBlocks: ContentBlock[] = [
            toolUseBlock,
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: latestOutput,
              is_error: false,
              _meta: { direct: true, source: "shell_command", partial: true, toolStatus: "running" },
            },
          ];
          publishChain = publishChain
            .then(() => publish(partialBlocks))
            .catch((error) => {
              logger.error(`[Agent] Failed to publish shell command update for session ${input.sessionId}:`, error);
            });
        },
      );
      latestOutput = extractToolResultText(result);
      const details = result && typeof result === "object" ? (result as unknown as Record<string, unknown>).details as Record<string, unknown> | undefined : undefined;
      exitCode = typeof details?.exitCode === "number" ? details.exitCode : null;
      termination = details?.termination && typeof details.termination === "object" && !Array.isArray(details.termination)
        ? details.termination as Record<string, unknown>
        : null;
      timedOut = termination?.reason === "timed_out";
      cancelled = termination?.reason === "aborted" || abortController.signal.aborted;
      outputTruncated = details?.outputTruncated === true || termination?.outputTruncated === true;
      truncated = Boolean(details?.truncation) || outputTruncated;
    } catch (error) {
      executionFailed = true;
      cancelled = abortController.signal.aborted;
      errorMessage = error instanceof Error ? error.message : String(error);
      latestOutput = latestOutput ? `${latestOutput}\n\n${errorMessage}` : errorMessage;
      exitCode = null;
      if (!cancelled) {
        logger.error(`[Agent] Direct shell command failed sessionId=${input.sessionId}:`, error);
      }
    }

    const isError = executionFailed || cancelled || timedOut || outputTruncated || (exitCode != null && exitCode !== 0);
    const toolCompletedAt = new Date().toISOString();
    const toolDurationMs = Math.max(0, new Date(toolCompletedAt).getTime() - new Date(toolStartedAt).getTime());
    const toolTiming = { startedAt: toolStartedAt, completedAt: toolCompletedAt, durationMs: toolDurationMs };
    const finalToolUseBlock: ContentBlock = {
      ...toolUseBlock,
      _meta: { direct: true, source: "shell_command", toolStatus: isError ? "failed" : "done", timing: toolTiming },
    };
    const finalToolResultBlock: ContentBlock = {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: latestOutput,
      is_error: isError,
      _meta: {
        direct: true,
        source: "shell_command",
        partial: false,
        toolStatus: isError ? "failed" : "done",
        exitCode: exitCode ?? null,
        termination,
        timedOut,
        cancelled,
        truncated,
        outputTruncated,
        executionFailed,
        timing: toolTiming,
        ...(errorMessage ? { errorMessage } : {}),
      },
    };
    const assistantContent: ContentBlock[] = [finalToolUseBlock, finalToolResultBlock];
    await publishChain;
    await publish(assistantContent, true);

    const model = handle.session.agent.state.model;
    const assistantMessage = {
      role: "assistant",
      content: assistantContent,
      timestamp: Date.now(),
      stopReason: cancelled ? "aborted" : "end",
      provider: model.provider,
      model: model.id,
      meta: {
        messageKind: "shell_command_result",
        executionKind: "shell_command_result",
        llm: false,
        command: input.command,
        rawText: input.rawText,
        exitCode: exitCode ?? null,
        termination,
        timedOut,
        cancelled,
        truncated,
        outputTruncated,
        executionFailed,
        ...(errorMessage ? { errorMessage } : {}),
        llmContextText: formatShellCommandResultForLlm({
          command: input.command,
          output: latestOutput,
          exitCode,
          cancelled,
          timedOut,
          timeoutSecs: typeof termination?.timeoutSecs === "number" ? termination.timeoutSecs : null,
        }),
      },
    } as never;
    handle.session.agent.state.messages.push(assistantMessage);
    const entryId = handle.sessionManager.appendMessage(assistantMessage);
    (assistantMessage as unknown as Record<string, unknown>).sessionEntryId = entryId;

    const completedAt = new Date().toISOString();

    await persistAssistantMessage({
      spaceId: input.spaceId,
      spaceSessionId: input.sessionId,
      userMessageId,
      event: {
        type: "turn_end",
        message: assistantMessage as Record<string, unknown>,
        toolResults: [{
          toolCallId: toolUseId,
          toolName: "bash",
          input: { command: input.command },
          content: latestOutput,
          isError,
          _meta: finalToolResultBlock._meta,
        }],
      },
      userId: input.actorUserId,
      turnId: user.turnId,
      startedAt: toolStartedAt,
      completedAt,
      thinkingLevel: handle.session.agent.state.thinkingLevel,
    });

    input.turnMetrics.toolCallCount += 1;
    removePendingUserMessage(handle, userMessageId);
  } finally {
    cleanupParentAbort?.();
    handle.activeDirectShellCommand = null;
    clearActiveTurnContext(handle, input.sessionId);
  }
}

async function prepareHandle(input: {
  spaceId: string;
  sessionId: string;
  actorUserId: string;
  requestedModel?: { provider: string; id: string };
  requestedThinkingLevel?: string | null;
  beforeTurnSequence?: number | null;
}) {
  const [modelRegistry, imageToTextConfig] = await Promise.all([
    getModelRegistryForUser(input.actorUserId),
    loadImageToTextConfig(input.actorUserId).catch((error) => {
      logger.warn("[ImageToText] config unavailable; continuing without fallback", error);
      return null;
    }),
  ]);
  const handle = await loadOrCreateSessionHandle({
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    userId: input.actorUserId,
    modelRegistry,
    imageToTextConfig,
    tools,
    model: input.requestedModel,
    beforeTurnSequence: input.beforeTurnSequence,
    sessionHandles,
  });

  await handle.session.configureRuntimeIdentity({
    userId: input.actorUserId,
    spaceOwnerUserId: handle.spaceOwnerUserId,
    modelRegistry,
    imageToTextConfig,
    requestedModel: input.requestedModel,
    requestedThinkingLevel: input.requestedThinkingLevel,
  });

  return handle;
}

function resolveRequestedModel(ownerMeta: Record<string, unknown>) {
  const provider = typeof ownerMeta.provider === "string" && ownerMeta.provider.trim() ? ownerMeta.provider.trim() : null;
  const model = typeof ownerMeta.model === "string" && ownerMeta.model.trim() ? ownerMeta.model.trim() : null;
  return provider && model ? { provider, id: model } : undefined;
}

function resolveRequestedThinkingLevel(ownerMeta: Record<string, unknown>): string | null | undefined {
  if (typeof ownerMeta.requestedThinkingLevel !== "string") return undefined;
  const trimmed = ownerMeta.requestedThinkingLevel.trim();
  return trimmed || null;
}

function resolveActorUserId(ownerMeta: Record<string, unknown>) {
  return typeof ownerMeta.userId === "string" && ownerMeta.userId.trim() ? ownerMeta.userId.trim() : null;
}

function resolveSourceClientId(ownerMeta: Record<string, unknown>) {
  const sourceClientId = ownerMeta.sourceClientId;
  return typeof sourceClientId === "string" && sourceClientId.trim() ? sourceClientId.trim() : null;
}

function resolveContextHookEnv(ownerMeta: Record<string, unknown>) {
  const context = ownerMeta.context && typeof ownerMeta.context === "object" && !Array.isArray(ownerMeta.context)
    ? ownerMeta.context as Record<string, unknown>
    : null;
  if (context?.kind !== "space_hook") return null;
  const env = context.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("COHUB_HOOK_")) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function resolvePromptEnv(ownerMeta: Record<string, unknown>) {
  let userEnv: Record<string, string> | null = null;
  try {
    userEnv = parsePromptEnv(ownerMeta.env);
  } catch (error) {
    logger.warn(`[Agent] ignoring invalid prompt env: ${error instanceof Error ? error.message : String(error)}`);
  }
  const hookEnv = resolveContextHookEnv(ownerMeta);
  if (!userEnv && !hookEnv) return null;
  // System hook keys win over user prompt.env.
  return { ...(userEnv ?? {}), ...(hookEnv ?? {}) };
}

async function createTurnExecutionToken(input: {
  accessMode: PromptAccessMode;
  actorUserId: string;
  spaceId: string;
  sessionId: string;
  turnId: string;
  source: unknown;
  promptAuth?: unknown;
}) {
  if (input.accessMode !== "full_access") return null;
  return createAgentExecutionToken({
    actorUserId: input.actorUserId,
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    source: typeof input.source === "string" && input.source.trim() ? input.source.trim() : "agent_turn",
    scopes: getPromptAuthScopes(input.promptAuth, input.spaceId),
  });
}

function filterToolsForAccessMode(allTools: AgentTool[], accessMode: PromptAccessMode) {
  if (accessMode === "full_access") return allTools;
  const readOnlyTools = new Set(["read", "ls", "find", "grep"]);
  return allTools.filter((tool) => readOnlyTools.has(tool.name));
}

async function configureHandleAccessMode(handle: SessionHandle, accessMode: PromptAccessMode) {
  if (handle.currentAccessMode === accessMode) return;
  await handle.session.configureTools(filterToolsForAccessMode(tools, accessMode));
  handle.currentAccessMode = accessMode;
}

function formatTurnFailureMessage(error: unknown) {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

async function failActiveTurn(input: {
  spaceId: string;
  sessionId: string;
  turnId: string;
  error: unknown;
}) {
  const errorMessage = formatTurnFailureMessage(input.error).slice(0, 2000) || "Agent turn failed.";
  try {
    await failSessionTurn({
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      errorMessage,
    });
    return true;
  } catch (failError) {
    logger.error(`[Agent] failed to mark turn failed sessionId=${input.sessionId} turnId=${input.turnId}:`, failError);
    return false;
  }
}

function getSpaceBootstrapMeta(meta: unknown) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const bootstrap = (meta as Record<string, unknown>).bootstrap;
  if (!bootstrap || typeof bootstrap !== "object" || Array.isArray(bootstrap)) return null;
  return bootstrap as Record<string, unknown>;
}

function logSpaceBootstrapWarning(spaceId: string, meta: unknown) {
  const bootstrap = getSpaceBootstrapMeta(meta);
  const status = typeof bootstrap?.status === "string" ? bootstrap.status : null;
  if (!status || status === "ready") return;
  logger.warn(`[Agent] space bootstrap is not ready; continuing execution spaceId=${spaceId} status=${status} stage=${typeof bootstrap?.stage === "string" ? bootstrap.stage : ""} error=${typeof bootstrap?.errorMessage === "string" ? bootstrap.errorMessage : ""}`);
}

type PostReleaseDrain = { spaceId: string; sessionId: string; reason: string } | null;

function getQueueWaitMs(job: Pick<Job<unknown>, "timestamp" | "processedOn">) {
  if (!job.timestamp) return null;
  const processedAt = job.processedOn && job.processedOn >= job.timestamp ? job.processedOn : Date.now();
  return Math.max(0, processedAt - job.timestamp);
}

export async function processAgentTurnJob(job: Job<AgentTurnJobData>) {
  const data = job.data;
  const requestId = getOrCreateRequestId(data.requestId);
  const queueWaitMs = getQueueWaitMs(job);
  const parentCtx = extractTrace((data.trace ?? data) as Record<string, unknown>);
  return runInActiveSpan(agentTracer, "agent.turn_job.process", {
    attributes: {
      "cohub.request_id": requestId,
      "cohub.space_id": data.spaceId,
      "cohub.session_id": data.sessionId,
      "job.id": job.id ?? "",
      "job.attempt": job.attemptsMade,
      ...(job.timestamp ? { "agent.queue.enqueued_at_ms": job.timestamp } : {}),
      ...(job.processedOn ? { "agent.queue.processed_on_ms": job.processedOn } : {}),
      ...(job.delay ? { "agent.queue.delay_ms": job.delay } : {}),
      ...(queueWaitMs != null ? { "agent.queue.wait_ms": queueWaitMs } : {}),
    },
  }, parentCtx, async (jobSpan) => {
    setRequestContextAttributes(jobSpan, getActiveTraceIdentifiers(requestId, trace.setSpan(context.active(), jobSpan)));
    if (queueWaitMs != null) jobSpan.addEvent("agent.queue.dequeued", { "agent.queue.wait_ms": queueWaitMs });
    const lock = await acquireSessionLock(data.sessionId);
    if (!lock) {
      logger.info(`[Agent] session locked; skipped wakeup sessionId=${data.sessionId} reason=${data.reason ?? "prompt"}`);
      return { skipped: "session_locked", jobId: job.id ?? null };
    }
    let activeTurn: { id: string; controller: AbortController } | null = null;
    const onLeaseLost = () => activeTurn?.controller.abort();
    lock.signal.addEventListener("abort", onLeaseLost, { once: true });
    let claimedBatch: ClaimedTurnBatch | null = null;
    let handle: SessionHandle | null = null;
    let handleSettled = false;
    let terminalHandled = false;
    let caughtError: unknown = null;
    let drainAfterRelease: PostReleaseDrain = null;

    try {
      const claim = await claimNextTurnBatch(data);
      if (claim.kind === "noop") {
        clearRetryState(data);
        return { skipped: "noop" };
      }
      if (claim.kind === "busy") {
        const result = await requeueTurnJob(data, "session_busy", job, {
          activeTurnId: claim.activeTurnId,
          activeStatus: claim.activeStatus,
          activeUpdatedAt: claim.activeUpdatedAt?.toISOString() ?? null,
        });
        if ((result.retryInMs ?? 0) >= BUSY_RETRY_MAX_DELAY_MS) {
          logger.warn(`[Agent] session busy retry delayed sessionId=${data.sessionId} activeTurnId=${claim.activeTurnId} delayMs=${result.retryInMs}`);
        }
        return result;
      }

      clearRetryState(data);
      const { batch } = claim;
      claimedBatch = batch;
      await publishSessionTurnsUpdated({
        sessionId: data.sessionId,
        turnIds: batch.turns.map((turn) => turn.id),
      }).catch((error) => logger.warn("[Realtime] failed to publish claimed turn updates", error));
      const ownerMeta = (batch.ownerTurn.meta && typeof batch.ownerTurn.meta === "object" && !Array.isArray(batch.ownerTurn.meta)
        ? batch.ownerTurn.meta as Record<string, unknown>
        : {});
      const actorUserId = resolveActorUserId(ownerMeta);
      const sourceClientId = resolveSourceClientId(ownerMeta);
      if (!actorUserId) throw new Error("Agent turn requires actorUserId for execution token");
      const promptContext = ownerMeta.context && typeof ownerMeta.context === "object" && !Array.isArray(ownerMeta.context)
        ? ownerMeta.context as Record<string, unknown>
        : null;
      const fileVisibility = await resolveSpaceFileVisibility({
        actorUserId,
        spaceId: data.spaceId,
        promptAuth: promptContext?.auth,
      });
      const accessMode = resolveBatchAccessMode(batch);
      const generationPolicy = normalizeGenerationPolicy(ownerMeta.generationPolicy);
      const promptEnv = resolvePromptEnv(ownerMeta);
      const abortEvent = await getAbortEvent(batch.ownerTurn.id);
      if (abortEvent) {
        if (abortEvent.reason === "interrupt" && abortEvent.continuedByTurnId) {
          await interruptSessionTurn({
            spaceId: data.spaceId,
            sessionId: data.sessionId,
            turnId: batch.ownerTurn.id,
            continuedByTurnId: abortEvent.continuedByTurnId,
          });
        } else {
          await abortSessionTurn({
            spaceId: data.spaceId,
            sessionId: data.sessionId,
            turnId: batch.ownerTurn.id,
            actorUserId,
          });
        }
        terminalHandled = true;
        drainAfterRelease = { spaceId: data.spaceId, sessionId: data.sessionId, reason: "abort_precheck" };
        return { skipped: "abort_requested", turnId: batch.ownerTurn.id };
      }
      lock.signal.throwIfAborted();
      const requestedHarness = resolveHarness(ownerMeta);
      if (isLocalHarness(requestedHarness)) {
        if (fileVisibility !== "full") throw new Error("Local Harness requires full workspace access");
        const remoteController = new AbortController();
        activeTurn = { id: batch.ownerTurn.id, controller: remoteController };
        setActiveAbortController(batch.ownerTurn.id, remoteController);
        const remoteAbort = await getAbortEvent(batch.ownerTurn.id);
        if (remoteAbort) {
          setActiveAbortEvent(remoteAbort);
          remoteController.abort();
        }
        try {
          await executeRemoteHarnessTurn({
            spaceId: data.spaceId,
            sessionId: data.sessionId,
            batch,
            actorUserId,
            accessMode,
            requestedThinkingLevel: resolveRequestedThinkingLevel(ownerMeta),
            harness: requestedHarness,
            provider: typeof ownerMeta.provider === "string" ? ownerMeta.provider : null,
            model: typeof ownerMeta.model === "string" ? ownerMeta.model : null,
            requestId,
            abortSignal: remoteController.signal,
            leaseSignal: lock.signal,
          });
          terminalHandled = true;
          drainAfterRelease = { spaceId: data.spaceId, sessionId: data.sessionId, reason: "remote_turn_complete" };
          return { ownerTurnId: batch.ownerTurn.id, mergedTurnIds: batch.mergedTurns.map((turn) => turn.id), userMessageCount: batch.turns.length };
        } finally {
          clearActiveAbortController(batch.ownerTurn.id, remoteController);
        }
      }

      const spaceInfo = await getSpace({ spaceId: data.spaceId }).catch(() => null);
      logSpaceBootstrapWarning(data.spaceId, spaceInfo?.space?.meta);
      const spaceEnv = await loadSpaceEnvSnapshot(data.spaceId);
      handle = await prepareHandle({
        spaceId: data.spaceId,
        sessionId: data.sessionId,
        actorUserId,
        requestedModel: resolveRequestedModel(ownerMeta),
        requestedThinkingLevel: resolveRequestedThinkingLevel(ownerMeta),
        beforeTurnSequence: batch.turns[0]?.sequence ?? batch.ownerTurn.sequence,
      });
      const activeHandle = handle;
      try {
        await configureHandleAccessMode(activeHandle, accessMode);
      } catch (error) {
        logger.error(`[Agent] failed to configure tools sessionId=${data.sessionId} turnId=${batch.ownerTurn.id} accessMode=${accessMode}:`, error);
        throw error;
      }

      if (accessMode === "full_access") warmupSandboxConnection(data.spaceId);

      const executionModel = {
        provider: activeHandle.session.agent.state.model.provider,
        id: activeHandle.session.agent.state.model.id,
      };
      const rawTurnUserMessages: TurnUserMessage[] = buildUserMessagesForBatch(batch)
        .filter((item) => Boolean(item.userMessageId))
        .map((item) => ({
          turnId: item.turnId,
          turnSeq: item.turnSeq,
          userMessageId: item.userMessageId,
          content: item.content,
          meta: item.meta,
        }));
      const turnUserMessages = await Promise.all(rawTurnUserMessages.map(async (item) => ({
        ...item,
        content: await normalizeContentBlocksImages(item.content, { readUrlImage: readPublicAssetImageUrl }),
      })));
      for (const item of turnUserMessages) {
        const meta = normalizeTurnUserMeta(item);
        ensurePendingUserMessage(activeHandle, {
          userMessageId: item.userMessageId,
          turnId: item.turnId,
          turnSeq: item.turnSeq,
          content: item.content,
          meta,
        });
      }

      const ownerUserMessageId = batch.executionBatch.anchorUserMessageId ?? turnUserMessages.at(-1)?.userMessageId ?? null;
      const executionScopes = getPromptAuthScopes(promptContext?.auth, data.spaceId);
      const executionToken = await createTurnExecutionToken({
        accessMode,
        actorUserId,
        spaceId: data.spaceId,
        sessionId: data.sessionId,
        turnId: batch.ownerTurn.id,
        source: ownerMeta.source,
        promptAuth: promptContext?.auth,
      });
      const turnMetrics = { llmRoundCount: 0, toolCallCount: 0 };
      const assistantMessageTiming = { startedAt: null as string | null };
      const abortController = new AbortController();
      activeTurn = { id: batch.ownerTurn.id, controller: abortController };
      if (lock.signal.aborted) abortController.abort();
      setActiveAbortController(batch.ownerTurn.id, abortController);
      const pendingAbortEvent = await getAbortEvent(batch.ownerTurn.id);
      if (pendingAbortEvent) {
        setActiveAbortEvent(pendingAbortEvent);
        abortController.abort();
      }

      setActiveTurnContext(activeHandle, {
        turnId: batch.ownerTurn.id,
        turnSeq: batch.ownerTurn.sequence,
        userMessageId: ownerUserMessageId,
        userMeta: ownerMeta,
        llmRound: 0,
      });
      activeHandle.currentExecutionTurnIds = new Set(batch.executionBatch.turnIds);
      await drainStreamStateBeforeReset(activeHandle);
      resetStreamState(activeHandle);

      const messages = await Promise.all(turnUserMessages
        .filter((item) => !hasSessionUserMessage(activeHandle, item.userMessageId))
        .map((item) => contentToAgentMessage(item.content, normalizeTurnUserMeta(item))));

      const directShellItem = accessMode === "full_access" && turnUserMessages.length === 1 ? turnUserMessages[0] : null;
      const directShellCommand = directShellItem ? getShellCommandBlock(directShellItem.content) : null;
      if (directShellItem && directShellCommand) {
        await wrapAgentTurn(agentTracer, {
          action: "prompt",
          mode: "prompt",
          spaceId: data.spaceId,
          sessionId: data.sessionId,
          turnId: batch.ownerTurn.id,
          turnSeq: batch.ownerTurn.sequence,
          userMessageId: directShellItem.userMessageId,
          requestId,
          modelProvider: executionModel.provider,
          modelId: executionModel.id,
          isResumedSession: activeHandle.sessionManager.buildSessionContext().messages.length > 0,
        }, async (turnSpan) => {
          await runWithToolExecutionContext({
            spaceId: data.spaceId,
            sessionId: data.sessionId,
            turnId: batch.ownerTurn.id,
            turnSeq: batch.ownerTurn.sequence,
            anchorUserMessageId: directShellItem.userMessageId,
            llmRound: 0,
            model: executionModel,
            actorUserId,
            executionToken,
            executionScopes,
            sourceClientId,
            fileVisibility,
            requestId,
            metrics: turnMetrics,
            assistantMessageTiming,
            generationPolicy,
            spaceEnv,
            env: promptEnv,
            abortSignal: abortController.signal,
          }, async () => {
            logger.debug(`[Agent] shell-command:start sessionId=${data.sessionId}`);
            await runDirectShellCommandTurn({
              handle: activeHandle,
              tools,
              spaceId: data.spaceId,
              sessionId: data.sessionId,
              user: directShellItem,
              command: directShellCommand.command,
              rawText: directShellCommand.rawText,
              actorUserId,
              executionToken,
              executionScopes,
              turnMetrics,
              abortSignal: abortController.signal,
            });
            logger.debug(`[Agent] shell-command:end sessionId=${data.sessionId}`);
          });
          turnSpan.setAttribute("agent.llm_round_count", 0);
          turnSpan.setAttribute("agent.tool_count", turnMetrics.toolCallCount);
          turnSpan.setAttribute("agent.outcome", "ok");
        });

        await settleSessionHandle(activeHandle, "strict");
        handleSettled = true;
        if (!abortController.signal.aborted) terminalHandled = true;
        drainAfterRelease = { spaceId: data.spaceId, sessionId: data.sessionId, reason: "direct_shell_complete" };
        clearRetryState(data);
        return {
          ownerTurnId: batch.ownerTurn.id,
          mergedTurnIds: batch.mergedTurns.map((turn) => turn.id),
          userMessageCount: turnUserMessages.length,
        };
      }

      if (messages.length === 0) {
        logger.info(`[Agent] batch has no new user messages; continuing ownerTurn=${batch.ownerTurn.id}`);
      }

      await wrapAgentTurn(agentTracer, {
        action: "prompt",
        mode: "prompt",
        spaceId: data.spaceId,
        sessionId: data.sessionId,
        turnId: batch.ownerTurn.id,
        turnSeq: batch.ownerTurn.sequence,
        userMessageId: ownerUserMessageId,
        requestId,
        modelProvider: executionModel.provider,
        modelId: executionModel.id,
        isResumedSession: activeHandle.sessionManager.buildSessionContext().messages.length > 0,
      }, async (turnSpan) => {
        await runWithToolExecutionContext({
          spaceId: data.spaceId,
          sessionId: data.sessionId,
          turnId: batch.ownerTurn.id,
          turnSeq: batch.ownerTurn.sequence,
          anchorUserMessageId: ownerUserMessageId,
          llmRound: 0,
          model: executionModel,
          actorUserId,
          executionToken,
          executionScopes,
          sourceClientId,
          fileVisibility,
          requestId,
          metrics: turnMetrics,
          assistantMessageTiming,
          generationPolicy,
          spaceEnv,
          env: promptEnv,
          abortSignal: abortController.signal,
        }, async () => {
          try {
            if (abortController.signal.aborted) throw new Error("aborted");
            const abortPromise = new Promise<never>((_, reject) => {
              abortController.signal.addEventListener("abort", () => {
                activeHandle.activeDirectShellCommand?.abortController.abort();
                activeHandle.session.abort().catch(() => undefined);
                reject(new Error("aborted"));
              }, { once: true });
            });
            await runWithRoundAutoCompaction(activeHandle, {
              actorUserId,
              abortSignal: abortController.signal,
              onCompacted: (compactOutcome) => {
                turnSpan.addEvent("agent.auto_compact", {
                  "agent.compaction.tokens_before": compactOutcome.tokensBefore,
                  "agent.compaction.estimated_tokens_after": compactOutcome.estimatedTokensAfter,
                  "agent.compaction.summary_length": compactOutcome.summary.length,
                  "agent.compaction.duration_ms": compactOutcome.durationMs,
                  "agent.compaction.attempt_count": compactOutcome.attemptCount,
                  ...(compactOutcome.compactSequence != null
                    ? { "agent.compaction.compact_sequence": compactOutcome.compactSequence }
                    : {}),
                });
              },
            }, async () => {
              if (messages.length > 0) {
                await Promise.race([activeHandle.session.promptMessages(messages), abortPromise]);
              } else {
                await Promise.race([
                  (async () => {
                    await activeHandle.session.agent.continue();
                    await activeHandle.session.waitForIdle();
                  })(),
                  abortPromise,
                ]);
              }
            });
          } catch (error) {
            if (abortController.signal.aborted || (error instanceof Error && error.message === "aborted")) {
              const abortEvent = getActiveAbortEvent(batch.ownerTurn.id);
              await activeHandle.session.abort().catch(() => undefined);
              await persistInterruptedAssistantSnapshot(activeHandle, {
                abortEvent,
                actorUserId,
                fallbackTurnId: batch.ownerTurn.id,
                fallbackUserMessageId: ownerUserMessageId,
              }).catch((snapshotError) => {
                logger.warn(`[Agent] failed to persist interrupted snapshot sessionId=${data.sessionId} turnId=${batch.ownerTurn.id}:`, snapshotError);
              });
              await activeHandle.persistenceChain.catch(() => undefined);
              if (abortEvent?.reason === "interrupt" && abortEvent.continuedByTurnId) {
                await interruptSessionTurn({
                  spaceId: data.spaceId,
                  sessionId: data.sessionId,
                  turnId: batch.ownerTurn.id,
                  continuedByTurnId: abortEvent.continuedByTurnId,
                });
                terminalHandled = true;
              } else {
                await abortSessionTurn({
                  spaceId: data.spaceId,
                  sessionId: data.sessionId,
                  turnId: batch.ownerTurn.id,
                  actorUserId,
                });
                terminalHandled = true;
              }
              await settleSessionHandle(activeHandle, "best_effort");
              handleSettled = true;
              return;
            }
            throw error;
          }
        });
        turnSpan.setAttribute("agent.llm_round_count", turnMetrics.llmRoundCount);
        turnSpan.setAttribute("agent.tool_count", turnMetrics.toolCallCount);
        turnSpan.setAttribute("agent.outcome", "ok");
      });

      await settleSessionHandle(activeHandle, "strict");
      handleSettled = true;
      if (!abortController.signal.aborted) terminalHandled = true;
      drainAfterRelease = { spaceId: data.spaceId, sessionId: data.sessionId, reason: "turn_complete" };
      clearRetryState(data);
      return {
        ownerTurnId: batch.ownerTurn.id,
        mergedTurnIds: batch.mergedTurns.map((turn) => turn.id),
        userMessageCount: turnUserMessages.length,
      };
    } catch (error) {
      if (error instanceof RuntimeExecutionUncertainError) {
        // The Runtime may already have changed local files. Surface the uncertain
        // Session immediately and wait for reconnect or explicit confirmation.
        terminalHandled = true;
        const ownerTurn = claimedBatch?.ownerTurn;
        const turnId = ownerTurn?.id;
        if (ownerTurn) {
          const harness = resolveHarness(ownerTurn.meta);
          const recoveryMeta = await markRuntimeRecovery(ownerTurn.id, {
            state: "attention",
            reason: "transport_disconnected",
            detectedAt: new Date().toISOString(),
          });
          const recovery = readRuntimeRecovery(recoveryMeta);
          await publishSessionTurnsUpdated({ sessionId: data.sessionId, turnIds: [ownerTurn.id] });
          if (isLocalHarness(harness) && recovery?.ownerUserId) {
            await enqueueRuntimeRecovery(agentTurnQueue, {
              spaceId: data.spaceId,
              sessionId: data.sessionId,
              expectedTurnId: ownerTurn.id,
              expectedHarness: harness,
              expectedOwnerUserId: recovery.ownerUserId,
            });
          }
        }
        logger.error("[Runtime] execution outcome requires reconciliation", { sessionId: data.sessionId, error });
        return { skipped: "runtime_outcome_unknown", turnId };
      }
      caughtError = error;
      const ownerTurnId = activeTurn?.id ?? claimedBatch?.ownerTurn.id ?? null;
      if (ownerTurnId) {
        logger.error(`[Agent] turn failed sessionId=${data.sessionId} turnId=${ownerTurnId}:`, error);
        terminalHandled = await failActiveTurn({
          spaceId: data.spaceId,
          sessionId: data.sessionId,
          turnId: ownerTurnId,
          error,
        });
        drainAfterRelease = { spaceId: data.spaceId, sessionId: data.sessionId, reason: "turn_failed" };
      }
      if (error instanceof ModelUnavailableError) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    } finally {
      if (activeTurn) clearActiveAbortController(activeTurn.id, activeTurn.controller);
      const ownerTurnId = claimedBatch?.ownerTurn.id ?? null;
      if (ownerTurnId && !terminalHandled) {
        const reconciled = await failActiveTurn({
          spaceId: data.spaceId,
          sessionId: data.sessionId,
          turnId: ownerTurnId,
          error: caughtError ?? new Error("Agent turn exited without terminal state."),
        });
        if (reconciled) drainAfterRelease = drainAfterRelease ?? { spaceId: data.spaceId, sessionId: data.sessionId, reason: "turn_reconciled" };
      }
      // Reset residual per-turn state to prevent leakage into the next turn
      // on the same reused session handle. handleSettled is true only on
      // normal exits (success/abort) where event handlers + settleSessionHandle
      // have already cleaned up; on error exits — even when failActiveTurn
      // marked the DB turn terminal — the agent may still be streaming and
      // per-turn fields are still set.
      if (handle && !handleSettled) {
        await handle.session.abort().catch(() => undefined);
        clearActiveTurnContext(handle, data.sessionId);
        handle.toolExecutionStartedAtById.clear();
        if (claimedBatch) {
          for (const userMessageId of claimedBatch.executionBatch.userMessageIds) {
            removePendingUserMessage(handle, userMessageId);
          }
        }
        if (caughtError instanceof CompactionStateRecoveryError) {
          sessionHandles.delete(handle.sessionKey);
          clearCurrentSessionExecutionAuth(handle.sessionId);
          await handle.persistenceChain.catch(() => undefined);
          await handle.sessionManager.close().catch(() => undefined);
          handle.session.dispose();
        } else {
          await settleSessionHandle(handle, terminalHandled ? "strict" : "best_effort");
        }
      }
      if (handle && claimedBatch && terminalHandled) {
        try {
          // Cloud sessions rebuild from durable platform data, so only the resume marker
          // is persisted alongside the native log — no native snapshot is archived.
          const completedContext = await loadRuntimeContext({ spaceId: data.spaceId, sessionId: data.sessionId, throughTurnId: claimedBatch.ownerTurn.id, headOnly: true });
          const previousMarker = handle.sessionManager.getCustomEntries("cohub.context").at(-1)?.data as Record<string, unknown> | undefined;
          handle.sessionManager.appendCustomEntry("cohub.context", { ...previousMarker, revision: completedContext.revision, throughTurnId: completedContext.throughTurnId });
          await handle.sessionManager.close();
          await refreshSessionHandleFileSignature(handle);
        } catch (error) { logger.warn("[SessionContext] failed to record the resume marker", error); }
      }
      if (claimedBatch) clearRetryState(data);
      lock.signal.removeEventListener("abort", onLeaseLost);
      await lock.release();
      if (drainAfterRelease) await drainNextQueuedTurn(drainAfterRelease);
    }
  });
}

export const __test = {
  getShellCommandBlock,
  formatShellCommandResultForLlm,
};

export function getActiveSessionHandles() {
  return sessionHandles;
}

export async function disposeAllSessionHandles() {
  for (const handle of sessionHandles.values()) {
    try {
      await handle.sessionManager.close().catch(() => undefined);
      await handle.persistenceChain.catch(() => undefined);
      clearCurrentSessionExecutionAuth(handle.sessionId);
      handle.session.dispose();
    } catch (error) {
      logger.error(`[Agent] failed to dispose session ${handle.sessionId}:`, error);
    }
  }
  sessionHandles.clear();
}
