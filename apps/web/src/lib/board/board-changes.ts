import type { BoardHistoryPage, RequestSource } from "@cohub/protocol";

export function isExternalBoardWrite(
	source: RequestSource | null | undefined,
): boolean {
	if (!source) return false;
	if (source.toolCallId) return true;
	return source.via === "cli";
}

const STORAGE_PREFIX = "cohub:board:seen";

function storageKey(userKey: string, spaceId: string, boardId: string) {
	return `${STORAGE_PREFIX}:${encodeURIComponent(userKey)}:${spaceId}:${boardId}`;
}

export function readBoardSeenVersion(
	userKey: string,
	spaceId: string,
	boardId: string,
): number | null {
	if (typeof localStorage === "undefined") return null;
	try {
		const raw = localStorage.getItem(storageKey(userKey, spaceId, boardId));
		const parsed = raw ? Number(raw) : Number.NaN;
		return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
	} catch {
		return null;
	}
}

export function writeBoardSeenVersion(
	userKey: string,
	spaceId: string,
	boardId: string,
	version: number,
) {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(
			storageKey(userKey, spaceId, boardId),
			String(Math.max(0, Math.floor(version))),
		);
	} catch {}
}

export type BoardChangeHistoryFetch = (input: {
	before?: number;
	limit?: number;
}) => Promise<BoardHistoryPage>;

export function externalChangedIds(
	transactions: readonly BoardHistoryPage["transactions"][number][],
	sinceVersion: number,
): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const transaction of transactions) {
		if (transaction.version <= sinceVersion) continue;
		if (!isExternalBoardWrite(transaction.source)) continue;
		for (const id of Object.keys(transaction.after?.items ?? {})) {
			if (seen.has(id)) continue;
			seen.add(id);
			ids.push(id);
		}
	}
	return ids;
}

const CHANGE_HISTORY_MAX_PAGES = 5;

export type BoardChangeHistoryResult = {
	ids: string[];
	latestVersion: number;
};

export async function fetchBoardChangeIds(
	fetchHistory: BoardChangeHistoryFetch,
	sinceVersion: number,
	limit = 60,
): Promise<BoardChangeHistoryResult> {
	const seen = new Set<string>();
	let latestVersion = sinceVersion;
	let before: number | undefined;
	for (let page = 0; page < CHANGE_HISTORY_MAX_PAGES; page += 1) {
		const result = await fetchHistory({ limit, ...(before ? { before } : {}) });
		latestVersion = Math.max(latestVersion, result.version);
		for (const id of externalChangedIds(result.transactions, sinceVersion)) {
			seen.add(id);
		}
		const oldest = result.transactions[result.transactions.length - 1];
		if (!result.nextBefore || (oldest && oldest.version <= sinceVersion)) break;
		before = result.nextBefore;
	}
	return { ids: [...seen], latestVersion };
}
