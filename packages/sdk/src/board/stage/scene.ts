import type {
	BoardDrawItem,
	BoardDrawPoint,
	BoardSceneItem as BoardItem,
	BoardScene as BoardModelScene,
	SceneItem,
} from "../model/index.js";
import { drawPointsBounds, itemBounds, parseBoardItem, type Rect, rectsIntersect } from "../model/index.js";
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
import { BOARD_LOD_HYSTERESIS, type BoardLod, boardCardDetailed, boardLodRatio, boardLodSize, DEFAULT_BOARD_LOD } from "../render/lod.js";
import { textZoomBucket } from "../render/text-resolution.js";
import { type BoardFrameBudget, fixedBoardFrameBudget } from "./frame-budget.js";
import { type Container, Graphics, Text } from "pixi.js";

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

const FAR_CHUNK = 256;
const LOD_ZOOM_STEPS = 8;
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
	gestureActive: boolean;
	focus?: { x: number; y: number };
	/** The world area on screen; live cards outside it skip rendering. */
	view?: Rect;
	lod?: BoardLod;
	budget?: BoardFrameBudget;
};

type FarRun = { key: string; order: number; items: BoardItem[] };
type LodPlan = {
	scene: BoardModelScene;
	live: ReadonlySet<string>;
	far: ReadonlySet<string>;
	runs: Map<string, FarRun>;
	limited: boolean;
	deferred: boolean;
};
type FarPlate = { graphics: Graphics; items: readonly BoardItem[]; sig: string };

function sameItems(a: readonly BoardItem[], b: readonly BoardItem[]): boolean {
	return a.length === b.length && a.every((item, index) => item === b[index]);
}

export type BoardSceneNode = {
	item: BoardItem;
	container: Container;
};

