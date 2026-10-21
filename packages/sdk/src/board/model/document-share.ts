import type { BoardDocument } from "@cohub/protocol/board-model";
import { sameJson } from "./json.js";

function shareRecord<T>(previous: Record<string, T>, next: Record<string, T>): Record<string, T> {
	let same = Object.keys(previous).length === Object.keys(next).length;
	const shared: Record<string, T> = {};
	for (const [id, value] of Object.entries(next)) {
		const current = previous[id];
		const kept = current !== undefined && sameJson(current, value) ? current : value;
		if (kept !== current) same = false;
		shared[id] = kept;
	}
	return same ? previous : shared;
}

export function shareBoardDocument(previous: BoardDocument | null, next: BoardDocument): BoardDocument {
	if (!previous) return next;
	const board = sameJson(previous.board, next.board) ? previous.board : next.board;
	const items = shareRecord(previous.items, next.items);
	const animations = shareRecord(previous.animations, next.animations);
	if (board === previous.board && items === previous.items && animations === previous.animations) return previous;
	return { board, items, animations };
}
