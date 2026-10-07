import { generationUsageStatsHourly, tokenUsageStatsHourly } from "@cohub/db";

const toFiniteNumber = (value: unknown): number => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
};

export type UsageRow = {
  bucketStartAt: Date;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costInput: string;
  costOutput: string;
  costCacheRead: string;
  costCacheWrite: string;
  costTotal: string;
  requestCount: number;
  successCount: number;
  errorCount: number;
  provider: string | null;
  model: string | null;
};

type HourlyBucket = {
  bucketStartAt: Date;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  costTotal: number;
  requestCount: number;
  successCount: number;
  errorCount: number;
  models: Set<string>;
};

type UsageAggregationResult = {
  hourly: Array<Omit<HourlyBucket, "models"> & { models: string[] }>;
  summary: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costInput: number;
    costOutput: number;
    costCacheRead: number;
    costCacheWrite: number;
    costTotal: number;
    requestCount: number;
    successCount: number;
    errorCount: number;
  };
};

/**
 * Aggregate raw usage rows (potentially multiple per hour due to model/provider
 * dimensions) into hourly buckets and a summary. Shared by space-level and
 * user-level usage endpoints.
 */
function aggregateUsageRows(rows: readonly UsageRow[]): UsageAggregationResult {
  const hourlyMap = new Map<string, HourlyBucket>();

  for (const row of rows) {
    const key = (row.bucketStartAt as Date).toISOString();
    const existing = hourlyMap.get(key);
    if (existing) {
      existing.totalTokens += row.totalTokens ?? 0;
      existing.inputTokens += row.inputTokens ?? 0;
      existing.outputTokens += row.outputTokens ?? 0;
      existing.cacheReadTokens += row.cacheReadTokens ?? 0;
      existing.cacheWriteTokens += row.cacheWriteTokens ?? 0;
      existing.costInput += toFiniteNumber(row.costInput);
      existing.costOutput += toFiniteNumber(row.costOutput);
      existing.costCacheRead += toFiniteNumber(row.costCacheRead);
      existing.costCacheWrite += toFiniteNumber(row.costCacheWrite);
      existing.costTotal += toFiniteNumber(row.costTotal);
      existing.requestCount += row.requestCount ?? 0;
      existing.successCount += row.successCount ?? 0;
      existing.errorCount += row.errorCount ?? 0;
      if (row.model) existing.models.add(row.model);
    } else {
      hourlyMap.set(key, {
        bucketStartAt: row.bucketStartAt as Date,
        totalTokens: row.totalTokens ?? 0,
        inputTokens: row.inputTokens ?? 0,
        outputTokens: row.outputTokens ?? 0,
        cacheReadTokens: row.cacheReadTokens ?? 0,
        cacheWriteTokens: row.cacheWriteTokens ?? 0,
        costInput: toFiniteNumber(row.costInput),
        costOutput: toFiniteNumber(row.costOutput),
        costCacheRead: toFiniteNumber(row.costCacheRead),
        costCacheWrite: toFiniteNumber(row.costCacheWrite),
        costTotal: toFiniteNumber(row.costTotal),
        requestCount: row.requestCount ?? 0,
        successCount: row.successCount ?? 0,
        errorCount: row.errorCount ?? 0,
        models: row.model ? new Set([row.model]) : new Set(),
      });
    }
  }

  const hourly = Array.from(hourlyMap.values())
    .sort((a, b) => a.bucketStartAt.getTime() - b.bucketStartAt.getTime())
    .map(({ models, ...rest }) => ({
      ...rest,
      models: Array.from(models),
      costInput: Number(rest.costInput.toFixed(4)),
      costOutput: Number(rest.costOutput.toFixed(4)),
      costCacheRead: Number(rest.costCacheRead.toFixed(4)),
      costCacheWrite: Number(rest.costCacheWrite.toFixed(4)),
      costTotal: Number(rest.costTotal.toFixed(4)),
    }));

  const summary = summarizeUsageHourly(hourly);

  return { hourly, summary };
}

const EMPTY_USAGE_SUMMARY = {
	totalTokens: 0,
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	costInput: 0,
	costOutput: 0,
	costCacheRead: 0,
	costCacheWrite: 0,
	costTotal: 0,
	requestCount: 0,
	successCount: 0,
	errorCount: 0,
} as const;

