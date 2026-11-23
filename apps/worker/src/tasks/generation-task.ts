import {
  BillingAccessBlockedError,
  billingOperations,
  calculateUsageCharge,
  COHUB_BILLING_TOKEN_TYPES,
  generationUsageKind,
  isPricingSnapshotFree,
  legacyPricingSnapshot,
  parsePricingSnapshot,
  pricingDiscountFor,
  resolveGenerationUsageType,
  snapshotMultiplier,
  type PricingPayer,
} from "@cohub/billing";
import type { Job } from "bullmq";
import { parseGenerationReserveHold } from "@cohub/core/generation-billing";
import { pricedReason } from "@cohub/core/usage-pricing";
import { generationReserveHolds, markGenerationDelivered } from "../generation-billing.js";
import { createGenerationClient, GenerationConfigError } from "@neta-art/generation";
import { createGenerationDeclarationLoader } from "@cohub/infra/config-runtime/generation-declarations";
import {
  GENERATION_BILLING_RETRY_TASK_TYPE,
  GENERATION_TASK_TYPE,
  TURN_SPEECH_TASK_TYPE,
  type GenerationBillingRetryTaskData,
  type GenerationModelDiscountSnapshot,
  type GenerationPricingSnapshot,
  type GenerationTaskData,
  type GenerationTaskResult,
  type GenerationUsageBilling,
} from "@cohub/protocol/generation";
import type { TaskPayload } from "@cohub/protocol/task";
import { defaultJobRetention } from "@cohub/infra/bullmq";
import { config } from "../config.js";
import { normalizeGenerationError, withGenerationRetry } from "../generation-errors.js";
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
  warn: (message) => console.warn(`[Generation] ${message}`),
});
const billingUsageGate = spaceWalletBilling.gate;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Tasks queued before pricing rules carried one multiplier for every payer. */
function parseLegacyModelDiscount(value: unknown): GenerationPricingSnapshot {
  if (!isRecord(value)) throw new Error("Invalid generation task payload: modelDiscount is invalid");
  const { multiplier, resolvedAt } = value;
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier < 0 || multiplier > 1) {
    throw new Error("Invalid generation task payload: modelDiscount.multiplier must be between 0 and 1");
  }
  if (typeof resolvedAt !== "string" || !Number.isFinite(Date.parse(resolvedAt))) {
    throw new Error("Invalid generation task payload: modelDiscount.resolvedAt must be an ISO date-time");
  }
  return legacyPricingSnapshot(multiplier, resolvedAt);
}

function parsePricing(data: Record<string, unknown>): GenerationPricingSnapshot {
  if (data.pricing !== undefined) return parsePricingSnapshot(data.pricing, "Invalid generation task payload: pricing");
  if (data.modelDiscount !== undefined) return parseLegacyModelDiscount(data.modelDiscount);
  return legacyPricingSnapshot(1, new Date(0).toISOString());
}

