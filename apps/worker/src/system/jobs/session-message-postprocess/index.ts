import { billingOperations, spaceWalletBillingOperations, COHUB_BILLING_TOKEN_TYPES, COHUB_BILLING_USAGE_TYPES, normalizePositiveUsd } from "@cohub/billing";
import { claimMessageWalletBilling } from "@cohub/core/space-wallet";
import { readImageToTextCalls, recordTokenUsage, resolveUsageActorUserId, tokenUsageIncrements } from "@cohub/core/sessions";
import { sessionMessages, spaceSessions } from "@cohub/db";
import {
  isLlmUsageMessage,
  SESSION_MESSAGE_POSTPROCESS_JOB,
  type SessionMessagePostprocessJobData,
  type Usage,
} from "@cohub/protocol";
import type { Job } from "bullmq";
import { and, eq, isNull } from "drizzle-orm";
import { createLogger } from "@cohub/infra/logging";
import { db } from "../../../db.js";
import { registerSystemJob } from "../../registry.js";
import { spaceWalletBilling } from "../../../space-wallet-billing.js";
import { usagePricing } from "../../../usage-pricing.js";
import { priceUsage, type FrozenPricing } from "@cohub/core/usage-pricing";
import { redisCommandClient } from "../../../redis.js";
import { stopTurnsOnBillingBlock } from "./billing-stop.js";

const logger = createLogger({ serviceName: "cohub-worker" });

const normalizeUsage = (value: unknown): Usage | null =>
  value && typeof value === "object" ? (value as Usage) : null;

type LlmCharge = { officialUsd: number; operationId: string; provider: string; model: string };

/** The LLM calls of a message that cost money: the message itself and its succeeded image-to-text calls. */
const billableLlmCharges = (message: typeof sessionMessages.$inferSelect, usage: Usage | null): LlmCharge[] => {
  if ((message.meta as { runtime?: unknown } | null)?.runtime === "local") return [];
  const charges: LlmCharge[] = [];
  if (!message.errorMessage && message.stopReason !== "error" && message.stopReason !== "aborted") {
    charges.push({ officialUsd: normalizePositiveUsd(usage?.cost?.total), operationId: `llm:${message.id}`, provider: message.provider ?? "unknown", model: message.model ?? "unknown" });
  }
  for (const call of readImageToTextCalls(message.meta)) {
    if (call.status !== "succeeded") continue;
    charges.push({ officialUsd: normalizePositiveUsd(call.usage?.cost?.total), operationId: `llm:image-to-text:${message.id}:${call.sourceKey}`, provider: call.provider, model: call.model });
  }
  return charges.filter((charge) => charge.officialUsd > 0);
};

const llmSubject = (charge: LlmCharge, at: Date) => ({
  usageType: COHUB_BILLING_USAGE_TYPES.generationLlm,
  model: charge.model,
  provider: charge.provider,
  // Time windows are checked at the message's own time, so late processing keeps a campaign it ran in.
  at,
});

const recordBilling = async (input: {
  spaceId: string | undefined;
  userId: string;
  sourceId: string;
  at: Date;
  charges: LlmCharge[];
  price: FrozenPricing;
}) => {
  const results = await Promise.all(input.charges.map(async (charge) => {
    const result = await spaceWalletBilling.recordUsage({
      spaceId: input.spaceId,
      userId: input.userId,
      ...priceUsage(await input.price(llmSubject(charge, input.at)), charge.officialUsd, `LLM usage ${charge.provider}/${charge.model}`),
      tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
      usageType: COHUB_BILLING_USAGE_TYPES.generationLlm,
      sourceId: input.sourceId,
      operationId: charge.operationId,
    });
    return result.status === "overage";
  }));
  return results.includes(true);
};

const aggregateUsage = async (message: typeof sessionMessages.$inferSelect, spaceId: string, userId: string | null) => {
  if (message.usageAggregatedAt) return;
  const increments = tokenUsageIncrements(message, { spaceId, userId });
  await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(sessionMessages)
      .set({ usageAggregatedAt: new Date() })
      .where(and(eq(sessionMessages.id, message.id), isNull(sessionMessages.usageAggregatedAt)))
      .returning({ id: sessionMessages.id });
    if (!claimed) return;
    for (const increment of increments) await recordTokenUsage(tx, increment);
  });
};

registerSystemJob(SESSION_MESSAGE_POSTPROCESS_JOB, async (job: Job) => {
  const { sessionId, messageId } = job.data as SessionMessagePostprocessJobData;
  const [context] = await db
    .select({ message: sessionMessages, spaceId: spaceSessions.spaceId })
    .from(sessionMessages)
    .innerJoin(spaceSessions, eq(spaceSessions.id, sessionMessages.sessionId))
    .where(and(eq(sessionMessages.id, messageId), eq(sessionMessages.sessionId, sessionId)))
    .limit(1);
  if (!context) throw new Error(`Session message not found: ${messageId}`);
  const { message, spaceId } = context;
  if (!isLlmUsageMessage(message)) return { ok: true, skipped: "non_llm_usage" };

  const usage = normalizeUsage(message.usage);
  const userId = await resolveUsageActorUserId(db, message);

  // Idempotent external effects first; non-idempotent hourly aggregation must remain last.
  const meta = (message.meta ?? {}) as Record<string, unknown>;
  const alreadyAttempted = Object.hasOwn(meta, "walletBillingAttempted");
  const walletEligible = meta.walletBillingEligible === true;
  const walletMode = walletEligible && billingOperations.status.configured && spaceWalletBillingOperations.status.configured;
  const mayBill = !message.usageAggregatedAt && !alreadyAttempted && billingOperations.status.configured;
  const charges = mayBill && userId ? billableLlmCharges(message, usage) : [];
  const at = message.createdAt ?? new Date();
  // Read the benefits these charges need before claiming the wallet charge: a failed read retries the
  // job instead of mispricing, and a message whose charges need none never waits on billing.
  const price = userId && charges.length > 0
    ? await usagePricing.freeze(userId, charges.map((charge) => llmSubject(charge, at)))
    : null;
  const shouldBill = price !== null && (!walletMode || await claimMessageWalletBilling(db, message.id));
  // Winning the wallet claim proves no earlier attempt debited, so the charge is never a retry here.
  const overdrawn = shouldBill && price !== null && userId !== null && await recordBilling({
    spaceId: walletEligible ? spaceId : undefined,
    userId,
    sourceId: message.id,
    at,
    charges,
    price,
  });
  if (overdrawn && userId && message.turnId) {
    await stopTurnsOnBillingBlock({ db, redis: redisCommandClient, gate: spaceWalletBilling.gate }, {
      spaceId,
      sessionId,
      turnId: message.turnId,
      userId,
      provider: message.provider,
      model: message.model,
    }).then((turnIds) => {
      if (turnIds.length) logger.info("[Billing] stopping Agent Turns on insufficient balance", { spaceId, sessionId, turnIds });
    }).catch((error: unknown) => logger.warn("[Billing] failed to stop Agent Turns on insufficient balance", { spaceId, sessionId, turnId: message.turnId, error }));
  }
  await aggregateUsage(message, spaceId, userId);

  return { ok: true };
});
