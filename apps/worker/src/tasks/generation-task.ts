import {
  BillingAccessBlockedError,
  billingOperations,
  calculateGenerationUsageCharge,
  COHUB_BILLING_TOKEN_TYPES,
  contentTypesFromBlocks,
  createBillingUsageGate,
  generationUsageKind,
  isGenerationModelDiscountFree,
  reconcileGenerationModelDiscountSnapshot,
  resolveGenerationUsageType,
} from "@cohub/billing";
import type { Job } from "bullmq";
import { createGenerationClient, GenerationConfigError } from "@neta-art/generation";
import { createGenerationDeclarationLoader } from "@cohub/infra/config-runtime/generation-declarations";
import {
  GENERATION_BILLING_RETRY_TASK_TYPE,
  GENERATION_TASK_TYPE,
  type GenerationBillingRetryTaskData,
  type GenerationModelDiscountSnapshot,
  type GenerationTaskData,
  type GenerationTaskResult,
  type GenerationUsageBilling,
} from "@cohub/protocol/generation";
import type { TaskPayload } from "@cohub/protocol/task";
import { defaultJobRetention } from "@cohub/infra/bullmq";
import { config } from "../config.js";
import { recordGenerationUsageStatsHourly } from "../generation-usage-stats.js";
import { redisCommandClient } from "../redis.js";
import { enqueueTask } from "./enqueue.js";
import { registerTask } from "./registry.js";
import { finalizeGenerationSession, markGenerationSessionRunning } from "./generation-session.js";
import { normalizeGenerationError } from "./generation-errors.js";