type UsageSummary = {
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costInput: number;
	costOutput: number;
	costCacheRead: number;
	costCacheWrite: number;
	costTotal: number;
	requestCount: number;
	successCount: number;
	errorCount: number;
};

function summarizeUsageHourly(hourly: readonly UsageSummary[]): UsageSummary {
	return hourly.reduce(
		(acc, stat) => ({
			totalTokens: acc.totalTokens + stat.totalTokens,
			inputTokens: acc.inputTokens + stat.inputTokens,
			outputTokens: acc.outputTokens + stat.outputTokens,
			cacheReadTokens: acc.cacheReadTokens + stat.cacheReadTokens,
			cacheWriteTokens: acc.cacheWriteTokens + stat.cacheWriteTokens,
			costInput: Number((acc.costInput + stat.costInput).toFixed(4)),
			costOutput: Number((acc.costOutput + stat.costOutput).toFixed(4)),
			costCacheRead: Number((acc.costCacheRead + stat.costCacheRead).toFixed(4)),
			costCacheWrite: Number((acc.costCacheWrite + stat.costCacheWrite).toFixed(4)),
			costTotal: Number((acc.costTotal + stat.costTotal).toFixed(4)),
			requestCount: acc.requestCount + stat.requestCount,
			successCount: acc.successCount + stat.successCount,
			errorCount: acc.errorCount + stat.errorCount,
		}),
		{ ...EMPTY_USAGE_SUMMARY },
	);
}

/** Column selection shared by all usage queries. */
export const USAGE_SELECT_COLUMNS = {
  bucketStartAt: tokenUsageStatsHourly.bucketStartAt,
  totalTokens: tokenUsageStatsHourly.totalTokens,
  inputTokens: tokenUsageStatsHourly.inputTokens,
  outputTokens: tokenUsageStatsHourly.outputTokens,
  cacheReadTokens: tokenUsageStatsHourly.cacheReadTokens,
  cacheWriteTokens: tokenUsageStatsHourly.cacheWriteTokens,
  costInput: tokenUsageStatsHourly.costInput,
  costOutput: tokenUsageStatsHourly.costOutput,
  costCacheRead: tokenUsageStatsHourly.costCacheRead,
  costCacheWrite: tokenUsageStatsHourly.costCacheWrite,
  costTotal: tokenUsageStatsHourly.costTotal,
  requestCount: tokenUsageStatsHourly.requestCount,
  successCount: tokenUsageStatsHourly.successCount,
  errorCount: tokenUsageStatsHourly.errorCount,
  provider: tokenUsageStatsHourly.provider,
  model: tokenUsageStatsHourly.model,
} as const;

export const resolveUsageDays = (daysParam: string | undefined): number => {
  const parsedDays = parseInt(daysParam ?? "", 10);
  return Number.isFinite(parsedDays) && parsedDays > 0 ? Math.min(parsedDays, 365) : 30;
};

export const buildUsageDateRange = (days: number) => {
  const now = new Date();
  const startDate = new Date(now.getTime() - days * 86400000);
  startDate.setUTCMinutes(0, 0, 0);
  return { startDate, now };
};

const DAY_MS = 86_400_000;
const MAX_USER_USAGE_DAYS = 366;

export class InvalidUsageRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUsageRangeError";
  }
}

function parseUsageBoundary(value: string, name: "from" | "to") {
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(isDateOnly ? `${value}T00:00:00.000Z` : value);
  if (!Number.isFinite(parsed.getTime()) || (isDateOnly && parsed.toISOString().slice(0, 10) !== value)) {
    throw new InvalidUsageRangeError(`${name} must be an ISO 8601 date`);
  }
  return parsed;
}

