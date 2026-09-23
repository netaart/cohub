import { and, eq, sql } from "drizzle-orm";
import { sessionTurns } from "@cohub/db";
import { readRuntimeRecovery, runtimeRecoveryActive, runtimeResolutionOpen } from "@cohub/core/sessions";
import { db } from "../db.js";
import { runtimeRegistrationKey, parseRuntimeRegistration, type RuntimeExecutionEvent, type RuntimeTurnInput, type RuntimeRecoveryState } from "@cohub/protocol";
import { redis, sendOutput } from "../redis.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { getActiveTraceIdentifiers } from "@cohub/infra/tracing";
import { getSpaceSandbox } from "../api.js";
import { persistAssistantMessage, persistBatchUserMessages } from "../persistence.js";
import { createRuntimeStream } from "../stream/runtime-stream.js";
import { loadRuntimeContext } from "./context-store.js";
import { buildUserMessagesForBatch, type ClaimedTurnBatch } from "../batch.js";
import type { PromptAccessMode } from "@cohub/core/sessions";
import { exchangeRuntimeTurn, RuntimeExecutionUncertainError, RuntimeResultUnavailableError } from "./exchange.js";
export { RuntimeExecutionUncertainError } from "./exchange.js";

function nativeAssistant(event: Extract<RuntimeExecutionEvent, { type: "message.commit" | "turn.end" }>, turnId: string, harness: string, final: boolean) {
  return {
    id: `runtime:${turnId}:${event.message.ordinal}:${final ? "final" : "intermediate"}`,
    role: "assistant", content: event.message.content,
    provider: event.message.provider ?? null, model: event.message.model ?? null,
    stopReason: event.message.stopReason ?? (final ? "stop" : "tool_use"),
    errorMessage: event.message.errorMessage ?? null, usage: event.message.usage ?? null,
    meta: { turnId, harness, runtime: "local", messageKind: final ? "assistant_final" : "assistant_intermediate", ...(final ? { runtimeArchiveStatus: "archive" in event && event.archive ? "pending" : "failed" } : {}) },
  };
}

export async function markRuntimeRecovery(turnId: string, recovery: RuntimeRecoveryState) {
  const [updated] = await db.update(sessionTurns).set({ meta: sql`coalesce(${sessionTurns.meta}, '{}'::jsonb) || jsonb_build_object('runtimeRecovery', coalesce(${sessionTurns.meta}->'runtimeRecovery', '{}'::jsonb) || ${JSON.stringify(recovery)}::jsonb)` })
    .where(and(eq(sessionTurns.id, turnId), runtimeRecoveryActive, runtimeResolutionOpen))
    .returning({ meta: sessionTurns.meta });
  return updated?.meta ?? null;
}

