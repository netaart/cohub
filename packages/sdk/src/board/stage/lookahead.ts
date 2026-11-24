import type { BoardItem } from "@cohub/protocol/board-model";
import { MEDIA_VARIANT_MAX } from "../../media.js";
import { type BoardSceneItem, boardTextureEdge, scaleVector } from "../model/index.js";
import type { BoardPlayerFrame } from "../player/index.js";
import type { BoardAssetPrefetch } from "./assets.js";

const SHOWN_OPACITY = 0.01;

function extent(item: BoardItem): { width: number; height: number } {
	const scale = scaleVector(item.scale);
	const size = "size" in item ? item.size : undefined;
	return { width: (size?.width ?? 0) * Math.abs(scale.x), height: (size?.height ?? 0) * Math.abs(scale.y) };
}

export function boardLookaheadPrefetch(
	frames: readonly BoardPlayerFrame[],
	shown: (id: string) => BoardSceneItem | undefined,
	scaleAt: (frame: BoardPlayerFrame) => number,
): BoardAssetPrefetch[] {
	const wanted = new Map<string, BoardAssetPrefetch>();
	for (const frame of frames) {
		const scale = scaleAt(frame);
		for (const [id, item] of frame.items) {
			const now = shown(id);
			if (!now || (item.opacity ?? 1) < SHOWN_OPACITY) continue;
			const from = extent(now);
			const to = extent(item);
			const parent = from.width > 0 ? now.frame.width / from.width : from.height > 0 ? now.frame.height / from.height : 1;
			const ahead = { ...now, ...item, id, frame: { ...now.frame, width: to.width * parent, height: to.height * parent } } as BoardSceneItem;
			const edge = Math.min(boardTextureEdge(ahead, scale), MEDIA_VARIANT_MAX);
			const known = wanted.get(id);
			if (!known || known.edge < edge) wanted.set(id, { item: ahead, edge });
		}
	}
	return [...wanted.values()];
}
