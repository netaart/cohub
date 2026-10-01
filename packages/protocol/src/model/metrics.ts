import { z } from "zod";
import type { ContentBlock } from "../core/content.js";
import type { Usage } from "../core/usage.js";
import type { SessionTurnIntermediateSummary } from "./turn.js";

const count = z.number().finite().nonnegative();
const usageSchema = z.object({
  input: count.optional(), output: count.optional(), cacheRead: count.optional(),
  cacheWrite: count.optional(), totalTokens: count.optional(),
  cost: z.object({ input: count.optional(), output: count.optional(), cacheRead: count.optional(), cacheWrite: count.optional(), total: count.optional() }).nullable().optional(),
});

/** One provider attempt, independent of whether its response becomes a chat message. */
export const requestMetricSchema = z.object({
  id: z.string(), provider: z.string(), model: z.string(),
  startedAt: count, completedAt: count.optional(), durationMs: count.optional(),
  firstTokenMs: count.optional(), outputDurationMs: count.optional(),
  status: z.enum(["running", "completed", "failed", "interrupted"]),
  usage: usageSchema.nullable().optional(),
  omitted: z.boolean().optional(),
  imageToText: z.object({ calls: count, durationMs: count, usage: usageSchema.nullable(), unknownUsageCalls: count }).optional(),
});
export type RequestMetric = z.infer<typeof requestMetricSchema>;

const toolMetricsSchema = z.object({ calls: count, errors: count, timedCalls: count, activeMs: count.nullable() });
export type ToolMetrics = z.infer<typeof toolMetricsSchema>;
export const turnMetricsSchema = z.object({
  version: z.literal(1),
  executionStartedAt: count.optional(),
  requests: z.record(z.string(), requestMetricSchema).optional(),
  retryWaitMs: count.optional(),
  retryCount: count.optional(),
  tools: toolMetricsSchema.optional(),
  imageToText: z.object({ durationMs: count.nullable(), timedCalls: count }).optional(),
});
export type TurnMetrics = z.infer<typeof turnMetricsSchema>;

export function metricsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function readTurnMetrics(meta: unknown): TurnMetrics | null {
  const result = turnMetricsSchema.safeParse(metricsRecord(meta).metrics);
  return result.success ? result.data : null;
}

const optionalCount = count.nullable();
/** Additive facts only. Rates are computed from matching samples, never averaged averages. */
export const executionStatsSchema = z.object({
  turns: count, generations: count,
  calls: optionalCount, failedCalls: optionalCount, unknownUsageCalls: count,
  toolCalls: optionalCount, toolErrors: optionalCount,
  elapsedMs: optionalCount, queueMs: optionalCount, modelMs: optionalCount, toolMs: optionalCount,
  retryCount: optionalCount, retryWaitMs: optionalCount,
  ttftMs: count, ttftSamples: count, outputMs: count, timedOutputTokens: count,
  compactions: count, compactionMs: optionalCount, compactionUsage: usageSchema.nullable(),
  imageToTextCalls: count, imageToTextMs: optionalCount,
  usage: usageSchema.nullable(),
  estimatedCostUsd: optionalCount, chargedCostUsd: optionalCount, providerCostUsd: optionalCount,
  partial: z.boolean(),
});
export type ExecutionStats = z.infer<typeof executionStatsSchema>;
export const sessionStatsSchema = z.object({
  version: z.literal(1), updatedAt: z.string(), revision: count,
  own: executionStatsSchema, inherited: executionStatsSchema,
  auxiliaryUsage: usageSchema.nullable(),
});
export type SessionStats = z.infer<typeof sessionStatsSchema>;
export function readSessionStats(meta: unknown): SessionStats | null {
  const result = sessionStatsSchema.safeParse(metricsRecord(meta).stats);
  return result.success ? result.data : null;
}

export function emptyExecutionStats(): ExecutionStats {
  return {
    turns: 0, generations: 0, calls: null, failedCalls: null, unknownUsageCalls: 0,
    toolCalls: null, toolErrors: null, elapsedMs: null, queueMs: null, modelMs: null, toolMs: null,
    retryCount: null, retryWaitMs: null, ttftMs: 0, ttftSamples: 0, outputMs: 0, timedOutputTokens: 0,
    compactions: 0, compactionMs: null, compactionUsage: null, imageToTextCalls: 0, imageToTextMs: null,
    usage: null, estimatedCostUsd: null, chargedCostUsd: null, providerCostUsd: null, partial: false,
  };
}

