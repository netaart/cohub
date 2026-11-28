import { resolveWalletMessageEligibility } from "@cohub/core/space-wallet";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { ContentBlock, Usage } from "@cohub/protocol/core";
import type { PersistMessageInput, SessionTurnStatus } from "@cohub/protocol/model";
import type { AgentTurnAbortEvent } from "@cohub/protocol";
import { usageCredentialMeta } from "@cohub/protocol/runtime";
import { sessionMessages, sessionTurns, spaceSessions } from "@cohub/db";
import { collectImageToTextTiming, collectToolMetrics } from "@cohub/protocol/model";
import { interruptedSummaryPatch, interruptedTurnUsage, isFinalAssistantMessageMeta, runtimeResolutionOpen, withNextSessionMessageSequence, addImageToTextCallsToSummary, claimSessionFallbackTitle, countToolCallsInContent, deriveMessagePreviewText, deriveSessionFallbackTitle, finalizeImageToTextUsageSummary, readImageToTextCalls, readSessionTitleSource, resolveMessageTurnId, shouldGenerateSessionTitle, createImageToTextUsageSummaryAccumulator, sumImageToTextUsage } from "@cohub/core/sessions";
import { scheduleSessionSnapshot } from "./session-snapshot.js";
import { sanitizeContentBlocksForPostgresJson, sanitizePostgresJsonValue } from "@cohub/core/content/sanitize";
import { enqueueSessionMessagePostprocess } from "./session-message-postprocess-queue.js";
import { enqueueSessionTitleGeneration } from "./session-title-queue.js";
import { normalizeAssistantTurn } from "./assistant-message-normalizer.js";
import { indexTurnReferences } from "./reference-index.js";
import { db } from "./db.js";
import { buildUserMessagesForBatch, type ClaimedTurnBatch } from "./batch.js";
import { logger } from "./logger.js";
import { publishRealtimeEnvelope } from "./redis.js";
import { buildAssistantIdempotencyKey, buildUserIdempotencyKey, completeMessageTiming, normalizeRecord, normalizeUsage, toDateOrNull, toMessageRecord, toTurnRecord } from "./persistence-records.js";
import { publishMessagePersisted, publishTurnFinalized, publishTurnState } from "./persistence-events.js";
import { addUsage, buildIntermediateObjectsForTurn } from "./persistence-intermediates.js";
import { dispatchFinalAssistantToGateway } from "./persistence-gateway.js";
import type { CohubModelRegistry } from "./runtime/model-registry.js";
export { publishSessionTurnsUpdated } from "./persistence-events.js";
export { persistCompactionEvent } from "./persistence-compaction.js";

async function updateSessionAfterAppend(sessionId: string, message: typeof sessionMessages.$inferSelect) {
  await db.update(spaceSessions).set({ lastMessageId: message.id, latestMessageText: message.text, lastMessageAt: message.createdAt ?? new Date(), updatedAt: new Date() }).where(eq(spaceSessions.id, sessionId));
}

type PersistenceTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function persistMessageNode(input: PersistMessageInput & { message: PersistMessageInput["message"] & { id?: string } }, finalizeLocal?: (tx: PersistenceTransaction, message: typeof sessionMessages.$inferSelect) => Promise<void>): Promise<{ message: typeof sessionMessages.$inferSelect; created: boolean }> {
  const [existing] = await db.select().from(sessionMessages).where(and(eq(sessionMessages.sessionId, input.sessionId), eq(sessionMessages.idempotencyKey, input.idempotencyKey))).limit(1);
  if (existing) {
    if (existing.role === "user") {
      try {
        const [session] = await db.select({ meta: spaceSessions.meta })
          .from(spaceSessions)
          .where(eq(spaceSessions.id, input.sessionId))
          .limit(1);
        if (
          readSessionTitleSource(session?.meta) === "fallback"
          && shouldGenerateSessionTitle({ content: existing.content })
        ) {
          await enqueueSessionTitleGeneration({
            sessionId: input.sessionId,
            messageId: existing.id,
            userId: input.userId ?? null,
          });
        }
      } catch (error) {
        logger.warn("[SessionTitle] failed to re-enqueue title generation", error);
      }
    }
    return { message: existing, created: false };
  }

  const [session] = await db.select({ id: spaceSessions.id, spaceId: spaceSessions.spaceId }).from(spaceSessions).where(eq(spaceSessions.id, input.sessionId)).limit(1);
  if (!session || session.spaceId !== input.spaceId) throw new Error("Space session not found");

  if (input.previousMessageId) {
    const [previous] = await db.select({ id: sessionMessages.id }).from(sessionMessages).where(and(eq(sessionMessages.id, input.previousMessageId), eq(sessionMessages.sessionId, input.sessionId))).limit(1);
    if (!previous) throw new Error("Previous message not found");
  }

  const content = sanitizeContentBlocksForPostgresJson(input.message.content);
  const text = deriveMessagePreviewText({ content }) || null;
  const messageRole = input.message.role ?? "assistant";
  const normalizedUsage = normalizeUsage(input.message.usage);
  const isAborted = input.message.stopReason === "aborted";
  const hasError = Boolean(input.message.errorMessage) || input.message.stopReason === "error";
  const isUnsuccessful = hasError || isAborted;
  if (messageRole === "assistant" && content.length === 0 && !text?.trim() && !isUnsuccessful) throw new Error("Refusing to persist empty assistant message");

  const requestedMessageKind = input.message.meta?.messageKind;
  // Explicit intermediate/final kinds win over inference so local streamed commits stay intermediate.
  const messageKind = messageRole !== "assistant"
    ? messageRole
    : requestedMessageKind === "assistant_intermediate"
      ? "assistant_intermediate"
      : isUnsuccessful
        ? "assistant_error"
        : requestedMessageKind === "shell_command_result" || requestedMessageKind === "assistant_final"
          ? "assistant_final"
          : countToolCallsInContent(content) > 0 || input.message.stopReason === "tool_use"
            ? "assistant_intermediate"
            : "assistant_final";
  const completedAt = toDateOrNull(input.message.completedAt) ?? new Date();
  const startedAt = toDateOrNull(input.message.startedAt) ?? completedAt;
  const durationMs = typeof input.message.durationMs === "number" ? Math.max(0, Math.floor(input.message.durationMs)) : Math.max(0, completedAt.getTime() - startedAt.getTime());
  const anchorUserMessageId = input.anchorUserMessageId?.trim() || null;
  const messageTurnId = resolveMessageTurnId(input.message.meta);

  const values: Omit<typeof sessionMessages.$inferInsert, "sequence"> = {
    id: input.message.id?.trim() || undefined,
    sessionId: input.sessionId,
    turnId: messageTurnId,
    role: messageRole,
    content,
    text,
    meta: sanitizePostgresJsonValue({ ...input.message.meta, walletBillingEligible: resolveWalletMessageEligibility(), messageKind, anchorUserMessageId, actorUserId: input.userId ?? null, providerResponseId: input.message.meta?.responseId ?? null }),
    idempotencyKey: input.idempotencyKey,
    provider: input.message.provider ?? null,
    model: input.message.model ?? null,
    stopReason: input.message.stopReason ?? null,
    errorMessage: isAborted ? null : input.message.errorMessage ?? null,
    usage: normalizedUsage,
    startedAt,
    completedAt,
    durationMs,
  };
  const localResult = messageRole === "assistant" && input.message.meta?.runtime === "local";
  let created = true;
  const [messageNode] = await withNextSessionMessageSequence(db, input.sessionId, (sequence) => localResult ? db.transaction(async (tx) => {
    if (!messageTurnId) throw new Error("Runtime result has no turn identity");
    const resolution = input.message.meta?.runtimeResolution === true;
    const [turn] = await tx.select({ id: sessionTurns.id, status: sessionTurns.status }).from(sessionTurns)
      .where(and(eq(sessionTurns.id, messageTurnId), eq(sessionTurns.sessionId, input.sessionId), resolution ? sql`${sessionTurns.meta}->'runtimeRecovery'->>'state' = 'confirmed_stopped'` : runtimeResolutionOpen)).limit(1).for("update");
    if (!turn) throw new Error("Runtime execution was manually resolved; late result retained locally");
    const [duplicate] = await tx.select().from(sessionMessages).where(and(eq(sessionMessages.sessionId, input.sessionId), eq(sessionMessages.idempotencyKey, input.idempotencyKey))).limit(1);
    if (duplicate) { created = false; return [duplicate]; }
    if (!["running", "abort_requested"].includes(turn.status)) throw new Error("Runtime execution already finalized");
    const [message] = await tx.insert(sessionMessages).values({ ...values, sequence }).returning();
    if (!message) throw new Error("Failed to persist Runtime message");
    if (finalizeLocal) await finalizeLocal(tx, message);
    await tx.update(spaceSessions).set({ lastMessageId: message.id, latestMessageText: message.text, lastMessageAt: message.createdAt ?? new Date(), updatedAt: new Date() }).where(eq(spaceSessions.id, input.sessionId));
    return [message];
  }) : db.insert(sessionMessages).values({ ...values, sequence }).returning());
  if (!messageNode) throw new Error("Failed to persist message");

  if (messageRole === "user") {
    try {
      const fallbackTitle = deriveSessionFallbackTitle({ content, text });
      if (
        fallbackTitle
        && await claimSessionFallbackTitle(db, { sessionId: input.sessionId, title: fallbackTitle })
        && shouldGenerateSessionTitle({ content })
      ) {
        await enqueueSessionTitleGeneration({
          sessionId: input.sessionId,
          messageId: messageNode.id,
          userId: input.userId ?? null,
        });
      }
    } catch (error) {
      logger.warn("[SessionTitle] failed to prepare title generation", error);
    }
  }
  if (!localResult) await updateSessionAfterAppend(input.sessionId, messageNode);
  return { message: messageNode, created };
}

