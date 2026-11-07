import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as z from "zod";
import {
  BillingAccessBlockedError,
  billingOperations,
  COHUB_BILLING_TOKEN_TYPES,
  COHUB_BILLING_USAGE_TYPES,
  normalizePositiveUsd,
  serializeBillingBlocked,
} from "@cohub/billing";
import type { CreateSpaceDecisionInput, SpaceDecisionResult } from "@cohub/protocol";
import { createLogger } from "@cohub/infra/logging";
import { selectDecisionModel } from "@cohub/infra/config-runtime/decisions";
import { authzDenied, requireValidId, useAuth } from "../../lib/middleware.js";
import {
  formatZodIssues,
  RequestError,
  requestErrorFrom,
  requestErrorResponse,
  zodIssueDetails,
} from "../../lib/request-error.js";
import { hasPermission } from "../../permissions.js";
import { getSpaceById } from "../../space-sessions.js";
import { archiveDecisionBestEffort, createModelCallId } from "../../model-call-archive.js";
import { callDecisionUpstream } from "../../decisions/client.js";
import { countStateImages, prepareDecisionState } from "../../decisions/state.js";
import { loadDecisionModels } from "../../decisions/models.js";
import { spaceWalletBilling } from "../../space-wallet-billing.js";

const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();

const billingUsageGate = spaceWalletBilling.gate;

const MAX_QUESTIONS = 200;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MIN_CRITERIA_ITEMS = 2;

const decisionRequestBodyLimit = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) => requestErrorResponse(c, 413, "decision_request_too_large", "Decision request body is too large."),
});

const decisionStateImageSchema = z.object({
  type: z.literal("image_url"),
  image_url: z.union([z.string().trim().min(1), z.object({ url: z.string().trim().min(1) }).loose()]),
});

const decisionStateSchema = z.union([
  z.string().min(1),
  z.record(z.string(), z.unknown()),
  z.array(z.union([z.string().min(1), decisionStateImageSchema])).min(1),
]);

const instructionsSchema = z.string().trim().min(1);

const decisionQuestionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), instructions: instructionsSchema }).loose(),
  z.object({
    type: z.literal("choice"),
    instructions: instructionsSchema,
    criteria: z.record(z.string(), z.string()).refine(
      (criteria) => Object.keys(criteria).length >= MIN_CRITERIA_ITEMS,
      `Choice questions need at least ${MIN_CRITERIA_ITEMS} criteria.`,
    ),
  }).loose(),
  z.object({
    type: z.literal("score"),
    instructions: instructionsSchema,
    criteria: z.array(z.string()).min(MIN_CRITERIA_ITEMS),
  }).loose(),
]);

const createDecisionSchema = z.object({
  provider: z.string().trim().min(1).nullish(),
  model: z.string().trim().min(1).nullish(),
  state: decisionStateSchema,
  questions: z.record(z.string().trim().min(1), decisionQuestionSchema)
    .refine((questions) => Object.keys(questions).length <= MAX_QUESTIONS, `At most ${MAX_QUESTIONS} questions.`),
});

async function recordDecisionBilling(input: {
  spaceId: string;
  decisionId: string;
  userId: string;
  provider: string;
  model: string;
  costUsd: number | null;
}) {
  // Unlike completions, the charge comes from the cost the upstream reports.
  const amountUsd = normalizePositiveUsd(input.costUsd);
  if (amountUsd <= 0) {
    logger.warn("[Decision] upstream returned no cost; skipping billing", {
      decisionId: input.decisionId,
      provider: input.provider,
      model: input.model,
      cost: input.costUsd,
    });
    return;
  }
  if (!billingOperations.status.configured) return;
  try {
    const result = await spaceWalletBilling.recordUsage({
      spaceId: input.spaceId,
      userId: input.userId,
      amountUsd,
      tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
      usageType: COHUB_BILLING_USAGE_TYPES.generationDecision,
      sourceId: input.decisionId,
      operationId: `decision:${input.decisionId}`,
      reason: `Decision call ${input.provider}/${input.model}`,
    });
    if (result.status === "overage") {
      logger.warn("[Billing] decision usage recorded as overage", {
        userId: input.userId,
        decisionId: input.decisionId,
        amountUsd,
      });
    }
  } catch (error) {
    logger.warn("[Billing] failed to record decision usage", {
      userId: input.userId,
      decisionId: input.decisionId,
      amountUsd,
      error,
    });
  }
}

