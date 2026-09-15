import {
  BillingAccessBlockedError,
  billingOperations,
  contentTypesFromBlocks,
  createBillingUsageGate,
  generationUsageKind,
  isGenerationModelDiscountFree,
  isBillingUsageGateUnavailableError,
  resolveGenerationUsageType,
} from "@cohub/billing";
import { createGenerationClient, GenerationValidationError } from "@neta-art/generation";
import { buildGenerationRequestMessage, buildGenerationResultMessage } from "@cohub/protocol/generation";
import { createInitialSpaceSession, getSpaceSessionById, persistMessageNode } from "./space-sessions.js";
import { assignSessionSourceSystemLabel } from "@cohub/core/labels/session-source";
import { db } from "./db/index.js";
import { sessionMessages, sessionTurns, spaceSessions, taskRuns } from "@cohub/db";
import { and, eq, sql } from "drizzle-orm";
import { getPostgresErrorConstraint, isPostgresUniqueViolation } from "./db/postgres-error.js";
import { createSessionTurn, setGenerationTurnAssistantProjection } from "./session-turns.js";
import { loadGenerationDeclaration } from "./generations/declarations.js";
import { enqueueTask } from "./tasks.js";
import { defaultJobRetention } from "@cohub/infra/bullmq";

const billingUsageGate = createBillingUsageGate({ operations: billingOperations });

async function retryDatabaseOperation<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
  throw lastError;
}

export class GenerationSessionExecutionError extends Error {
  constructor(public readonly status: 400 | 404 | 409 | 503, public readonly code: string, message: string) {
    super(message);
    this.name = "GenerationSessionExecutionError";
  }
}

