import { access } from "node:fs/promises";
import { trace } from "@opentelemetry/api";
import { SessionManager } from "./runtime/local-session-manager.js";
import { and, asc, eq, sql } from "drizzle-orm";
import { sessionMessages, sessionTurns } from "@cohub/db";
import { getSpace } from "./api.js";
import { parseRuntimeRegistration, runtimeRegistrationKey } from "@cohub/protocol/runtime";
import { interruptSessionTurn, persistAssistantMessage, persistUserMessage } from "./persistence.js";
import { redis } from "./redis.js";
import { logger } from "./logger.js";
import { getAgentTracer } from "@cohub/infra/tracing/agent";
import type { CohubModel, CohubModelRegistry } from "./runtime/model-registry.js";
import type { ImageToTextConfig } from "@cohub/infra/config-runtime/model-tasks";
import {
  ensureAgentSpaceSessionPath,
  getAgentSessionFilePath,
  getAgentSpaceSessionsPath,
  getAgentWorkspacePath,
} from "./runtime/paths.js";
import { clearCurrentSessionExecutionAuth, setCurrentSessionExecutionAuth } from "./runtime/session-execution-auth.js";
import { listEnabledSpaceMods, type SpaceModListItem } from "@cohub/core/space-mods";
import { db } from "./db.js";
import { createCohubAgentSession } from "./runtime/session-runtime.js";
import type { ContextProjectionOptions } from "@cohub/protocol";
import { loadRequestedContextWindow, loadRequestedThinkingLevel, loadRuntimeContext } from "./runtime/context-store.js";
import { appendTerminalGenerationMessages } from "./generation-session-sync.js";
import { syncCloudContext } from "./runtime/cloud-context.js";
import { resolveSandboxProvider, type createSandboxCodingTools } from "./sandbox/tools.js";
import { connectLocalRuntime, createLocalRpc, loadLocalPromptWorkspace } from "./sandbox/local-workspace.js";
import { localMountSources, syncLocalMounts } from "./sandbox/local-mounts.js";
import {
  applyAssistantMessageEvent,
  applyToolExecutionEnd,
  applyToolExecutionStart,
  applyToolExecutionUpdate,
  createAssistantStreamState,
} from "./stream/assistant-stream-state.js";
import { type PendingUserMessage, type SessionHandle, getSessionFileSignature, getSessionKey, removePendingUserMessage, sameSessionFileSignature, setSessionManagerFilePath } from "./session-handle.js";
import { buildStreamMessageId, clearAssistantMessageTiming, drainStreamStateBeforeReset, ensureProjectedStreamContent, flushProviderRenderUpdate, resetStreamState, resolveAssistantMessageStartedAt, resolvePersistedAssistantContent, schedulePersistence, scheduleProviderRenderUpdate } from "./session-stream.js";
import { extractTextFromToolResult, extractToolResultContent, safeStringify } from "./session-tool-results.js";

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

