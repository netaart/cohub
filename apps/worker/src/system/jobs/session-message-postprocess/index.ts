import { billingOperations, spaceWalletBillingOperations, COHUB_BILLING_TOKEN_TYPES, COHUB_BILLING_USAGE_TYPES } from "@cohub/billing";
import { claimMessageWalletBilling } from "@cohub/core/space-wallet";
import { qualifyAndRewardReferral } from "@cohub/core/referrals";
import { readImageToTextCalls } from "@cohub/core/sessions";
import { sessionMessages, sessionTurns, spaceSessions, tokenUsageStatsHourly } from "@cohub/db";
import {
  SESSION_MESSAGE_POSTPROCESS_JOB,
  type SessionMessagePostprocessJobData,
  type Usage,
} from "@cohub/protocol";
import type { Job } from "bullmq";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createLogger } from "@cohub/infra/logging";
import { db } from "../../../db.js";
import { registerSystemJob } from "../../registry.js";
import { resolveLlmRequestStats } from "./request-stats.js";
import { spaceWalletBilling } from "../../../space-wallet-billing.js";
import { redisCommandClient } from "../../../redis.js";
import { stopTurnsOnBillingBlock } from "./billing-stop.js";

const logger = createLogger({ serviceName: "cohub-worker" });

const finiteNumberOrZero = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const normalizeUsage = (value: unknown): Usage | null =>
  value && typeof value === "object" ? (value as Usage) : null;

const resolveActorUserId = async (message: typeof sessionMessages.$inferSelect) => {
  const meta = message.meta as Record<string, unknown> | null;
  if (typeof meta?.actorUserId === "string" && meta.actorUserId.trim()) return meta.actorUserId.trim();
  const anchorUserMessageId = typeof meta?.anchorUserMessageId === "string" ? meta.anchorUserMessageId : null;
  if (!anchorUserMessageId) return null;
  const [anchor] = await db
    .select({ meta: sessionMessages.meta })
    .from(sessionMessages)
    .where(and(eq(sessionMessages.id, anchorUserMessageId), eq(sessionMessages.sessionId, message.sessionId)))
    .limit(1);
  const userId = (anchor?.meta as Record<string, unknown> | null)?.userId;
  return typeof userId === "string" && userId.trim() ? userId.trim() : null;
};

const recordBillingUsage = async (input: {
  spaceId: string | undefined;
  retryOnly: boolean;
  userId: string | null;
  usage: Usage | null;
  sourceId: string;
  operationId: string;
  provider: string;
  model: string;
}) => {
  if (!input.userId) return false;
  const amount = input.usage?.cost?.total;
  const amountUsd = typeof amount === "number" && Number.isFinite(amount) && amount > 0
    ? Number(amount.toFixed(8))
    : 0;
  if (amountUsd <= 0 || !billingOperations.status.configured) return false;
  const result = await spaceWalletBilling.recordUsage({
    spaceId: input.spaceId,
    retryOnly: input.retryOnly,
    userId: input.userId,
    amountUsd,
    tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
    usageType: COHUB_BILLING_USAGE_TYPES.generationLlm,
    sourceId: input.sourceId,
    operationId: input.operationId,
    reason: `LLM usage ${input.provider}/${input.model}`,
  });
  return result.status === "overage";
};

const recordBilling = async (spaceId: string | undefined, retryOnly: boolean, message: typeof sessionMessages.$inferSelect, userId: string | null, usage: Usage | null) => {
  if ((message.meta as { runtime?: unknown } | null)?.runtime === "local") return false;
  let overdrawn = false;
  if (!message.errorMessage && message.stopReason !== "error" && message.stopReason !== "aborted") {
    overdrawn = await recordBillingUsage({
      spaceId,
      retryOnly,
      userId,
      usage,
      sourceId: message.id,
      operationId: `llm:${message.id}`,
      provider: message.provider ?? "unknown",
      model: message.model ?? "unknown",
    });
  }
  const auxiliary = await Promise.all(readImageToTextCalls(message.meta).map((call) => call.status === "succeeded"
    ? recordBillingUsage({
        spaceId,
        retryOnly,
        userId,
        usage: call.usage,
        sourceId: message.id,
        operationId: `llm:image-to-text:${message.id}:${call.sourceKey}`,
        provider: call.provider,
        model: call.model,
      })
    : false));
  return overdrawn || auxiliary.includes(true);
};

const maybeQualifyReferral = async (message: typeof sessionMessages.$inferSelect) => {
  const meta = message.meta as Record<string, unknown> | null;
  const turnId = typeof meta?.turnId === "string" ? meta.turnId : null;
  if (!turnId || meta?.messageKind !== "assistant_final" || meta.runtime === "local") return;

  // Prefer turn owner; fall back to actor stamped on the assistant message.
  const actorUserId = await resolveActorUserId(message);
  const [turn] = await db
    .select({ userUuid: sessionTurns.userUuid, status: sessionTurns.status, completedAt: sessionTurns.completedAt })
    .from(sessionTurns)
    .where(and(eq(sessionTurns.id, turnId), eq(sessionTurns.sessionId, message.sessionId)))
    .limit(1);
  if (turn?.status !== "completed") return;
  const inviteeUserId = turn.userUuid?.trim() || actorUserId;
  if (!inviteeUserId) return;

  await qualifyAndRewardReferral({
    db,
    billing: billingOperations,
    inviteeUserId,
    completedAt: turn.completedAt,
    logger: {
      warn: (messageText, metaFields) => logger.warn(messageText, metaFields),
      info: (messageText, metaFields) => logger.info(messageText, metaFields),
    },
  });
};