const loader = createGenerationDeclarationLoader({
  platformConfigRoot: config.platformConfigRoot,
  redis: redisCommandClient,
});
const billingUsageGate = createBillingUsageGate({
  operations: billingOperations,
  onEvaluationError: (error, gateInput) => {
    console.warn("[BillingGate] worker generation billing evaluation failed", { error, gateInput });
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseModelDiscountSnapshot(value: unknown): GenerationModelDiscountSnapshot {
  if (!isRecord(value)) throw new Error("Invalid generation task payload: modelDiscount is required");
  if (
    typeof value.multiplier !== "number" ||
    !Number.isFinite(value.multiplier) ||
    value.multiplier < 0 ||
    value.multiplier > 1
  ) {
    throw new Error("Invalid generation task payload: modelDiscount.multiplier must be between 0 and 1");
  }
  if (
    typeof value.resolvedAt !== "string" ||
    !value.resolvedAt.trim() ||
    !Number.isFinite(Date.parse(value.resolvedAt))
  ) {
    throw new Error("Invalid generation task payload: modelDiscount.resolvedAt must be an ISO date-time");
  }
  return {
    multiplier: value.multiplier,
    resolvedAt: value.resolvedAt,
  };
}

function parseGenerationTaskData(data: unknown): GenerationTaskData {
  if (!isRecord(data)) throw new Error("Invalid generation task payload: data is required");
  if (typeof data.model !== "string" || !data.model.trim()) {
    throw new Error("Invalid generation task payload: model is required");
  }
  if (!Array.isArray(data.content) || data.content.length === 0) {
    throw new Error("Invalid generation task payload: content is required");
  }
  if (data.parameters !== undefined && !isRecord(data.parameters)) {
    throw new Error("Invalid generation task payload: parameters must be an object");
  }
  if (data.meta !== undefined && !isRecord(data.meta)) {
    throw new Error("Invalid generation task payload: meta must be an object");
  }
  return {
    model: data.model,
    content: data.content as GenerationTaskData["content"],
    parameters: data.parameters,
    meta: data.meta,
    ...(data.modelDiscount === undefined
      ? {}
      : { modelDiscount: parseModelDiscountSnapshot(data.modelDiscount) }),
  };
}

function getGenerationApiKey(): string {
  if (!config.generationApiKey) throw new GenerationConfigError("Missing required env: GENERATION_API_KEY");
  return config.generationApiKey;
}

async function recordGenerationStatsSafe(input: {
  taskRunId: string;
  userId: string;
  spaceId: string;
  sessionId?: string | null;
  usageType: string;
  adapterType?: string | null;
  model: string;
  costTotal: number;
}) {
  try {
    await recordGenerationUsageStatsHourly({
      taskRunId: input.taskRunId,
      userId: input.userId,
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      usageType: input.usageType,
      adapterType: input.adapterType ?? null,
      model: input.model,
      costTotal: input.costTotal,
    });
  } catch (error) {
    console.warn("[UsageStats] failed to record generation usage stats", {
      userId: input.userId,
      spaceId: input.spaceId,
      model: input.model,
      usageType: input.usageType,
      taskRunId: input.taskRunId,
      error,
    });
  }
}

/**
 * Record multimodal generation usage after a successful provider call.
 * Failures are logged and never fail the task (matches LLM billing).
 */
async function enqueueGenerationBillingRetry(input: {
  userId: string;
  taskRunId: string;
  amountUsd: number;
  officialCostUsd: number;
  modelDiscount: GenerationModelDiscountSnapshot;
  usageType: string;
  model: string;
  adapterType?: string | null;
  spaceId: string;
  sessionId?: string | null;
}) {
  const data: GenerationBillingRetryTaskData = {
    schemaVersion: 2,
    taskRunId: input.taskRunId,
    userId: input.userId,
    amountUsd: input.amountUsd,
    officialCostUsd: input.officialCostUsd,
    modelDiscount: input.modelDiscount,
    usageType: input.usageType,
    model: input.model,
    adapterType: input.adapterType ?? null,
  };
  // Credit consumption remains idempotent via operationId `generation:${taskRunId}`.
  await enqueueTask({
    type: GENERATION_BILLING_RETRY_TASK_TYPE,
    spaceId: input.spaceId,
    sessionId: input.sessionId ?? undefined,
    userId: input.userId,
    data,
  }, {
    attempts: 8,
    backoff: { type: "exponential", delay: 5_000 },
    ...defaultJobRetention,
  });
}

async function recordGenerationUsageBilling(input: {
  userId: string;
  taskRunId: string;
  model: string;
  adapterType: string | null | undefined;
  officialCostUsd: number;
  modelDiscount: GenerationModelDiscountSnapshot;
  usageType: ReturnType<typeof resolveGenerationUsageType>;
  spaceId: string;
  sessionId?: string | null;
}): Promise<GenerationUsageBilling> {
  const pricing = calculateGenerationUsageCharge(input.officialCostUsd, input.modelDiscount);
  const { officialCostUsd, amountUsd } = pricing;
  const billingPricing = {
    officialCostUsd,
    amountUsd,
    discountMultiplier: pricing.discountMultiplier,
    usageType: input.usageType,
  };
  if (pricing.skipReason) {
    return {
      ...billingPricing,
      status: "skipped",
      reason: pricing.skipReason,
    };
  }
  if (!billingOperations.status.configured) {
    return { ...billingPricing, status: "skipped", reason: "billing_not_configured" };
  }
  if (!input.taskRunId) {
    return { ...billingPricing, status: "skipped", reason: "missing_task_run_id" };
  }

  try {
    const result = await billingOperations.recordUsage({
      userId: input.userId,
      amountUsd,
      tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
      usageType: input.usageType,
      sourceId: input.taskRunId,
      operationId: `generation:${input.taskRunId}`,
      reason: `Generation ${input.model}`,
    });
    if (result.status === "overage") {
      console.warn("[Billing] generation usage recorded as overage", {
        userId: input.userId,
        taskRunId: input.taskRunId,
        officialCostUsd,
        amountUsd,
        discountMultiplier: input.modelDiscount.multiplier,
        model: input.model,
        usageType: input.usageType,
        adapterType: input.adapterType ?? null,
      });
    }
    if (result.status === "disabled" || result.status === "skipped") {
      return {
        ...billingPricing,
        status: "skipped",
        reason: result.status === "disabled" ? "billing_disabled" : "zero_amount",
      };
    }
    return {
      ...billingPricing,
      status: result.status === "overage" ? "overage" : "recorded",
    };
  } catch (error) {
    console.warn("[Billing] failed to record generation usage; enqueueing retry", {
      userId: input.userId,
      taskRunId: input.taskRunId,
      officialCostUsd,
      amountUsd,
      discountMultiplier: input.modelDiscount.multiplier,
      model: input.model,
      usageType: input.usageType,
      adapterType: input.adapterType ?? null,
      error,
    });
    await enqueueGenerationBillingRetry({
      userId: input.userId,
      taskRunId: input.taskRunId,
      amountUsd,
      officialCostUsd,
      modelDiscount: input.modelDiscount,
      usageType: input.usageType,
      model: input.model,
      adapterType: input.adapterType ?? null,
      spaceId: input.spaceId,
      sessionId: input.sessionId,
    }).catch((enqueueError) => {
      console.warn("[Billing] failed to enqueue generation billing retry", {
        userId: input.userId,
        taskRunId: input.taskRunId,
        officialCostUsd,
        amountUsd,
        error: enqueueError,
      });
    });
    return { ...billingPricing, status: "skipped", reason: "record_failed" };
  }
}

registerTask(GENERATION_TASK_TYPE, async (job: Job, context) => {
  const payload = job.data as TaskPayload;
  const spaceId = payload.spaceId;
  const sessionId = payload.sessionId;
  const turnId = payload.turnId;
  const userId = payload.userId;
  if (!spaceId) throw new Error("Invalid generation task payload: spaceId is required");
  if (!userId) throw new Error("Invalid generation task payload: userId is required");
  const data = parseGenerationTaskData(payload.data);
  const taskRunId = context?.taskRunId ?? String(job.id ?? "");
  await markGenerationSessionRunning(taskRunId).catch((error) => {
    console.warn("[GenerationSession] failed to mark turn running", error);
  });

  try {
    const declaration = await loader.loadGenerationDeclaration(userId, data.model);
    if (!declaration) throw new Error(`Generation model is unavailable: ${data.model}`);

    // Re-read authoritative entitlements before trusting a queued snapshot. This
    // binds discounts to the task user/model and keeps old API payloads safe.
    const resolvedDiscount = await billingOperations.getGenerationModelDiscount({
      userId,
      model: data.model,
    });
    const modelDiscount = reconcileGenerationModelDiscountSnapshot({
      model: data.model,
      snapshot: data.modelDiscount,
      resolved: resolvedDiscount,
    });
    if (resolvedDiscount.benefitKey) {
      console.info("[Billing] worker verified generation model discount", {
        userId,
        spaceId,
        model: data.model,
        multiplier: resolvedDiscount.multiplier,
        benefitKey: resolvedDiscount.benefitKey,
        resolvedAt: resolvedDiscount.resolvedAt,
        acceptedAt: modelDiscount.resolvedAt,
      });
    }

    // Gate uses request-side modality; billing/stats re-resolve with output after success.
    const gateUsageType = resolveGenerationUsageType({
      adapterType: declaration.adapter?.type,
      contentTypes: contentTypesFromBlocks(data.content),
    });
    const billingDecision = isGenerationModelDiscountFree(modelDiscount)
      ? { status: "allowed" as const, balanceState: "zero" as const, netUsd: 0 }
      : await billingUsageGate.evaluate({
          userId,
          usageKind: generationUsageKind(gateUsageType),
          source: "generation_task",
          model: data.model,
          spaceId,
          sessionId: sessionId ?? null,
          turnId: turnId ?? null,
        });
    if (billingDecision.status === "blocked") throw new BillingAccessBlockedError(billingDecision);

    const result = await createGenerationClient({
      models: [declaration],
      includeBuiltinModels: false,
      apiKey: getGenerationApiKey(),
      ...(config.generationBaseUrl ? { baseUrl: config.generationBaseUrl } : {}),
    }).generateResult({
      model: data.model,
      content: data.content,
      parameters: data.parameters,
      meta: data.meta,
    });

    const usageType = resolveGenerationUsageType({
      adapterType: declaration.adapter?.type,
      contentTypes: [
        ...contentTypesFromBlocks(result.content),
        ...contentTypesFromBlocks(data.content),
      ],
    });
    const billing = await recordGenerationUsageBilling({
      userId,
      taskRunId,
      model: data.model,
      adapterType: declaration.adapter?.type,
      officialCostUsd: result.cost ?? 0,
      modelDiscount,
      usageType,
      spaceId,
      sessionId,
    });
    if (billing.status === "skipped" && billing.reason === "missing_cost") {
      console.warn("[Billing] generation completed without provider cost", {
        userId,
        taskRunId,
        model: data.model,
        usageType,
        adapterType: declaration.adapter?.type ?? null,
      });
    }

    // Success-only rollup (idempotent via taskRunId). Failures stay out to avoid retry noise.
    await recordGenerationStatsSafe({
      taskRunId,
      userId,
      spaceId,
      sessionId,
      usageType,
      adapterType: declaration.adapter?.type,
      model: data.model,
      costTotal: result.cost ?? 0,
    });

    const taskResult = {
      model: data.model,
      provider: declaration.adapter?.type ?? null,
      output: result.content,
      ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
      ...(result.cost !== undefined ? { cost: result.cost } : {}),
      billing,
      ...(data.meta ? { meta: data.meta } : {}),
    } satisfies GenerationTaskResult;
    await finalizeGenerationSession({ taskRunId, payload, result: taskResult });
    return taskResult;
  } catch (error) {
    throw normalizeGenerationError(error);
  }
});
