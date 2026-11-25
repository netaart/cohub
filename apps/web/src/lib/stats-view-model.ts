import type { ExecutionStats, RequestMetric } from "@cohub/protocol/model";
import { formatDurationMs } from "#lib/format-duration.ts";
import { formatTokenCount, getDisplayInputTokens } from "#lib/format-usage.ts";
import { formatCurrency } from "#lib/i18n/format.ts";
import type { Locale } from "#lib/i18n/locale.ts";

export type StatsScope = "turn" | "session";

export type StatsLabelKey =
	| "turns"
	| "elapsed"
	| "tokens"
	| "modelCost"
	| "generationCost"
	| "queue"
	| "modelTime"
	| "toolTime"
	| "otherTime"
	| "calls"
	| "tools"
	| "ttft"
	| "tps"
	| "retries"
	| "cached"
	| "input"
	| "output"
	| "cache"
	| "context"
	| "generations"
	| "compaction"
	| "imageToText"
	| "failedCalls"
	| "toolErrors";

export type StatsItem = { key: StatsLabelKey; value: string };

export type StatsSegment = StatsItem & {
	share: number;
	tone: "brand" | "strong" | "muted" | "faint";
};

export type StatsBreakdown = { segments: StatsSegment[]; facts: StatsItem[] };

export type StatsModelRow = {
	key: string;
	provider: string;
	model: string;
	calls: string;
	tokens: string;
	cost: string;
};

export type StatsViewModel = {
	totals: StatsItem[];
	time: StatsBreakdown | null;
	tokens: StatsBreakdown | null;
	models: StatsModelRow[];
	extra: StatsItem[];
	partial: boolean;
};

export type StatsContext = { tokens: number; window: number | null };

const finite = (value: number | null | undefined): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;
const positive = (value: number | null | undefined): value is number =>
	finite(value) && value > 0;

function item(
	items: StatsItem[],
	key: StatsLabelKey,
	value: string | null | undefined,
) {
	if (value) items.push({ key, value });
}

function breakdown(
	entries: Array<{
		key: StatsLabelKey;
		value: number | null | undefined;
		tone: StatsSegment["tone"];
	}>,
	format: (value: number) => string,
	facts: StatsItem[],
): StatsBreakdown | null {
	const visible = entries.filter(
		(entry): entry is typeof entry & { value: number } => positive(entry.value),
	);
	const total = visible.reduce((sum, entry) => sum + entry.value, 0);
	if (!total && !facts.length) return null;
	return {
		segments: visible.map((entry) => ({
			key: entry.key,
			value: format(entry.value),
			share: (entry.value / total) * 100,
			tone: entry.tone,
		})),
		facts,
	};
}

export function buildStatsModels(
	requests: readonly RequestMetric[],
	locale: Locale,
): StatsModelRow[] {
	const groups = new Map<
		string,
		{
			provider: string;
			model: string;
			calls: number;
			tokens: number | null;
			cost: number | null;
		}
	>();
	for (const request of requests) {
		const key = `${request.provider}/${request.model}`;
		const group = groups.get(key) ?? {
			provider: request.provider,
			model: request.model,
			calls: 0,
			tokens: 0,
			cost: 0,
		};
		group.calls += 1;
		const tokens = request.usage?.totalTokens;
		group.tokens =
			group.tokens == null || !finite(tokens) ? null : group.tokens + tokens;
		const cost = request.usage?.cost?.total;
		group.cost = group.cost == null || !finite(cost) ? null : group.cost + cost;
		groups.set(key, group);
	}
	if (groups.size < 2) return [];
	const number = new Intl.NumberFormat(locale);
	return [...groups]
		.sort(
			([, a], [, b]) => (b.tokens ?? 0) - (a.tokens ?? 0) || b.calls - a.calls,
		)
		.map(([key, group]) => ({
			key,
			provider: group.provider,
			model: group.model,
			calls: number.format(group.calls),
			tokens: group.tokens == null ? "" : formatTokenCount(group.tokens),
			cost:
				group.cost == null ? "" : formatCurrency(group.cost, "USD", { locale }),
		}));
}

