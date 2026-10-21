import type {
	BoardDrawItem,
	BoardDrawPoint,
	BoardSceneItem as BoardItem,
	BoardScene as BoardModelScene,
	SceneItem,
} from "../model/index.js";
import { drawPointsBounds, parseBoardItem } from "../model/index.js";
import type {
	BoardCardRenderer,
	BoardCardRendererResolver,
	BoardRenderContext,
} from "../render/index.js";
import {
	type ClipGroup,
	clippingAncestor,
	isClippingFrame,
	syncClipGroup,
} from "../render/index.js";
import { textZoomBucket } from "../render/text-resolution.js";
import { type Container, Graphics } from "pixi.js";

type CardEntry = {
	item: BoardItem;
	container: Container;
	renderer: BoardCardRenderer;
	selected: boolean;
	hovered: boolean;
	resizing: boolean;
	globalSig: string;
	scriptRevision: number;
};

const FAR_LAYER_ENTER = 450;
const FAR_LAYER_EXIT = 350;
const FAR_PASS_BATCH = 240;
const FAR_LIVE_LIMIT = 64;
const RESOLUTION_BATCH = 32;
const Z_FAR_LAYER = -1;
const Z_LIFTED = 1e9;
const Z_LIVE_STROKE = Number.MAX_SAFE_INTEGER - 1;
const Z_OVERLAY = Number.MAX_SAFE_INTEGER;

const POOL_LIMIT_PER_RENDERER = 48;
const EMPTY_IDS: ReadonlySet<string> = new Set();

function idSetSignature(ids: Set<string>): number {
	let hash = ids.size;
	for (const id of ids) {
		let local = 0;
		for (let i = 0; i < id.length; i += 1) {
			local = (local * 31 + id.charCodeAt(i)) | 0;
		}
		hash ^= local;
	}
	return hash;
}

export type BoardLiveStroke = {
	id: string;
	points: BoardDrawPoint[];
	color: string;
	size: number;
};

export type SceneSyncInput = {
	items: readonly BoardItem[];
	strokes: readonly BoardLiveStroke[];
	scene: BoardModelScene;
	context: BoardRenderContext;
	getItem: (id: string) => BoardItem | null;
	visibleIds: Set<string> | null;
	pinnedIds: Set<string>;
	globalSig: string;
	staleIds?: ReadonlySet<string>;
	structureVersion: number;
	geometryVersion: number;
	gestureActive: boolean;
	focus?: { x: number; y: number };
};

export type BoardSceneNode = {
	item: BoardItem;
	container: Container;
};

export type BoardScene = {
	sync: (input: SceneSyncInput) => void;
	getNode: (itemId: string) => BoardSceneNode | null;
	holders: (key: string) => ReadonlySet<string>;
	readonly liveVersion: number;
	liveIds: () => ReadonlySet<string>;
	readonly animated: boolean;
	tick: (clock: number) => number | null;
	destroy: (context: BoardRenderContext) => void;
};

