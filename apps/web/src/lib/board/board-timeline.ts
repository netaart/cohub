import type { BoardAnimation, BoardDocument } from "@cohub/protocol";
import {
	type BoardSceneItem,
	boardTargetSpan,
	type WorldPoint,
	worldPoint,
} from "@neta-art/cohub/board";

export function boardTimelineLanding(
	document: BoardDocument,
	animation: BoardAnimation,
	items: readonly BoardSceneItem[],
	at: number,
): WorldPoint | null {
	let frame: BoardSceneItem | null = null;
	let shown: BoardSceneItem | null = null;
	let before: { item: BoardSceneItem; end: number } | null = null;
	for (const item of items) {
		if (item.parent) continue;
		const span = boardTargetSpan(document, animation, item.id);
		if (!span) continue;
		if (span.start <= at && at < span.end) {
			if (item.type === "frame") frame = item;
			else shown = item;
		} else if (span.end <= at && (!before || span.end >= before.end))
			before = { item, end: span.end };
	}
	const target = frame ?? shown ?? before?.item;
	return target
		? worldPoint(
				target.frame.x + target.frame.width / 2,
				target.frame.y + target.frame.height / 2,
			)
		: null;
}
