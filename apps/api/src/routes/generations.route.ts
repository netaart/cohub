import { BillingAccessBlockedError, serializeBillingWarning } from "@cohub/billing";
import { Hono, type Context } from "hono";
import { GENERATION_TASK_TYPE, type CreateGenerationTaskResponse } from "@cohub/protocol/generation";
import { useAuth, authzDenied } from "../lib/middleware.js";
import { billingBlockedResponse } from "../lib/billing-blocked.js";
import { hasPermission } from "../permissions.js";
import { enqueueGeneration, GenerationRequestError } from "../generations/enqueue.js";
import { createGenerationTaskRequestSchema } from "../generations/schema.js";
import { getSpaceSessionById } from "../space-sessions.js";
import { getSessionTurnById } from "../session-turns.js";
import { getRequestSource } from "../lib/request-source.js";

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

  const sessionId = request.sessionId?.trim() || null;
  const turnId = request.turnId?.trim() || null;
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

  try {
    const { taskRunId, billing, hold } = await enqueueGeneration({
      userId: user.uuid,
      spaceId: request.spaceId,
      sessionId,
      turnId,
      model: request.model,
      content: request.content,
      parameters: request.parameters,
      meta: request.meta,
      requestSource: getRequestSource(c),
    });
    return c.json({
      taskRunId,
      taskType: GENERATION_TASK_TYPE,
      status: "pending",
      billing: serializeBillingWarning(billing),
      ...(hold ? { reservation: { amountUsd: hold.amountUsd, status: "held" as const } } : {}),
    } satisfies CreateGenerationTaskResponse, 202);
  } catch (error) {
    if (error instanceof BillingAccessBlockedError) return billingBlockedResponse(c, error);
    if (error instanceof GenerationRequestError) return generationError(c, error.status, error.code, error.message);
    throw error;
  }
});

export default router;