export function buildStatsViewModel(
	stats: ExecutionStats,
	options: {
		scope: StatsScope;
		locale: Locale;
		requests?: readonly RequestMetric[];
		context?: StatsContext | null;
	},
): StatsViewModel {
	const { scope, locale } = options;
	const number = (value: number) =>
		new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
	const duration = (value: number) => formatDurationMs(value, locale);
	const usd = (value: number | null) =>
		value == null ? null : formatCurrency(value, "USD", { locale });
	const usage = stats.usage;
	const tokens = usage?.totalTokens;
	const modelCost = usd(stats.modelCostUsd);
	const generationCost = usd(stats.generationCostUsd);

	const totals: StatsItem[] = [];
	if (scope === "session") item(totals, "turns", number(stats.turns));
	if (finite(stats.elapsedMs))
		item(totals, "elapsed", duration(stats.elapsedMs));
	if (tokens != null) item(totals, "tokens", formatTokenCount(tokens));
	if (modelCost) item(totals, "modelCost", modelCost);
	else item(totals, "generationCost", generationCost);

	const toolMs = stats.toolCalls ? stats.toolMs : null;
	// Execution time the model and tool intervals do not explain (local harnesses report no model time).
	const otherMs = finite(stats.elapsedMs)
		? stats.elapsedMs - (stats.modelMs ?? 0) - (toolMs ?? 0)
		: null;
	const timeFacts: StatsItem[] = [];
	if (stats.calls) item(timeFacts, "calls", number(stats.calls));
	if (stats.toolCalls) item(timeFacts, "tools", number(stats.toolCalls));
	if (stats.ttftSamples)
		item(timeFacts, "ttft", duration(stats.ttftMs / stats.ttftSamples));
	if (stats.outputMs > 0)
		item(
			timeFacts,
			"tps",
			`${number((stats.timedOutputTokens / stats.outputMs) * 1000)} tok/s`,
		);
	if (stats.retryCount)
		item(
			timeFacts,
			"retries",
			`${number(stats.retryCount)} · ${duration(stats.retryWaitMs ?? 0)}`,
		);
	const time = breakdown(
		[
			{ key: "queue", value: stats.queueMs, tone: "faint" },
			{ key: "modelTime", value: stats.modelMs, tone: "brand" },
			{ key: "toolTime", value: toolMs, tone: "strong" },
			{
				key: "otherTime",
				value:
					otherMs != null && otherMs > (stats.elapsedMs ?? 0) * 0.01
						? otherMs
						: null,
				tone: "muted",
			},
		],
		duration,
		timeFacts,
	);

	const input = getDisplayInputTokens(usage);
	const tokenFacts: StatsItem[] = [];
	if (
		input > 0 &&
		stats.unknownUsageCalls === 0 &&
		usage?.input != null &&
		usage.cacheRead != null &&
		usage.cacheWrite != null
	)
		item(tokenFacts, "cache", `${number((usage.cacheRead / input) * 100)}%`);
	const context = options.context;
	if (context && context.tokens > 0)
		item(
			tokenFacts,
			"context",
			context.window
				? `${formatTokenCount(context.tokens)} / ${formatTokenCount(context.window)} · ${Math.round(Math.min(100, (context.tokens / context.window) * 100))}%`
				: formatTokenCount(context.tokens),
		);
	const tokenBreakdown = usage
		? breakdown(
				[
					{ key: "cached", value: usage.cacheRead, tone: "muted" },
					{
						key: "input",
						value: (usage.input ?? 0) + (usage.cacheWrite ?? 0),
						tone: "strong",
					},
					{ key: "output", value: usage.output, tone: "brand" },
				],
				formatTokenCount,
				tokenFacts,
			)
		: null;

	const extra: StatsItem[] = [];
	if (scope === "session" && stats.generations)
		item(extra, "generations", number(stats.generations));
	if (modelCost) item(extra, "generationCost", generationCost);
	if (stats.failedCalls) item(extra, "failedCalls", number(stats.failedCalls));
	if (stats.toolErrors) item(extra, "toolErrors", number(stats.toolErrors));
	if (stats.compactions)
		item(
			extra,
			"compaction",
			`${number(stats.compactions)}${stats.compactionMs != null ? ` · ${duration(stats.compactionMs)}` : ""}`,
		);
	if (stats.imageToTextCalls)
		item(
			extra,
			"imageToText",
			`${number(stats.imageToTextCalls)}${stats.imageToTextMs != null ? ` · ${duration(stats.imageToTextMs)}` : ""}`,
		);

	return {
		totals,
		time,
		tokens: tokenBreakdown,
		models: buildStatsModels(options.requests ?? [], locale),
		extra,
		partial: stats.partial,
	};
}

export type TimelineRequest = {
	id: string;
	provider: string;
	model: string;
	status: RequestMetric["status"];
	left: number;
	width: number;
	firstToken: number;
	output: number;
	startMs: number;
	durationMs: number;
};

export type StatsTimelineModel = {
	requests: TimelineRequest[];
	durationMs: number;
};

function finiteTimestamp(value: number | undefined) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function buildStatsTimeline(
	requests: readonly RequestMetric[],
): StatsTimelineModel | null {
	if (requests.length < 2) return null;
	const starts = requests
		.map((request) => finiteTimestamp(request.startedAt))
		.filter((value): value is number => value != null);
	if (starts.length < 2) return null;
	const origin = Math.min(...starts);
	const raw = requests.map((request, index) => {
		const start = finiteTimestamp(request.startedAt) ?? origin;
		const duration = finite(request.durationMs) ? request.durationMs : 0;
		const completed = finiteTimestamp(request.completedAt);
		const end =
			completed != null
				? Math.max(completed, start + duration)
				: start + duration;
		return { request, index, start, end };
	});
	const end = Math.max(...raw.map((item) => item.end), origin + 1);
	const window = Math.max(1, end - origin);
	const timeline = raw.map(({ request, index, start, end: requestEnd }) => {
		const requestDuration = Math.max(1, requestEnd - start);
		const firstTokenMs = Math.min(
			requestDuration,
			Math.max(0, request.firstTokenMs ?? 0),
		);
		const outputMs = Math.min(
			requestDuration - firstTokenMs,
			Math.max(0, request.outputDurationMs ?? 0),
		);
		return {
			id: request.id || `request-${index}`,
			provider: request.provider,
			model: request.model,
			status: request.status,
			left: Math.max(0, ((start - origin) / window) * 100),
			width: Math.max(0.8, (requestDuration / window) * 100),
			firstToken: (firstTokenMs / requestDuration) * 100,
			output: (outputMs / requestDuration) * 100,
			startMs: start - origin,
			durationMs: requestDuration,
		};
	});
	return { requests: timeline, durationMs: window };
}