const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const sum = (a: number | null | undefined, b: number | null | undefined): number | null => a == null && b == null ? null : (a ?? 0) + (b ?? 0);
export function readStatsUsage(value: unknown): Usage | null {
  const result = usageSchema.safeParse(value);
  return result.success ? result.data : null;
}
/** Preserve absent fields: unknown is not a reported zero. */
export function sumStatsUsage(a: Usage | null, b: Usage | null): Usage | null {
  if (!a && !b) return null;
  const result: Usage = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
    const value = sum(a?.[key], b?.[key]);
    if (value !== null) result[key] = value;
  }
  if (a?.cost || b?.cost) {
    result.cost = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
      const value = sum(a?.cost?.[key], b?.cost?.[key]);
      if (value !== null) result.cost[key] = value;
    }
  }
  return result;
}

export function mergeExecutionStats(a: ExecutionStats, b: ExecutionStats): ExecutionStats {
  const result = emptyExecutionStats();
  for (const key of Object.keys(result) as (keyof ExecutionStats)[]) {
    if (key === "usage" || key === "compactionUsage") result[key] = sumStatsUsage(a[key], b[key]);
    else if (key === "partial") result.partial = a.partial || b.partial;
    else Object.assign(result, { [key]: sum(a[key], b[key]) });
  }
  return result;
}

export type StatsTurn = {
  status: string; intent?: string; executionKind?: string; totalUsage?: Usage | null;
  finalUsage?: Usage | null; durationMs?: number | null; createdAt?: string | Date | null;
  completedAt?: string | Date | null; meta?: unknown; intermediateSummary?: SessionTurnIntermediateSummary | null;
};
export const isSettledStatsTurn = (turn: Pick<StatsTurn, "status">) => ["completed", "failed", "interrupted", "cancelled", "merged"].includes(turn.status);

export function readTurnStats(turn: StatsTurn): ExecutionStats {
  const result = emptyExecutionStats();
  if (!isSettledStatsTurn(turn) || turn.status === "merged" || turn.status === "cancelled") return result;
  const meta = metricsRecord(turn.meta);
  const metrics = readTurnMetrics(meta);
  const compact = turn.intent === "compact";
  const generation = turn.executionKind === "direct_generation";
  result.turns = compact ? 0 : 1;
  result.generations = generation ? 1 : 0;
  result.elapsedMs = finite(turn.durationMs);
  result.usage = readStatsUsage(turn.totalUsage ?? turn.finalUsage);
  if (metrics?.executionStartedAt != null && turn.createdAt) {
    const createdAt = new Date(turn.createdAt).getTime();
    if (Number.isFinite(createdAt)) result.queueMs = Math.max(0, metrics.executionStartedAt - createdAt);
    if (turn.completedAt) {
      const completedAt = new Date(turn.completedAt).getTime();
      if (Number.isFinite(completedAt)) result.elapsedMs = Math.max(0, completedAt - metrics.executionStartedAt);
    }
  }
  const compaction = turn.intermediateSummary?.compaction;
  result.compactions = compact ? (turn.status === "completed" ? 1 : 0) : compaction?.count ?? 0;
  result.compactionMs = compact ? finite(turn.durationMs) : finite(compaction?.durationMsTotal);
  result.compactionUsage = compact ? result.usage : readStatsUsage(compaction?.usage);
  const imageSummary = metricsRecord(metricsRecord(meta.imageToText).summary);
  result.imageToTextCalls = finite(imageSummary.callCount) ?? turn.intermediateSummary?.imageToText?.callCount ?? 0;
  result.imageToTextMs = metrics?.imageToText?.durationMs ?? null;
  if (result.imageToTextCalls > (metrics?.imageToText?.timedCalls ?? 0)) result.partial = true;
  result.toolCalls = metrics?.tools?.calls ?? (compact || generation ? 0 : finite(turn.intermediateSummary?.toolCallCount));
  result.toolErrors = metrics?.tools?.errors ?? null;
  result.toolMs = metrics?.tools?.activeMs ?? null;
  result.retryCount = metrics?.retryCount ?? null;
  result.retryWaitMs = metrics?.retryWaitMs ?? null;
  if (metrics?.tools && metrics.tools.timedCalls < metrics.tools.calls) result.partial = true;
  const requests = Object.values(metrics?.requests ?? {});
  if (requests.length) {
    result.calls = requests.length;
    result.failedCalls = requests.filter((request) => request.status === "failed" || request.status === "interrupted").length;
    for (const request of requests) {
      result.modelMs = sum(result.modelMs, request.durationMs);
      if (request.status === "running" || request.durationMs == null) result.partial = true;
      if (!request.usage) result.unknownUsageCalls += 1;
      result.unknownUsageCalls += request.imageToText?.unknownUsageCalls ?? 0;
      if (request.omitted && request.imageToText) {
        result.imageToTextCalls += request.imageToText.calls;
        result.imageToTextMs = sum(result.imageToTextMs, request.imageToText.durationMs);
      }
      if (request.firstTokenMs != null) {
        result.ttftMs += request.firstTokenMs;
        result.ttftSamples += 1;
      }
      if (request.outputDurationMs != null && request.outputDurationMs > 0 && request.usage?.output != null) {
        result.outputMs += request.outputDurationMs;
        result.timedOutputTokens += request.usage.output;
      }
    }
    // Final/intermediate usage already includes persisted responses. Supplement only
    // attempts explicitly excluded from the transcript (marked by the collector).
    if (result.usage) {
      for (const request of requests) if (request.omitted) {
        result.usage = sumStatsUsage(result.usage, request.usage ?? null);
        result.usage = sumStatsUsage(result.usage, request.imageToText?.usage ?? null);
      }
    } else {
      // A fatal error may settle a Turn before the final usage projection is built.
      // Durable attempts still retain the known primary-model consumption.
      result.usage = requests.reduce<Usage | null>((total, request) => sumStatsUsage(total, request.usage ?? null), null);
      result.usage = sumStatsUsage(result.usage, result.compactionUsage);
      if (requests.some((request) => request.imageToText)) {
        for (const request of requests) result.usage = sumStatsUsage(result.usage, request.imageToText?.usage ?? null);
        result.imageToTextCalls = requests.reduce((sum, request) => sum + (request.imageToText?.calls ?? 0), 0);
        result.imageToTextMs = requests.reduce<number | null>((total, request) => sum(total, request.imageToText?.durationMs), null);
      } else result.usage = sumStatsUsage(result.usage, readStatsUsage(imageSummary.usage ?? turn.intermediateSummary?.imageToText?.usage));
      result.partial = true;
    }
  } else if (!compact && !generation && meta.llm !== false) result.partial = true;
  else if (meta.llm === false) result.calls = 0;
  if (result.unknownUsageCalls > 0) result.partial = true;
  if (generation) {
    const source = metricsRecord(meta.generation);
    const billing = metricsRecord(source.billing);
    result.providerCostUsd = finite(source.officialCostUsd);
    const confirmedFree = billing.status === "skipped" && billing.amountUsd === 0 && ["zero_amount", "discounted_free", "discounted_below_minimum"].includes(String(billing.reason));
    result.chargedCostUsd = confirmedFree ? 0 : ["recorded", "overage"].includes(String(billing.status)) ? finite(billing.amountUsd) : null;
    result.partial ||= result.chargedCostUsd == null;
    // Generation costs have a different basis; never mix them into LLM token usage.
    result.usage = null;
  } else {
    result.estimatedCostUsd = finite(result.usage?.cost?.total);
    result.partial ||= result.usage == null && meta.llm !== false;
  }
  return result;
}