async function finalizeSessionTurnFromMessage(input: { spaceId: string; sessionId: string; turnId: string; status: Exclude<SessionTurnStatus, "running">; assistantContent: ContentBlock[]; assistantText: string | null; provider: string | null; model: string | null; stopReason: string | null; errorMessage: string | null; usage: Usage | null; metaPatch?: Record<string, unknown> | null }, executor: Pick<typeof db, "update"> = db, prepared?: Awaited<ReturnType<typeof buildIntermediateObjectsForTurn>>) {
  const intermediate = prepared ?? await buildIntermediateObjectsForTurn(input);
  const imageToText = intermediate?.imageToTextAccumulator ?? createImageToTextUsageSummaryAccumulator();
  const finalCalls = readImageToTextCalls(input.metaPatch);
  addImageToTextCallsToSummary(imageToText, finalCalls);
  const imageToTextSummary = finalizeImageToTextUsageSummary(imageToText);
  const currentImageToText = normalizeRecord(input.metaPatch?.imageToText);
  const turnMetaPatch = {
    ...(input.metaPatch ?? {}),
    ...(imageToTextSummary.callCount > 0
      ? { imageToText: { ...(currentImageToText ?? {}), schemaVersion: 1, summary: imageToTextSummary } }
      : {}),
  };
  const completedAt = new Date();
  const completedAtIso = completedAt.toISOString();
  const [row] = await executor.update(sessionTurns).set({
    status: input.status,
    assistantContent: input.assistantContent,
    assistantText: input.assistantText,
    provider: input.provider,
    model: input.model,
    stopReason: input.stopReason,
    errorMessage: input.errorMessage,
    finalUsage: input.usage,
    totalUsage: addUsage(addUsage(intermediate?.summary.usage, input.usage), sumImageToTextUsage(input.metaPatch)),
    meta: sql`coalesce(${sessionTurns.meta}, '{}'::jsonb) || ${JSON.stringify(turnMetaPatch)}::jsonb || jsonb_build_object('metrics', coalesce(${sessionTurns.meta}->'metrics', '{}'::jsonb) || ${JSON.stringify({ version: 1, tools: collectToolMetrics([...intermediate.rows.map((message) => message.content), input.assistantContent]), imageToText: collectImageToTextTiming(intermediate.rows.map((message) => message.meta)) })}::jsonb)`,
    summary: { text: input.assistantText, finishReason: input.status === "interrupted" ? "interrupted" : input.status === "failed" ? "failed" : "completed" },
    intermediateIndex: intermediate?.index ?? null,
    intermediateSummary: intermediate?.summary ?? null,
    completedAt,
    durationMs: sql<number>`greatest(0, floor(extract(epoch from (${completedAtIso}::timestamptz - ${sessionTurns.startedAt})) * 1000)::int)`,
    updatedAt: completedAt,
  }).where(and(eq(sessionTurns.id, input.turnId), eq(sessionTurns.sessionId, input.sessionId), inArray(sessionTurns.status, ["running", "abort_requested", "interrupted"]), input.metaPatch?.runtimeResolution === true ? undefined : runtimeResolutionOpen)).returning();
  return { turn: row ? toTurnRecord(row) : null, messages: intermediate.rows };
}