export async function executeRemoteHarnessTurn(input: {
  spaceId: string; sessionId: string; batch: ClaimedTurnBatch; actorUserId: string | null;
  accessMode: PromptAccessMode; requestedThinkingLevel?: string | null;
  harness: "pi" | "codex"; provider?: string | null; model?: string | null; requestId?: string | null; abortSignal: AbortSignal;
  recovery?: boolean;
  leaseSignal?: AbortSignal;
}): Promise<void> {
  input.abortSignal.throwIfAborted();
  if (!input.recovery && input.harness === "pi" && input.accessMode === "read_only") throw new Error("Pi cannot enforce read-only access");
  const [sandbox, registrationRaw] = await Promise.all([input.recovery ? Promise.resolve(null) : getSpaceSandbox({ spaceId: input.spaceId }), redis.get(runtimeRegistrationKey(input.spaceId))]);
  if ((!input.recovery && sandbox?.sandbox?.provider !== "local") || !registrationRaw) throw new Error("Local Runtime is offline");
  const registration = parseRuntimeRegistration(registrationRaw);
  if (!registration) {
    logger.warn("[Runtime] ignoring invalid registration", { spaceId: input.spaceId });
    throw new Error("Local Runtime registration is invalid");
  }
  const capabilities = registration.capabilities;
  const previousRecovery = readRuntimeRecovery(input.batch.ownerTurn.meta);
  if (input.recovery && previousRecovery?.ownerUserId && previousRecovery.ownerUserId !== registration.ownerUserId) throw new RuntimeExecutionUncertainError("Runtime owner changed");
  if (!input.recovery && !capabilities.harnesses.includes(input.harness)) throw new Error("Harness is unavailable on this Runtime");
  if (!input.recovery && input.model && !capabilities.models.some((model) => model.harness === input.harness && model.id === input.model && (!input.provider || model.provider === input.provider))) throw new Error("Model is unavailable on this Runtime");
  const users = buildUserMessagesForBatch(input.batch);
  const user = users.at(-1);
  const first = users[0];
  if (!user || !first || user.turnId !== input.batch.ownerTurn.id) throw new Error("Invalid Runtime batch");
  const userMessageId = user.userMessageId;
  const beforeSequence = first.turnSeq;
  const traceIdentifiers = getActiveTraceIdentifiers(input.requestId?.trim() || user.turnId);
  const context = await loadRuntimeContext({ spaceId: input.spaceId, sessionId: input.sessionId, beforeSequence, headOnly: true, harness: input.harness });
  await persistBatchUserMessages({ spaceId: input.spaceId, sessionId: input.sessionId, batch: input.batch });
  const command: RuntimeTurnInput = {
    spaceId: input.spaceId, sessionId: input.sessionId, turnId: user.turnId, userMessageId,
    harness: input.harness, messages: users.map((message, index) => ({ turnId: message.turnId, userMessageId: message.userMessageId,
      userId: input.batch.turns[index]?.userUuid ?? null, content: message.content })),
    context, provider: input.provider, model: input.model,
    thinkingLevel: input.requestedThinkingLevel,
    requestId: traceIdentifiers.requestId,
    traceContext: {
      requestId: traceIdentifiers.requestId,
      traceId: traceIdentifiers.traceId,
      spanId: traceIdentifiers.spanId,
      traceparent: traceIdentifiers.traceparent,
    },
    accessMode: input.accessMode,
  };
  logger.info("[Runtime] dispatching local turn", {
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    turnId: user.turnId,
    harness: input.harness,
    runtimeId: registration.runtimeId ?? null,
    requestId: traceIdentifiers.requestId,
    traceId: traceIdentifiers.traceId,
  });
  const stream = createRuntimeStream({ spaceId: input.spaceId, sessionId: input.sessionId, turnId: user.turnId, userMessageId }, sendOutput, (error) => logger.warn("[Runtime] stream delivery failed; persistence continues", error));
  const committed = new Set<number>();
  let finalRevision: string | null = null;
  try {
    if (!input.recovery) {
      await markRuntimeRecovery(user.turnId, { state: "executing", ownerUserId: registration.ownerUserId });
    }
    if (!input.recovery) await sendOutput({ type: "turn_lifecycle", spaceId: input.spaceId, sessionId: input.sessionId, turnId: user.turnId, anchorUserMessageId: userMessageId, phase: "llm_call_started", llmRound: 1, provider: input.provider, model: input.model, at: new Date().toISOString(), timestamp: Date.now() }).catch((error) => logger.warn("[Runtime] lifecycle delivery failed", error));
    await exchangeRuntimeTurn({
      input: command, recovery: input.recovery, requestId: input.recovery ? undefined : user.turnId,
      ...(input.recovery ? { reconnectMs: 1000, ackMs: 8000, handshakeMs: 5000 } : {}),
      signal: input.abortSignal, headers: env.WORKER_SECRET ? { "x-worker-secret": env.WORKER_SECRET } : undefined,
      onAcknowledgementError: (error) => logger.warn("[Runtime] local acknowledgement failed; durable turn retained", { turnId: user.turnId, error }),
      endpoint: async () => {
        const raw = await redis.get(runtimeRegistrationKey(input.spaceId));
        if (!raw) throw new Error("Local Runtime is offline");
        const current = parseRuntimeRegistration(raw);
        if (!current) throw new Error("Local Runtime registration is invalid");
        if (current.ownerUserId !== registration.ownerUserId) throw new Error("Runtime owner changed");
        const endpoint = new URL(current.endpoint);
        if (!["ws:", "wss:"].includes(endpoint.protocol) || endpoint.pathname !== `/internal/runtime-relay/${input.spaceId}` || endpoint.username || endpoint.password) throw new Error("Invalid Runtime endpoint");
        endpoint.searchParams.set("connection", current.connectionId);
        return endpoint.toString();
      },
      event: async (event, send, requestId) => {
        input.leaseSignal?.throwIfAborted();
        if (input.recovery && !["message.commit", "turn.end"].includes(event.type)) throw new Error("Recovery cannot execute or request context");
        if (event.type === "context.required") {
          send({ type: "session.context", requestId, context: await loadRuntimeContext({ spaceId: input.spaceId, sessionId: input.sessionId, beforeSequence, harness: input.harness, pendingTurnIds: event.pendingTurnIds }) });
          return;
        }
        if (["message.start", "text.delta", "content.replace"].includes(event.type)) {
          if (!finalRevision && !("ordinal" in event && committed.has(event.ordinal))) stream.apply(event);
          return;
        }
        if (event.type !== "message.commit" && event.type !== "turn.end") return;
        if (event.type === "message.commit" && (committed.has(event.message.ordinal) || finalRevision)) return;
        if (event.type === "turn.end" && event.archive && (event.archive.turnId !== user.turnId || event.archive.sessionId !== input.sessionId || event.archive.harness !== input.harness)) throw new Error("Runtime archive identity mismatch");
        if (!finalRevision) {
          const [current] = await db.select({ meta: sessionTurns.meta }).from(sessionTurns).where(eq(sessionTurns.id, user.turnId)).limit(1);
          if (readRuntimeRecovery(current?.meta)?.state === "confirmed_stopped") throw new RuntimeExecutionUncertainError("Execution was manually resolved; late result retained locally");
          await stream.flush();
          input.leaseSignal?.throwIfAborted();
          if (event.type === "turn.end" || event.message.content.length) {
            await persistAssistantMessage({
              spaceId: input.spaceId, spaceSessionId: input.sessionId, userMessageId,
              event: { type: "turn_end", message: nativeAssistant(event, user.turnId, input.harness, event.type === "turn.end"), toolResults: [] },
              userId: input.actorUserId, turnId: user.turnId, messageOrdinal: event.message.ordinal,
              idempotencyKey: `runtime:${user.turnId}:${event.message.ordinal}:${event.type}`,
            });
          }
          committed.add(event.message.ordinal);
          await stream.commit(event.message.ordinal);
          if (event.type === "turn.end") {
            const completedContext = await loadRuntimeContext({ spaceId: input.spaceId, sessionId: input.sessionId, throughTurnId: user.turnId, headOnly: true });
            finalRevision = completedContext.revision;
          }
        }
        if (event.type === "turn.end" && finalRevision) send({ type: "turn.ack", requestId, revision: finalRevision, turnId: user.turnId });
      },
    });
  } catch (error) {
    // Once dispatched, local effects may exist even if persistence or transport failed.
    const [current] = await db.select({ status: sessionTurns.status }).from(sessionTurns).where(eq(sessionTurns.id, user.turnId)).limit(1).catch(() => []);
    if (current && ["running", "abort_requested"].includes(current.status) && (input.recovery || error instanceof RuntimeExecutionUncertainError)) {
      if (error instanceof RuntimeResultUnavailableError) {
        if (!input.leaseSignal?.aborted) await markRuntimeRecovery(user.turnId, { state: "attention", ownerUserId: registration.ownerUserId }).catch((cause) => logger.warn("[Runtime] failed to record recovery state", cause));
        throw error;
      }
      throw new RuntimeExecutionUncertainError("Runtime outcome needs reconciliation", { cause: error });
    }
    if (current && ["completed", "failed", "interrupted"].includes(current.status)) return;
    throw error;
  } finally { stream.dispose(); }
}