router.post("/", decisionRequestBodyLimit, async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;

  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) {
    return requestErrorResponse(c, 404, "space_not_found", "Space not found.");
  }
  if (!(await hasPermission(user, "session.prompt.readonly", { spaceId }))) {
    return authzDenied(c);
  }
  const space = await getSpaceById(spaceId);
  if (!space) return requestErrorResponse(c, 404, "space_not_found", "Space not found.");

  const rawBody: unknown = await c.req.json().catch(() => undefined);
  if (rawBody === undefined) {
    return requestErrorResponse(c, 400, "invalid_decision_request", "Body must be valid JSON.", { reason: "invalid_json" });
  }
  const parsed = createDecisionSchema.safeParse(rawBody);
  if (!parsed.success) {
    const details = zodIssueDetails(parsed.error);
    return requestErrorResponse(c, 400, "invalid_decision_request", formatZodIssues(details), { issues: details });
  }
  const body = parsed.data as CreateSpaceDecisionInput;

  const models = await loadDecisionModels(user.uuid).catch((error) => {
    logger.error("[Decision] failed to load model catalog", error);
    return null;
  });
  if (!models || models.length === 0) {
    return requestErrorResponse(c, 503, "decisions_unavailable", "Decision models are unavailable.");
  }
  const selected = selectDecisionModel(models, { provider: body.provider, model: body.model });
  if (!selected.model) {
    return requestErrorResponse(c, 404, "model_not_found", selected.error ?? "Model not found.", {
      provider: body.provider ?? null,
      model: body.model ?? null,
    });
  }
  const model = selected.model;

  const imageCount = countStateImages(body.state);
  if (imageCount > model.maxImages) {
    return requestErrorResponse(
      c,
      400,
      "decision_image_limit",
      model.maxImages === 0
        ? `${model.id} does not accept images.`
        : `${model.id} accepts at most ${model.maxImages} images (received ${imageCount}).`,
      { model: model.id, imageCount, maxImages: model.maxImages },
    );
  }

  const gate = await billingUsageGate.evaluate({
    userId: user.uuid,
    usageKind: "llm.decision",
    source: "decision",
    model: model.id,
    provider: model.provider,
    spaceId,
  });
  if (gate.status === "blocked") {
    return c.json(serializeBillingBlocked(new BillingAccessBlockedError(gate)), 402);
  }

  const decisionId = createModelCallId();
  const startedAt = new Date();

  let state: Awaited<ReturnType<typeof prepareDecisionState>>;
  try {
    state = await prepareDecisionState(body.state, { signal: c.req.raw.signal });
  } catch (error) {
    if (error instanceof RequestError) return requestErrorFrom(c, error);
    throw error;
  }
  const outcome = await callDecisionUpstream({
    model,
    state,
    questions: body.questions,
    userId: user.uuid,
    spaceId,
    decisionId,
    signal: c.req.raw.signal,
  });

  const completedAt = new Date();
  const archive = {
    decisionId,
    spaceId,
    userId: user.uuid,
    provider: model.provider,
    model: model.id,
    request: { provider: model.provider, model: model.id, state: body.state, questions: body.questions },
    attempts: outcome.attempts,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
    clientAborted: outcome.status === "aborted",
    error: outcome.status === "failed" ? { code: outcome.error.code, message: outcome.error.message } : null,
  };

  if (outcome.status !== "succeeded") {
    archiveDecisionBestEffort({ ...archive, costUsd: null });
    if (outcome.status === "aborted") {
      return requestErrorResponse(c, 400, "decision_aborted", "Decision request was aborted.");
    }
    logger[outcome.error.status === 400 ? "warn" : "error"]("[Decision] upstream call failed", {
      decisionId,
      model: model.id,
      attempts: outcome.attempts,
    });
    return requestErrorFrom(c, outcome.error);
  }

  const costUsd = outcome.usage.cost?.total ?? null;
  archiveDecisionBestEffort({ ...archive, costUsd });
  await recordDecisionBilling({
    spaceId,
    decisionId,
    userId: user.uuid,
    provider: model.provider,
    model: model.id,
    costUsd,
  });

  const result: SpaceDecisionResult = {
    decisionId,
    provider: model.provider,
    model: model.id,
    answers: outcome.answers,
    usage: outcome.usage,
  };
  return c.json(result);
});

export default router;