export async function persistBatchUserMessages(input: { spaceId: string; sessionId: string; batch: ClaimedTurnBatch }) {
  const users = buildUserMessagesForBatch(input.batch);
  if (!users.length) return;
  const rows = await db.select({ id: sessionMessages.id, turnId: sessionMessages.turnId, role: sessionMessages.role }).from(sessionMessages)
    .where(and(eq(sessionMessages.sessionId, input.sessionId), inArray(sessionMessages.id, users.map((user) => user.userMessageId))));
  const existing = new Map(rows.map((row) => [row.id, row]));
  // Claim/recovery metadata can change. Stable message IDs, not a metadata hash, fence replay.
  for (const user of users) {
    const previous = existing.get(user.userMessageId);
    if (previous) {
      if (previous.turnId !== user.turnId || previous.role !== "user") throw new Error("Batch message identity mismatch");
      continue;
    }
    await persistUserMessage({ spaceId: input.spaceId, sessionId: input.sessionId, ...user });
  }
}

export async function persistUserMessage(input: { spaceId: string; sessionId: string; userMessageId: string; turnId: string; agentSessionEntryId?: string | null; content: ContentBlock[]; meta?: Record<string, unknown> | null; startedAt?: string | null }) {
  const turnId = resolveMessageTurnId({ turnId: input.turnId });
  if (!turnId) throw new Error("Valid user message turn id is required");
  const [turnRow] = await db.select().from(sessionTurns).where(and(
    eq(sessionTurns.id, turnId),
    eq(sessionTurns.sessionId, input.sessionId),
  )).limit(1);
  if (!turnRow) throw new Error("User message turn not found in session");
  const timing = completeMessageTiming({ startedAt: input.startedAt });
  const persisted = await persistMessageNode({
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    previousMessageId: null,
    anchorUserMessageId: input.userMessageId,
    userId: turnRow.userUuid ?? null,
    idempotencyKey: await buildUserIdempotencyKey({ messageId: input.userMessageId, content: input.content, meta: input.meta ?? null }),
    message: { id: input.userMessageId, role: "user", content: input.content, meta: { ...(input.meta ?? {}), turnId, messageId: input.userMessageId, clientMessageId: typeof input.meta?.clientMessageId === "string" ? input.meta.clientMessageId : null, agentSessionEntryId: input.agentSessionEntryId ?? (typeof input.meta?.sessionEntryId === "string" ? input.meta.sessionEntryId : null) }, provider: null, model: null, stopReason: null, errorMessage: null, usage: null, ...timing },
  });
  const record = toMessageRecord(persisted.message);
  if (!persisted.created) return { ok: true, message: record, created: false };
  await publishMessagePersisted(input.spaceId, record);
  return { ok: true, message: record };
}

const EMPTY_ASSISTANT_MESSAGE_ERROR = "LLM returned an empty assistant message after streaming completed.";

