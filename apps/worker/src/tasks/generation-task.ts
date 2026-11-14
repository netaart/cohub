import {
  BillingAccessBlockedError,
  billingOperations,
  calculateGenerationUsageCharge,
  COHUB_BILLING_TOKEN_TYPES,
  contentTypesFromBlocks,
  generationUsageKind,
  isGenerationModelDiscountFree,
  reconcileGenerationModelDiscountSnapshot,
  resolveGenerationUsageType,
} from "@cohub/billing";
import type { Job } from "bullmq";
import { parseGenerationReserveHold } from "@cohub/core/generation-billing";
import { generationReserveHolds } from "../generation-billing.js";
import {
  createGenerationClient,
  GenerationConfigError,
  GenerationProviderError,
  GenerationUnsupportedAdapterError,
  GenerationValidationError,
} from "@neta-art/generation";
import { createGenerationDeclarationLoader } from "@cohub/infra/config-runtime/generation-declarations";
import {
  GENERATION_BILLING_RETRY_TASK_TYPE,
  GENERATION_TASK_TYPE,
  TURN_SPEECH_TASK_TYPE,
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
import { createGenerationTaskFetch } from "../generation-task-fetch.js";
import { redisCommandClient } from "../redis.js";
import { enqueueTask } from "./enqueue.js";
import { registerTask, type TaskHandler } from "./registry.js";
import { finalizeGenerationSession, markGenerationSessionRunning } from "./generation-session.js";
import { settleTurnSpeechTask } from "./turn-speech.js";
import { spaceWalletBilling } from "../space-wallet-billing.js";

const loader = createGenerationDeclarationLoader({
  platformConfigRoot: config.platformConfigRoot,
  redis: redisCommandClient,
});
const billingUsageGate = spaceWalletBilling.gate;

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
    reserveHold: parseGenerationReserveHold(data.reserveHold),
  };
}

function getGenerationApiKey(): string {
  if (!config.generationApiKey) throw new GenerationConfigError("Missing required env: GENERATION_API_KEY");
  return config.generationApiKey;
}

function summarizeProviderBody(body: string | undefined): string | null {
  if (!body) return null;
  return body.replace(/\s+/g, " ").trim().slice(0, 500) || null;
}

function truncateProviderDetail(value: string, maxLength = 1_000): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function summarizeProviderDetails(details: Record<string, unknown> | undefined): string | null {
  if (!details) return null;
  try {
    const serialized = JSON.stringify(details);
    if (!serialized) return null;
    return `details ${truncateProviderDetail(serialized.replace(/\s+/g, " "))}`;
  } catch {
    return "details [unserializable]";
  }
}

function providerStatusMessage(status: number | undefined): string | null {
  if (status === undefined) return null;
  if (status === 401 || status === 403) return "Generation provider rejected the configured credentials";
  if (status === 429) return "Generation provider rate limit exceeded";
  if (status >= 500) return "Generation provider is temporarily unavailable";
  return "Generation provider request failed";
}

function normalizeGenerationError(error: unknown): Error {
  if (error instanceof GenerationValidationError) {
    return new Error(`Invalid generation input: ${error.message}`);
  }
  if (error instanceof GenerationProviderError) {
    const parts = [providerStatusMessage(error.status) ?? error.message];
    if (error.status !== undefined) parts.push(`HTTP ${error.status}`);
    const details = summarizeProviderDetails(error.details);
    if (details) parts.push(details);
    const body = summarizeProviderBody(error.body);
    if (body) parts.push(body);
    return new Error(parts.join(" — "));
  }
  if (error instanceof GenerationConfigError || error instanceof GenerationUnsupportedAdapterError) {
    return new Error(error.message);
  }
  if (error instanceof Error) return error;
  return new Error(String(error));
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
  payer: GenerationBillingRetryTaskData["payer"];
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
    payer: input.payer ?? null,
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
    // A held task's retry waits for the generation to finalize, so a later task failure can still skip it.
    ...(input.payer ? { delay: 30_000 } : {}),
    backoff: { type: "exponential", delay: 5_000 },
    ...defaultJobRetention,
  });
}

async function recordGenerationUsageBilling(input: {
  retryOnly: boolean;
  userId: string;
  taskRunId: string;
  model: string;
  adapterType: string | null | undefined;
  officialCostUsd: number;
  modelDiscount: GenerationModelDiscountSnapshot;
  usageType: ReturnType<typeof resolveGenerationUsageType>;
  spaceId: string;
  sessionId?: string | null;
  payer: GenerationBillingRetryTaskData["payer"];
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
    const result = await spaceWalletBilling.recordUsage({
      retryOnly: input.retryOnly,
      payer: input.payer,
      spaceId: input.spaceId,
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
        reason: result.status === "disabled" ? "billing_disabled" : "record_failed",
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
      payer: input.payer,
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

const runGenerationTask: TaskHandler = async (job: Job, context) => {
  const payload = job.data as TaskPayload;
  const spaceId = payload.spaceId;
  const sessionId = payload.sessionId;
  const turnId = payload.turnId;
  const userId = payload.userId;
  if (!spaceId) throw new Error("Invalid generation task payload: spaceId is required");
  if (!userId) throw new Error("Invalid generation task payload: userId is required");
  const data = parseGenerationTaskData(payload.data);
  const taskRunId = context?.taskRunId ?? String(job.id ?? "");
  const runnable = await markGenerationSessionRunning(taskRunId).catch((error) => {
    console.warn("[GenerationSession] failed to mark turn running", error);
    return null;
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
    // A held task fails closed: a turn that was cancelled, finished, or cannot be read must not be charged.
    if (data.reserveHold && runnable !== true) {
      throw new Error(runnable === false ? "Generation turn is no longer runnable." : "Generation turn state could not be verified.");
    }
    // The submission hold already proved the balance; the gate would re-check a balance the hold reserved.
    const billingDecision = data.reserveHold || isGenerationModelDiscountFree(modelDiscount)
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
      fetch: createGenerationTaskFetch(taskRunId, config.generationBaseUrl),
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
      retryOnly: job.attemptsMade > 0 || job.attemptsStarted > 1,
      userId,
      taskRunId,
      model: data.model,
      adapterType: declaration.adapter?.type,
      officialCostUsd: result.cost ?? 0,
      modelDiscount,
      usageType,
      spaceId,
      sessionId,
      payer: data.reserveHold?.payer.type ?? null,
    });
    if (data.reserveHold) {
      // An uncommitted charge keeps its hold; the billing retry releases it once the debit lands, else the TTL does.
      if (billing.status === "skipped" && billing.reason === "record_failed") {
        console.info("[GenerationReserve] kept until the billing retry charges", {
          taskRunId,
          payerType: data.reserveHold.payer.type,
          payerId: data.reserveHold.payer.id,
          amountUsd: billing.amountUsd,
        });
      } else {
        await generationReserveHolds.release(taskRunId, data.reserveHold.payer, "charged");
      }
    }
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
    await settleTurnSpeechTask({ taskRunId, payload, output: result.content }).catch((error) => {
      console.warn("[TurnSpeech] failed to record segment", { taskRunId, error });
    });
    return taskResult;
  } catch (error) {
    throw normalizeGenerationError(error);
  }
};

registerTask(GENERATION_TASK_TYPE, runGenerationTask);
registerTask(TURN_SPEECH_TASK_TYPE, runGenerationTask);
