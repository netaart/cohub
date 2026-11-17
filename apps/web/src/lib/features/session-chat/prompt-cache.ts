import type { Usage } from "@cohub/protocol/core";
import { isAgentTurn, type SessionTurnIndexItem } from "@cohub/protocol/model";
import type { ModelCatalogItem } from "#lib/model-catalog.ts";
import { resolveTurnHarness } from "./session-utils.ts";

/**
 * Production data: cold resends of at least $1 carry ~85% of expired-cache
 * spend, while cheaper models rarely reach it and stay quiet.
 */
export const COLD_RESEND_NOTICE_USD = 1;

const SETTLED_STATUSES = new Set(["completed", "failed", "interrupted"]);

type CacheTurn = Pick<
	SessionTurnIndexItem,
	"id" | "sequence" | "status" | "completedAt" | "provider" | "model"
> & {
	executionKind?: SessionTurnIndexItem["executionKind"];
	intent?: SessionTurnIndexItem["intent"];
	finalUsage?: Usage | null;
	meta?: Record<string, unknown> | null;
};

export type ColdResend = {
	/** The settled Turn whose cached prefix this estimate is about. */
	turnId: string;
	/** When the prefix leaves the provider cache; `0` when it is already gone. */
	expiresAt: number;
	contextTokens: number;
	cost: number;
};

function modelNumber(record: unknown, key: string): number | null {
	const value =
		record && typeof record === "object"
			? (record as Record<string, unknown>)[key]
			: undefined;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: null;
}

/**
 * Estimates what the next message re-sends once the provider cache is cold.
 * Returns null unless the resend is expensive enough to be worth a notice.
 */
export function estimateColdResend(
	turns: CacheTurn[],
	selected: { provider: string; id: string } | null,
	catalog: ModelCatalogItem[] | null | undefined,
): ColdResend | null {
	if (!selected) return null;
	const last = turns
		.filter(
			(turn) =>
				isAgentTurn(turn) &&
				turn.intent !== "compact" &&
				resolveTurnHarness(turn) === "cohub",
		)
		.reduce<CacheTurn | null>(
			(latest, turn) =>
				!latest || turn.sequence > latest.sequence ? turn : latest,
			null,
		);
	if (!last || !SETTLED_STATUSES.has(last.status) || !last.completedAt)
		return null;
	const usage = last.finalUsage;
	const contextTokens =
		(usage?.input ?? 0) +
		(usage?.cacheRead ?? 0) +
		(usage?.cacheWrite ?? 0) +
		(usage?.output ?? 0);
	if (contextTokens <= 0) return null;

	const item = catalog?.find(
		(entry) => entry.provider === selected.provider && entry.id === selected.id,
	);
	const price =
		modelNumber(item?.model.cost, "cacheWrite") ??
		modelNumber(item?.model.cost, "input");
	if (!price) return null;
	const cost = (contextTokens * price) / 1_000_000;
	if (cost < COLD_RESEND_NOTICE_USD) return null;

	const completedAt = Date.parse(last.completedAt);
	if (!Number.isFinite(completedAt)) return null;
	const sameModel =
		(last.provider ?? "cohub") === selected.provider &&
		last.model === selected.id;
	let expiresAt = 0;
	if (sameModel) {
		// Without a measured lifetime the cache state is unknown: stay quiet.
		const ttlSeconds = modelNumber(item?.model.promptCache, "short");
		if (!ttlSeconds) return null;
		expiresAt = completedAt + ttlSeconds * 1000;
	}
	return { turnId: last.id, expiresAt, contextTokens, cost };
}