export async function persistAssistantMessage(input: { spaceId: string; spaceSessionId: string; userMessageId: string; event: Record<string, unknown>; userId?: string | null; turnId?: string | null; startedAt?: string | null; completedAt?: string | null; messageOrdinal?: number | null; thinkingLevel?: string | null; contextWindow?: number | null; contextWindowSource?: string | null; idempotencyKey?: string; modelRegistry?: Pick<CohubModelRegistry, "find"> }) {
  const assistantMessage = input.event.message;
  const contextMeta = typeof input.contextWindow === "number" && input.contextWindow > 0
    ? { contextWindow: input.contextWindow, ...(input.contextWindowSource ? { contextWindowSource: input.contextWindowSource } : {}) }
    : {};
  const toolResultsRaw = Array.isArray(input.event.toolResults) ? input.event.toolResults as Array<Record<string, unknown>> : [];
  if (!assistantMessage || typeof assistantMessage !== "object") {
    logger.warn("[Persist] turn_end event missing assistant message payload.");
    return;
  }
  const assistant = assistantMessage as Record<string, unknown>;
  const normalized = normalizeAssistantTurn(assistant, toolResultsRaw);
  const stopReason = typeof assistant.stopReason === "string" ? assistant.stopReason : null;
  const errorMessage = typeof assistant.errorMessage === "string" ? assistant.errorMessage : null;
  const hasAssistantError = stopReason === "error" || stopReason === "aborted" || Boolean(errorMessage);
  const isEmptySuccessfulAssistant = normalized.content.length === 0 && !hasAssistantError;
  const effectiveStopReason = isEmptySuccessfulAssistant ? "error" : stopReason;
  const effectiveErrorMessage = isEmptySuccessfulAssistant ? EMPTY_ASSISTANT_MESSAGE_ERROR : errorMessage;
  const timing = completeMessageTiming({ startedAt: input.startedAt, completedAt: input.completedAt });
  const provider = typeof assistant.provider === "string" ? assistant.provider : null;
  const model = typeof assistant.model === "string" ? assistant.model : null;
  const credentialMeta = input.modelRegistry ? usageCredentialMeta(provider && model ? input.modelRegistry.find(provider, model) : null) : {};

  const message: PersistMessageInput["message"] = {
    role: "assistant",
    externalMessageId: typeof assistant.id === "string" ? assistant.id : null,
    protocolMessageId: typeof assistant.id === "string" ? assistant.id : null,
    content: normalized.content,
    provider,
    model,
    stopReason: effectiveStopReason,
    errorMessage: effectiveErrorMessage,
    // messageOrdinal 必须与 stream_update(session.turn.patch) 事件里的 messageOrdinal 保持同一套编号体系，
    // 否则 SDK 的 messageRecordToIntermediate(处理 session.message.persisted 事件)
    // 会因为读不到 meta.messageOrdinal 而 fallback 到 messageId=message.id(DB UUID)，
    // 与 stream-snapshot API 重新编号的 ordinal:N 不在同一套去重 key 体系里，
    // 导致同一条中间消息在快照恢复与实时事件两条路径里无法合并，最终在
    // ProcessCard/ToolCallList 的 {#each ... (id)} 产生重复 key(each_key_duplicate)。
    meta: { ...(normalizeRecord(assistant.meta) ?? {}), turnId: input.turnId ?? null, spaceId: input.spaceId, sessionId: input.spaceSessionId, nativeApi: typeof assistant.api === "string" ? assistant.api : null, rawStopReason: stopReason, messageOrdinal: input.messageOrdinal ?? null, ...contextMeta, ...(isEmptySuccessfulAssistant ? { emptyAssistantMessageConvertedToError: true } : {}), thinking: normalized.thinking, thinkingSummary: normalized.thinkingSummary, toolCallRenderStates: normalized.toolCallRenderStates, agentSessionEntryId: typeof assistant.sessionEntryId === "string" ? assistant.sessionEntryId : null, ...credentialMeta },
    usage: normalizeUsage(assistant.usage as PersistMessageInput["message"]["usage"]),
    ...timing,
  };
  const local = message.meta?.runtime === "local";
  const localFinal = local && (message.meta?.messageKind === "assistant_final" || message.meta?.messageKind === "assistant_error");
  if (local && input.idempotencyKey) {
    const [existing] = await db.select().from(sessionMessages).where(and(eq(sessionMessages.sessionId, input.spaceSessionId), eq(sessionMessages.idempotencyKey, input.idempotencyKey))).limit(1);
    if (existing) return { ok: true, message: toMessageRecord(existing), created: false };
  }
  const prepared = localFinal && input.turnId ? await buildIntermediateObjectsForTurn({ spaceId: input.spaceId, sessionId: input.spaceSessionId, turnId: input.turnId }) : undefined;
  const persisted = await persistMessageNode({ spaceId: input.spaceId, sessionId: input.spaceSessionId, previousMessageId: input.userMessageId, anchorUserMessageId: input.userMessageId, userId: input.userId ?? null, idempotencyKey: input.idempotencyKey ?? await buildAssistantIdempotencyKey({ previousMessageId: input.userMessageId, message }), message }, localFinal ? async (tx, row) => {
    if (!input.turnId) throw new Error("Missing Runtime final turn identity");
    const result = await finalizeSessionTurnFromMessage({ spaceId: input.spaceId, sessionId: input.spaceSessionId, turnId: input.turnId,
      status: effectiveStopReason === "aborted" ? "interrupted" : effectiveStopReason === "error" || effectiveErrorMessage ? "failed" : "completed",
      assistantContent: row.content, assistantText: row.text, provider: row.provider, model: row.model, stopReason: row.stopReason, errorMessage: row.errorMessage, usage: row.usage as Usage | null,
      metaPatch: { ...(message.meta?.runtimeResolution === true ? { runtimeResolution: true } : {}), runtimeArchiveStatus: message.meta?.runtimeArchiveStatus ?? "failed", finalMessageDurationMs: row.durationMs,
        ...(input.thinkingLevel ? { effectiveThinkingLevel: input.thinkingLevel } : {}),
        ...(message.meta?.usageLimit ? { usageLimit: message.meta.usageLimit } : {}),
      },
    }, tx, prepared);
    if (!result.turn) throw new Error("Runtime finalization lost its turn");
  } : undefined);
  const record = toMessageRecord(persisted.message);
  if (local) {
    if (persisted.created && prepared && input.turnId) indexTurnReferences({ spaceId: input.spaceId, sessionId: input.spaceSessionId, turnId: input.turnId, messages: [...prepared.rows, persisted.message] });
    if (persisted.created) {
      await publishMessagePersisted(input.spaceId, record).catch((error) => logger.warn("[Realtime] failed to publish local Runtime message", error));
      await enqueueSessionMessagePostprocess({ sessionId: input.spaceSessionId, message: record }).catch((error) => logger.warn("[Postprocess] failed to enqueue local Runtime message", error));
    }
    if (localFinal && input.turnId) {
      const [turn] = await db.select().from(sessionTurns).where(eq(sessionTurns.id, input.turnId)).limit(1);
      if (turn) await publishTurnFinalized(input.spaceId, toTurnRecord(turn)).catch((error) => logger.warn("[Realtime] failed to publish local Runtime turn", error));
      await dispatchFinalAssistantToGateway({ spaceId: input.spaceId, sessionId: input.spaceSessionId, message: record }).catch((error) => logger.warn("[GatewayOutbound] failed to dispatch local Runtime message", error));
    }
    return { ok: true, message: record, created: persisted.created };
  }
  if (!persisted.created && !input.idempotencyKey) {
    await enqueueSessionMessagePostprocess({ sessionId: input.spaceSessionId, message: record });
    return { ok: true, message: record, created: false };
  }
  if (persisted.created) await publishMessagePersisted(input.spaceId, record);
  if (record.meta?.messageKind === "assistant_final" || record.meta?.messageKind === "assistant_error") {
    const turnId = typeof record.meta.turnId === "string" ? record.meta.turnId : null;
    if (turnId) {
      const { turn: finalized, messages: turnMessages } = await finalizeSessionTurnFromMessage({ spaceId: input.spaceId, sessionId: input.spaceSessionId, turnId, status: effectiveStopReason === "aborted" ? "interrupted" : record.meta.messageKind === "assistant_error" ? "failed" : "completed", assistantContent: record.content, assistantText: record.text, provider: record.provider, model: record.model, stopReason: record.stopReason, errorMessage: record.errorMessage, usage: record.usage, metaPatch: { ...contextMeta, ...(record.meta.runtimeResolution === true ? { runtimeResolution: true } : {}), ...(typeof record.meta.agentSessionEntryId === "string" ? { agentSessionEntryId: record.meta.agentSessionEntryId } : {}), ...(record.meta.imageToText ? { imageToText: record.meta.imageToText } : {}), ...(typeof record.durationMs === "number" ? { finalMessageDurationMs: record.durationMs } : {}), ...(typeof input.thinkingLevel === "string" && input.thinkingLevel.trim() ? { effectiveThinkingLevel: input.thinkingLevel } : {}) } });
      if (finalized) {
        indexTurnReferences({ spaceId: input.spaceId, sessionId: finalized.sessionId, turnId: finalized.id, messages: turnMessages });
        await publishTurnFinalized(input.spaceId, finalized).catch((error) => logger.warn("[Realtime] failed to publish finalized turn", error));
      }
    }
    if (persisted.created) await dispatchFinalAssistantToGateway({ spaceId: input.spaceId, sessionId: input.spaceSessionId, message: record }).catch((error) => logger.error("[GatewayOutbound] failed to dispatch assistant message", error));
  }
  // Every LLM round is postprocessed, including intermediate tool-use messages.
  // Billing uses a stable message operation ID; hourly aggregation intentionally runs last.
  await enqueueSessionMessagePostprocess({ sessionId: input.spaceSessionId, message: record });
  return { ok: true, message: record };
}

