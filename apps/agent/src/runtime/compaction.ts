import {
  BACKGROUND_CONTEXT,
  calculateContextTokens,
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  prepareCompaction,
  shouldCompact,
  withAbortSignal,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, RetryPolicy, Usage } from "@earendil-works/pi-ai";
import { logger } from "../logger.js";
import type { SessionHandle } from "../session.js";
import { persistCompactionEvent } from "../persistence.js";
import { refreshSessionHandleFileSignature } from "../session.js";
import { getAgentTracer } from "@cohub/infra/tracing/agent";
import { db } from "../db.js";
import { sessionTurns } from "@cohub/db";
import { and, eq, sql } from "drizzle-orm";
import { getCurrentToolExecutionContext } from "../tool-context.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createModelsFromCohubRegistry } from "./pi-models-adapter.js";
import { estimateProxyContextTokens, resolveReserveTokens } from "./compaction-policy.js";
import {
  findFirstKeptEntryId,
  getCompactionSummaryMessageCount,
  resolveCompactionScope,
  validateCompactionEffect,
} from "./compaction-plan.js";

type ProviderCallStats = {
  total: number;
  succeeded: number;
  failed: number;
};

export type CompactionOutcome =
  | {
      compacted: true;
      summary: string;
      tokensBefore: number;
      estimatedTokensAfter: number;
      firstKeptEntryId: string;
      archivePath: string | undefined;
      compactSequence: number | null;
      usage: Usage | undefined;
      durationMs: number;
      attemptCount: number;
    }
  | { compacted: false; reason: string };

/** Thrown when archive restoration fails and the active handle is no longer safe to use. */
export class CompactionStateRecoveryError extends Error {
  constructor(sessionId: string) {
    super(`Compaction state recovery failed for session ${sessionId}`);
    this.name = "CompactionStateRecoveryError";
  }
}