export function resolveUserUsageRange(
  input: { days?: string; from?: string; to?: string },
  now = new Date(),
) {
  const hasCustomRange = input.from !== undefined || input.to !== undefined;
  if (input.days !== undefined && hasCustomRange) {
    throw new InvalidUsageRangeError("days cannot be combined with from or to");
  }
  if (input.to !== undefined && input.from === undefined) {
    throw new InvalidUsageRangeError("from is required when to is provided");
  }

  if (input.from !== undefined) {
    const startDate = parseUsageBoundary(input.from, "from");
    const endDate = input.to === undefined ? now : parseUsageBoundary(input.to, "to");
    const duration = endDate.getTime() - startDate.getTime();
    if (duration <= 0) throw new InvalidUsageRangeError("to must be after from");
    if (duration > MAX_USER_USAGE_DAYS * DAY_MS) {
      throw new InvalidUsageRangeError(`usage range cannot exceed ${MAX_USER_USAGE_DAYS} days`);
    }
    return {
      startDate,
      endDate,
      days: Math.ceil(duration / DAY_MS),
      range: { from: startDate.toISOString(), to: endDate.toISOString() },
    };
  }

  const rawDays = input.days ?? "30";
  if (!/^\d+$/.test(rawDays)) throw new InvalidUsageRangeError("days must be a positive integer");
  const days = Number(rawDays);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_USER_USAGE_DAYS) {
    throw new InvalidUsageRangeError(`days must be between 1 and ${MAX_USER_USAGE_DAYS}`);
  }
  const startDate = new Date(now.getTime() - days * DAY_MS);
  startDate.setUTCMinutes(0, 0, 0);
  return {
    startDate,
    endDate: new Date(now.getTime() + 1),
    days,
    range: { from: startDate.toISOString(), to: now.toISOString() },
  };
}

export type GenerationUsageRow = {
  bucketStartAt: Date;
  costTotal: string;
  requestCount: number;
  successCount: number;
  errorCount: number;
  provider: string;
  model: string | null;
  usageType: string;
};

type GenerationHourlyBucket = {
  bucketStartAt: Date;
  costTotal: number;
  requestCount: number;
  successCount: number;
  errorCount: number;
  models: Set<string>;
  usageTypes: Set<string>;
};

type GenerationUsageAggregationResult = {
  hourly: Array<Omit<GenerationHourlyBucket, "models" | "usageTypes"> & { models: string[]; usageTypes: string[] }>;
  summary: {
    costTotal: number;
    requestCount: number;
    successCount: number;
    errorCount: number;
  };
};

export type UserModelRankings = {
  llmModels: Array<{
    provider: string;
    model: string;
    totalTokens: number;
    requestCount: number;
    costTotal: number;
  }>;
  generationModels: Array<{
    provider: string;
    model: string;
    requestCount: number;
    costTotal: number;
  }>;
};

export function aggregateUserModelRankings(
  usageRows: readonly UsageRow[],
  generationRows: readonly GenerationUsageRow[],
): UserModelRankings {
  const llmModels = new Map<string, UserModelRankings["llmModels"][number]>();
  for (const row of usageRows) {
    const provider = row.provider ?? "unknown";
    const model = row.model ?? "unknown";
    const key = `${provider}\0${model}`;
    const current = llmModels.get(key);
    if (current) {
      current.totalTokens += row.totalTokens;
      current.requestCount += row.requestCount;
      current.costTotal += toFiniteNumber(row.costTotal);
    } else {
      llmModels.set(key, {
        provider,
        model,
        totalTokens: row.totalTokens,
        requestCount: row.requestCount,
        costTotal: toFiniteNumber(row.costTotal),
      });
    }
  }

  const generationModels = new Map<string, UserModelRankings["generationModels"][number]>();
  for (const row of generationRows) {
    const model = row.model ?? "unknown";
    const key = `${row.provider}\0${model}`;
    const current = generationModels.get(key);
    if (current) {
      current.requestCount += row.requestCount;
      current.costTotal += toFiniteNumber(row.costTotal);
    } else {
      generationModels.set(key, {
        provider: row.provider,
        model,
        requestCount: row.requestCount,
        costTotal: toFiniteNumber(row.costTotal),
      });
    }
  }

  return {
    llmModels: [...llmModels.values()]
      .sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model))
      .slice(0, 5)
      .map((row) => ({ ...row, costTotal: Number(row.costTotal.toFixed(8)) })),
    generationModels: [...generationModels.values()]
      .sort((a, b) => b.requestCount - a.requestCount || a.model.localeCompare(b.model))
      .slice(0, 5)
      .map((row) => ({ ...row, costTotal: Number(row.costTotal.toFixed(8)) })),
  };
}

