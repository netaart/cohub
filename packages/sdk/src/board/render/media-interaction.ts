import type { BoardSceneItem, } from "../model/scene.js";
import type { WorldPoint } from "../model/geometry.js";
import { featuredTaskArtifact } from "../model/task.js";
import { TASK_CARD_FULL_DETAIL_ZOOM } from "./renderers/task-card-renderer.js";

export type BoardMediaAction = {
	action: "play-media";
	itemId: string;
};

export function mediaPlayBadgeVisible(
	item: BoardSceneItem,
	zoom: number,
	options: { materialized: boolean; hasVideoPreview: boolean },
): boolean {
	if (!options.materialized) return false;
	if (item.type === "video" || item.type === "audio") return true;
	if (item.type !== "task" || zoom < TASK_CARD_FULL_DETAIL_ZOOM) return false;
	const artifact = featuredTaskArtifact(item.props.snapshot.artifacts);
	if (artifact?.type === "audio") return true;
	return artifact?.type === "video" &&
		(Boolean(artifact.previewUrl) || options.hasVideoPreview);
}

export function mediaPlayBadgeHit(
	item: BoardSceneItem,
	point: WorldPoint,
	zoom: number,
): boolean {
	const radius = 28 / Math.max(zoom, 0.05);
	const centerX = item.frame.x + item.frame.width / 2;
	const centerY = item.frame.y + item.frame.height / 2;
	return Math.hypot(point.x - centerX, point.y - centerY) <= radius;
}

export function boardMediaActionAt(
	item: BoardSceneItem,
	point: WorldPoint,
	zoom: number,
	options: { materialized: boolean; hasVideoPreview: boolean },
): BoardMediaAction | null {
	return mediaPlayBadgeVisible(item, zoom, options) &&
		mediaPlayBadgeHit(item, point, zoom)
		? { action: "play-media", itemId: item.id }
		: null;
}