async function finalizeInterruptedTurn(input: { spaceId: string; sessionId: string; turnId: string; stopReason: "interrupted" | "aborted"; summary: Record<string, unknown> }) {
  const [existing] = await db.select().from(sessionTurns).where(and(eq(sessionTurns.id, input.turnId), eq(sessionTurns.sessionId, input.sessionId))).limit(1);
  if (!existing) return { turn: null, messages: [], changed: false, finalized: false };
  if (!["running", "abort_requested", "interrupted"].includes(existing.status)) return { turn: toTurnRecord(existing), messages: [], changed: false, finalized: false };
  if (existing.status === "interrupted" && existing.assistantContent != null) {
    const summary = interruptedSummaryPatch(existing.summary, input.summary);
    if (!summary) return { turn: toTurnRecord(existing), messages: [], changed: false, finalized: false };
    const [updated] = await db.update(sessionTurns).set({ summary: sql`coalesce(${sessionTurns.summary}, '{}'::jsonb) || ${JSON.stringify(summary)}::jsonb`, stopReason: input.stopReason, updatedAt: new Date() })
      .where(and(eq(sessionTurns.id, input.turnId), eq(sessionTurns.sessionId, input.sessionId), eq(sessionTurns.status, "interrupted"), sql`${sessionTurns.summary}->>'reason' is distinct from 'steer'`)).returning();
    return { turn: updated ? toTurnRecord(updated) : null, messages: [], changed: Boolean(updated), finalized: false };
  }
  const intermediate = await buildIntermediateObjectsForTurn(input);
  let last: typeof sessionMessages.$inferSelect | null = null;
  for (let index = intermediate.rows.length - 1; index >= 0; index--) {
    const message = intermediate.rows[index];
    if (message?.role === "assistant") { last = message; break; }
  }
  if (isFinalAssistantMessageMeta(last?.meta)) {
    addImageToTextCallsToSummary(intermediate.imageToTextAccumulator, readImageToTextCalls(last?.meta));
  }
  const imageToTextSummary = finalizeImageToTextUsageSummary(intermediate.imageToTextAccumulator);
  const completedAt = existing.status === "interrupted" && existing.completedAt ? existing.completedAt : new Date();
  const completedAtIso = completedAt.toISOString();
  const metrics = {
    version: 1,
    tools: collectToolMetrics(intermediate.rows.map((message) => message.content)),
    imageToText: collectImageToTextTiming(intermediate.rows.map((message) => message.meta)),
  };
  const metaPatch = imageToTextSummary.callCount > 0 ? { imageToText: { schemaVersion: 1, summary: imageToTextSummary } } : {};
  const [row] = await db.update(sessionTurns).set({
    status: "interrupted",
    assistantContent: last?.content ?? null,
    assistantText: last?.text ?? null,
    provider: last?.provider ?? null,
    model: last?.model ?? null,
    stopReason: input.stopReason,
    errorMessage: null,
    finalUsage: last?.usage ?? null,
    totalUsage: interruptedTurnUsage(intermediate.summary.usage, last),
    summary: input.summary,
    intermediateIndex: intermediate.index ?? null,
    intermediateSummary: intermediate.summary,
    meta: sql`coalesce(${sessionTurns.meta}, '{}'::jsonb) || ${JSON.stringify(metaPatch)}::jsonb || jsonb_build_object('metrics', coalesce(${sessionTurns.meta}->'metrics', '{}'::jsonb) || ${JSON.stringify(metrics)}::jsonb)`,
    completedAt,
    durationMs: sql<number>`greatest(0, floor(extract(epoch from (${completedAtIso}::timestamptz - ${sessionTurns.startedAt})) * 1000)::int)`,
    updatedAt: completedAt,
  }).where(and(
    eq(sessionTurns.id, input.turnId), eq(sessionTurns.sessionId, input.sessionId),
    inArray(sessionTurns.status, existing.status === "interrupted" ? ["interrupted"] : ["running", "abort_requested"]),
  )).returning();
  return { turn: row ? toTurnRecord(row) : null, messages: intermediate.rows, changed: Boolean(row), finalized: existing.status !== "interrupted" };
}