export async function createGenerationSessionExecution(input: {
  spaceId: string;
  userId: string;
  sessionId?: string | null;
  clientMessageId?: string | null;
  model: string;
  content: import("@cohub/protocol/generation").GenerationContentBlock[];
  parameters?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  source?: string | null;
}) {
  const requestedSessionId = input.sessionId?.trim() || null;
  const requestedClientMessageId = input.clientMessageId?.trim() || null;
  if (requestedSessionId && requestedClientMessageId) {
    const existingSession = await getSpaceSessionById(requestedSessionId);
    if (existingSession && existingSession.spaceId !== input.spaceId) throw new GenerationSessionExecutionError(404, "generation_session_not_found", "Generation session not found in this space.");
    if (existingSession) {
      const [existing] = await db.select({ id: sessionTurns.id, meta: sessionTurns.meta, status: sessionTurns.status }).from(sessionTurns).where(and(eq(sessionTurns.sessionId, requestedSessionId), eq(sessionTurns.userUuid, input.userId), eq(sessionTurns.executionKind, "direct_generation"), sql`${sessionTurns.meta}->>'clientMessageId' = ${requestedClientMessageId}`)).limit(1);
      const existingMeta = existing?.meta && typeof existing.meta === "object" && !Array.isArray(existing.meta) ? existing.meta as Record<string, unknown> : null;
      if (existing && typeof existingMeta?.generationTaskId === "string") {
        const [task] = await db.select({ status: taskRuns.status }).from(taskRuns).where(eq(taskRuns.id, existingMeta.generationTaskId)).limit(1);
        if (!task) throw new GenerationSessionExecutionError(503, "generation_task_unavailable", "The existing generation task could not be found.");
        if (task.status === "failed" || existing.status === "failed") throw new GenerationSessionExecutionError(409, "generation_retry_required", "This generation already failed. Retry with a new client message ID.");
        return { taskRunId: existingMeta.generationTaskId, sessionId: requestedSessionId, turnId: existing.id, billing: null };
      }
    }
  }

  const declaration = await loadGenerationDeclaration(input.userId, input.model);
  if (!declaration) throw new GenerationSessionExecutionError(404, "generation_model_not_found", `Generation model not found: ${input.model}`);
  let parameters: Record<string, unknown> | undefined;
  try {
    parameters = createGenerationClient({ models: [declaration], includeBuiltinModels: false }).validate({
      model: input.model,
      content: input.content,
      parameters: input.parameters,
      meta: input.meta,
    }).parameters;
  } catch (error) {
    if (error instanceof GenerationValidationError) throw new GenerationSessionExecutionError(400, "invalid_generation_input", error.message);
    throw error;
  }
  const usageType = resolveGenerationUsageType({ adapterType: declaration.adapter?.type, contentTypes: contentTypesFromBlocks(input.content) });
  const discount = await billingOperations.getGenerationModelDiscount({ userId: input.userId, model: input.model }).catch(() => {
    throw new GenerationSessionExecutionError(503, "generation_pricing_unavailable", "Generation pricing is temporarily unavailable.");
  });
  let billingDecision: Awaited<ReturnType<typeof billingUsageGate.evaluate>>;
  try {
    billingDecision = isGenerationModelDiscountFree(discount)
      ? { status: "allowed" as const, balanceState: "zero" as const, netUsd: 0 }
      : await billingUsageGate.evaluate({ userId: input.userId, usageKind: generationUsageKind(usageType), source: "generation_task", model: input.model, spaceId: input.spaceId, sessionId: input.sessionId ?? null });
  } catch (error) {
    if (isBillingUsageGateUnavailableError(error)) throw new GenerationSessionExecutionError(503, "generation_balance_unavailable", error.message);
    throw error;
  }
  if (billingDecision.status === "blocked") throw new BillingAccessBlockedError(billingDecision);

  const taskRunId = crypto.randomUUID();
  let sessionId = input.sessionId?.trim() || null;
  let turnId: string | null = null;
  try {
    if (sessionId) {
      const session = await getSpaceSessionById(sessionId);
      if (!session) {
        const created = await createInitialSpaceSession({ spaceId: input.spaceId, sessionId, userUuid: input.userId, title: null, source: input.source ?? "web", externalSessionId: null, meta: { createdBy: "direct_generation" } });
        sessionId = created.id;
        await assignSessionSourceSystemLabel({ db, spaceId: input.spaceId, sessionId, source: input.source ?? "web", provider: null }).catch((error) => {
          console.warn("[GenerationSession] failed to assign source label", { sessionId, error });
        });
      } else if (session.spaceId !== input.spaceId) {
        throw new GenerationSessionExecutionError(404, "generation_session_not_found", "Generation session not found in this space.");
      }

    }
    if (!sessionId) {
      const session = await createInitialSpaceSession({ spaceId: input.spaceId, sessionId: crypto.randomUUID(), userUuid: input.userId, title: null, source: input.source ?? "web", externalSessionId: null, meta: { createdBy: "direct_generation" } });
      sessionId = session.id;
      await assignSessionSourceSystemLabel({ db, spaceId: input.spaceId, sessionId, source: input.source ?? "web", provider: null }).catch((error) => {
        console.warn("[GenerationSession] failed to assign source label", { sessionId, error });
      });
    }
    const request = buildGenerationRequestMessage({ taskId: taskRunId, model: input.model, provider: declaration.adapter?.type ?? null, parameters, content: input.content });
    let turn: Awaited<ReturnType<typeof createSessionTurn>>;
    try {
      turn = await createSessionTurn({ id: crypto.randomUUID(), sessionId, userUuid: input.userId, userContent: request.content, executionKind: "direct_generation", intent: "followup", meta: { ...(input.meta ?? {}), executionKind: "direct_generation", generationTaskId: taskRunId, clientMessageId: input.clientMessageId ?? null } });
    } catch (error) {
      const clientMessageId = input.clientMessageId?.trim();
      if (!clientMessageId || !isPostgresUniqueViolation(error) || getPostgresErrorConstraint(error) !== "v2_uq_session_turns_direct_generation_client_message") throw error;
      const [existing] = await db.select({ id: sessionTurns.id, meta: sessionTurns.meta, status: sessionTurns.status }).from(sessionTurns).where(and(eq(sessionTurns.sessionId, sessionId), eq(sessionTurns.userUuid, input.userId), eq(sessionTurns.executionKind, "direct_generation"), sql`${sessionTurns.meta}->>'clientMessageId' = ${clientMessageId}`)).limit(1);
      const existingMeta = existing?.meta && typeof existing.meta === "object" && !Array.isArray(existing.meta) ? existing.meta as Record<string, unknown> : null;
      if (!existing || typeof existingMeta?.generationTaskId !== "string") throw error;
      const [task] = await db.select({ status: taskRuns.status }).from(taskRuns).where(eq(taskRuns.id, existingMeta.generationTaskId)).limit(1);
      if (!task) throw new GenerationSessionExecutionError(503, "generation_task_unavailable", "The existing generation task could not be found.");
      if (task.status === "failed" || existing.status === "failed") throw new GenerationSessionExecutionError(409, "generation_retry_required", "This generation already failed. Retry with a new client message ID.");
      return { taskRunId: existingMeta.generationTaskId, sessionId, turnId: existing.id, billing: null };
    }
    turnId = turn.id;
    await persistMessageNode({ spaceId: input.spaceId, sessionId, userId: input.userId, idempotencyKey: `generation:${taskRunId}:request`, message: { role: "user", content: request.content, meta: { ...request.meta, messageKind: "generation_request", turnId, generationTaskId: taskRunId } } });
    const placeholder = buildGenerationResultMessage({ taskId: taskRunId, model: input.model, provider: declaration.adapter?.type ?? null, parameters, status: "queued" });
    const placeholderText = placeholder.content.find((block) => block.type === "text")?.text ?? null;
    await persistMessageNode({ spaceId: input.spaceId, sessionId, userId: input.userId, idempotencyKey: `generation:${taskRunId}:result`, message: { role: "assistant", content: placeholder.content, text: placeholderText, model: input.model, meta: { ...placeholder.meta, messageKind: "generation_result", turnId, generationTaskId: taskRunId, generationStatus: "queued" } } });
    await setGenerationTurnAssistantProjection({ sessionId, turnId, content: placeholder.content, text: placeholderText, model: input.model, taskId: taskRunId });
    await enqueueTask({ type: "generation", spaceId: input.spaceId, sessionId, turnId, userId: input.userId, data: { model: input.model, content: input.content, parameters, meta: input.meta, requestSource: null, modelDiscount: { multiplier: discount.multiplier, resolvedAt: discount.resolvedAt } } }, { taskRunId, attempts: 1, ...defaultJobRetention }).catch(() => {
      throw new GenerationSessionExecutionError(503, "generation_queue_unavailable", "Generation queue is temporarily unavailable.");
    });
    return { taskRunId, sessionId, turnId, billing: billingDecision };
  } catch (error) {
    if (sessionId && turnId) {
      const failureSessionId = sessionId;
      const failureTurnId = turnId;
      const message = error instanceof Error ? error.message : String(error);
      const failed = buildGenerationResultMessage({ taskId: taskRunId, model: input.model, parameters, status: "failed", error: { message } });
      const failedText = failed.content.find((block) => block.type === "text")?.text ?? null;
      try {
        await retryDatabaseOperation(async () => db.transaction(async (tx) => {
          const completedAt = new Date();
          const [turn] = await tx.update(sessionTurns).set({
            status: "failed",
            assistantContent: failed.content,
            assistantText: failedText,
            model: input.model,
            errorMessage: message,
            summary: { text: failedText, finishReason: "failed" },
            completedAt,
            updatedAt: completedAt,
          }).where(and(eq(sessionTurns.id, failureTurnId), eq(sessionTurns.sessionId, failureSessionId), eq(sessionTurns.executionKind, "direct_generation"), sql`${sessionTurns.status} in ('queued', 'running')`)).returning({ id: sessionTurns.id });
          if (!turn) return;
          await tx.update(sessionMessages).set({ content: failed.content, text: failedText, meta: { ...failed.meta, messageKind: "generation_result", turnId, generationTaskId: taskRunId, generationStatus: "failed" }, completedAt }).where(and(eq(sessionMessages.sessionId, failureSessionId), eq(sessionMessages.idempotencyKey, `generation:${taskRunId}:result`)));
          await tx.update(spaceSessions).set({ latestMessageText: failedText, lastMessageAt: completedAt, updatedAt: completedAt }).where(eq(spaceSessions.id, failureSessionId));
        }));
      } catch (cleanupError) {
        console.error("[GenerationSession] failed to persist generation failure after retries", { sessionId: failureSessionId, turnId: failureTurnId, taskRunId, cleanupError });
      }
    }
    throw error;
  }
}