export const GENERATION_USAGE_SELECT_COLUMNS = {
  bucketStartAt: generationUsageStatsHourly.bucketStartAt,
  costTotal: generationUsageStatsHourly.costTotal,
  requestCount: generationUsageStatsHourly.requestCount,
  successCount: generationUsageStatsHourly.successCount,
  errorCount: generationUsageStatsHourly.errorCount,
  provider: generationUsageStatsHourly.provider,
  model: generationUsageStatsHourly.model,
  usageType: generationUsageStatsHourly.usageType,
} as const;

/** Aggregate generation usage rows into hourly buckets and a summary. */
function aggregateGenerationUsageRows(
  rows: readonly GenerationUsageRow[],
): GenerationUsageAggregationResult {
  const hourlyMap = new Map<string, GenerationHourlyBucket>();

  for (const row of rows) {
    const key = (row.bucketStartAt as Date).toISOString();
    const existing = hourlyMap.get(key);
    if (existing) {
      existing.costTotal += toFiniteNumber(row.costTotal);
      existing.requestCount += row.requestCount ?? 0;
      existing.successCount += row.successCount ?? 0;
      existing.errorCount += row.errorCount ?? 0;
      if (row.model) existing.models.add(row.model);
      if (row.usageType) existing.usageTypes.add(row.usageType);
    } else {
      hourlyMap.set(key, {
        bucketStartAt: row.bucketStartAt as Date,
        costTotal: toFiniteNumber(row.costTotal),
        requestCount: row.requestCount ?? 0,
        successCount: row.successCount ?? 0,
        errorCount: row.errorCount ?? 0,
        models: new Set(row.model ? [row.model] : []),
        usageTypes: new Set(row.usageType ? [row.usageType] : []),
      });
    }
  }

  const hourly = [...hourlyMap.values()]
    .sort((a, b) => a.bucketStartAt.getTime() - b.bucketStartAt.getTime())
    .map(({ models, usageTypes, ...rest }) => ({
      ...rest,
      models: [...models].sort(),
      usageTypes: [...usageTypes].sort(),
      costTotal: Number(rest.costTotal.toFixed(8)),
    }));

  const summary = hourly.reduce(
    (acc, row) => ({
      costTotal: Number((acc.costTotal + row.costTotal).toFixed(8)),
      requestCount: acc.requestCount + row.requestCount,
      successCount: acc.successCount + row.successCount,
      errorCount: acc.errorCount + row.errorCount,
    }),
    { costTotal: 0, requestCount: 0, successCount: 0, errorCount: 0 },
  );

  return { hourly, summary };
}

export type UsageTotals = {
  totalTokens: number;
  requestCount: number;
  successCount: number;
  errorCount: number;
  costTotal: number;
};

export type UsageAggregation = UsageAggregationResult & {
  generation: GenerationUsageAggregationResult;
  totals: UsageTotals;
};

export function aggregateUsage(
  rows: readonly UsageRow[],
  generationRows: readonly GenerationUsageRow[],
): UsageAggregation {
  const { hourly, summary } = aggregateUsageRows(rows);
  const generation = aggregateGenerationUsageRows(generationRows);
  return {
    hourly,
    summary,
    generation,
    totals: {
      totalTokens: summary.totalTokens,
      requestCount: summary.requestCount + generation.summary.requestCount,
      successCount: summary.successCount + generation.summary.successCount,
      errorCount: summary.errorCount + generation.summary.errorCount,
      costTotal: Number((summary.costTotal + generation.summary.costTotal).toFixed(8)),
    },
  };
}

export function stripUsageCost<T extends UsageAggregation>(usage: T): T {
  return {
    ...usage,
    hourly: usage.hourly.map((row) => ({
      ...row,
      costInput: 0,
      costOutput: 0,
      costCacheRead: 0,
      costCacheWrite: 0,
      costTotal: 0,
    })),
    summary: {
      ...usage.summary,
      costInput: 0,
      costOutput: 0,
      costCacheRead: 0,
      costCacheWrite: 0,
      costTotal: 0,
    },
    generation: {
      ...usage.generation,
      hourly: usage.generation.hourly.map((row) => ({ ...row, costTotal: 0 })),
      summary: { ...usage.generation.summary, costTotal: 0 },
    },
    totals: { ...usage.totals, costTotal: 0 },
  };
}
