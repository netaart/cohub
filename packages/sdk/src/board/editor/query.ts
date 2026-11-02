import {
	arrowHitRadius,
	arrowPathBounds,
	type BoardArrowItem,
	type BoardFrame,
	type BoardSceneItem,
	degToRad,
	distanceToArrow,
	frameLabelHitRect,
	HANDLE_HIT_RADIUS,
	type Rect,
	rectContainsPoint,
	parseBoardMediaSource,
	resolveSceneArrow,
	rotatePointAround,
	type SceneItem,
	unionRects,
	type WorldPoint,
	worldPoint,
} from "../model/index.js";
import type { EditorContext } from "./context.js";
import { BOARD_INPUT, isTouchLikePointer } from "./input.js";
import { createSpatialIndex, type SpatialEntry } from "./spatial.js";

const NO_IDS: ReadonlySet<string> = new Set();

function encloses(outer: Rect, inner: Rect): boolean {
	return (
		inner.x >= outer.x &&
		inner.y >= outer.y &&
		inner.x + inner.width <= outer.x + outer.width &&
		inner.y + inner.height <= outer.y + outer.height
	);
}

function distanceToFrame(frame: BoardFrame, point: WorldPoint): number {
	const center = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
	const local = frame.rotation ? rotatePointAround(point, center, -degToRad(frame.rotation)) : point;
	const dx = Math.max(frame.x - local.x, 0, local.x - frame.x - frame.width);
	const dy = Math.max(frame.y - local.y, 0, local.y - frame.y - frame.height);
	return Math.hypot(dx, dy);
}

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

	function boundsOf(item: BoardSceneItem, scene = state.scene): Rect {
		if (item.type === "arrow")
			return arrowPathBounds(resolveSceneArrow(item as SceneItem<BoardArrowItem>, scene), item.style.strokeWidth);
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
			for (const child of state.scene.descendants(id)) if (state.base.items[child]) result.add(child);
		}
		return result;
	}

	function mediaIdsForPath(path: string): ReadonlySet<string> {
		if (!mediaIdsByPath) {
			mediaIdsByPath = new Map();
			for (const item of state.scene.items) {
				if (item.type !== "image" && item.type !== "video" && item.type !== "audio") continue;
				const src = (item.props as { src: string }).src;
				if (parseBoardMediaSource(src)?.kind !== "file") continue;
				const ids = mediaIdsByPath.get(src) ?? new Set<string>();
				ids.add(item.id);
				mediaIdsByPath.set(src, ids);
			}
		}
		return mediaIdsByPath.get(path) ?? NO_IDS;
	}

	function contentBounds(ids?: Iterable<string>, scene = state.scene): Rect | null {
		const list = ids ? [...ids].flatMap((id) => (scene.get(id) ? [scene.get(id) as BoardSceneItem] : [])) : scene.items;
		return unionRects((ctx.document.hasScriptItems ? list.filter((item) => Boolean(state.base.items[item.id])) : list).map((item) => boundsOf(item, scene)));
	}

	function idsInRect(rect: Rect, includeTemporary = false): string[] {
		ensureSpatial();
		const ids = spatial.idsInRect(rect);
		return includeTemporary || !ctx.document.hasScriptItems ? ids : ids.filter((id) => Boolean(state.base.items[id]));
	}

	function frameAt(point: WorldPoint, exclude?: ReadonlySet<string>): BoardSceneItem | null {
		ensureSpatial();
		for (const id of spatial.idsAtPoint(point)) {
			const item = state.scene.get(id);
			if (!state.base.items[id] || item?.type !== "frame" || exclude?.has(id) || !state.scene.shown(id)) continue;
			if (registry.hitTest(item, point)) return item;
		}
		return null;
	}

	function frameAround(rect: Rect, exclude?: ReadonlySet<string>): BoardSceneItem | null {
		const { scene } = state;
		const corners = [rect.x, rect.x + rect.width].flatMap((x) => [rect.y, rect.y + rect.height].map((y) => worldPoint(x, y)));
		let around: BoardSceneItem | null = null;
		for (const id of idsInRect(rect)) {
			const item = scene.get(id);
			if (item?.type !== "frame" || exclude?.has(id) || !encloses(boundsOf(item), rect)) continue;
			if (!corners.every((corner) => registry.hitTest(item, corner))) continue;
			if (!around || scene.indexOf(id) > scene.indexOf(around.id)) around = item;
		}
		return around;
	}

	function enclosedIn(rect: Rect, parent: string | undefined): BoardSceneItem[] {
		const { scene } = state;
		const enclosed: BoardSceneItem[] = [];
		for (const id of idsInRect(rect)) {
			const item = scene.get(id);
			if (item && item.parent === parent && encloses(rect, boundsOf(item))) enclosed.push(item);
		}
		return enclosed.sort((a, b) => scene.indexOf(a.id) - scene.indexOf(b.id));
	}

	function hitsItem(item: BoardSceneItem, point: WorldPoint): boolean {
		if (!state.scene.shown(item.id) && !state.selection.includes(item.id)) return false;
		if (item.type === "arrow") {
			const resolved = resolveSceneArrow(item as SceneItem<BoardArrowItem>, state.scene);
			return distanceToArrow(resolved, point) <= arrowHitRadius(item.style.strokeWidth) / Math.min(1, state.camera.zoom);
		}
		return registry.hitTest(item, point);
	}

	function itemAt(point: WorldPoint, exclude?: ReadonlySet<string>, includeTemporary = false): BoardSceneItem | null {
		ensureSpatial();
		for (const id of spatial.idsAtPoint(point)) {
			const item = state.scene.get(id);
			if (item && (includeTemporary || state.base.items[id]) && !exclude?.has(id) && hitsItem(item, point)) return item;
		}
		return null;
	}

	function pickable(item: BoardSceneItem | undefined, id: string): item is BoardSceneItem {
		return Boolean(item && state.base.items[id] && !isLocked(item) && !(item.type === "frame" && state.scene.children(id).length > 0));
	}

	function pickAt(point: WorldPoint, pointerType = "mouse"): BoardSceneItem | null {
		ensureSpatial();
		for (const id of spatial.idsAtPoint(point)) {
			const item = state.scene.get(id);
			if (pickable(item, id) && hitsItem(item, point)) return item;
		}
		const label = labelItemAt(point);
		if (label?.type === "frame") return label;
		if (!isTouchLikePointer(pointerType)) return null;
		const reach = BOARD_INPUT.touchHitSlop / Math.max(state.camera.zoom, 0.0001);
		let nearest: BoardSceneItem | null = null;
		let best = reach;
		for (const id of spatial.idsInRect({ x: point.x - reach, y: point.y - reach, width: reach * 2, height: reach * 2 })) {
			const item = state.scene.get(id);
			if (!pickable(item, id) || !(state.scene.shown(id) || state.selection.includes(id))) continue;
			const distance =
				item.type === "arrow"
					? distanceToArrow(resolveSceneArrow(item as SceneItem<BoardArrowItem>, state.scene), point) -
						arrowHitRadius(item.style.strokeWidth) / Math.min(1, state.camera.zoom)
					: distanceToFrame(item.frame, point);
			if (distance > 0 && distance < best) {
				nearest = item;
				best = distance;
			}
		}
		return nearest;
	}

	function labelItemAt(point: WorldPoint, frameLabelSize = state.frameLabelSize): BoardSceneItem | null {
		ensureSpatial();
		const { scene, selection, camera } = state;
		const below = spatial.idsInRect({ x: point.x, y: point.y, width: 0, height: frameLabelSize + 12 });
		const nearby = [...spatial.idsAtPoint(point), ...below];
		const candidates = selection.length === 1 ? [...selection, ...nearby] : nearby;
		for (const id of new Set(candidates)) {
			const item = scene.get(id);
			if (!item || !state.base.items[id] || isLocked(item) || !scene.shown(id)) continue;
			if (
				item.type === "frame" &&
				rectContainsPoint(frameLabelHitRect(item.frame, frameLabelSize), point)
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
		frameAround,
		enclosedIn,
		itemAt,
		pickAt,
		labelItemAt,
		arrowHandleAt,
		connectTargetAt,
	};
}

export type QueryModule = ReturnType<typeof createQueryModule>;