async function publishInterruptedResult(spaceId: string, result: Awaited<ReturnType<typeof finalizeInterruptedTurn>>) {
  const { turn, messages, changed, finalized } = result;
  if (!turn || !changed) return;
  if (messages.length) indexTurnReferences({ spaceId, sessionId: turn.sessionId, turnId: turn.id, messages });
  if (finalized) await publishTurnFinalized(spaceId, turn);
  else {
    void scheduleSessionSnapshot(turn.sessionId, turn.sequence);
    await publishRealtimeEnvelope({ domain: "session", type: "session.turn.updated", spaceId, sessionId: turn.sessionId, payload: { turn } });
    await publishTurnState(spaceId, turn);
  }
}

export async function interruptSessionTurn(input: { spaceId: string; sessionId: string; turnId: string; continuedByTurnId: string }) {
  const result = await finalizeInterruptedTurn({ ...input, stopReason: "interrupted", summary: { finishReason: "interrupted", reason: "steer", continuedByTurnId: input.continuedByTurnId } });
  await publishInterruptedResult(input.spaceId, result);
  return result.turn;
}

export async function abortSessionTurn(input: { spaceId: string; sessionId: string; turnId: string; actorUserId?: string | null; abortEvent?: AgentTurnAbortEvent | null }) {
  const summary = input.abortEvent?.reason === "billing"
    ? { finishReason: "interrupted", reason: "billing", billing: input.abortEvent.billing ?? null }
    : { finishReason: "interrupted", reason: "abort" };
  const result = await finalizeInterruptedTurn({ ...input, stopReason: "aborted", summary });
  await publishInterruptedResult(input.spaceId, result);
  return result.turn;
}

export async function failSessionTurn(input: { spaceId: string; sessionId: string; turnId: string; errorMessage: string }) {
  const completedAt = new Date();
  const completedAtIso = completedAt.toISOString();
  const [row] = await db.update(sessionTurns).set({ status: "failed", errorMessage: input.errorMessage, summary: { finishReason: "failed", text: input.errorMessage }, completedAt, durationMs: sql<number>`greatest(0, floor(extract(epoch from (${completedAtIso}::timestamptz - ${sessionTurns.startedAt})) * 1000)::int)`, updatedAt: completedAt }).where(and(eq(sessionTurns.id, input.turnId), eq(sessionTurns.sessionId, input.sessionId), inArray(sessionTurns.status, ["queued", "running", "abort_requested", "interrupted"]))).returning();
  const turn = row ? toTurnRecord(row) : null;
  if (turn) {
    // No message load on the failure path, so we skip live reference indexing
    // here (avoiding an extra query for a rare error case); the backfill script
    // reconciles any references from a failed turn's messages.
    await publishTurnFinalized(input.spaceId, turn);
  }
  return turn;
}
