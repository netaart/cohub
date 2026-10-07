import type { SpaceUsageResponse } from "@neta-art/cohub";
import { formatCurrency, toIntlTag } from "$lib/i18n/format";
import type { Locale } from "$lib/i18n/locale";

export type ActivityDay = {
	date: string;
	tokens: number;
	requests: number;
	generationRequests: number;
};

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

function dateKey(date: Date) {
	const parts = dayFormatter.formatToParts(date);
	const get = (type: string) =>
		parts.find((part) => part.type === type)?.value ?? "00";
	return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(date: Date, amount: number) {
	const result = new Date(date);
	result.setDate(result.getDate() + amount);
	return result;
}

export function buildActivityDays(
	data: Pick<SpaceUsageResponse, "hourly" | "generation">,
	days: number,
): ActivityDay[] {
	const map = new Map<string, ActivityDay>();
	const ensure = (key: string) => {
		const existing = map.get(key);
		if (existing) return existing;
		const created = {
			date: key,
			tokens: 0,
			requests: 0,
			generationRequests: 0,
		};
		map.set(key, created);
		return created;
	};

	for (const row of data.hourly) {
		const day = ensure(dateKey(new Date(row.bucketStartAt)));
		day.tokens += row.totalTokens;
		day.requests += row.requestCount;
	}
	for (const row of data.generation?.hourly ?? []) {
		const day = ensure(dateKey(new Date(row.bucketStartAt)));
		day.requests += row.requestCount;
		day.generationRequests += row.requestCount;
	}

	const today = new Date();
	return Array.from({ length: days }, (_, index) =>
		ensure(dateKey(addDays(today, index - days + 1))),
	);
}

export function formatCompact(value: number, locale: Locale = "en") {
	if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return new Intl.NumberFormat(toIntlTag(locale)).format(Math.round(value));
}

export function formatCost(value: number, locale: Locale = "en") {
	if (!value) return formatCurrency(0, "USD", { locale });
	if (value < 0.01) return `<${formatCurrency(0.01, "USD", { locale })}`;
	return formatCurrency(value, "USD", {
		locale,
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
}
