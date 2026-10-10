import {
	arrowHitRadius,
	arrowPathBounds,
	type BoardArrowItem,
	type BoardSceneItem,
	distanceToArrow,
	HANDLE_HIT_RADIUS,
	type Rect,
	rectContainsPoint,
	resolveSceneArrow,
	type SceneItem,
	unionRects,
	type WorldPoint,
} from "../model/index.js";
import type { EditorContext } from "./context.js";
import { createSpatialIndex, type SpatialEntry } from "./spatial.js";

const NO_IDS: ReadonlySet<string> = new Set();

export function createQueryModule(ctx: EditorContext) {
	const { state, registry } = ctx;
	const spatial = createSpatialIndex();
	let indexedScene: typeof state.scene | null = null;
	let spatialDirty: Set<string> | null = null;
	let mediaIdsByPath: Map<string, Set<string>> | null = null;

	function invalidate(ids?: readonly string[]) {
		if (!ids) {
			spatialDirty = null;
			mediaIdsByPath = null;
			return;
		}
		if (!spatialDirty) return;
		const scene = state.scene;
		const affected = new Set<string>();
		const pending = [...ids];
		while (pending.length) {
			const id = pending.pop() as string;
			if (affected.has(id)) continue;
			affected.add(id);
			spatialDirty.add(id);
			pending.push(...scene.children(id), ...scene.binders(id));
		}
	}

	function ensureSpatial() {
		const scene = state.scene;
		if (indexedScene === scene) return;
		const dirty = indexedScene ? spatialDirty : null;
		indexedScene = scene;
		spatialDirty = new Set();
		if (dirty === null) {
			const entries: SpatialEntry[] = scene.items.map((item, order) => ({
				id: item.id,
				order,
				rect: boundsOf(item),
			}));
			spatial.rebuild(entries);
			return;
		}
		const upserts = new Map<string, SpatialEntry | null>();
		for (const id of dirty) {
			const item = scene.get(id);
			upserts.set(id, item ? { id, order: scene.indexOf(id), rect: boundsOf(item) } : null);
		}
		spatial.upsert(upserts);
	}

	function boundsOf(item: BoardSceneItem): Rect {
		if (item.type === "arrow")
			return arrowPathBounds(resolveSceneArrow(item as SceneItem<BoardArrowItem>, state.scene), item.style.strokeWidth);
		return registry.bounds(item);
	}

	function itemById(id: string): BoardSceneItem | null {
		return state.scene.get(id) ?? null;
	}

	function isLocked(item: { locked?: boolean }): boolean {
		return item.locked === true;
	}

	function unlockedIds(ids: Iterable<string>): string[] {
		const result: string[] = [];
		for (const id of ids) {
			const item = state.scene.get(id);
			if (item && !isLocked(item)) result.push(id);
		}
		return result;
	}

	function rootsOf(ids: Iterable<string>): string[] {
		const scene = state.scene;
		const set = new Set(ids);
		return [...set].filter((id) => {
			let cursor = scene.get(id)?.parent;
			for (let depth = 0; cursor && depth < 64; depth += 1) {
				if (set.has(cursor)) return false;
				cursor = scene.get(cursor)?.parent;
			}
			return true;
		});
	}

	function withSubtrees(ids: Iterable<string>): Set<string> {
		const result = new Set<string>();
		for (const id of ids) {
			result.add(id);
			for (const child of state.scene.descendants(id)) result.add(child);
		}
		return result;
	}

	function mediaIdsForPath(path: string): ReadonlySet<string> {
		if (!mediaIdsByPath) {
			mediaIdsByPath = new Map();
			for (const item of state.scene.items) {
				if (item.type !== "image" && item.type !== "video" && item.type !== "audio") continue;
				const src = (item.props as { src: string }).src;
				const ids = mediaIdsByPath.get(src) ?? new Set<string>();
				ids.add(item.id);
				mediaIdsByPath.set(src, ids);
			}
		}
		return mediaIdsByPath.get(path) ?? NO_IDS;
	}

	function contentBounds(ids?: Iterable<string>): Rect | null {
		const scene = state.scene;
		const list = ids ? [...ids].flatMap((id) => (scene.get(id) ? [scene.get(id) as BoardSceneItem] : [])) : scene.items;
		return unionRects(list.map(boundsOf));
	}

	function idsInRect(rect: Rect): string[] {
		ensureSpatial();
		return spatial.idsInRect(rect);
	}

	function frameAt(point: WorldPoint, exclude?: ReadonlySet<string>): BoardSceneItem | null {
		ensureSpatial();
		for (const id of spatial.idsAtPoint(point)) {
			const item = state.scene.get(id);
			if (item?.type !== "frame" || exclude?.has(id)) continue;
			if (registry.hitTest(item, point)) return item;
		}
		return null;
	}

	function hitsItem(item: BoardSceneItem, point: WorldPoint): boolean {
		if (item.type === "arrow") {
			const resolved = resolveSceneArrow(item as SceneItem<BoardArrowItem>, state.scene);
			return distanceToArrow(resolved, point) <= arrowHitRadius(item.style.strokeWidth) / Math.min(1, state.camera.zoom);
		}
		return registry.hitTest(item, point);
	}

	function itemAt(point: WorldPoint, exclude?: ReadonlySet<string>): BoardSceneItem | null {
		ensureSpatial();
		for (const id of spatial.idsAtPoint(point)) {
			const item = state.scene.get(id);
			if (item && !exclude?.has(id) && hitsItem(item, point)) return item;
		}
		return null;
	}

	function labelItemAt(point: WorldPoint): BoardSceneItem | null {
		ensureSpatial();
		const { scene, selection, camera } = state;
		const nearby = spatial.idsAtPoint(point);
		const candidates = selection.length === 1 ? [...selection, ...nearby] : nearby;
		for (const id of new Set(candidates)) {
			const item = scene.get(id);
			if (!item || isLocked(item)) continue;
			if (
				item.type === "frame" &&
				rectContainsPoint(
					{ x: item.frame.x, y: item.frame.y - 22, width: Math.max(48, item.frame.width * 0.5), height: 24 },
					point,
				)
			)
				return item;
			if (item.type === "arrow") {
				const resolved = resolveSceneArrow(item as SceneItem<BoardArrowItem>, scene);
				const radius = Math.max(10, (item.props.fontSize ?? 14) * 0.9) / Math.min(1, camera.zoom);
				if (Math.hypot(resolved.mid.x - point.x, resolved.mid.y - point.y) <= radius) return item;
			}
		}
		return null;
	}

	function arrowHandleAt(point: WorldPoint): "start" | "end" | "mid" | null {
		if (state.selection.length !== 1) return null;
		const item = state.scene.get(state.selection[0] as string);
		if (item?.type !== "arrow" || isLocked(item)) return null;
		const resolved = resolveSceneArrow(item as SceneItem<BoardArrowItem>, state.scene);
		const radius = (HANDLE_HIT_RADIUS + 2) / state.camera.zoom;
		const distance = (target: WorldPoint) => Math.hypot(target.x - point.x, target.y - point.y);
		const start = distance(resolved.start.point);
		const end = distance(resolved.end.point);
		const mid = distance(resolved.mid);
		if (start <= radius && start <= end && start <= mid) return "start";
		if (end <= radius && end <= mid) return "end";
		if (mid <= radius) return "mid";
		return null;
	}

	function connectTargetAt(point: WorldPoint, exclude: ReadonlySet<string> = NO_IDS): string | null {
		const item = itemAt(point, exclude);
		if (!item || isLocked(item) || item.type === "arrow") return null;
		return registry.capabilities(item).canConnect ? item.id : null;
	}

	return {
		invalidate,
		boundsOf,
		itemById,
		isLocked,
		unlockedIds,
		rootsOf,
		withSubtrees,
		mediaIdsForPath,
		contentBounds,
		idsInRect,
		frameAt,
		itemAt,
		labelItemAt,
		arrowHandleAt,
		connectTargetAt,
	};
}

export type QueryModule = ReturnType<typeof createQueryModule>;