const isLlmUsageMessage = (message: typeof sessionMessages.$inferSelect) => {
  if (message.role === "assistant") return true;
  const meta = message.meta as Record<string, unknown> | null;
  return message.role === "system" && meta?.messageKind === "compacted";
};

const aggregateUsage = async (
  message: typeof sessionMessages.$inferSelect,
  spaceId: string,
  userId: string | null,
  usage: Usage | null,
) => {
  if (!isLlmUsageMessage(message) || message.usageAggregatedAt) return;
  const bucketStartAt = new Date(message.createdAt ?? new Date());
  bucketStartAt.setUTCMinutes(0, 0, 0);
  const mainStats = resolveLlmRequestStats(message);
  const auxiliaryCalls = readImageToTextCalls(message.meta);

  await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(sessionMessages)
      .set({ usageAggregatedAt: new Date() })
      .where(and(eq(sessionMessages.id, message.id), isNull(sessionMessages.usageAggregatedAt)))
      .returning({ id: sessionMessages.id });
    if (!claimed) return;

    const increment = async (input: {
      provider: string | null;
      model: string | null;
      usage: Usage | null;
      requestCount: number;
      successCount: number;
      errorCount: number;
    }) => {
      const inputTokens = finiteNumberOrZero(input.usage?.input);
      const outputTokens = finiteNumberOrZero(input.usage?.output);
      const cacheReadTokens = finiteNumberOrZero(input.usage?.cacheRead);
      const cacheWriteTokens = finiteNumberOrZero(input.usage?.cacheWrite);
      const totalTokens = finiteNumberOrZero(input.usage?.totalTokens);
      const costInput = finiteNumberOrZero(input.usage?.cost?.input);
      const costOutput = finiteNumberOrZero(input.usage?.cost?.output);
      const costCacheRead = finiteNumberOrZero(input.usage?.cost?.cacheRead);
      const costCacheWrite = finiteNumberOrZero(input.usage?.cost?.cacheWrite);
      const costTotal = finiteNumberOrZero(input.usage?.cost?.total);
      await tx.insert(tokenUsageStatsHourly).values({
        bucketStartAt,
        userId,
        spaceId,
        sessionId: message.sessionId,
        provider: input.provider,
        model: input.model,
        requestCount: input.requestCount,
        successCount: input.successCount,
        errorCount: input.errorCount,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens,
        costInput: String(costInput),
        costOutput: String(costOutput),
        costCacheRead: String(costCacheRead),
        costCacheWrite: String(costCacheWrite),
        costTotal: String(costTotal),
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: [
          tokenUsageStatsHourly.bucketStartAt,
          tokenUsageStatsHourly.userId,
          tokenUsageStatsHourly.spaceId,
          tokenUsageStatsHourly.sessionId,
          tokenUsageStatsHourly.provider,
          tokenUsageStatsHourly.model,
        ],
        set: {
          requestCount: sql`${tokenUsageStatsHourly.requestCount} + ${input.requestCount}`,
          successCount: sql`${tokenUsageStatsHourly.successCount} + ${input.successCount}`,
          errorCount: sql`${tokenUsageStatsHourly.errorCount} + ${input.errorCount}`,
          inputTokens: sql`${tokenUsageStatsHourly.inputTokens} + ${inputTokens}`,
          outputTokens: sql`${tokenUsageStatsHourly.outputTokens} + ${outputTokens}`,
          cacheReadTokens: sql`${tokenUsageStatsHourly.cacheReadTokens} + ${cacheReadTokens}`,
          cacheWriteTokens: sql`${tokenUsageStatsHourly.cacheWriteTokens} + ${cacheWriteTokens}`,
          totalTokens: sql`${tokenUsageStatsHourly.totalTokens} + ${totalTokens}`,
          costInput: sql`${tokenUsageStatsHourly.costInput} + ${String(costInput)}::numeric`,
          costOutput: sql`${tokenUsageStatsHourly.costOutput} + ${String(costOutput)}::numeric`,
          costCacheRead: sql`${tokenUsageStatsHourly.costCacheRead} + ${String(costCacheRead)}::numeric`,
          costCacheWrite: sql`${tokenUsageStatsHourly.costCacheWrite} + ${String(costCacheWrite)}::numeric`,
          costTotal: sql`${tokenUsageStatsHourly.costTotal} + ${String(costTotal)}::numeric`,
          updatedAt: new Date(),
        },
      });
    };

    await increment({
      provider: message.provider,
      model: message.model,
      usage,
      ...mainStats,
    });
    for (const call of auxiliaryCalls) {
      await increment({
        provider: call.provider,
        model: call.model,
        usage: call.usage,
        requestCount: 1,
        successCount: call.status === "succeeded" ? 1 : 0,
        errorCount: call.status === "failed" ? 1 : 0,
      });
    }
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
  const userId = await resolveActorUserId(message);

  // Idempotent external effects first; non-idempotent hourly aggregation must remain last.
  const meta = (message.meta ?? {}) as Record<string, unknown>;
  const alreadyAttempted = Object.hasOwn(meta, "walletBillingAttempted");
  const walletEligible = meta.walletBillingEligible === true;
  const walletMode = walletEligible && billingOperations.status.configured && spaceWalletBillingOperations.status.configured;
  const shouldBill = !message.usageAggregatedAt && !alreadyAttempted && (!walletMode || await claimMessageWalletBilling(db, message.id));
  const overdrawn = shouldBill && await recordBilling(walletEligible ? spaceId : undefined, job.attemptsMade > 0 || job.attemptsStarted > 1, message, userId, usage);
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
  await maybeQualifyReferral(message);
  await aggregateUsage(message, spaceId, userId, usage);

  return { ok: true };
});