export function createBoardScene(options: {
	world: Container;
	overlay: Graphics;
	getRenderer: BoardCardRendererResolver;
	requestFrame?: () => void;
}): BoardScene {
	const { world, overlay, getRenderer } = options;
	world.sortableChildren = true;
	overlay.zIndex = Z_OVERLAY;
	const cards = new Map<string, CardEntry>();
	const clips = new Map<string, ClipGroup>();
	const animatedIds = new Set<string>();
	const tickingIds = new Set<string>();
	const pools = new Map<string, Container[]>();
	const heldKeys = new Map<string, string>();
	const holders = new Map<string, Set<string>>();
	let orderById = new Map<string, number>();
	let farSig: string | null = null;
	let farActive = false;
	let lastStructureVersion = -1;
	let lastZoom = Number.NaN;
	let lastResolution = "";
	const pendingResolution = new Set<string>();
	let liveVersion = 0;
	let lifted: ReadonlySet<string> = new Set();
	const liveStrokes = new Map<
		string,
		{
			container: Container;
			renderer: BoardCardRenderer;
			template: BoardDrawItem;
		}
	>();
	function setHeldKey(
		context: BoardRenderContext,
		cardId: string,
		item: BoardItem | null,
	) {
		const desiredKey = item ? context.assetKey(item) : null;
		const heldKey = heldKeys.get(cardId) ?? null;
		if (desiredKey === heldKey) return;
		if (heldKey) {
			context.releaseTexture(heldKey);
			const ids = holders.get(heldKey);
			ids?.delete(cardId);
			if (ids?.size === 0) holders.delete(heldKey);
		}
		if (desiredKey && item) {
			heldKeys.set(cardId, desiredKey);
			const ids = holders.get(desiredKey);
			if (ids) ids.add(cardId);
			else holders.set(desiredKey, new Set([cardId]));
			context.acquireTexture(desiredKey, item);
		} else heldKeys.delete(cardId);
	}

	function takeFromPool(rendererId: string): Container | null {
		const pool = pools.get(rendererId);
		if (!pool || pool.length === 0) return null;
		return pool.pop() ?? null;
	}

	function recycle(
		id: string,
		entry: CardEntry,
		context: BoardRenderContext,
		destroyed: boolean,
	) {
		setHeldKey(context, id, null);
		cards.delete(id);
		pendingResolution.delete(id);
		animatedIds.delete(id);
		tickingIds.delete(id);
		if (destroyed) return;
		entry.container.parent?.removeChild(entry.container);
		entry.container.visible = false;
		const pool = pools.get(entry.renderer.id) ?? [];
		if (pool.length >= POOL_LIMIT_PER_RENDERER) {
			entry.renderer.destroy?.(entry.container, context);
			return;
		}
		pool.push(entry.container);
		pools.set(entry.renderer.id, pool);
	}

	function hostFor(item: BoardItem, scene: BoardModelScene): Container {
		const clipId = clippingAncestor(scene, item);
		const frame = clipId ? scene.get(clipId) : undefined;
		if (!clipId || !frame) return world;
		let entry = clips.get(clipId);
		if (!entry) {
			entry = syncClipGroup(undefined, frame);
			entry.group.sortableChildren = true;
			clips.set(clipId, entry);
		}
		const parent = hostFor(frame, scene);
		if (entry.group.parent !== parent) parent.addChild(entry.group);
		entry.group.zIndex = (orderById.get(clipId) ?? 0) + 0.5;
		return entry.group;
	}

	function syncClips(scene: BoardModelScene) {
		for (const entry of cards.values()) {
			const host = hostFor(entry.item, scene);
			if (entry.container.parent !== host) host.addChild(entry.container);
		}
		for (const [id, entry] of clips) {
			const frame = scene.get(id);
			if (
				!frame ||
				!isClippingFrame(frame) ||
				entry.group.children.length <= 1
			) {
				for (const child of [...entry.group.children])
					if (child !== entry.mask) world.addChild(child);
				entry.group.destroy({ children: true });
				clips.delete(id);
				continue;
			}
			syncClipGroup(entry, frame);
		}
	}

	function materialize(
		item: BoardItem,
		context: BoardRenderContext,
		globalSig: string,
		scene: BoardModelScene,
	): CardEntry {
		const renderer = getRenderer(item, context);
		const pooled = takeFromPool(renderer.id);
		const container = pooled ?? renderer.create(item, context);
		container.visible = true;
		if (pooled) renderer.update(container, item, context);
		container.alpha = scene.opacity(item.id);
		hostFor(item, scene).addChild(container);
		if (renderer.animated) animatedIds.add(item.id);
		if (renderer.tick) tickingIds.add(item.id);
		const entry: CardEntry = {
			item,
			container,
			renderer,
			selected: context.selectedIds.has(item.id),
			hovered: context.hoveredId === item.id,
			resizing: context.resizingIds.has(item.id),
			globalSig,
			scriptRevision: context.scripts?.revision?.(item.id) ?? 0,
		};
		cards.set(item.id, entry);
		setHeldKey(context, item.id, item);
		renderer.zoom?.(container, context.zoom);
		return entry;
	}

	// Double-buffered: a pass paints the hidden layer, then swaps it in.
	let farFront = createFarLayer();
	let farBack = createFarLayer();
	let farPainted = false;
	let farCovered: ReadonlySet<string> = new Set();
	let farInput: SceneSyncInput | null = null;
	let farRunning = false;
	let farQueued = false;
	let farFrame = 0;

	function createFarLayer() {
		const layer = new Graphics({ label: "board-far-layer" });
		layer.zIndex = Z_FAR_LAYER;
		layer.visible = false;
		world.addChild(layer);
		return layer;
	}

	function requestFarPass(signature: string) {
		farSig = signature;
		if (farRunning) farQueued = true;
		else runFarPass();
	}

	function runFarPass() {
		if (!farInput) return;
		farRunning = true;
		farQueued = false;
		const { context, getItem, pinnedIds } = farInput;
		const ids = visibleFacts(farInput).orderedIds;
		const target = farPainted ? farBack : farFront;
		const painted = new Set<string>();
		target.clear();
		if (target === farFront) farCovered = painted;
		let index = 0;
		const step = () => {
			farFrame = 0;
			const end = Math.min(ids.length, index + FAR_PASS_BATCH);
			for (; index < end; index += 1) {
				const id = ids[index] as string;
				if (pinnedIds.has(id)) continue;
				const item = getItem(id);
				if (!item) continue;
				getRenderer(item, context).renderFar?.(target, item, context);
				painted.add(id);
			}
			if (index < ids.length) {
				farFrame = requestAnimationFrame(step);
				if (target === farFront) options.requestFrame?.();
				return;
			}
			if (target === farBack) {
				farBack = farFront;
				farFront = target;
				farBack.visible = false;
				farBack.clear();
				farCovered = painted;
			}
			farFront.visible = farActive;
			farPainted = true;
			farRunning = false;
			options.requestFrame?.();
			if (farQueued) runFarPass();
		};
		step();
	}

	function resetFarLayer() {
		cancelAnimationFrame(farFrame);
		farFrame = 0;
		farRunning = false;
		farQueued = false;
		farInput = null;
		farPainted = false;
		farCovered = new Set();
		farSig = null;
		farFront.clear();
		farBack.clear();
	}

	function syncLiveStrokes(input: SceneSyncInput) {
		const { strokes, context, getItem } = input;
		const live = new Set<string>();
		for (const stroke of strokes) {
			if (stroke.points.length === 0 || getItem(stroke.id)) continue;
			let entry = liveStrokes.get(stroke.id);
			if (
				entry &&
				(entry.template.style.stroke !== stroke.color ||
					entry.template.style.strokeWidth !== stroke.size)
			) {
				removeLiveStroke(stroke.id, context);
				entry = undefined;
			}
			const item = entry
				? liveStrokeItem(stroke, entry.template)
				: createLiveStroke(stroke, input);
			if (!item) continue;
			live.add(stroke.id);
			entry = liveStrokes.get(stroke.id);
			entry?.renderer.update(entry.container, item, context);
		}
		for (const id of liveStrokes.keys()) {
			if (!live.has(id)) removeLiveStroke(id, context);
		}
	}

	function liveStrokeItem(
		stroke: BoardLiveStroke,
		template: BoardDrawItem,
	): SceneItem<BoardDrawItem> {
		return {
			...template,
			id: stroke.id,
			props: { points: stroke.points },
			frame: { ...drawPointsBounds(stroke.points, stroke.size), rotation: 0 },
		};
	}

	function createLiveStroke(
		stroke: BoardLiveStroke,
		input: SceneSyncInput,
	): SceneItem<BoardDrawItem> | null {
		const parsed = parseBoardItem({
			type: "draw",
			style: { stroke: stroke.color, strokeWidth: stroke.size },
			props: { points: stroke.points.slice(0, 1) },
		});
		if (!parsed.ok || parsed.item.type !== "draw") return null;
		const template = parsed.item as BoardDrawItem;
		const item = liveStrokeItem(stroke, template);
		const renderer = getRenderer(item, input.context);
		const container = renderer.create(item, input.context);
		container.zIndex = Z_LIVE_STROKE;
		world.addChild(container);
		liveStrokes.set(stroke.id, { container, renderer, template });
		return item;
	}

	function removeLiveStroke(id: string, context: BoardRenderContext) {
		const entry = liveStrokes.get(id);
		if (!entry) return;
		liveStrokes.delete(id);
		world.removeChild(entry.container);
		entry.renderer.destroy?.(entry.container, context);
	}

	let visibleMemo: {
		ids: Set<string> | null;
		structureVersion: number;
		signature: number;
		orderedIds: string[];
		unbatched: Set<string>;
	} | null = null;
	function visibleFacts(input: SceneSyncInput) {
		const { items, visibleIds, structureVersion, context, getItem } = input;
		if (
			visibleMemo?.ids === visibleIds &&
			visibleMemo.structureVersion === structureVersion
		)
			return visibleMemo;
		const orderedIds =
			visibleIds === null
				? items.map((item) => item.id)
				: [...visibleIds].sort(
						(a, b) => (orderById.get(a) ?? 0) - (orderById.get(b) ?? 0),
					);
		const unbatched = new Set<string>();
		for (const id of orderedIds) {
			const item = getItem(id);
			if (item && !getRenderer(item, context).renderFar) unbatched.add(id);
		}
		visibleMemo = {
			ids: visibleIds,
			structureVersion,
			signature: visibleIds === null ? 0 : idSetSignature(visibleIds),
			orderedIds,
			unbatched,
		};
		return visibleMemo;
	}

	function sync(input: SceneSyncInput) {
		const {
			items,
			scene,
			context,
			getItem,
			visibleIds,
			pinnedIds,
			globalSig,
			structureVersion,
			geometryVersion,
			gestureActive,
		} = input;

		const resolution = `${textZoomBucket(context.zoom)}:${context.textResolution}`;
		if (resolution !== lastResolution) {
			lastResolution = resolution;
			queueResolution(input.focus);
		}
		const structureChanged = structureVersion !== lastStructureVersion;
		if (structureChanged) {
			lastStructureVersion = structureVersion;
			const liveIds = new Set(items.map((item) => item.id));
			for (const [id, entry] of [...cards]) {
				if (!liveIds.has(id)) recycle(id, entry, context, false);
			}
			orderById = new Map(items.map((item, index) => [item.id, index]));
		}

		const visibleCount = visibleIds === null ? items.length : visibleIds.size;
		const nextFarActive = farActive
			? visibleCount > FAR_LAYER_EXIT
			: visibleCount > FAR_LAYER_ENTER;
		const farModeChanged = nextFarActive !== farActive;
		farActive = nextFarActive;
		farFront.visible = farActive;

		if (farActive) {
			farInput = input;
			const nextFarSig = [
				structureVersion,
				geometryVersion,
				globalSig,
				idSetSignature(pinnedIds),
				visibleIds === null ? "all" : visibleFacts(input).signature,
			].join("|");
			if (farSig === null || (nextFarSig !== farSig && !gestureActive)) {
				requestFarPass(nextFarSig);
			}
		} else if (farModeChanged) {
			resetFarLayer();
		}

		const wanted = new Set<string>(pinnedIds);
		if (farActive) {
			const { orderedIds, unbatched } = visibleFacts(input);
			for (const id of unbatched) wanted.add(id);
			let retained = 0;
			if (!farPainted) for (const id of cards.keys()) {
				if ((!visibleIds || visibleIds.has(id)) && !farCovered.has(id) && !wanted.has(id)) {
					wanted.add(id);
					retained++;
				}
			}
			let budget = Math.max(0, FAR_LIVE_LIMIT - retained);
			for (const id of orderedIds) {
				if (budget === 0) break;
				if (farCovered.has(id) || wanted.has(id)) continue;
				wanted.add(id);
				budget -= 1;
			}
		} else if (visibleIds === null) {
			for (const item of items) wanted.add(item.id);
		} else {
			for (const id of visibleIds) wanted.add(id);
		}

		let liveSetChanged = false;

		for (const [id, entry] of [...cards]) {
			if (!wanted.has(id)) {
				recycle(id, entry, context, false);
				liveSetChanged = true;
			}
		}

		for (const id of wanted) {
			const item = getItem(id);
			if (!item) continue;
			let entry = cards.get(id);
			const renderer = getRenderer(item, context);
			if (entry && entry.renderer.id !== renderer.id) {
				world.removeChild(entry.container);
				entry.renderer.destroy?.(entry.container, context);
				recycle(id, entry, context, true);
				entry = undefined;
			}
			if (!entry) {
				materialize(item, context, globalSig, scene);
				liveSetChanged = true;
				continue;
			}

			const selected = context.selectedIds.has(id);
			const hovered = context.hoveredId === id;
			const resizing = context.resizingIds.has(id);
			const scriptRevision = context.scripts?.revision?.(id) ?? 0;
			const observed =
				entry.renderer.observesSelection === true &&
				(selected !== entry.selected || hovered !== entry.hovered);
			const changed =
				input.staleIds?.has(id) ||
				scriptRevision !== entry.scriptRevision ||
				item !== entry.item ||
				entry.renderer.animated ||
				observed ||
				resizing !== entry.resizing ||
				globalSig !== entry.globalSig;
			entry.scriptRevision = scriptRevision;
			entry.item = item;
			entry.selected = selected;
			entry.hovered = hovered;
			entry.resizing = resizing;
			entry.globalSig = globalSig;
			setHeldKey(context, id, item);
			if (changed) {
				entry.renderer.update(entry.container, item, context);
				entry.container.alpha = scene.opacity(id);
				if (entry.renderer.tick) tickingIds.add(id);
				pendingResolution.delete(id);
			}
		}
		refreshResolution(context);
		if (liveSetChanged) liveVersion += 1;
		if (structureChanged || liveSetChanged) syncClips(scene);
		if (context.zoom !== lastZoom) {
			lastZoom = context.zoom;
			for (const entry of cards.values()) entry.renderer.zoom?.(entry.container, lastZoom);
		}

		const liftChanged = context.liftedIds !== lifted;
		lifted = context.liftedIds;
		if (structureChanged || farModeChanged || liveSetChanged || liftChanged) applyChildOrder(scene);
		syncLiveStrokes(input);
	}

	function queueResolution(focus: SceneSyncInput["focus"]) {
		const ids = [...cards].filter(([, entry]) => entry.renderer.resolution);
		if (focus) {
			const distance = ({ item: { frame } }: CardEntry) =>
				(frame.x + frame.width / 2 - focus.x) ** 2 + (frame.y + frame.height / 2 - focus.y) ** 2;
			ids.sort(([, a], [, b]) => distance(a) - distance(b));
		}
		pendingResolution.clear();
		for (const [id] of ids) pendingResolution.add(id);
	}

	function refreshResolution(context: BoardRenderContext) {
		let budget = RESOLUTION_BATCH;
		for (const id of pendingResolution) {
			if (budget-- === 0) break;
			pendingResolution.delete(id);
			const entry = cards.get(id);
			if (!entry) continue;
			entry.renderer.resolution?.(entry.container, entry.item, context);
			if (entry.renderer.tick) tickingIds.add(id);
		}
		if (pendingResolution.size) options.requestFrame?.();
	}

	function tick(clock: number): number | null {
		let next: number | null = null;
		for (const id of tickingIds) {
			const entry = cards.get(id);
			const wait = entry?.container.visible ? (entry.renderer.tick?.(entry.container, clock) ?? null) : null;
			if (wait === null) tickingIds.delete(id);
			else next = next === null ? wait : Math.min(next, wait);
		}
		return next;
	}

	function applyChildOrder(scene: BoardModelScene) {
		const raised = new Set(lifted);
		for (const id of lifted) {
			if (scene.get(id)?.type === "frame") {
				for (const child of scene.descendants(id)) raised.add(child);
			}
		}
		const order = (id: string) => (orderById.get(id) ?? 0) + (raised.has(id) ? Z_LIFTED : 0);
		for (const [id, entry] of cards) entry.container.zIndex = order(id);
		for (const [id, entry] of clips) {
			entry.group.zIndex = order(id) + 0.5;
			entry.group.sortChildren();
		}
		world.sortChildren();
	}

	function destroy(context: BoardRenderContext) {
		for (const entry of cards.values())
			entry.renderer.destroy?.(entry.container, context);
		cards.clear();
		for (const pool of pools.values()) {
			for (const container of pool) container.destroy({ children: true });
		}
		pools.clear();
		for (const key of heldKeys.values()) context.releaseTexture(key);
		heldKeys.clear();
		holders.clear();
		orderById = new Map();
		for (const entry of clips.values()) entry.group.destroy({ children: true });
		clips.clear();
		animatedIds.clear();
		tickingIds.clear();
		for (const id of [...liveStrokes.keys()]) removeLiveStroke(id, context);
		resetFarLayer();
		farActive = false;
		visibleMemo = null;
		lastStructureVersion = -1;
		lastZoom = Number.NaN;
		lastResolution = "";
		pendingResolution.clear();
	}

	return {
		sync,
		getNode: (itemId) => {
			const entry = cards.get(itemId);
			return entry ? { item: entry.item, container: entry.container } : null;
		},
		holders: (key) => holders.get(key) ?? EMPTY_IDS,
		get liveVersion() {
			return liveVersion;
		},
		liveIds: () => new Set(cards.keys()),
		get animated() {
			return animatedIds.size > 0;
		},
		tick,
		destroy,
	};
}
