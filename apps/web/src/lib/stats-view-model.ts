import type { ExecutionStats, RequestMetric } from "@cohub/protocol/model";
import { formatDurationMs } from "$lib/format-duration";
import { formatTokenCount, getDisplayInputTokens } from "$lib/format-usage";
import { formatCurrency } from "$lib/i18n/format";
import type { Locale } from "$lib/i18n/locale";

export type StatsScope = "turn" | "session";

export type StatsLabelKey =
	| "turns"
	| "calls"
	| "tools"
	| "elapsed"
	| "queue"
	| "modelTime"
	| "toolTime"
	| "retries"
	| "ttft"
	| "tps"
	| "input"
	| "tokens"
	| "output"
	| "cache"
	| "cacheTokens"
	| "compaction"
	| "imageToText"
	| "generations"
	| "modelCost"
	| "generationCost";

export type StatsSectionKey = "summary" | "timing" | "usage" | "additional";

export type StatsItem = {
	key: string;
	label: StatsLabelKey;
	value: string;
};

export type StatsBarSegment = {
	key: string;
	label: StatsLabelKey;
	value: string;
	share: number;
	tone: "brand" | "strong" | "subtle";
};

export type StatsGroup = {
	key: StatsSectionKey;
	items: StatsItem[];
};

export type StatsViewModel = {
	hero: StatsItem[];
	timing: StatsBarSegment[];
	usage: StatsBarSegment[];
	groups: StatsGroup[];
	elapsed: string | null;
};

const numberFormatter = (locale: Locale) =>
	new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });

const finite = (value: number | null | undefined): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

function formatNumber(value: number, locale: Locale) {
	return numberFormatter(locale).format(value);
}

function formatRetries(stats: ExecutionStats, locale: Locale) {
	return `${formatNumber(stats.retryCount ?? 0, locale)} · ${formatDurationMs(stats.retryWaitMs ?? 0, locale)}`;
}

function formatTps(stats: ExecutionStats, locale: Locale) {
	return `${formatNumber((stats.timedOutputTokens / stats.outputMs) * 1000, locale)} tok/s`;
}

function makeBar(
	entries: Array<{
		key: string;
		label: StatsLabelKey;
		value: number | null | undefined;
		tone: StatsBarSegment["tone"];
	}>,
) {
	const visible = entries.filter(
		(entry): entry is typeof entry & { value: number } =>
			finite(entry.value) && entry.value > 0,
	);
	const total = visible.reduce((sum, entry) => sum + entry.value, 0);
	if (!total) return [];
	return visible.map((entry) => ({
		key: entry.key,
		label: entry.label,
		value: entry.value === 0 ? "0" : "",
		share: (entry.value / total) * 100,
		tone: entry.tone,
	}));
}

function add(
	items: StatsItem[],
	key: string,
	label: StatsLabelKey,
	value: string | null | undefined,
) {
	if (value == null || value === "") return;
	items.push({ key, label, value });
}

