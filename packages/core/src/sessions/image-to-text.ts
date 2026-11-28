import type { Usage } from "@cohub/protocol/core";
import { readUsageHost, type UsageCredential } from "@cohub/protocol/runtime";

export type ImageToTextCallRecord = {
  sourceKey: string;
  provider: string;
  model: string;
  credential: UsageCredential;
  host: string | null;
  status: "succeeded" | "failed";
  usage: Usage | null;
  durationMs: number;
  error?: string;
};

export type ImageToTextUsageSummary = {
  callCount: number;
  successCount: number;
  errorCount: number;
  sourceCount: number;
  usage: Usage | null;
};

export type ImageToTextUsageSummaryAccumulator = ImageToTextUsageSummary & {
  sourceKeys: Set<string>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeUsage(value: unknown): Usage | null {
  const usage = asRecord(value);
  if (!usage) return null;
  const cost = asRecord(usage.cost);
  return {
    input: finiteNumber(usage.input),
    output: finiteNumber(usage.output),
    cacheRead: finiteNumber(usage.cacheRead),
    cacheWrite: finiteNumber(usage.cacheWrite),
    totalTokens: finiteNumber(usage.totalTokens),
    cost: cost
      ? {
          input: finiteNumber(cost.input),
          output: finiteNumber(cost.output),
          cacheRead: finiteNumber(cost.cacheRead),
          cacheWrite: finiteNumber(cost.cacheWrite),
          total: finiteNumber(cost.total),
        }
      : null,
  };
}

export function readImageToTextCalls(meta: unknown): ImageToTextCallRecord[] {
  const imageToText = asRecord(asRecord(meta)?.imageToText);
  if (!Array.isArray(imageToText?.calls)) return [];
  const calls: ImageToTextCallRecord[] = [];
  for (const value of imageToText.calls) {
    const call = asRecord(value);
    if (!call) continue;
    const sourceKey = typeof call.sourceKey === "string" ? call.sourceKey : "";
    const provider = typeof call.provider === "string" ? call.provider : "";
    const model = typeof call.model === "string" ? call.model : "";
    const status = call.status === "succeeded" || call.status === "failed" ? call.status : null;
    if (!sourceKey || !provider || !model || !status) continue;
    calls.push({
      sourceKey,
      provider,
      model,
      credential: call.credential === "user" ? "user" : "platform",
      host: readUsageHost(call),
      status,
      usage: normalizeUsage(call.usage),
      durationMs: Math.max(0, Math.floor(finiteNumber(call.durationMs) ?? 0)),
      ...(typeof call.error === "string" ? { error: call.error } : {}),
    });
  }
  return calls;
}

export function addImageToTextUsage(a: Usage | null | undefined, b: Usage | null | undefined): Usage | null {
  if (!a && !b) return null;
  return {
    input: (a?.input ?? 0) + (b?.input ?? 0),
    output: (a?.output ?? 0) + (b?.output ?? 0),
    cacheRead: (a?.cacheRead ?? 0) + (b?.cacheRead ?? 0),
    cacheWrite: (a?.cacheWrite ?? 0) + (b?.cacheWrite ?? 0),
    totalTokens: (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0),
    cost: a?.cost || b?.cost
      ? {
          input: (a?.cost?.input ?? 0) + (b?.cost?.input ?? 0),
          output: (a?.cost?.output ?? 0) + (b?.cost?.output ?? 0),
          cacheRead: (a?.cost?.cacheRead ?? 0) + (b?.cost?.cacheRead ?? 0),
          cacheWrite: (a?.cost?.cacheWrite ?? 0) + (b?.cost?.cacheWrite ?? 0),
          total: (a?.cost?.total ?? 0) + (b?.cost?.total ?? 0),
        }
      : null,
  };
}

export function createImageToTextUsageSummaryAccumulator(): ImageToTextUsageSummaryAccumulator {
  return {
    callCount: 0,
    successCount: 0,
    errorCount: 0,
    sourceCount: 0,
    usage: null,
    sourceKeys: new Set(),
  };
}

export function addImageToTextCallsToSummary(
  accumulator: ImageToTextUsageSummaryAccumulator,
  calls: ImageToTextCallRecord[],
): ImageToTextUsageSummaryAccumulator {
  for (const call of calls) {
    accumulator.callCount += 1;
    accumulator.sourceKeys.add(call.sourceKey);
    if (call.status === "succeeded") {
      accumulator.successCount += 1;
      accumulator.usage = addImageToTextUsage(accumulator.usage, call.usage);
    } else {
      accumulator.errorCount += 1;
    }
  }
  accumulator.sourceCount = accumulator.sourceKeys.size;
  return accumulator;
}

export function finalizeImageToTextUsageSummary(
  accumulator: ImageToTextUsageSummaryAccumulator,
): ImageToTextUsageSummary {
  return {
    callCount: accumulator.callCount,
    successCount: accumulator.successCount,
    errorCount: accumulator.errorCount,
    sourceCount: accumulator.sourceKeys.size,
    usage: accumulator.usage,
  };
}

export function summarizeImageToTextCalls(meta: unknown): ImageToTextUsageSummary {
  const accumulator = addImageToTextCallsToSummary(
    createImageToTextUsageSummaryAccumulator(),
    readImageToTextCalls(meta),
  );
  return finalizeImageToTextUsageSummary(accumulator);
}

export function sumImageToTextUsage(meta: unknown): Usage | null {
  return summarizeImageToTextCalls(meta).usage;
}
