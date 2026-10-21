import type {
	ModelAvailabilityStatus,
	ModelStatusEntry,
	ModelStatusResponse,
} from "@cohub/protocol/model/status";
import {
	type RawOnlineHeartbeat,
	resampleModelStatusHeartbeats,
} from "./model-status-heartbeats.js";

const PRIMARY_INSTANCE = "neta";
const HISTORY_WINDOW_MINUTES = 24 * 60;

export type RawCheckWindow = {
	sample_count?: number;
	operational_samples?: number;
	outage_samples?: number;
	success_rate?: number;
};

export type RawCheck = {
	model?: string;
	instance?: string;
	status?: string;
	checked_at?: string;
	probe_interval_seconds?: number;
	latency_1h?: {
		sample_count?: number;
		average_duration_ms?: number;
		p90_duration_ms?: number;
	};
	windows?: Record<string, RawCheckWindow>;
	history?: Array<{
		started_at?: string;
		status?: string;
		sample_count?: number;
		operational_samples?: number;
	}>;
};

export type RawOnlineMetric = {
	status?: string;
	has_data?: boolean;
	sample_count?: number;
	success_count?: number;
	request_count?: number;
	failure_count?: number;
	success_rate?: number;
	duration_avg_ms?: number;
	duration_p90_ms?: number;
	last_checked?: string;
};

export type RawOnlineWindow = {
	minutes?: number;
	metric?: RawOnlineMetric;
};

export type RawOnlineModel = {
	model?: string;
	status?: string;
	summary?: RawOnlineMetric;
	windows?: RawOnlineWindow[];
	heartbeats?: RawOnlineHeartbeat[];
};

export type RawOnline = {
	window?: { start?: string; minutes?: number };
	models?: RawOnlineModel[];
};

export type RawStatus = {
	generated_at?: string;
	overall_status?: string;
	checks?: RawCheck[];
	online?: RawOnline;
};

function modelId(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed || null;
}

function knownStatus(value: string | undefined): ModelAvailabilityStatus | null {
	if (value === "operational" || value === "degraded" || value === "outage") {
		return value;
	}
	return null;
}

function normalizeStatus(value: string | undefined): ModelAvailabilityStatus {
	return knownStatus(value) ?? "operational";
}

