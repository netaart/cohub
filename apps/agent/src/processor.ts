import { UnrecoverableError, type Job } from "bullmq";
import { ModelUnavailableError, getPromptAuthScopes, readRuntimeRecovery, type PromptAccessMode } from "@cohub/core/sessions";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { context, trace } from "@opentelemetry/api";
import { getActiveTraceIdentifiers, getOrCreateRequestId, setRequestContextAttributes } from "@cohub/infra/tracing";
import { wrapAgentTurn, getAgentTracer } from "@cohub/infra/tracing/agent";
import { runInActiveSpan, extractTrace } from "@cohub/infra/tracing/propagator";
import { getSpace } from "./api.js";
import { abortSessionTurn, failSessionTurn, interruptSessionTurn, publishSessionTurnsUpdated } from "./persistence.js";
import { ensureSandboxConnection } from "./sandbox-pool.js";
import { createSandboxCodingTools } from "./sandbox/tools.js";
import { CohubModelRegistry } from "./runtime/model-registry.js";
import { resolveBatchContextWindow } from "./runtime/batch-limit.js";
import { loadRuntimeModelsConfigs } from "./runtime/models-loader.js";
import { loadImageToTextConfig } from "./runtime/model-tasks-config.js";
import { loadSpaceEnvSnapshot } from "./runtime/env-cache.js";
import { CompactionStateRecoveryError, maybeAutoCompact, OverflowRecoveryError, type CompactionOutcome } from "./runtime/compaction.js";
import { clearCurrentSessionExecutionAuth } from "./runtime/session-execution-auth.js";
import { resolveSpaceFileVisibility } from "./runtime/cross-space-query-access.js";
import { normalizeGenerationPolicy } from "@cohub/protocol/generation";
import { runWithToolExecutionContext } from "./tool-context.js";
import { createImageInputCache } from "@cohub/model-runtime/image-content";
import { loadOrCreateSessionHandle } from "./session.js";
import { ensurePendingUserMessage, hasSessionUserMessage, removePendingUserMessage, refreshSessionHandleFileSignature, getSessionKey, type SessionHandle } from "./session-handle.js";
import { resetStreamState, drainStreamStateBeforeReset, persistInterruptedAssistantSnapshot } from "./session-stream.js";
import { claimNextTurnBatch, buildUserMessagesForBatch, enqueueNextRunnableTurn, resolveBatchAccessMode, type ClaimedTurnBatch } from "./batch.js";
import { acquireSessionLock } from "./session-lock.js";
import { enqueueRuntimeRecovery } from "@cohub/infra/agent-queue";
import { agentTurnQueue, enqueueAgentTurnJob, type AgentTurnJobData } from "./queue.js";
import { getAbortEvent } from "./abort.js";
import { setActiveAbortController, clearActiveAbortController, getActiveAbortEvent, setActiveAbortEvent } from "./active-turns.js";
import { logger } from "./logger.js";
import { isApprovalMode, isLocalHarness, resolveHarness } from "@cohub/protocol";
import { executeRemoteHarnessTurn, markRuntimeRecovery, RuntimeExecutionUncertainError } from "./runtime/remote-runtime.js";
import { loadRuntimeContext } from "./runtime/context-store.js";
import { createTurnExecutionToken, getQueueWaitMs, logSpaceBootstrapWarning, resolveActorUserId, resolvePromptEnv, resolveRequestedModel, resolveRequestedThinkingLevel, resolveSourceClientId } from "./turn-job-meta.js";
import { BUSY_RETRY_MAX_DELAY_MS, clearRetryState, requeueTurnJob } from "./turn-retry.js";
import { type TurnUserMessage, clearActiveTurnContext, contentToAgentMessage, normalizeTurnUserMeta, setActiveTurnContext } from "./turn-context.js";
import { getShellCommandBlock, runDirectShellCommandTurn } from "./shell-command-turn.js";

const sessionHandles = new Map<string, SessionHandle>();
const tools = createSandboxCodingTools();
const agentTracer = getAgentTracer();

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

async function getModelRegistryForUser(userId: string | null | undefined, spaceId?: string | null) {
  const configs = await loadRuntimeModelsConfigs(userId?.trim() || null, spaceId?.trim() || null);
  const registry = new CohubModelRegistry({ configs });
  if (registry.getError()) {
    logger.warn(`[Agent] Model registry warning for ${userId?.trim() || "__platform__"}:`, registry.getError());
  }
  return registry;
}

