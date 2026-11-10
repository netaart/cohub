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

export function usageSubject(item: BillingBalanceActivity): string | null {
	const match = item.description?.match(SUBJECT);
	return match ? (match[1] ?? match[2] ?? null) : null;
}

function dayKey(date: Date) {
	return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function runKey(item: BillingBalanceActivity) {
	if (item.kind !== "usage" || transferActivityKind(item)) return null;
	return `${item.usageType}|${item.description}|${item.status === "covered" ? "" : "overage"}`;
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