function positiveCount(value: number | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function hasPositiveCount(value: number | undefined): boolean {
	return positiveCount(value) !== null;
}

function onlineMetricHasData(metric: RawOnlineMetric | undefined): boolean {
	if (!metric || metric.has_data === false) return false;
	const count = metric.request_count ?? metric.sample_count;
	if (count !== undefined) return hasPositiveCount(count);
	return typeof metric.success_rate === "number" && Number.isFinite(metric.success_rate);
}

function onlineWindowMetric(
	windows: RawOnlineWindow[] | null | undefined,
	minutes: number,
): RawOnlineMetric | null {
	return windows?.find((window) => window.minutes === minutes)?.metric ?? null;
}

function onlineWindowRate(
	windows: RawOnlineWindow[] | null | undefined,
	minutes: number,
): number | null {
	const metric = onlineWindowMetric(windows, minutes);
	if (!onlineMetricHasData(metric ?? undefined)) return null;
	return typeof metric?.success_rate === "number" && Number.isFinite(metric.success_rate)
		? metric.success_rate
		: null;
}

function probeWindowRate(
	windows: RawCheck["windows"],
	key: string,
): number | null {
	const window = windows?.[key];
	if (!hasPositiveCount(window?.sample_count)) return null;
	return typeof window?.success_rate === "number" && Number.isFinite(window.success_rate)
		? window.success_rate
		: null;
}

function uptime24h(history: RawCheck["history"]): number | null {
	if (!history?.length) return null;
	let operational = 0;
	let total = 0;
	for (const bucket of history) {
		const samples = bucket.sample_count ?? 0;
		total += samples;
		operational += bucket.operational_samples ?? 0;
	}
	return total > 0 ? (operational / total) * 100 : null;
}

function historyRates(
	history: RawCheck["history"],
): Array<number | null> | null {
	if (!history?.length) return null;
	return history.map((bucket) => {
		const samples = positiveCount(bucket.sample_count);
		return samples
			? Math.round(((bucket.operational_samples ?? 0) / samples) * 100)
			: null;
	});
}

function onlineLatency(online: RawOnlineModel | null): {
	average_duration_ms?: number;
	p90_duration_ms?: number;
} | null {
	const metric = onlineWindowMetric(online?.windows, 60);
	if (!onlineMetricHasData(metric ?? undefined)) return null;
	return {
		average_duration_ms: metric?.duration_avg_ms,
		p90_duration_ms: metric?.duration_p90_ms,
	};
}

function onlineCheckedAt(online: RawOnlineModel | null): string | null {
	const recentMetric = onlineWindowMetric(online?.windows, 5);
	if (onlineMetricHasData(recentMetric ?? undefined) && recentMetric?.last_checked) {
		return recentMetric.last_checked;
	}
	if (
		onlineMetricHasData(online?.summary) &&
		online?.summary?.last_checked
	) {
		return online.summary.last_checked;
	}
	return null;
}

const RECENT_RATE_WINDOWS = [5, 10, 30, 60] as const;

function recentRate(
	online: RawOnlineModel | null,
	check: RawCheck | null,
): { rate: number | null; minutes: number | null } {
	for (const minutes of RECENT_RATE_WINDOWS) {
		const rate = onlineWindowRate(online?.windows, minutes);
		if (rate != null) return { rate, minutes };
	}
	const probeRate = probeWindowRate(check?.windows, "5m");
	if (probeRate != null) return { rate: probeRate, minutes: 5 };
	return { rate: null, minutes: null };
}

function slimModelStatus(
	check: RawCheck | null,
	online: RawOnlineModel | null,
	bars: Array<number | null> | null,
	barsWindowMinutes: number | null,
): ModelStatusEntry {
	const checkWindows = check?.windows;
	const onlineStatus =
		knownStatus(online?.status) ??
		knownStatus(onlineWindowMetric(online?.windows, 5)?.status);
	const latency = check?.latency_1h ?? onlineLatency(online);
	const recent = recentRate(online, check);

	return {
		status: onlineStatus ?? normalizeStatus(check?.status),
		successRate5m:
			onlineWindowRate(online?.windows, 5) ?? probeWindowRate(checkWindows, "5m"),
		successRateRecent: recent.rate,
		successRateRecentWindowMinutes: recent.minutes,
		successRate2h: probeWindowRate(checkWindows, "2h"),
		successRate24h:
			onlineWindowRate(online?.windows, 1440) ?? uptime24h(check?.history),
		latencyAvgMs: latency?.average_duration_ms ?? null,
		latencyP90Ms: latency?.p90_duration_ms ?? null,
		checkedAt: check?.checked_at ?? onlineCheckedAt(online),
		probeIntervalSeconds: check?.probe_interval_seconds ?? null,
		heartbeats8h: bars,
		heartbeatsWindowMinutes: barsWindowMinutes,
		history: check?.history?.length
			? check.history.map((bucket) => {
					const samples = positiveCount(bucket.sample_count);
					return {
						t: bucket.started_at ?? "",
						status: normalizeStatus(bucket.status),
						rate: samples
							? ((bucket.operational_samples ?? 0) / samples) * 100
							: null,
						samples: bucket.sample_count ?? 0,
					};
				})
			: null,
	};
}

export function buildModelStatusResponse(raw: RawStatus): ModelStatusResponse {
	const checksByModel = new Map<string, RawCheck>();
	for (const check of raw.checks ?? []) {
		const id = modelId(check.model);
		if (!id) continue;
		const existing = checksByModel.get(id);
		if (
			!existing ||
			(check.instance === PRIMARY_INSTANCE && existing.instance !== PRIMARY_INSTANCE)
		) {
			checksByModel.set(id, check.model === id ? check : { ...check, model: id });
		}
	}

	const onlineByModel = new Map<string, RawOnlineModel>();
	for (const online of raw.online?.models ?? []) {
		const id = modelId(online.model);
		if (id) onlineByModel.set(id, online.model === id ? online : { ...online, model: id });
	}

	const rawWindowMinutes = raw.online?.window?.minutes;
	const onlineWindowMinutes =
		typeof rawWindowMinutes === "number" &&
		Number.isFinite(rawWindowMinutes) &&
		rawWindowMinutes > 0
			? rawWindowMinutes
			: 480;
	const models: Record<string, ModelStatusEntry> = {};
	const modelIds = new Set([...checksByModel.keys(), ...onlineByModel.keys()]);

	for (const id of modelIds) {
		const check = checksByModel.get(id) ?? null;
		const online = onlineByModel.get(id) ?? null;
		const observedBars = online
			? resampleModelStatusHeartbeats(
					online.heartbeats ?? [],
					raw.online?.window?.start,
					onlineWindowMinutes,
			  )
			: null;
		const hasObservedBars = observedBars?.some((rate) => rate !== null) ?? false;
		const fallbackBars = historyRates(check?.history);
		const bars = hasObservedBars ? observedBars : fallbackBars;
		const barsWindowMinutes = hasObservedBars
			? onlineWindowMinutes
			: fallbackBars
				? HISTORY_WINDOW_MINUTES
				: null;
		models[id] = slimModelStatus(check, online, bars, barsWindowMinutes);
	}

	const overall = raw.overall_status;
	return {
		generatedAt: raw.generated_at ?? new Date().toISOString(),
		overallStatus:
			overall === "operational" || overall === "degraded" || overall === "outage"
			? overall
			: "unknown",
		models,
	};
}
