import type { BillingBalanceActivity } from "@neta-art/cohub";

export type LedgerRun = {
	id: string;
	first: BillingBalanceActivity;
	items: BillingBalanceActivity[];
	amountUsd: number;
	status: BillingBalanceActivity["status"];
};

export type LedgerDay = { key: string; date: Date; runs: LedgerRun[] };

export function transferActivityKind(item: {
	kind: string;
	sourceId: string | null;
}): "out" | "returned" | null {
	if (item.kind === "usage" && item.sourceId?.startsWith("cohub:swt:"))
		return "out";
	if (item.kind === "reversal" && item.sourceId?.startsWith("swt:"))
		return "returned";
	return null;
}

export const quotedName = (reason: string | null) =>
	reason?.match(/"(.+)"$/)?.[1] ?? reason;

const SUBJECT =
	/^(?:LLM usage|Raw LLM completion|Decision call) [^/\s]+\/(.+)$|^Generation (.+)$/;
/** The pricing facts the server appends to a discounted usage reason: ` [list=5;x=0.5;quota=6/10]`. */
const PRICING_SUFFIX = / \[list=([\d.]+)((?:;[a-z]+=[^;\]]+)*)\]$/;

export type UsagePricing = {
	listUsd: number;
	multiplier: number | null;
	quota: { covered: number; requested: number } | null;
};

function plainReason(description: string | null): string | null {
	return description?.replace(PRICING_SUFFIX, "") ?? null;
}

export function usagePricing(
	item: Pick<BillingBalanceActivity, "description">,
): UsagePricing | null {
	const match = item.description?.match(PRICING_SUFFIX);
	if (!match) return null;
	const fields = new Map(
		(match[2] ?? "")
			.split(";")
			.filter(Boolean)
			.map((pair) => pair.split("=") as [string, string]),
	);
	const multiplier = Number(fields.get("x"));
	const [covered, requested] = (fields.get("quota") ?? "")
		.split("/")
		.map(Number);
	return {
		listUsd: Number(match[1]),
		multiplier: Number.isFinite(multiplier) ? multiplier : null,
		quota:
			covered !== undefined &&
			requested !== undefined &&
			covered > 0 &&
			requested > 0
				? { covered, requested }
				: null,
	};
}

export function usageSubject(item: BillingBalanceActivity): string | null {
	const match = plainReason(item.description)?.match(SUBJECT);
	return match ? (match[1] ?? match[2] ?? null) : null;
}

/** Pricing shared by every item of a run; the list total only when each item carries one. */
export function runPricing(items: readonly BillingBalanceActivity[]) {
	const priced = items.map(usagePricing);
	if (priced.some((pricing) => !pricing)) return null;
	const first = priced[0];
	if (!first) return null;
	return {
		listUsd: -Number(
			priced
				.reduce((sum, pricing) => sum + (pricing?.listUsd ?? 0), 0)
				.toFixed(8),
		),
		multiplier: priced.every(
			(pricing) => pricing?.multiplier === first.multiplier,
		)
			? first.multiplier
			: null,
		quota: priced.length === 1 ? first.quota : null,
	};
}

function dayKey(date: Date) {
	return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function runKey(item: BillingBalanceActivity) {
	if (item.kind !== "usage" || transferActivityKind(item)) return null;
	return `${item.usageType}|${plainReason(item.description)}|${item.status === "covered" ? "" : "overage"}`;
}

function mergedStatus(
	left: BillingBalanceActivity["status"],
	right: BillingBalanceActivity["status"],
) {
	if (left === right) return left;
	return left === "covered" || right === "covered" ? "partial" : left;
}

export function ledgerDays(items: BillingBalanceActivity[]): LedgerDay[] {
	const days: LedgerDay[] = [];
	let lastKey: string | null = null;
	for (const item of items) {
		const date = new Date(item.createdAt);
		const key = dayKey(date);
		let day = days.at(-1);
		if (!day || day.key !== key) {
			day = { key, date, runs: [] };
			days.push(day);
			lastKey = null;
		}
		const itemKey = runKey(item);
		const run = day.runs.at(-1);
		if (run && itemKey !== null && itemKey === lastKey) {
			run.items.push(item);
			run.amountUsd = Number((run.amountUsd + item.amountUsd).toFixed(8));
			run.status = mergedStatus(run.status, item.status);
		} else {
			day.runs.push({
				id: item.id,
				first: item,
				items: [item],
				amountUsd: item.amountUsd,
				status: item.status,
			});
		}
		lastKey = itemKey;
	}
	return days;
}
