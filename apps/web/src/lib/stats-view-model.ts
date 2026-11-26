import {
	type ExecutionStats,
	type RequestMetric,
	readTurnStats,
	type StatsTurn,
} from "@cohub/protocol/model";
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
};

export type StatsContext = { tokens: number; window: number | null };

export function statsToneClass(tone: StatsSegment["tone"]) {
	if (tone === "brand") return "bg-brand";
	if (tone === "strong") return "bg-text-tertiary";
	if (tone === "muted") return "bg-text-placeholder/60";
	return "bg-text-placeholder/30";
}

export const statsTimeTone = {
	queue: "faint",
	modelTime: "brand",
	toolTime: "strong",
	otherTime: "muted",
} as const satisfies Record<string, StatsSegment["tone"]>;

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
			{ key: "queue", value: stats.queueMs, tone: statsTimeTone.queue },
			{ key: "modelTime", value: stats.modelMs, tone: statsTimeTone.modelTime },
			{ key: "toolTime", value: toolMs, tone: statsTimeTone.toolTime },
			{
				key: "otherTime",
				value:
					otherMs != null && otherMs > (stats.elapsedMs ?? 0) * 0.01
						? otherMs
						: null,
				tone: statsTimeTone.otherTime,
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
	};
}

export type StatsTimelinePart = {
	key: "queue" | "modelTime" | "toolTime" | "otherTime";
	left: number;
	width: number;
	failed?: boolean;
};

export type StatsTimelineRow = {
	key: string;
	label: string;
	durationMs: number;
	width: number;
	parts: StatsTimelinePart[];
	breakdown: StatsItem[];
	request?: RequestMetric;
	failed?: boolean;
};

export type StatsTimelineModel = {
	rows: StatsTimelineRow[];
	durationMs: number;
};

const timestamp = (value: number | undefined) =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

function timeline(
	rows: Omit<StatsTimelineRow, "width">[],
	locale: Locale,
): StatsTimelineModel | null {
	if (rows.length < 2) return null;
	const durationMs = Math.max(1, ...rows.map((row) => row.durationMs));
	return {
		durationMs,
		rows: rows.map((row) => ({
			...row,
			width: (row.durationMs / durationMs) * 100,
			breakdown: [
				...row.breakdown,
				{ key: "elapsed", value: formatDurationMs(row.durationMs, locale) },
			],
		})),
	};
}

function measure(
	durationMs: number,
	spans: Array<{
		key: StatsTimelinePart["key"];
		start: number;
		end: number;
		failed?: boolean;
	}>,
	locale: Locale,
) {
	const filled: typeof spans = [];
	let cursor = 0;
	const gap = (until: number) => {
		if (until - cursor > durationMs * 0.01)
			filled.push({ key: "otherTime", start: cursor, end: until });
	};
	for (const span of spans
		.filter((span) => span.end > span.start)
		.sort((a, b) => a.start - b.start)) {
		gap(span.start);
		filled.push(span);
		cursor = Math.max(cursor, span.end);
	}
	gap(durationMs);
	const totals = new Map<StatsLabelKey, number>();
	for (const { key, start, end } of filled)
		totals.set(key, (totals.get(key) ?? 0) + end - start);
	return {
		parts: filled.map(({ key, start, end, failed }) => ({
			key,
			left: (start / durationMs) * 100,
			width: ((end - start) / durationMs) * 100,
			...(failed ? { failed } : {}),
		})),
		breakdown: [...totals].map(([key, ms]) => ({
			key,
			value: formatDurationMs(ms, locale),
		})),
	};
}

export function buildTurnTimeline(
	requests: readonly RequestMetric[],
	tools: readonly (readonly [number, number])[],
	locale: Locale,
): StatsTimelineModel | null {
	const spans = requests
		.flatMap((request) => {
			const start = timestamp(request.startedAt);
			if (start == null) return [];
			const end = Math.max(
				timestamp(request.completedAt) ?? start,
				start + (finite(request.durationMs) ? request.durationMs : 0),
			);
			return [{ request, start, end }];
		})
		.sort((a, b) => a.start - b.start);
	const rows = spans.map(({ request, start, end }, index) => {
		const next = spans[index + 1]?.start;
		const stepEnd = Math.max(
			end,
			next ??
				Math.max(end, ...tools.filter(([s]) => s >= start).map(([, e]) => e)),
		);
		const durationMs = Math.max(1, stepEnd - start);
		const failed =
			request.status === "failed" || request.status === "interrupted";
		const { parts, breakdown } = measure(
			durationMs,
			[
				{ key: "modelTime", start: 0, end: end - start, failed },
				...tools.map(([s, e]) => ({
					key: "toolTime" as const,
					start: Math.max(s, end) - start,
					end: Math.min(e, stepEnd) - start,
				})),
			],
			locale,
		);
		return {
			key: request.id || `request-${index}`,
			label: String(index + 1),
			durationMs,
			parts,
			breakdown,
			request,
			...(failed ? { failed } : {}),
		};
	});
	return timeline(rows, locale);
}

const SESSION_TIMELINE_TURNS = 50;

export function buildSessionTimeline(
	turns: readonly (StatsTurn & { sequence: number })[],
	locale: Locale,
): StatsTimelineModel | null {
	const rows = [...turns]
		.sort((a, b) => a.sequence - b.sequence)
		.flatMap((turn) => {
			const stats = readTurnStats(turn);
			if (!stats.turns || !finite(stats.elapsedMs)) return [];
			const queue = stats.queueMs ?? 0;
			const durationMs = Math.max(1, queue + stats.elapsedMs);
			const tool = Math.min(stats.toolMs ?? 0, durationMs - queue);
			const modelEnd = Math.min(
				queue + (stats.modelMs ?? 0),
				durationMs - tool,
			);
			const { parts, breakdown } = measure(
				durationMs,
				[
					{ key: "queue", start: 0, end: queue },
					{ key: "modelTime", start: queue, end: modelEnd },
					{ key: "toolTime", start: modelEnd, end: modelEnd + tool },
				],
				locale,
			);
			return [
				{
					key: String(turn.sequence),
					label: String(turn.sequence),
					durationMs,
					parts,
					breakdown,
					...(turn.status === "completed" ? {} : { failed: true }),
				},
			];
		});
	return timeline(rows.slice(-SESSION_TIMELINE_TURNS), locale);
}
