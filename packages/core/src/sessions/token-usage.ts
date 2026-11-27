import { sessionMessages, tokenUsageStatsHourly } from "@cohub/db";
import type { Usage } from "@cohub/protocol/core";
import { resolveHarness, type HarnessKind } from "@cohub/protocol/runtime";
import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { readImageToTextCalls } from "./image-to-text.js";

// biome-ignore lint/suspicious/noExplicitAny: any Postgres driver, including transactions.
type Executor = PgDatabase<PgQueryResultHKT, any, any>;

export const LOCAL_USAGE_PROVIDER = "local";

export type LlmRequestStats = {
  requestCount: number;
  successCount: number;
  errorCount: number;
};

type UsageMessage = Pick<
  typeof sessionMessages.$inferSelect,
  "sessionId" | "role" | "provider" | "model" | "usage" | "meta" | "errorMessage" | "stopReason" | "createdAt"
>;

export type TokenUsageIncrement = LlmRequestStats & {
  bucketStartAt: Date;
  userId: string | null;
  spaceId: string;
  sessionId: string;
  harness: HarnessKind;
  provider: string | null;
  model: string | null;
  usage: Usage | null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const positiveInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;

const nonNegativeInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;

const finiteNumberOrZero = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const isSuccessfulMessage = (message: { errorMessage?: unknown; stopReason?: unknown }) =>
  !message.errorMessage && message.stopReason !== "error" && message.stopReason !== "aborted";

export function resolveLlmRequestStats(message: { role: string; errorMessage?: unknown; stopReason?: unknown; meta?: unknown }): LlmRequestStats {
  const meta = asRecord(message.meta);
  const compaction = message.role === "system" && meta?.messageKind === "compacted"
    ? asRecord(meta.compaction)
    : null;

  if (compaction) {
    const providerCalls = asRecord(compaction.providerCalls);
    const requestCount = positiveInteger(providerCalls?.total);
    const successCount = nonNegativeInteger(providerCalls?.succeeded);
    const errorCount = nonNegativeInteger(providerCalls?.failed);
    if (
      requestCount != null &&
      successCount != null &&
      errorCount != null &&
      successCount + errorCount === requestCount
    ) {
      return { requestCount, successCount, errorCount };
    }
  }

  const requestCount = positiveInteger(compaction?.providerCallCount) ?? 1;
  return isSuccessfulMessage(message)
    ? { requestCount, successCount: requestCount, errorCount: 0 }
    : { requestCount, successCount: 0, errorCount: requestCount };
}

export function tokenUsageIncrements(
  message: UsageMessage,
  context: { spaceId: string; userId: string | null },
): TokenUsageIncrement[] {
  const bucketStartAt = new Date(message.createdAt ?? new Date());
  bucketStartAt.setUTCMinutes(0, 0, 0);
  const meta = asRecord(message.meta);
  const base = { bucketStartAt, userId: context.userId, spaceId: context.spaceId, sessionId: message.sessionId, harness: resolveHarness(meta) };
  return [
    {
      ...base,
      provider: meta?.runtime === "local" ? LOCAL_USAGE_PROVIDER : message.provider,
      model: message.model,
      usage: asRecord(message.usage) as Usage | null,
      ...resolveLlmRequestStats(message),
    },
    ...readImageToTextCalls(message.meta).map((call) => ({
      ...base,
      provider: call.provider,
      model: call.model,
      usage: call.usage,
      requestCount: 1,
      successCount: call.status === "succeeded" ? 1 : 0,
      errorCount: call.status === "failed" ? 1 : 0,
    })),
  ];
}

export async function recordTokenUsage(db: Executor, increment: TokenUsageIncrement): Promise<void> {
  const { usage } = increment;
  const tokens = {
    inputTokens: finiteNumberOrZero(usage?.input),
    outputTokens: finiteNumberOrZero(usage?.output),
    cacheReadTokens: finiteNumberOrZero(usage?.cacheRead),
    cacheWriteTokens: finiteNumberOrZero(usage?.cacheWrite),
    totalTokens: finiteNumberOrZero(usage?.totalTokens),
  };
  const costs = {
    costInput: String(finiteNumberOrZero(usage?.cost?.input)),
    costOutput: String(finiteNumberOrZero(usage?.cost?.output)),
    costCacheRead: String(finiteNumberOrZero(usage?.cost?.cacheRead)),
    costCacheWrite: String(finiteNumberOrZero(usage?.cost?.cacheWrite)),
    costTotal: String(finiteNumberOrZero(usage?.cost?.total)),
  };
  const t = tokenUsageStatsHourly;
  await db.insert(t).values({
    bucketStartAt: increment.bucketStartAt,
    userId: increment.userId,
    spaceId: increment.spaceId,
    sessionId: increment.sessionId,
    harness: increment.harness,
    provider: increment.provider,
    model: increment.model,
    requestCount: increment.requestCount,
    successCount: increment.successCount,
    errorCount: increment.errorCount,
    ...tokens,
    ...costs,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [t.bucketStartAt, t.userId, t.spaceId, t.sessionId, t.harness, t.provider, t.model],
    set: {
      requestCount: sql`${t.requestCount} + ${increment.requestCount}`,
      successCount: sql`${t.successCount} + ${increment.successCount}`,
      errorCount: sql`${t.errorCount} + ${increment.errorCount}`,
      inputTokens: sql`${t.inputTokens} + ${tokens.inputTokens}`,
      outputTokens: sql`${t.outputTokens} + ${tokens.outputTokens}`,
      cacheReadTokens: sql`${t.cacheReadTokens} + ${tokens.cacheReadTokens}`,
      cacheWriteTokens: sql`${t.cacheWriteTokens} + ${tokens.cacheWriteTokens}`,
      totalTokens: sql`${t.totalTokens} + ${tokens.totalTokens}`,
      costInput: sql`${t.costInput} + ${costs.costInput}::numeric`,
      costOutput: sql`${t.costOutput} + ${costs.costOutput}::numeric`,
      costCacheRead: sql`${t.costCacheRead} + ${costs.costCacheRead}::numeric`,
      costCacheWrite: sql`${t.costCacheWrite} + ${costs.costCacheWrite}::numeric`,
      costTotal: sql`${t.costTotal} + ${costs.costTotal}::numeric`,
      updatedAt: new Date(),
    },
  });
}

export async function resolveUsageActorUserId(
  db: Executor,
  message: Pick<typeof sessionMessages.$inferSelect, "sessionId" | "meta">,
): Promise<string | null> {
  const meta = asRecord(message.meta);
  if (typeof meta?.actorUserId === "string" && meta.actorUserId.trim()) return meta.actorUserId.trim();
  const anchorUserMessageId = typeof meta?.anchorUserMessageId === "string" ? meta.anchorUserMessageId : null;
  if (!anchorUserMessageId) return null;
  const [anchor] = await db
    .select({ meta: sessionMessages.meta })
    .from(sessionMessages)
    .where(and(eq(sessionMessages.id, anchorUserMessageId), eq(sessionMessages.sessionId, message.sessionId)))
    .limit(1);
  const userId = asRecord(anchor?.meta)?.userId;
  return typeof userId === "string" && userId.trim() ? userId.trim() : null;
}