export function collectImageToTextTiming(metas: readonly unknown[]) {
  let durationMs: number | null = null;
  let timedCalls = 0;
  for (const meta of metas) {
    const calls = metricsRecord(metricsRecord(meta).imageToText).calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      const duration = finite(metricsRecord(call).durationMs);
      if (duration != null) { durationMs = sum(durationMs, duration); timedCalls += 1; }
    }
  }
  return { durationMs, timedCalls };
}

/** Union of measured tool intervals. Parent wrappers/parallel children do not inflate wall time. */
export function collectToolMetrics(contents: readonly (readonly ContentBlock[])[]): ToolMetrics {
  const tools = new Map<string, { error: boolean; start: number | null; end: number | null }>();
  for (const content of contents) for (const block of content) {
    if (block.type !== "tool_use" && block.type !== "tool_result") continue;
    const id = block.type === "tool_use" ? block.id : block.tool_use_id;
    const previous = tools.get(id);
    const timing = metricsRecord(metricsRecord(block._meta).timing);
    const start = typeof timing.startedAt === "string" ? finite(Date.parse(timing.startedAt)) : null;
    const end = typeof timing.completedAt === "string" ? finite(Date.parse(timing.completedAt)) : null;
    tools.set(id, { error: previous?.error === true || (block.type === "tool_result" && block.is_error === true), start: start ?? previous?.start ?? null, end: end ?? previous?.end ?? null });
  }
  const intervals = [...tools.values()].flatMap(({ start, end }) => start != null && end != null && end >= start ? [[start, end] as const] : []).sort((a, b) => a[0] - b[0]);
  let activeMs = 0;
  let through = 0;
  for (const [start, end] of intervals) { activeMs += Math.max(0, end - Math.max(start, through)); through = Math.max(through, end); }
  return { calls: tools.size, errors: [...tools.values()].filter((tool) => tool.error).length, timedCalls: intervals.length, activeMs: intervals.length ? activeMs : tools.size ? null : 0 };
}