function parseGenerationTaskData(data: unknown): GenerationTaskData & { pricing: GenerationPricingSnapshot } {
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
    pricing: parsePricing(data),
    reserveHold: parseGenerationReserveHold(data.reserveHold),
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
  payer: GenerationBillingRetryTaskData["payer"];
  reason: string;
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
    reason: input.reason,
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

/** The charge one payer would owe for this generation, with the reason the balance ledger renders. */
function chargeFor(pricing: GenerationPricingSnapshot, payer: PricingPayer, officialCostUsd: number, model: string) {
  const multiplier = snapshotMultiplier(pricing, payer);
  return {
    ...calculateUsageCharge(officialCostUsd, multiplier),
    reason: pricedReason(`Generation ${model}`, { officialUsd: officialCostUsd, discount: pricingDiscountFor(pricing, payer), quota: pricing.quota }),
  };
}

async function recordGenerationUsageBilling(input: {
  retryOnly: boolean;
  userId: string;
  taskRunId: string;
  model: string;
  adapterType: string | null | undefined;
  officialCostUsd: number;
  pricing: GenerationPricingSnapshot;
  usageType: ReturnType<typeof resolveGenerationUsageType>;
  spaceId: string;
  sessionId?: string | null;
  payer: GenerationBillingRetryTaskData["payer"];
}): Promise<GenerationUsageBilling> {
  // An unpinned charge is priced for the user; the wallet router swaps in the wallet price if it pays.
  const charge = chargeFor(input.pricing, input.payer ?? "personal", input.officialCostUsd, input.model);
  const walletCharge = input.payer ? null : chargeFor(input.pricing, "space_wallet", input.officialCostUsd, input.model);
  const { officialCostUsd, amountUsd } = charge;
  const quota = input.pricing.quota
    ? { tokenType: input.pricing.quota.tokenType, requested: input.pricing.quota.requested, covered: input.pricing.quota.covered }
    : null;
  const billingPricing = {
    officialCostUsd,
    amountUsd,
    discountMultiplier: charge.discountMultiplier,
    usageType: input.usageType,
    ...(quota ? { quota } : {}),
  };
  const context = {
    userId: input.userId,
    taskRunId: input.taskRunId,
    officialCostUsd,
    amountUsd,
    discountMultiplier: charge.discountMultiplier,
    model: input.model,
    usageType: input.usageType,
    adapterType: input.adapterType ?? null,
  };
  if (charge.skipReason) return { ...billingPricing, status: "skipped", reason: charge.skipReason };
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
      reason: charge.reason,
      ...(walletCharge ? { spaceWalletCharge: { amountUsd: walletCharge.amountUsd, reason: walletCharge.reason } } : {}),
      tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
      usageType: input.usageType,
      sourceId: input.taskRunId,
      operationId: `generation:${input.taskRunId}`,
    });
    const charged = result.payer === "space_wallet" && walletCharge
      ? { amountUsd: walletCharge.amountUsd, discountMultiplier: walletCharge.discountMultiplier }
      : {};
    if (result.status === "overage") console.warn("[Billing] generation usage recorded as overage", { ...context, ...charged, payer: result.payer });
    if (result.status === "disabled" || result.status === "skipped") {
      return {
        ...billingPricing,
        ...charged,
        status: "skipped",
        reason: result.status === "disabled" ? "billing_disabled" : "record_failed",
      };
    }
    return { ...billingPricing, ...charged, status: result.status === "overage" ? "overage" : "recorded" };
  } catch (error) {
    console.warn("[Billing] failed to record generation usage; enqueueing retry", { ...context, error });
    await enqueueGenerationBillingRetry({
      userId: input.userId,
      taskRunId: input.taskRunId,
      amountUsd,
      officialCostUsd,
      modelDiscount: { multiplier: charge.discountMultiplier, resolvedAt: input.pricing.resolvedAt },
      usageType: input.usageType,
      model: input.model,
      adapterType: input.adapterType ?? null,
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      payer: input.payer,
      reason: charge.reason,
    }).catch((enqueueError) => {
      console.warn("[Billing] failed to enqueue generation billing retry", { ...context, error: enqueueError });
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

    const { pricing } = data;
    const usageType = resolveGenerationUsageType(declaration.category);
    // Held or quota-covered tasks fail closed: a turn that was cancelled, finished, or cannot be read
    // must not be charged, and its quota has already gone back to the user.
    const drewQuota = (pricing.quota?.covered ?? 0) > 0;
    if ((data.reserveHold || drewQuota) && runnable !== true) {
      throw new Error(runnable === false ? "Generation turn is no longer runnable." : "Generation turn state could not be verified.");
    }
    // The submission hold already proved the balance; the gate would re-check a balance the hold reserved.
    const billingDecision = data.reserveHold || isPricingSnapshotFree(pricing)
      ? { status: "allowed" as const, balanceState: "zero" as const, netUsd: 0 }
      : await billingUsageGate.evaluate({
          userId,
          usageKind: generationUsageKind(usageType),
          source: "generation_task",
          model: data.model,
          spaceId,
          sessionId: sessionId ?? null,
          turnId: turnId ?? null,
        });
    if (billingDecision.status === "blocked") throw new BillingAccessBlockedError(billingDecision);

    let gatewayRequests = 0;
    const client = createGenerationClient({
      models: [declaration],
      includeBuiltinModels: false,
      apiKey: getGenerationApiKey(),
      fetch: createGenerationTaskFetch(taskRunId, {
        baseUrl: config.generationBaseUrl,
        onGatewayRequest: () => { gatewayRequests += 1; },
      }),
      ...(config.generationBaseUrl ? { baseUrl: config.generationBaseUrl } : {}),
    });
    const result = await withGenerationRetry(
      () => client.generateResult({
        model: data.model,
        content: data.content,
        parameters: data.parameters,
        meta: data.meta,
      }),
      {
        gatewayRequests: () => gatewayRequests,
        onRetry: (error) => console.warn("[Generation] retrying after a provider failure", {
          taskRunId,
          model: data.model,
          error: normalizeGenerationError(error).message,
        }),
      },
    );

    markGenerationDelivered(taskRunId);

    const billing = await recordGenerationUsageBilling({
      retryOnly: job.attemptsMade > 0 || job.attemptsStarted > 1,
      userId,
      taskRunId,
      model: data.model,
      adapterType: declaration.adapter?.type,
      officialCostUsd: result.cost ?? 0,
      pricing,
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
