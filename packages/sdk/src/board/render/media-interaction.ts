import { isBoardModelItem } from "../model/media.js";
import type { BoardSceneItem } from "../model/scene.js";
import { degToRad, rotatePointAround, type WorldPoint, worldPoint } from "../model/geometry.js";
import { audioKeyCenter } from "./renderers/audio-card-renderer.js";
import { modelKeyCenter } from "./renderers/model-card-renderer.js";
import { featuredTaskArtifact } from "@cohub/protocol";
import { boardCardDetailed } from "./lod.js";
import type { BoardCardHit, BoardRenderContext } from "./renderers/board-renderer-registry.js";

export const BOARD_PLAY_MEDIA = "play-media";

export type BoardMediaAction = {
	action: typeof BOARD_PLAY_MEDIA;
	itemId: string;
};

export function mediaPlayBadgeVisible(
	item: BoardSceneItem,
	zoom: number,
	options: { materialized: boolean; hasVideoPreview: boolean },
): boolean {
	if (!options.materialized) return false;
	if (item.type === "video" || item.type === "audio") return true;
	if (isBoardModelItem(item)) return boardCardDetailed(zoom);
	if (item.type !== "task" || !boardCardDetailed(zoom)) return false;
	const artifact = featuredTaskArtifact(item.props.snapshot.artifacts);
	if (artifact?.type === "audio") return true;
	return artifact?.type === "video" &&
		(Boolean(artifact.previewUrl) || options.hasVideoPreview);
}

function cornerKey(item: BoardSceneItem) {
	const { width, height } = item.frame;
	if (item.type === "audio") return audioKeyCenter(width, height);
	return isBoardModelItem(item) ? modelKeyCenter(width, height) : null;
}

export function mediaPlayKeyCenter(item: BoardSceneItem): WorldPoint {
	const { x, y, width, height, rotation } = item.frame;
	const center = worldPoint(x + width / 2, y + height / 2);
	const key = cornerKey(item);
	if (!key) return center;
	return rotatePointAround(worldPoint(x + key.x, y + key.y), center, degToRad(rotation || 0));
}

export function mediaPlayBadgeHit(
	item: BoardSceneItem,
	point: WorldPoint,
	zoom: number,
): boolean {
	const scale = Math.max(zoom, 0.05);
	const radius = isBoardModelItem(item)
		? Math.max(cornerKey(item)?.radius ?? 0, 16 / scale)
		: 28 / scale;
	const center = mediaPlayKeyCenter(item);
	return Math.hypot(point.x - center.x, point.y - center.y) <= radius;
}

export function boardMediaActionAt(
	item: BoardSceneItem,
	point: WorldPoint,
	zoom: number,
	options: { materialized: boolean; hasVideoPreview: boolean },
): BoardMediaAction | null {
	return mediaPlayBadgeVisible(item, zoom, options) &&
		mediaPlayBadgeHit(item, point, zoom)
		? { action: BOARD_PLAY_MEDIA, itemId: item.id }
		: null;
}

const PLAY_HIT: BoardCardHit = { action: BOARD_PLAY_MEDIA, cursor: "pointer" };

export function mediaPlayHit(item: BoardSceneItem, point: WorldPoint, context: BoardRenderContext): BoardCardHit | null {
	const key = context.assetKey(item);
	const action = boardMediaActionAt(item, point, context.zoom, {
		materialized: true,
		hasVideoPreview: Boolean(key && context.getTexture(key)),
	});
	return action ? PLAY_HIT : null;
}