export type BoardScene = {
	sync: (input: SceneSyncInput) => void;
	getNode: (itemId: string) => BoardSceneNode | null;
	holders: (key: string) => ReadonlySet<string>;
	repaintFar: (keys: ReadonlySet<string>, assetKey: (item: BoardItem) => string | null) => void;
	readonly liveVersion: number;
	liveIds: () => ReadonlySet<string>;
	/** Live cards and cards drawn on far plates. */
	counts: () => { live: number; far: number };
	readonly settling: boolean;
	readonly animated: boolean;
	tick: (clock: number) => number | null;
	redrawText: () => void;
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
	let idsByOrder: readonly string[] = [];
	let lastStructureVersion = -1;
	let lastZoom = Number.NaN;
	let lastResolution = "";
	const pendingResolution = new Set<string>();
	let liveVersion = 0;
	let lifted: ReadonlySet<string> = new Set();
	const fixedBudget = fixedBoardFrameBudget();
	let budget: BoardFrameBudget = fixedBudget;
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
		for (const plate of plates.values()) {
			const first = plate.items[0];
			const host = first && hostFor(first, scene);
			if (host && plate.graphics.parent !== host) host.addChild(plate.graphics);
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
		container.culled = false;
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

	const lodSizes = new WeakMap<BoardItem, number>();
	let nearIds: ReadonlySet<string> = EMPTY_IDS;
	let plan: LodPlan | null = null;
	let planInputs: unknown[] = [];

	/** Visible ids in z-order; sorting indices beats comparing ids through the map. */
	function orderedIds(visibleIds: Set<string> | null): readonly string[] {
		if (visibleIds === null) return idsByOrder;
		const order = new Int32Array(visibleIds.size);
		let length = 0;
		for (const id of visibleIds) {
			const index = orderById.get(id);
			if (index !== undefined) order[length++] = index;
		}
		return Array.from(order.subarray(0, length).sort(), (index) => idsByOrder[index] as string);
	}

	function lodSize(renderer: BoardCardRenderer, item: BoardItem): number {
		let size = lodSizes.get(item);
		if (size === undefined) {
			size = boardLodSize(renderer, item);
			lodSizes.set(item, size);
		}
		return size;
	}

	/**
	 * Split the visible cards into live ones and z-ordered chunks of far stand-ins.
	 * A card is live while it is legible on screen, until the live budget keeps
	 * the on-screen ones nearest the focus; pinned cards and cards without a far
	 * stand-in stay live.
	 */
	function lodPlan(input: SceneSyncInput): LodPlan {
		const { visibleIds, context, getItem, pinnedIds, scene } = input;
		const lod = input.lod ?? DEFAULT_BOARD_LOD;
		const step = Math.round(Math.log2(Math.max(context.zoom, 1e-4)) * LOD_ZOOM_STEPS);
		const cell = input.view && input.focus && plan?.limited ? input.view.width / 8 : 0;
		const at = cell ? `${Math.round((input.focus?.x ?? 0) / cell)},${Math.round((input.focus?.y ?? 0) / cell)}` : "";
		const inputs = [visibleIds, input.structureVersion, idSetSignature(pinnedIds), step, at, lod.media, lod.text, lod.card, lod.live];
		const reusable = plan && inputs.every((value, index) => value === planInputs[index]);
		if (plan && reusable && !plan.deferred && (input.gestureActive || plan.scene === scene)) return plan;
		planInputs = inputs;

		const ids = orderedIds(visibleIds);
		const live = new Set<string>();
		const near: BoardItem[] = [];
		for (const id of ids) {
			const item = getItem(id);
			if (!item) continue;
			const renderer = getRenderer(item, context);
			if (pinnedIds.has(id) || !renderer.renderFar) {
				live.add(id);
				continue;
			}
			const ratio = boardLodRatio(renderer, lodSize(renderer, item), context.zoom, lod);
			if (ratio >= (nearIds.has(id) ? BOARD_LOD_HYSTERESIS : 1)) near.push(item);
		}
		const room = Math.max(0, lod.live - live.size);
		const limited = near.length > room;
		const allowance = budget.allow("materialize");
		const { focus, view } = input;
		const ranked = focus && (limited || near.length > allowance)
			? near
					.map(({ id, frame }) => ({
						id,
						offscreen: view && !rectsIntersect(itemBounds(frame), view) ? 1 : 0,
						distance: (frame.x + frame.width / 2 - focus.x) ** 2 + (frame.y + frame.height / 2 - focus.y) ** 2,
					}))
					.sort((a, b) => a.offscreen - b.offscreen || a.distance - b.distance)
			: near;
		let admitted = 0;
		let deferred = false;
		for (const { id } of ranked.slice(0, room)) {
			if (!cards.has(id) && admitted++ >= allowance) deferred = true;
			else live.add(id);
		}
		if (deferred) options.requestFrame?.();
		nearIds = live;

		const runs = new Map<string, FarRun>();
		const far = new Set<string>();
		for (const id of ids) {
			const item = getItem(id);
			if (!item || live.has(id)) continue;
			const order = orderById.get(id) ?? 0;
			const key = `${Math.floor(order / FAR_CHUNK)}:${clippingAncestor(scene, item) ?? ""}`;
			const run = runs.get(key);
			if (run) run.items.push(item);
			else runs.set(key, { key, order, items: [item] });
			far.add(id);
		}
		plan = { scene, live, far, runs, limited, deferred };
		return plan;
	}

	const plates = new Map<string, FarPlate>();
	let paintedPlan: LodPlan | null = null;
	let paintedSig = "";
	let platesPending = false;
	let covered: ReadonlySet<string> = EMPTY_IDS;

	/**
	 * Repaint the plates whose cards changed, within a per-frame budget. A card
	 * is covered once a plate draws it; until then it stays live if it already is.
	 */
	function paintPlates(input: SceneSyncInput, current: LodPlan): boolean {
		const { context, globalSig, scene } = input;
		if (current === paintedPlan && globalSig === paintedSig) return false;
		const start = performance.now();
		const allowance = budget.allow("plate");
		let painted = 0;
		let pending = false;
		let changed = false;
		for (const run of current.runs.values()) {
			let plate = plates.get(run.key);
			if (plate?.sig === globalSig && sameItems(plate.items, run.items)) continue;
			if (painted >= allowance) {
				pending = true;
				continue;
			}
			painted += run.items.length;
			if (!plate) {
				plate = { graphics: new Graphics({ label: "board-far-plate" }), items: [], sig: "" };
				plates.set(run.key, plate);
				changed = true;
			}
			const { graphics } = plate;
			graphics.clear();
			for (const item of run.items) getRenderer(item, context).renderFar?.(graphics, item, context);
			plate.items = run.items;
			plate.sig = globalSig;
			graphics.zIndex = run.order;
			const host = hostFor(run.items[0] as BoardItem, scene);
			if (graphics.parent !== host) host.addChild(graphics);
		}
		const paintMs = performance.now() - start;
		for (const [key, plate] of plates) {
			if (current.runs.has(key)) continue;
			plates.delete(key);
			plate.graphics.destroy();
			changed = true;
		}
		const next = new Set<string>();
		for (const plate of plates.values()) for (const item of plate.items) next.add(item.id);
		covered = next;
		budget.spend("plate", painted, paintMs);
		platesPending = pending;
		if (pending) options.requestFrame?.();
		else {
			paintedPlan = current;
			paintedSig = globalSig;
		}
		return changed;
	}

	function repaintFar(keys: ReadonlySet<string>, assetKey: (item: BoardItem) => string | null) {
		for (const plate of plates.values()) {
			if (!plate.items.some((item) => keys.has(assetKey(item) ?? ""))) continue;
			plate.sig = "";
			paintedPlan = null;
		}
	}

	function clearPlates() {
		for (const plate of plates.values()) plate.graphics.destroy();
		plates.clear();
		paintedPlan = null;
		paintedSig = "";
		platesPending = false;
		covered = EMPTY_IDS;
		plan = null;
		planInputs = [];
		nearIds = EMPTY_IDS;
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

	function sync(input: SceneSyncInput) {
		const {
			items,
			scene,
			context,
			getItem,
			pinnedIds,
			globalSig,
			structureVersion,
		} = input;
		fixedBudget.reset();
		budget = input.budget ?? fixedBudget;

		const resolution = `${textZoomBucket(context.zoom)}:${boardCardDetailed(context.zoom)}:${context.textResolution}`;
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
			idsByOrder = items.map((item) => item.id);
			orderById = new Map(idsByOrder.map((id, index) => [id, index]));
		}

		const current = lodPlan(input);
		const platesChanged = paintPlates(input, current);
		const wanted = new Set<string>(pinnedIds);
		for (const id of current.live) wanted.add(id);
		for (const id of cards.keys()) {
			if (current.far.has(id) && !covered.has(id)) wanted.add(id);
		}

		let liveSetChanged = false;
		let made = 0;
		let making = 0;

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
				const start = performance.now();
				materialize(item, context, globalSig, scene);
				making += performance.now() - start;
				made += 1;
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
		budget.spend("materialize", made, making);
		if (input.view) cullCards(input.view, pinnedIds);
		refreshResolution(context);
		if (liveSetChanged) liveVersion += 1;
		if (structureChanged || liveSetChanged || platesChanged) syncClips(scene);
		if (context.zoom !== lastZoom) {
			lastZoom = context.zoom;
			for (const entry of cards.values()) entry.renderer.zoom?.(entry.container, lastZoom);
		}

		const liftChanged = context.liftedIds !== lifted;
		lifted = context.liftedIds;
		if (structureChanged || liveSetChanged || liftChanged) applyChildOrder(scene);
		syncLiveStrokes(input);
	}

	function cullCards(view: Rect, pinnedIds: ReadonlySet<string>) {
		for (const [id, entry] of cards) {
			const culled = !pinnedIds.has(id) && !rectsIntersect(itemBounds(entry.item.frame), view);
			if (entry.container.culled === culled) continue;
			entry.container.culled = culled;
			if (!culled && entry.renderer.tick) tickingIds.add(id);
		}
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
		if (pendingResolution.size === 0) return;
		const start = performance.now();
		const allowance = budget.allow("resolution");
		let refreshed = 0;
		for (const id of pendingResolution) {
			if (refreshed === allowance) break;
			pendingResolution.delete(id);
			const entry = cards.get(id);
			if (!entry) continue;
			entry.renderer.resolution?.(entry.container, entry.item, context);
			if (entry.renderer.tick) tickingIds.add(id);
			refreshed += 1;
		}
		budget.spend("resolution", refreshed, performance.now() - start);
		if (pendingResolution.size) options.requestFrame?.();
	}

	function tick(clock: number): number | null {
		let next: number | null = null;
		for (const id of tickingIds) {
			const entry = cards.get(id);
			const wait = entry?.container.visible && !entry.container.culled ? (entry.renderer.tick?.(entry.container, clock) ?? null) : null;
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

	function redrawText() {
		const redraw = (container: Container) => {
			for (const child of container.children) {
				if (child instanceof Text) child.style.update();
				else redraw(child);
			}
		};
		for (const entry of cards.values()) redraw(entry.container);
		for (const pool of pools.values()) for (const container of pool) redraw(container);
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
		idsByOrder = [];
		clearPlates();
		for (const entry of clips.values()) entry.group.destroy({ children: true });
		clips.clear();
		animatedIds.clear();
		tickingIds.clear();
		for (const id of [...liveStrokes.keys()]) removeLiveStroke(id, context);
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
		repaintFar,
		get liveVersion() {
			return liveVersion;
		},
		liveIds: () => new Set(cards.keys()),
		counts: () => ({ live: cards.size, far: covered.size }),
		get settling() {
			return Boolean(plan?.deferred) || platesPending || pendingResolution.size > 0;
		},
		get animated() {
			return animatedIds.size > 0;
		},
		tick,
		redrawText,
		destroy,
	};
}