export function buildStatsViewModel(
	stats: ExecutionStats,
	scope: StatsScope,
	locale: Locale,
): StatsViewModel {
	const input = getDisplayInputTokens(stats.usage);
	const cache =
		input > 0 &&
		stats.unknownUsageCalls === 0 &&
		stats.usage?.input != null &&
		stats.usage.cacheRead != null &&
		stats.usage.cacheWrite != null
			? (stats.usage.cacheRead / input) * 100
			: null;
	const duration = (value: number) => formatDurationMs(value, locale);
	const number = (value: number) => formatNumber(value, locale);

	const hero: StatsItem[] = [];
	if (scope === "session") add(hero, "turns", "turns", number(stats.turns));
	if (stats.elapsedMs != null)
		add(hero, "elapsed", "elapsed", duration(stats.elapsedMs));
	if (scope === "turn" && stats.calls != null)
		add(hero, "calls", "calls", number(stats.calls));
	if (stats.usage?.totalTokens != null)
		add(hero, "tokens", "tokens", formatTokenCount(stats.usage.totalTokens));
	if (scope === "session" && stats.calls != null && hero.length < 3)
		add(hero, "calls", "calls", number(stats.calls));
	if (stats.generations && hero.length < 3)
		add(hero, "generations", "generations", number(stats.generations));

	const timing = makeBar([
		{ key: "queue", label: "queue", value: stats.queueMs, tone: "subtle" },
		{ key: "model", label: "modelTime", value: stats.modelMs, tone: "brand" },
		{ key: "tools", label: "toolTime", value: stats.toolMs, tone: "strong" },
	]);
	if (timing.length) {
		for (const segment of timing) {
			const raw =
				segment.key === "queue"
					? stats.queueMs
					: segment.key === "model"
						? stats.modelMs
						: stats.toolMs;
			segment.value = raw == null ? "" : duration(raw);
		}
	}

	const usage = makeBar([
		{ key: "input", label: "input", value: input, tone: "strong" },
		{
			key: "output",
			label: "output",
			value: stats.usage?.output,
			tone: "brand",
		},
	]);
	for (const segment of usage) {
		const raw = segment.key === "input" ? input : stats.usage?.output;
		segment.value = raw == null ? "" : formatTokenCount(raw);
	}

	const scale: StatsItem[] = [];
	if (scope === "turn" && stats.turns)
		add(scale, "turns", "turns", number(stats.turns));
	if (scope === "session" && stats.calls != null)
		add(scale, "calls", "calls", number(stats.calls));
	if (stats.toolCalls != null)
		add(scale, "tools", "tools", number(stats.toolCalls));
	if (stats.generations)
		add(scale, "generations", "generations", number(stats.generations));

	const timingItems: StatsItem[] = [];
	add(
		timingItems,
		"queue",
		"queue",
		stats.queueMs == null ? null : duration(stats.queueMs),
	);
	add(
		timingItems,
		"model",
		"modelTime",
		stats.modelMs == null ? null : duration(stats.modelMs),
	);
	add(
		timingItems,
		"tools",
		"toolTime",
		stats.toolMs == null || !stats.toolCalls ? null : duration(stats.toolMs),
	);
	add(
		timingItems,
		"retries",
		"retries",
		stats.retryCount ? formatRetries(stats, locale) : null,
	);
	add(
		timingItems,
		"ttft",
		"ttft",
		stats.ttftSamples ? duration(stats.ttftMs / stats.ttftSamples) : null,
	);
	add(
		timingItems,
		"tps",
		"tps",
		stats.outputMs > 0 ? formatTps(stats, locale) : null,
	);

	const usageItems: StatsItem[] = [];
	if (
		stats.usage &&
		(stats.usage.input != null ||
			stats.usage.cacheRead != null ||
			stats.usage.cacheWrite != null)
	)
		add(usageItems, "input", "input", formatTokenCount(input));
	add(
		usageItems,
		"tokens",
		"tokens",
		stats.usage?.totalTokens == null
			? null
			: formatTokenCount(stats.usage.totalTokens),
	);
	add(
		usageItems,
		"output",
		"output",
		stats.usage?.output == null ? null : formatTokenCount(stats.usage.output),
	);
	add(
		usageItems,
		"cacheTokens",
		"cacheTokens",
		stats.usage?.cacheRead ? formatTokenCount(stats.usage.cacheRead) : null,
	);
	add(usageItems, "cache", "cache", cache == null ? null : `${number(cache)}%`);
	add(
		usageItems,
		"modelCost",
		"modelCost",
		stats.modelCostUsd == null
			? null
			: formatCurrency(stats.modelCostUsd, "USD", { locale }),
	);
	add(
		usageItems,
		"generationCost",
		"generationCost",
		stats.generationCostUsd == null
			? null
			: formatCurrency(stats.generationCostUsd, "USD", { locale }),
	);

	const additional: StatsItem[] = [];
	add(
		additional,
		"compaction",
		"compaction",
		stats.compactions
			? `${number(stats.compactions)}${stats.compactionMs != null ? ` · ${duration(stats.compactionMs)}` : ""}`
			: null,
	);
	add(
		additional,
		"imageToText",
		"imageToText",
		stats.imageToTextCalls
			? `${number(stats.imageToTextCalls)}${stats.imageToTextMs != null ? ` · ${duration(stats.imageToTextMs)}` : ""}`
			: null,
	);

	const groups = [
		{ key: "summary" as const, items: scale },
		{ key: "timing" as const, items: timingItems },
		{ key: "usage" as const, items: usageItems },
		{ key: "additional" as const, items: additional },
	].filter((group): group is StatsGroup => group.items.length > 0);

	return {
		hero: hero.slice(0, 3),
		timing,
		usage,
		groups,
		elapsed: stats.elapsedMs == null ? null : duration(stats.elapsedMs),
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