async function runWithRoundAutoCompaction<T>(
  handle: SessionHandle,
  input: {
    actorUserId: string | null;
    abortSignal?: AbortSignal;
    /** The user asked to compact before this Turn's first LLM round. */
    compactFirst?: boolean;
    onCompacted?: (outcome: Extract<CompactionOutcome, { compacted: true }>) => void;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const previousTransform = handle.session.agent.transformContext;
  let compacting = false;
  let compactRequested = input.compactFirst === true;

  handle.session.agent.transformContext = async (_messages, signal) => {
    if (!compacting) {
      compacting = true;
      try {
        const force = handle.session.consumePendingForcedCompaction();
        const requested = compactRequested;
        compactRequested = false;
        const compactOutcome = await maybeAutoCompact(handle, {
          actorUserId: input.actorUserId,
          abortSignal: signal ?? input.abortSignal,
          force,
          requested,
        }).catch((error) => {
          // Recovery failures are fatal for both threshold and forced compaction.
          if (force || error instanceof CompactionStateRecoveryError) throw error;
          logger.warn(`[Agent] auto-compact check failed sessionId=${handle.sessionId}:`, error);
          return { compacted: false, reason: "error" } as const;
        });
        if (compactOutcome.compacted) {
          input.onCompacted?.(compactOutcome);
        } else if (requested && !force) {
          // A failed requested compaction must not cost the user their message.
          logger.warn(`[Agent] requested compaction skipped sessionId=${handle.sessionId} reason=${compactOutcome.reason}`);
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

async function prepareHandle(input: {
  spaceId: string;
  sessionId: string;
  actorUserId: string;
  requestedModel?: { provider: string; id: string };
  requestedThinkingLevel?: string | null;
  requestedContextWindow?: number | null;
  beforeTurnSequence?: number | null;
}) {
  const [modelRegistry, imageToTextConfig] = await Promise.all([
    getModelRegistryForUser(input.actorUserId, input.spaceId),
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
    requestedContextWindow: input.requestedContextWindow,
  });

  return handle;
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

type PostReleaseDrain = { spaceId: string; sessionId: string; reason: string } | null;

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
            abortEvent,
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
            approvalMode: isApprovalMode(ownerMeta.approvalMode) ? ownerMeta.approvalMode : undefined,
            requestedServiceTier: typeof ownerMeta.requestedServiceTier === "string" ? ownerMeta.requestedServiceTier : null,
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
        requestedContextWindow: resolveBatchContextWindow(batch.turns),
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
      const turnUserMessages: TurnUserMessage[] = buildUserMessagesForBatch(batch)
        .filter((item) => Boolean(item.userMessageId))
        .map((item) => ({
          turnId: item.turnId,
          turnSeq: item.turnSeq,
          userMessageId: item.userMessageId,
          content: item.content,
          meta: item.meta,
        }));
      const batchUserMessageIds = new Set(batch.executionBatch.userMessageIds);
      activeHandle.pendingUserMessages = activeHandle.pendingUserMessages.filter((item) => batchUserMessageIds.has(item.userMessageId));
      activeHandle.userMessageIdentityError = null;
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

      const messages = turnUserMessages
        .filter((item) => !hasSessionUserMessage(activeHandle, item.userMessageId))
        .map((item) => contentToAgentMessage(item.content, normalizeTurnUserMeta(item)));

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
          imageInputCache: createImageInputCache(),
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
              compactFirst: batch.turns.some((turn) => (turn.meta as Record<string, unknown> | null)?.compactFirst === true),
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
            if (activeHandle.userMessageIdentityError) throw activeHandle.userMessageIdentityError;
          } catch (error) {
            if (activeHandle.userMessageIdentityError) throw activeHandle.userMessageIdentityError;
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
                  abortEvent,
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
      // Abort exits before the prompt settle normally but never consume their pending messages.
      if (handle && claimedBatch) {
        for (const userMessageId of claimedBatch.executionBatch.userMessageIds) {
          removePendingUserMessage(handle, userMessageId);
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

export function getActiveSessionHandles() {
  return sessionHandles;
}

async function disposeHandle(handle: SessionHandle) {
  try {
    await handle.sessionManager.close().catch(() => undefined);
    await handle.persistenceChain.catch(() => undefined);
    clearCurrentSessionExecutionAuth(handle.sessionId);
    handle.session.dispose();
  } catch (error) {
    logger.error(`[Agent] failed to dispose session ${handle.sessionId}:`, error);
  }
}

export async function disposeSessionHandle(spaceId: string, sessionId: string) {
  const key = getSessionKey(spaceId, sessionId);
  const handle = sessionHandles.get(key);
  if (!handle) return;
  sessionHandles.delete(key);
  await disposeHandle(handle);
}

export async function disposeAllSessionHandles() {
  for (const handle of sessionHandles.values()) await disposeHandle(handle);
  sessionHandles.clear();
}
