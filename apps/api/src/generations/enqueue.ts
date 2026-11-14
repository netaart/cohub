import {
  billingOperations,
  contentTypesFromBlocks,
  resolveGenerationUsageType,
  type BillingAccessDecision,
} from "@cohub/billing";
import { defaultJobRetention } from "@cohub/infra/bullmq";
import { createLogger } from "@cohub/infra/logging";
import {
  GENERATION_TASK_TYPE,
  TURN_SPEECH_TASK_TYPE,
  type GenerationContentBlock,
  type GenerationReserveHold,
  type GenerationTaskData,
} from "@cohub/protocol/generation";
import { GenerationValidationError } from "@neta-art/generation";
import { admitGeneration, GenerationBillingUnavailableError, generationReserveHolds } from "../generation-billing.js";
import { enqueueTask } from "../tasks.js";
import { loadGenerationDeclaration } from "./declarations.js";
import { resolveGenerationRequestParameters } from "./schema.js";

const logger = createLogger({ serviceName: "cohub-api" });

export class GenerationRequestError extends Error {
  constructor(readonly status: 400 | 404 | 503, readonly code: string, message: string) {
    super(message);
    this.name = "GenerationRequestError";
  }
}

export type GenerationRequestInput = {
  userId: string;
  model: string;
  content: GenerationContentBlock[];
  parameters?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

export async function validateGenerationRequest(input: GenerationRequestInput) {
  const declaration = await loadGenerationDeclaration(input.userId, input.model);
  if (!declaration) throw new GenerationRequestError(404, "generation_model_not_found", `Generation model not found: ${input.model}`);
  try {
    return { declaration, parameters: resolveGenerationRequestParameters(declaration, input) };
  } catch (error) {
    if (error instanceof GenerationValidationError) throw new GenerationRequestError(400, "invalid_generation_input", error.message);
    throw error;
  }
}

export async function enqueueGeneration(input: GenerationRequestInput & {
  spaceId: string;
  sessionId?: string | null;
  turnId?: string | null;
  taskRunId?: string;
} & Pick<GenerationTaskData, "requestSource" | "speech">): Promise<{
  taskRunId: string;
  billing: BillingAccessDecision;
  hold: GenerationReserveHold | null;
}> {
  const { declaration, parameters } = await validateGenerationRequest(input);
  const usageType = resolveGenerationUsageType({
    adapterType: declaration.adapter?.type,
    contentTypes: contentTypesFromBlocks(input.content),
  });
  const context = { userId: input.userId, spaceId: input.spaceId, model: input.model };

  let discount: Awaited<ReturnType<typeof billingOperations.getGenerationModelDiscount>>;
  try {
    discount = await billingOperations.getGenerationModelDiscount({ userId: input.userId, model: input.model });
  } catch (error) {
    logger.error("[Billing] failed to resolve generation model discount before enqueue", { ...context, error });
    throw new GenerationRequestError(503, "generation_pricing_unavailable", "Generation pricing is temporarily unavailable. Please try again later.");
  }
  if (discount.benefitKey) {
    logger.info("[Billing] generation model discount resolved", {
      ...context,
      multiplier: discount.multiplier,
      benefitKey: discount.benefitKey,
      resolvedAt: discount.resolvedAt,
    });
  }

  const taskRunId = input.taskRunId ?? crypto.randomUUID();
  let admission: Awaited<ReturnType<typeof admitGeneration>>;
  try {
    admission = await admitGeneration({
      taskRunId,
      userId: input.userId,
      spaceId: input.spaceId,
      sessionId: input.sessionId ?? null,
      turnId: input.turnId ?? null,
      model: input.model,
      usageType,
      discount,
    });
  } catch (error) {
    if (error instanceof GenerationBillingUnavailableError) throw new GenerationRequestError(503, "generation_balance_unavailable", error.message);
    throw error;
  }
  const { decision, hold } = admission;

  const data: GenerationTaskData = {
    model: input.model,
    content: input.content,
    parameters,
    meta: input.meta,
    requestSource: input.requestSource ?? null,
    modelDiscount: { multiplier: discount.multiplier, resolvedAt: discount.resolvedAt },
    ...(hold ? { reserveHold: hold } : {}),
    ...(input.speech ? { speech: input.speech } : {}),
  };
  try {
    const enqueued = await enqueueTask({
      type: input.speech ? TURN_SPEECH_TASK_TYPE : GENERATION_TASK_TYPE,
      spaceId: input.spaceId,
      sessionId: input.sessionId ?? undefined,
      turnId: input.turnId ?? undefined,
      userId: input.userId,
      data,
    }, { attempts: 1, ...defaultJobRetention, taskRunId });
    return { taskRunId: enqueued.taskRunId, billing: decision, hold };
  } catch (error) {
    if (hold) await generationReserveHolds.release(taskRunId, hold.payer, "enqueue_failed");
    logger.error("[generations] failed to enqueue generation task", { ...context, error });
    throw new GenerationRequestError(503, "generation_queue_unavailable", "Generation queue is temporarily unavailable. Please try again later.");
  }
}
