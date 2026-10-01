import type { Usage } from "@cohub/protocol/core";
import { formatCurrency } from "$lib/i18n/format";
import type { Locale } from "$lib/i18n/locale";

/** Compact token count for message/process meta bars (matches chat bubble style). */
export function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

/** Precise USD cost for per-message / process summaries. */
export function formatUsageCost(n: number, locale?: Locale): string {
	if (!Number.isFinite(n) || n <= 0) return "";
	return formatCurrency(n, "USD", { locale });
}

export function getUsageCostTotal(
	usage: Usage | null | undefined,
): number | null {
	const total = usage?.cost?.total;
	if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) {
		return null;
	}
	return total;
}

export function formatUsageCostFromUsage(
	usage: Usage | null | undefined,
	locale?: Locale,
): string {
	const total = getUsageCostTotal(usage);
	return total == null ? "" : formatUsageCost(total, locale);
}

/** Normalized input excludes both cache reads and cache writes; display their total. */
export function getDisplayInputTokens(usage: Usage | null | undefined): number {
	if (!usage) return 0;
	return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

export function getUsageTotalTokens(usage: Usage | null | undefined): number {
	if (!usage) return 0;
	return usage.totalTokens ?? ((usage.input ?? 0) + (usage.output ?? 0) || 0);
}

function addUsage(a: Usage | null | undefined, b: Usage): Usage {
	return {
		input: (a?.input ?? 0) + (b.input ?? 0) || undefined,
		output: (a?.output ?? 0) + (b.output ?? 0) || undefined,
		cacheRead: (a?.cacheRead ?? 0) + (b.cacheRead ?? 0) || undefined,
		cacheWrite: (a?.cacheWrite ?? 0) + (b.cacheWrite ?? 0) || undefined,
		totalTokens: (a?.totalTokens ?? 0) + (b.totalTokens ?? 0) || undefined,
		cost:
			a?.cost || b.cost
				? {
						input: (a?.cost?.input ?? 0) + (b.cost?.input ?? 0) || undefined,
						output: (a?.cost?.output ?? 0) + (b.cost?.output ?? 0) || undefined,
						cacheRead:
							(a?.cost?.cacheRead ?? 0) + (b.cost?.cacheRead ?? 0) || undefined,
						cacheWrite:
							(a?.cost?.cacheWrite ?? 0) + (b.cost?.cacheWrite ?? 0) ||
							undefined,
						total: (a?.cost?.total ?? 0) + (b.cost?.total ?? 0) || undefined,
					}
				: null,
	};
}

/** Sum message-level usages (e.g. live intermediate messages). */
export function sumUsages(
	usages: Array<Usage | null | undefined>,
): Usage | null {
	let result: Usage | null = null;
	for (const usage of usages) {
		if (!usage) continue;
		result = addUsage(result, usage);
	}
	return result;
}
