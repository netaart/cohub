import {
  BillingAccessBlockedError,
  billingOperations,
  contentTypesFromBlocks,
  resolveGenerationUsageType,
  serializeBillingWarning,
} from "@cohub/billing";
import { Hono, type Context } from "hono";
import { GenerationValidationError } from "@neta-art/generation";
import {
  GENERATION_TASK_TYPE,
  type CreateGenerationTaskResponse,
  type GenerationModelDiscountSnapshot,
} from "@cohub/protocol/generation";
import { useAuth, authzDenied } from "../lib/middleware.js";
import { billingBlockedResponse } from "../lib/billing-blocked.js";
import { hasPermission } from "../permissions.js";
import { loadGenerationDeclaration } from "../generations/declarations.js";
import { createGenerationTaskRequestSchema, resolveGenerationRequestParameters } from "../generations/schema.js";
import { getSpaceSessionById } from "../space-sessions.js";
import { getSessionTurnById } from "../session-turns.js";
import { enqueueTask } from "../tasks.js";
import { defaultJobRetention } from "@cohub/infra/bullmq";
import { createLogger } from "@cohub/infra/logging";
import { getRequestSource } from "../lib/request-source.js";
import { admitGeneration, GenerationBillingUnavailableError, generationReserveHolds } from "../generation-billing.js";


const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();

type ErrorStatus = 400 | 401 | 402 | 403 | 404 | 409 | 413 | 422 | 500 | 502 | 503;

function generationError(c: Context, status: ErrorStatus, code: string, message: string, details?: unknown) {
  return c.json({ code, message, ...(details === undefined ? {} : { details }) }, status);
}

function zodDetails(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

router.post("/", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const parsed = createGenerationTaskRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return generationError(c, 400, "invalid_generation_request", "Invalid generation request.", zodDetails(parsed.error));
  }

  const request = parsed.data;
  if (!(await hasPermission(user, "generation.create", { spaceId: request.spaceId }))) return authzDenied(c);

  let sessionId = request.sessionId?.trim() || null;
  const turnId = request.turnId?.trim() || null;
  const meta = request.meta;
  const requestSource = getRequestSource(c);
  if (sessionId) {
    const session = await getSpaceSessionById(sessionId);
    if (!session || session.spaceId !== request.spaceId) {
      return generationError(c, 404, "generation_session_not_found", "Generation session not found in this space.");
    }
    if (!(await hasPermission(user, "session.view", { spaceId: request.spaceId, sessionId }))) return authzDenied(c);
  }
  if (turnId) {
    if (!sessionId) {
      return generationError(c, 400, "generation_session_required", "sessionId is required when turnId is provided.");
    }
    const turn = await getSessionTurnById(sessionId, turnId);
    if (!turn) {
      return generationError(c, 404, "generation_turn_not_found", "Generation turn not found in this session.");
    }
  }

  const declaration = await loadGenerationDeclaration(user.uuid, request.model);
  if (!declaration) {
    return generationError(c, 404, "generation_model_not_found", `Generation model not found: ${request.model}`);
  }

  let parameters: Record<string, unknown> | undefined;
  try {
    parameters = resolveGenerationRequestParameters(declaration, request);
  } catch (error) {
    if (error instanceof GenerationValidationError) {
      return generationError(c, 400, "invalid_generation_input", error.message);
    }
    throw error;
  }

  const usageType = resolveGenerationUsageType({
    adapterType: declaration.adapter?.type,
    contentTypes: contentTypesFromBlocks(request.content),
  });
  let resolvedDiscount: Awaited<ReturnType<typeof billingOperations.getGenerationModelDiscount>>;
  try {
    resolvedDiscount = await billingOperations.getGenerationModelDiscount({
      userId: user.uuid,
      model: request.model,
    });
  } catch (error) {
    logger.error("[Billing] failed to resolve generation model discount before enqueue", {
      userId: user.uuid,
      spaceId: request.spaceId,
      model: request.model,
      error,
    });
    return generationError(
      c,
      503,
      "generation_pricing_unavailable",
      "Generation pricing is temporarily unavailable. Please try again later.",
    );
  }
  const modelDiscount: GenerationModelDiscountSnapshot = {
    multiplier: resolvedDiscount.multiplier,
    resolvedAt: resolvedDiscount.resolvedAt,
  };
  if (resolvedDiscount.benefitKey) {
    logger.info("[Billing] generation model discount resolved", {
      userId: user.uuid,
      spaceId: request.spaceId,
      model: request.model,
      multiplier: resolvedDiscount.multiplier,
      benefitKey: resolvedDiscount.benefitKey,
      resolvedAt: resolvedDiscount.resolvedAt,
    });
  }
  const reservedTaskRunId = crypto.randomUUID();
  let admission: Awaited<ReturnType<typeof admitGeneration>>;
  try {
    admission = await admitGeneration({
      taskRunId: reservedTaskRunId,
      userId: user.uuid,
      spaceId: request.spaceId,
      sessionId,
      turnId,
      model: request.model,
      usageType,
      discount: resolvedDiscount,
    });
  } catch (error) {
    if (error instanceof BillingAccessBlockedError) return billingBlockedResponse(c, error);
    if (!(error instanceof GenerationBillingUnavailableError)) throw error;
    return generationError(c, 503, "generation_balance_unavailable", error.message);
  }
  const { decision: billingDecision, hold } = admission;

  let taskRunId: string;
  try {
    const enqueued = await enqueueTask({
      type: GENERATION_TASK_TYPE,
      spaceId: request.spaceId,
      sessionId: sessionId ?? undefined,
      turnId: turnId ?? undefined,
      userId: user.uuid,
      data: {
        model: request.model,
        content: request.content,
        parameters,
        meta,
        requestSource,
        modelDiscount,
        ...(hold ? { reserveHold: hold } : {}),
      },
    }, {
      attempts: 1,
      ...defaultJobRetention,
      taskRunId: reservedTaskRunId,
    });
    taskRunId = enqueued.taskRunId;
  } catch (error) {
    if (hold) await generationReserveHolds.release(reservedTaskRunId, hold.payer);
    logger.error("[generations] failed to enqueue generation task", {
      userId: user.uuid,
      spaceId: request.spaceId,
      model: request.model,
      error,
    });
    return generationError(c, 503, "generation_queue_unavailable", "Generation queue is temporarily unavailable. Please try again later.");
  }

  return c.json({
    taskRunId,
    taskType: GENERATION_TASK_TYPE,
    status: "pending",
    billing: serializeBillingWarning(billingDecision),
    ...(hold ? { reservation: { amountUsd: hold.amountUsd, status: "held" as const } } : {}),
  } satisfies CreateGenerationTaskResponse, 202);
});

export default router;