/** Thrown when overflow recovery cannot free enough context (no empty LLM retry). */
export class OverflowRecoveryError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Context overflow recovery failed: ${reason}`);
    this.name = "OverflowRecoveryError";
    this.reason = reason;
  }
}

function resolveCompactionSettings(contextWindow: number) {
  return {
    ...DEFAULT_COMPACTION_SETTINGS,
    enabled: true,
    reserveTokens: resolveReserveTokens(contextWindow),
  };
}

function getContextTokenBudget(messages: AgentMessage[]): { accurateTokens: number; estimatedTokens: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const assistant = message as unknown as AssistantMessage;
    if (assistant.stopReason === "aborted" || assistant.stopReason === "error" || !assistant.usage) continue;
    const accurateTokens = calculateContextTokens(assistant.usage);
    if (accurateTokens <= 0) continue;

    let trailingTokens = 0;
    for (let j = i + 1; j < messages.length; j++) {
      const trailingMessage = messages[j];
      if (trailingMessage) trailingTokens += estimateTokens(trailingMessage);
    }
    return { accurateTokens, estimatedTokens: accurateTokens + trailingTokens };
  }
  return null;
}

const COMPACTION_RETRY_POLICY: RetryPolicy = {
  enabled: true,
  maxRetries: 1,
  baseDelayMs: 1_000,
};

/** Run compaction once while retrying only the individual failed provider call. */
async function compactWithRetry(
  preparation: Parameters<typeof compact>[0],
  models: Parameters<typeof compact>[1],
  model: Parameters<typeof compact>[2],
  abortSignal?: AbortSignal,
): Promise<{
  result: Awaited<ReturnType<typeof compact>>;
  attemptCount: number;
  providerCalls: ProviderCallStats;
}> {
  const providerCalls: ProviderCallStats = { total: 0, succeeded: 0, failed: 0 };
  const countedModels = new Proxy(models, {
    get(target, property, receiver) {
      if (property !== "completeSimple") return Reflect.get(target, property, receiver);
      return async (...args: Parameters<typeof target.completeSimple>) => {
        providerCalls.total += 1;
        try {
          const response = await target.completeSimple(...args);
          if (response.stopReason === "error" || response.stopReason === "aborted") {
            providerCalls.failed += 1;
          } else {
            providerCalls.succeeded += 1;
          }
          return response;
        } catch (error) {
          providerCalls.failed += 1;
          throw error;
        }
      };
    },
  });
  const result = await compact(
    preparation,
    countedModels,
    model,
    undefined,
    undefined,
    COMPACTION_RETRY_POLICY,
    undefined,
    abortSignal ? withAbortSignal(abortSignal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT,
  );

  return { result, attemptCount: 1, providerCalls };
}

async function restorePreCompactionState(handle: SessionHandle, archivePath: string) {
  const restored = await handle.sessionManager.restoreFromArchive(archivePath).catch((error) => {
    logger.error(`[Compaction] restoreFromArchive failed sessionId=${handle.sessionId}:`, error);
    return false;
  });
  if (!restored) return false;
  handle.session.agent.state.messages = handle.sessionManager.buildSessionContext().messages;
  await refreshSessionHandleFileSignature(handle);
  return true;
}

/**
 * Check if the session needs auto-compaction and run it if so.
 * Called before LLM requests while the session lock is held.
 *
 * Order of operations (failures are non-destructive):
 *   1. LLM summarization — if fails, nothing is touched
 *   2. Session file: append compaction entry, archive old file, rewrite trimmed
 *   3. Rebuild agent state from compacted context, measure tokensAfter
 *   4. DB persistence (compact turn + system message, re-sequence) with real tokensAfter + archivePath
 *
 * The caller is responsible for returning the rebuilt session context to the
 * current LLM request after compaction. This keeps the active request aligned
 * with the rewritten session file and refreshed agent state.
 */
export async function maybeAutoCompact(
  handle: SessionHandle,
  input: { actorUserId: string | null; abortSignal?: AbortSignal; force?: boolean },
): Promise<CompactionOutcome> {
  const model = handle.session.agent.state.model;
  const contextWindow = model.contextWindow ?? 0;
  if (!contextWindow) return { compacted: false, reason: "no_context_window" };

  const settings = resolveCompactionSettings(contextWindow);
  if (!settings.enabled) return { compacted: false, reason: "disabled" };

  const force = input.force === true;
  const messages = handle.session.agent.state.messages;
  const tokenBudget = getContextTokenBudget(messages);
  // Provider usage undercounts inline base64 images on proxies that bill them
  // as text, so take the larger of the two views for the threshold decision.
  // tokensBefore reporting keeps using the accurate provider number.
  const proxyTokens = estimateProxyContextTokens(messages);
  const thresholdTokens = Math.max(tokenBudget?.estimatedTokens ?? 0, proxyTokens);
  if (!force) {
    if (!tokenBudget && proxyTokens <= 0) return { compacted: false, reason: "no_usage_data" };
    if (!shouldCompact(thresholdTokens, contextWindow, settings)) {
      return { compacted: false, reason: "below_threshold" };
    }
  }

  const tokensLabel = tokenBudget?.estimatedTokens ?? "unknown";
  logger.info(
    `[Compaction] ${force ? "overflow-compact" : "auto-compact"} triggered sessionId=${handle.sessionId} contextWindow=${contextWindow} reserve=${settings.reserveTokens} tokens=${tokensLabel} proxyTokens=${proxyTokens}`,
  );

  let compactionEntryAppended = false;
  let archivePathForRecovery: string | undefined;
  let dbPersisted = false;

  const tracer = getAgentTracer();
  const outcome = await tracer.startActiveSpan("agent.compaction", async (span): Promise<CompactionOutcome> => {
    span.setAttribute("cohub.session_id", handle.sessionId);
    span.setAttribute("agent.context_window", contextWindow);
    span.setAttribute("agent.compaction.force", force);

    try {
      // ── 1. Prepare & summarize ──
      // The transform hook runs between LLM rounds, so every branch entry here
      // is settled and the completed prefix of the active turn is safe to compact.
      await handle.persistenceChain;
      const branchEntries = handle.sessionManager.getCompactionEntries();
      const preparationResult = prepareCompaction(branchEntries, settings);
      if (!preparationResult.ok) {
        span.setAttribute("agent.compaction.error", preparationResult.error.message);
        return { compacted: false, reason: `prepare_failed: ${preparationResult.error.message}` };
      }
      const preparationValue = preparationResult.value;
      if (!preparationValue) {
        return { compacted: false, reason: "nothing_to_compact" };
      }
      const preparation = {
        ...preparationValue,
        tokensBefore: tokenBudget?.accurateTokens ?? preparationValue.tokensBefore,
      };
      const summarizedMessageCount = getCompactionSummaryMessageCount(preparation);
      if (summarizedMessageCount === 0) {
        return { compacted: false, reason: "nothing_to_summarize" };
      }
      const firstKeptEntryId = findFirstKeptEntryId(branchEntries, preparation.retainedTail);
      if (!firstKeptEntryId) {
        span.setAttribute("agent.compaction.error", "missing_first_kept_entry_id");
        logger.warn(`[Compaction] missing firstKeptEntryId sessionId=${handle.sessionId}`);
        return { compacted: false, reason: "missing_first_kept_entry_id" };
      }

      span.setAttribute("agent.compaction.tokens_before", preparation.tokensBefore);
      span.setAttribute("agent.compaction.proxy_tokens", proxyTokens);
      span.setAttribute("agent.compaction.messages_to_summarize", preparation.messagesToSummarize.length);
      span.setAttribute("agent.compaction.turn_prefix_messages", preparation.turnPrefixMessages.length);
      span.setAttribute("agent.compaction.is_split_turn", preparation.isSplitTurn);

      const apiKey = handle.session.modelRegistry.getApiKey(model.provider);
      if (!apiKey) return { compacted: false, reason: "no_api_key" };

      const models = createModelsFromCohubRegistry(handle.session.modelRegistry, model);
      const compactStartedAt = Date.now();
      const compactAttempt = await compactWithRetry(preparation, models, model, input.abortSignal);
      const compactDurationMs = Math.max(0, Date.now() - compactStartedAt);
      if (!compactAttempt.result.ok) {
        span.setAttribute("agent.compaction.error", compactAttempt.result.error.message);
        logger.warn(`[Compaction] summarization failed sessionId=${handle.sessionId}: ${compactAttempt.result.error.message}`);
        return { compacted: false, reason: `compact_failed: ${compactAttempt.result.error.message}` };
      }
      const result = compactAttempt.result.value;
      const estimatedTokensAfter = estimateProxyContextTokens([
        {
          role: "compactionSummary",
          summary: result.summary,
          tokensBefore: result.tokensBefore,
          timestamp: Date.now(),
        } as AgentMessage,
        ...result.retainedTail,
      ]);
      span.setAttribute("agent.compaction.estimated_tokens_after", estimatedTokensAfter);
      span.setAttribute("agent.compaction.attempt_count", compactAttempt.attemptCount);
      span.setAttribute("agent.compaction.provider_call_count", compactAttempt.providerCalls.total);
      span.setAttribute("agent.compaction.provider_success_count", compactAttempt.providerCalls.succeeded);
      span.setAttribute("agent.compaction.provider_error_count", compactAttempt.providerCalls.failed);
      span.setAttribute("agent.compaction.duration_ms", compactDurationMs);
      const invalidEffect = validateCompactionEffect({
        estimatedTokensBefore: Math.max(thresholdTokens, result.tokensBefore),
        estimatedTokensAfter,
        inputBudget: Math.max(1, contextWindow - settings.reserveTokens),
        force,
      });
      if (invalidEffect) {
        span.setAttribute("agent.compaction.error", invalidEffect);
        logger.warn(
          `[Compaction] rejected ineffective result sessionId=${handle.sessionId} reason=${invalidEffect} tokensBefore=${result.tokensBefore} estimatedTokensAfter=${estimatedTokensAfter}`,
        );
        return { compacted: false, reason: invalidEffect };
      }

      // ── 2. Resolve turn placement before mutating the session file ──
      // Must run before archiveAndRewrite: for in-turn cuts the current turn's
      // user message (the only branch entry carrying meta.turnId — assistant
      // entries never do) sits before the cut and is removed by the rewrite.
      // Resolving afterwards leaves no entry with a turnId to resolve from,
      // silently degrading in-turn compactions to "between_turns" and
      // appending the compact turn at the end of the timeline.
      const firstKeptTurnStartEntryId = handle.sessionManager.findTurnStartEntryId(firstKeptEntryId);
      const firstKeptTurnId =
        (firstKeptTurnStartEntryId
          ? handle.sessionManager.getEntryTurnId(firstKeptTurnStartEntryId)
          : null) ?? handle.sessionManager.getFirstKeptTurnId(firstKeptEntryId);
      const { scope, ownerTurnId } = resolveCompactionScope(preparation, firstKeptTurnId);

      // ── 3. Session file: append compaction entry, archive, rewrite ──
      const compactionEntryId = handle.sessionManager.appendCompaction(
        result.summary,
        firstKeptEntryId,
        result.tokensBefore,
        result.details,
      );
      compactionEntryAppended = true;

      const archivePath = await handle.sessionManager.archiveAndRewrite(
        compactionEntryId,
        firstKeptEntryId,
      );

      if (!archivePath) {
        // File archive/rewrite failed before rewriting. The compaction entry
        // was appended but is still at the end of entries. removeLastEntry
        // removes it from memory and rewrites the file.
        logger.error(`[Compaction] archiveAndRewrite failed sessionId=${handle.sessionId}, aborting compaction`);
        span.setAttribute("agent.compaction.error", "archive_rewrite_failed");
        handle.sessionManager.removeLastEntry();
        compactionEntryAppended = false;
        return { compacted: false, reason: "archive_rewrite_failed" };
      }
      archivePathForRecovery = archivePath;

      // ── 4. Rebuild agent state ──
      const sessionContext = handle.sessionManager.buildSessionContext();
      handle.session.agent.state.messages = sessionContext.messages;
      await refreshSessionHandleFileSignature(handle);

      span.setAttribute("agent.compaction.archive_path", archivePath);

      // ── 5. Resolve DB sequence for the compact turn ──
      let insertBeforeTurnSequence: number | null = null;
      if (scope === "between_turns") {
        if (firstKeptTurnId) {
          const [turnRow] = await db.select({ sequence: sessionTurns.sequence })
            .from(sessionTurns)
            .where(and(eq(sessionTurns.id, firstKeptTurnId), eq(sessionTurns.sessionId, handle.sessionId)))
            .limit(1);
          insertBeforeTurnSequence = turnRow?.sequence ?? null;
        }
        if (insertBeforeTurnSequence == null) {
          logger.warn(`[Compaction] could not resolve firstKeptTurnId sequence; appending compact turn at end`);
          const [maxRow] = await db.select({ max: sql<number>`coalesce(max(${sessionTurns.sequence}), 0)::int` })
            .from(sessionTurns).where(eq(sessionTurns.sessionId, handle.sessionId));
          insertBeforeTurnSequence = (maxRow?.max ?? 0) + 1;
        }
      }

      // ── 6. DB persistence ──
      const toolContext = getCurrentToolExecutionContext();
      const dbResult = await persistCompactionEvent({
        spaceId: handle.spaceId,
        sessionId: handle.sessionId,
        actorUserId: input.actorUserId,
        compactionId: compactionEntryId,
        scope,
        ownerTurnId,
        firstKeptTurnId,
        llmRound: handle.currentLlmRound ?? toolContext?.llmRound ?? null,
        triggerReason: force ? "overflow_recovery" : "threshold",
        summary: result.summary,
        tokensBefore: result.tokensBefore,
        estimatedTokensAfter,
        firstKeptEntryId,
        model: { provider: model.provider, id: model.id },
        contextWindow,
        keepRecentTokens: settings.keepRecentTokens,
        summarizedMessageCount,
        attemptCount: compactAttempt.attemptCount,
        providerCalls: compactAttempt.providerCalls,
        isSplitTurn: preparation.isSplitTurn,
        usage: result.usage,
        durationMs: compactDurationMs,
        archivePath,
        insertBeforeTurnSequence,
      });

      if (!dbResult) {
        // DB failed. archiveAndRewrite already succeeded, so the compaction
        // entry is root (index 0), not last. Use restoreFromArchive to reload
        // the pre-compaction state from the archive copy.
        logger.error(
          `[Compaction] DB persistence failed; restoring session file from archive sessionId=${handle.sessionId}`,
        );
        span.setAttribute("agent.compaction.error", "db_persistence_failed");
        const restored = await restorePreCompactionState(handle, archivePath);
        archivePathForRecovery = undefined;
        compactionEntryAppended = false;
        if (!restored) throw new CompactionStateRecoveryError(handle.sessionId);
        return { compacted: false, reason: "db_persistence_failed" };
      }
      dbPersisted = true;
      archivePathForRecovery = undefined;
      compactionEntryAppended = false;

      if (
        dbResult.compactSequence != null &&
        handle.currentTurnSeq != null &&
        dbResult.compactSequence <= handle.currentTurnSeq
      ) {
        handle.currentTurnSeq += 1;
        if (handle.activeAssistantContext?.turnSeq != null) {
          handle.activeAssistantContext.turnSeq += 1;
        }
      }
      if (
        dbResult.compactSequence != null &&
        toolContext?.sessionId === handle.sessionId &&
        toolContext.turnSeq != null &&
        dbResult.compactSequence <= toolContext.turnSeq
      ) {
        toolContext.turnSeq += 1;
      }

      logger.info(
        `[Compaction] done sessionId=${handle.sessionId} scope=${scope} tokensBefore=${result.tokensBefore} estimatedTokensAfter=${estimatedTokensAfter} archive=${archivePath}`,
      );

      return {
        compacted: true,
        summary: result.summary,
        tokensBefore: result.tokensBefore,
        estimatedTokensAfter,
        firstKeptEntryId,
        archivePath,
        compactSequence: dbResult.compactSequence,
        usage: result.usage,
        durationMs: compactDurationMs,
        attemptCount: compactAttempt.attemptCount,
      };
    } catch (error) {
      span.recordException(error as Error);
      logger.error(`[Compaction] unexpected error sessionId=${handle.sessionId}:`, error);
      if (error instanceof CompactionStateRecoveryError) throw error;
      if (!dbPersisted && archivePathForRecovery) {
        const restored = await restorePreCompactionState(handle, archivePathForRecovery);
        if (!restored) throw new CompactionStateRecoveryError(handle.sessionId);
      } else if (!dbPersisted && compactionEntryAppended) {
        try {
          handle.sessionManager.removeLastEntry();
        } catch (cleanupError) {
          logger.error(`[Compaction] cleanup removeLastEntry failed sessionId=${handle.sessionId}:`, cleanupError);
        }
      }
      return { compacted: false, reason: `error: ${error instanceof Error ? error.message : String(error)}` };
    }
  });
  return outcome;
}