export function subscribeSessionEvents(handle: SessionHandle) {
  const claimedUserMessages = new WeakMap<object, PendingUserMessage & { startedAt: string }>();
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
      const userMeta = message.role === "user" && message.meta && typeof message.meta === "object" && !Array.isArray(message.meta)
        ? message.meta as Record<string, unknown>
        : null;
      // The loop guard nudge lives only in the pi context; it is not a platform user message.
      if (message.role === "user" && userMeta?.internal !== true) {
        const previousTurnId = handle.currentTurnId;
        const userMessageId = typeof userMeta?.userMessageId === "string" ? userMeta.userMessageId.trim() : "";
        const pendingIndex = userMessageId ? handle.pendingUserMessages.findIndex((item) => item.userMessageId === userMessageId) : -1;
        const pending = pendingIndex >= 0 ? handle.pendingUserMessages.splice(pendingIndex, 1)[0] : undefined;
        // Once one input is unidentified the whole run fails; later inputs must not restore an identity.
        if (!pending || handle.userMessageIdentityError) {
          handle.userMessageIdentityError ??= new Error(`Agent received a user message without a pending identity (userMessageId=${userMessageId || "none"})`);
          handle.currentTurnId = null;
          handle.currentUserMessageId = null;
          handle.currentUserMessageMeta = null;
          handle.session.agent.abort();
        } else {
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
          handle.currentUserMessageMeta = pending.meta ?? null;
          claimedUserMessages.set(event.message, { ...pending, turnId: nextTurnId, startedAt: new Date().toISOString() });
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
      const claimed = message.role === "user" ? claimedUserMessages.get(event.message) : undefined;
      if (claimed) {
        claimedUserMessages.delete(event.message);
        const { userMessageId, turnId, content, startedAt } = claimed;
        const meta = claimed.meta ?? null;
        const agentSessionEntryId = typeof message.sessionEntryId === "string"
          ? message.sessionEntryId
          : null;

        schedulePersistence(handle, `user:${userMessageId}`, async () => {
          const span = handle.turnTracer.startSpan("agent.persistence.user_message", {
            attributes: {
              "cohub.space_id": handle.spaceId,
              "cohub.session_id": handle.sessionId,
              "agent.input_message_id": userMessageId,
              ...getSessionTraceAttributes(handle),
              ...(turnId ? { "agent.turn_id": turnId } : {}),
            },
          });
          try {
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
            contextWindow: handle.session.agent.state.model.contextWindow,
            contextWindowSource: (handle.session.agent.state.model as CohubModel).contextWindowSource,
            modelRegistry: handle.session.modelRegistry,
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

/** The Space owner's user skills are copied only onto the owner's own machine. */
async function isOwnersRuntime(spaceId: string, ownerUserId: string | null) {
  if (!ownerUserId) return false;
  const raw = await redis.get(runtimeRegistrationKey(spaceId)).catch(() => null);
  return Boolean(raw && parseRuntimeRegistration(raw)?.ownerUserId === ownerUserId);
}

async function prepareLocalRuntime(input: { spaceId: string; sessionId: string; ownerUserId: string | null; spaceMods: SpaceModListItem[] }) {
  const [connection, ownersRuntime] = await Promise.all([connectLocalRuntime(input.spaceId), isOwnersRuntime(input.spaceId, input.ownerUserId)]);
  const mounts = connection
    ? await syncLocalMounts({
      rpc: createLocalRpc(connection, input),
      capabilities: connection.capabilities,
      spaceId: input.spaceId,
      sources: localMountSources({ ownerUserId: ownersRuntime ? input.ownerUserId : null, mods: input.spaceMods }),
    })
      .catch((error: unknown) => {
        logger.warn(`[Agent] Failed to sync Local Runtime mounts for ${input.spaceId}`, error);
        return null;
      })
    : null;
  // Rebuild the prompt when the Runtime connection or a held mount's content changes.
  const key = !connection ? "local:offline"
    : `local:${connection.connectionId}:${mounts ? Object.entries(mounts.revisions).sort(([a], [b]) => a.localeCompare(b)).map((entry) => entry.join("@")).join(",") : "unmounted"}`;
  return { connection, mounts, spaceMods: input.spaceMods, key };
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
  const projectionOptions: ContextProjectionOptions = {
    resolveApi: ({ provider, model }) => provider && model ? input.modelRegistry.find(provider, model)?.api ?? null : null,
  };
  const durableHead = await loadRuntimeContext({ spaceId: input.spaceId, sessionId: input.sessionId, beforeSequence: input.beforeTurnSequence ?? undefined, headOnly: true });
  // The session file's own marker says which durable revision it already holds, in memory or on disk
  // after a restart; history is read only when syncCloudContext would actually append something.
  const loadDurableContext = async (manager: SessionManager) => {
    const marker = manager.getCustomEntries("cohub.context").at(-1)?.data as { revision?: string } | undefined;
    if (marker?.revision === durableHead.revision) return durableHead;
    const startedAt = performance.now();
    const context = await loadRuntimeContext({ spaceId: input.spaceId, sessionId: input.sessionId, beforeSequence: input.beforeTurnSequence ?? undefined });
    logger.info("[SessionContext] full load", { sessionId: input.sessionId, reason: marker ? "stale" : "missing", messages: context.messages.length, durationMs: Math.round(performance.now() - startedAt) });
    return context;
  };

  const [spaceInfo, sandboxProvider] = await Promise.all([
    getSpace({ spaceId: input.spaceId }).catch((error: unknown) => {
      logger.warn(`[Agent] Failed to load space info for ${input.spaceId}; falling back to platform config`, error);
      return null;
    }),
    resolveSandboxProvider(input.spaceId).catch((error: unknown) => {
      logger.warn(`[Agent] Failed to resolve sandbox provider for ${input.spaceId}; assuming a cloud sandbox`, error);
      return "cloud" as const;
    }),
  ]);
  const spaceOwnerUserId = spaceInfo?.space?.userUuid?.trim() || null;
  const loadSpaceMods = () => listEnabledSpaceMods(db, input.spaceId).catch((error: unknown) => {
    logger.warn(`[Agent] Failed to load space mods for ${input.spaceId}; continuing without mods`, error);
    return [];
  });

  // A Local Runtime's mounts are brought up to date every Turn, as a cloud Pod's mounts are always current.
  const local = sandboxProvider === "local" ? await prepareLocalRuntime({ spaceId: input.spaceId, sessionId: input.sessionId, ownerUserId: spaceOwnerUserId, spaceMods: await loadSpaceMods() }) : null;
  const promptWorkspace = local?.key ?? "cloud";

  const existing = input.sessionHandles.get(sessionKey);
  if (existing) {
    if (sameSessionFileSignature(existing.sessionFileSignature, fileSignature) && existing.promptWorkspace === promptWorkspace) {
      existing.spaceOwnerUserId = spaceOwnerUserId;
      if (!existing.currentUserMessageId && syncCloudContext(existing.sessionManager, await loadDurableContext(existing.sessionManager), projectionOptions)) {
        await existing.session.reload();
        const appended = await syncGenerationMessagesToSessionFile(input.sessionId, existing.sessionManager, input.beforeTurnSequence);
        if (appended.length > 0) existing.session.agent.state.messages.push(...appended);
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

  const [spaceMods, localWorkspace] = await Promise.all([
    local?.spaceMods ?? loadSpaceMods(),
    local ? loadLocalPromptWorkspace({ rpc: local.connection && createLocalRpc(local.connection, input), spaceId: input.spaceId, mounts: local.mounts }) : null,
  ]);

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

  syncCloudContext(sessionManager, await loadDurableContext(sessionManager), projectionOptions);
  await syncGenerationMessagesToSessionFile(input.sessionId, sessionManager, input.beforeTurnSequence).catch((error) => {
    logger.warn(`[Session] failed to project generation messages sessionId=${input.sessionId}:`, error);
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
    ...(localWorkspace ? { localWorkspace } : {}),
    ...(resolvedModel ? { model: resolvedModel } : {}),
    loadSelectedThinkingLevel: () => loadRequestedThinkingLevel({ sessionId: input.sessionId, beforeSequence: input.beforeTurnSequence ?? undefined }).catch((error: unknown) => {
      logger.warn(`[Session] failed to load selected thinking level sessionId=${input.sessionId}; using the lowest supported level`, error);
      return null;
    }),
    loadSelectedContextWindow: () => loadRequestedContextWindow({ sessionId: input.sessionId, beforeSequence: input.beforeTurnSequence ?? undefined }).catch((error: unknown) => {
      logger.warn(`[Session] failed to load selected context window sessionId=${input.sessionId}; using the configured window`, error);
      return null;
    }),
  });

  await session.reload();

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
    userMessageIdentityError: null,
    pendingExecutionAuths: [],
    activeDirectShellCommand: null,
    currentUserMessageId: null,
    currentUserMessageMeta: null,
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
    promptWorkspace,
  };

  subscribeSessionEvents(handle);
  input.sessionHandles.set(sessionKey, handle);
  logger.debug(`[Session] ready sessionId=${input.sessionId} spaceId=${input.spaceId}`);
  return handle;
}
