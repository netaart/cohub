import type { BoardHistoryInput, BoardHistoryPage } from "@neta-art/cohub";
import {
	type BoardDocument,
	type BoardReplayEntry,
	type BoardReplayPlayer,
	createBoardReplayPlayer,
} from "@neta-art/cohub/board";

export type BoardReplaySpeed = 1 | 2 | 4;
export const BOARD_REPLAY_SPEEDS: readonly BoardReplaySpeed[] = [1, 2, 4];

export const BOARD_REPLAY_STEP_MS = 640;
export const BOARD_REPLAY_PAGE_SIZE = 200;

export type BoardReplayFetch = (input: BoardHistoryInput) => Promise<BoardHistoryPage>;

function lowerBound(
	entries: readonly BoardReplayEntry[],
	target: number,
): number {
	let low = 0;
	let high = entries.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if ((entries[mid] as BoardReplayEntry).version < target) low = mid + 1;
		else high = mid;
	}
	return low;
}

export function replayStep(
	entries: readonly BoardReplayEntry[],
	floor: number,
	version: number,
): number {
	if (version <= floor) return 0;
	const index = lowerBound(entries, version);
	return index < entries.length ? index + 1 : entries.length;
}

export function replayFraction(
	entries: readonly BoardReplayEntry[],
	floor: number,
	version: number,
): number {
	return entries.length === 0
		? 1
		: replayStep(entries, floor, version) / entries.length;
}

export function replayVersionAt(
	entries: readonly BoardReplayEntry[],
	floor: number,
	fraction: number,
): number {
	if (entries.length === 0) return floor;
	const clamped = Math.max(0, Math.min(1, fraction));
	const position = Math.round(clamped * entries.length);
	if (position <= 0) return floor;
	return entries[Math.min(position, entries.length) - 1]?.version ?? floor;
}

export function replayEntryAt(
	entries: readonly BoardReplayEntry[],
	version: number,
): BoardReplayEntry | null {
	const entry = entries[lowerBound(entries, version)];
	return entry?.version === version ? entry : null;
}

export function replayPreviousVersion(
	entries: readonly BoardReplayEntry[],
	floor: number,
	version: number,
): number {
	return entries[lowerBound(entries, version) - 1]?.version ?? floor;
}

export function replayNextVersion(
	entries: readonly BoardReplayEntry[],
	version: number,
): number {
	return entries[lowerBound(entries, version + 1)]?.version ?? version;
}

export type BoardReplayDocumentFetch = () => Promise<{ version: number; document: BoardDocument }>;

export async function loadBoardReplay(
	fetchHistory: BoardReplayFetch,
	fetchDocument: BoardReplayDocumentFetch,
): Promise<{ player: BoardReplayPlayer; nextBefore: number | null }> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const [page, live] = await Promise.all([fetchHistory({ limit: BOARD_REPLAY_PAGE_SIZE }), fetchDocument()]);
		if (page.version === live.version) return { player: createBoardReplayPlayer(live.document, page), nextBefore: page.nextBefore };
	}
	throw new Error("The Board kept changing while its history loaded.");
}
