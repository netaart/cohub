import {
	applyBoardPatchToDocument,
	arrowBindings,
	arrowHitRadius,
	arrowPathBounds,
	type BoardAnimation,
	type BoardArrowEnd,
	type BoardArrowItem,
	type BoardDocument,
	type BoardDrawPoint,
	type BoardFileSnapshotFacts,
	type BoardFrame,
	type BoardItem,
	type BoardMediaSnapshot,
	type BoardPatch,
	type BoardScene,
	type BoardSceneItem,
	type BoardSettings,
	type BoardStyledToolId,
	type BoardTaskSnapshot,
	type BoardTrack,
	type BoardViewport,
	buildBoardScene,
	cameraForRect,
	clampBoardStrokeSize,
	clampZoom,
	compileBoardAnimations,
	distanceToArrow,
	evaluateBoardAnimations,
	featuredTaskArtifact,
	FIT_PADDING,
	HANDLE_HIT_RADIUS,
	IDENTITY_MATRIX,
	invertMatrix,
	applyMatrix,
	isArrowBinding,
	isBoardColorId,
	isShapeKind,
	mergeFileSnapshot,
	normalizeRotation,
	normalizeViewport,
	panBy,
	placeItem,
	pointToWorld,
	pruneBoardTrack,
	type Rect,
	type ResizeHandle,
	rectCenter,
	rectContainsPoint,
	rectsIntersect,
	refreshBoardScene,
	resizeFrame,
	resolveSceneArrow,
	rotateFrames,
	type SceneItem,
	type ScreenPoint,
	scaleFrames,
	sceneItemToItem,
	screenPoint,
	selectionBounds,
	shapeBounds,
	shapeCapabilities,
	shapeHitTest,
	unionRects,
	type WorldPoint,
	worldPoint,
	zoomAround,
} from "@neta-art/cohub/board";
import { ensureBoardTextMeasurement } from "@neta-art/cohub/board/render";
import { untrack } from "svelte";
import { appendBoardDrawSample } from "$lib/board/board-draw-input";
import { createBoardItemId } from "$lib/board/board-id";
import {
	type BoardItemEntry,
	createAppBoardItem,
	createArrowBoardItem,
	createDrawBoardItem,
	createFileNodeForPath,
	createFrameBoardItem,
	createShapeBoardItem,
	createTaskBoardItem,
	createTextBoardItem,
	DUPLICATE_OFFSET,
	titleForBoardItem,
} from "$lib/board/board-items";
import {
	createSpatialIndex,
	type SpatialEntry,
} from "$lib/board/board-spatial";
import {
	type BoardToolId,
	canTapSelectWithHand,
	isContinuousBoardTool,
	isWithinHandTapSlop,
} from "$lib/board/board-tool";
import {
	readBoardToolStyles,
	writeBoardToolStyles,
} from "$lib/board/board-tool-preferences";
import { normalizeWheelDelta, wheelZoomFactor } from "$lib/board/camera-input";
import {
	type AlignMode,
	alignFrames,
	type DistributeAxis,
	distributeFrames,
} from "$lib/board/core/align";
import {
	type BoardClipboardPayload,
	defaultPasteOffset,
	encodeClipboard,
	materializeClipboard,
	parseClipboard,
	remapItems,
} from "$lib/board/core/clipboard";
import {
	CONNECTION_PORT_RADIUS,
	type ConnectionPort,
	connectionPorts,
	connectionPortAt as portAt,
} from "$lib/board/core/connection-ports";
import {
	resolveSelectionTransform,
	selectionTransformControlAt,
} from "$lib/board/core/selection-transform";
import { computeSnap, type SnapGuide } from "$lib/board/core/snapping";
import { diffBoardEdits, isEmptyBoardPatch, readPath, routeBoardEdits, sameJson } from "$lib/board/core/document-edits";
import "$lib/board/core/shapes";

export type { BoardToolId } from "$lib/board/board-tool";
export type { AlignMode, DistributeAxis };

export type BoardInteraction =
	| { type: "idle" }
	| {
			type: "panning";
			start: ScreenPoint;
			origin: BoardViewport;
			moved: boolean;
			tapSelection: { targetId: string | null } | null;
	  }
	| {
			type: "translating";
			start: WorldPoint;
			origin: Map<string, BoardFrame>;
			moved: boolean;
			duplicate: boolean;
	  }
	| {
			type: "resizing";
			handle: ResizeHandle;
			single: BoardFrame | null;
			bounds: Rect;
			origin: Map<string, BoardFrame>;
			moved: boolean;
	  }
	| {
			type: "rotating";
			pivot: WorldPoint;
			startAngle: number;
			current: WorldPoint;
			origin: Map<string, BoardFrame>;
			moved: boolean;
	  }
	| {
			type: "brushing";
			start: WorldPoint;
			current: WorldPoint;
			additive: boolean;
			baseSelection: string[];
	  }
	| {
			type: "drawing";
			id: string;
			pointerId: number;
			points: BoardDrawPoint[];
			color: string;
			size: number;
	  }
	| {
			type: "creatingArrow";
			id: string;
			start: WorldPoint;
			current: WorldPoint;
			startItemId: string | null;
			startSide: "top" | "right" | "bottom" | "left" | null;
			targetItemId: string | null;
			color: string;
			size: number;
	  }
	| {
			type: "creatingBox";
			id: string;
			kind: "shape" | "frame";
			start: WorldPoint;
			current: WorldPoint;
			color: string;
			geometry: string;
	  }
	| {
			type: "draggingArrowHandle";
			arrowId: string;
			which: "start" | "end" | "mid";
			origin: BoardArrowItem;
			targetItemId: string | null;
			moved: boolean;
	  };

export type BoardPointerEvent = {
	pointerId: number;
	screen: ScreenPoint;
	world: WorldPoint;
	shiftKey: boolean;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	button: number;
	buttons: number;
	pointerType: string;
	cancelled: boolean;
	pressure: number;
};

export type BoardViewState = {
	visibleRect: Rect | null;
	selectedNodes: Array<{ id: string; type: string; title?: string }>;
};

export type BoardPlayhead = { animationId: string; time: number };

export type BoardEditorOptions = {
	document: BoardDocument;
	viewport?: BoardViewport;
	initialTool?: BoardToolId;
	key?: string;
	readonly?: boolean;
	onCommit: (patch: BoardPatch) => void | Promise<void>;
	onViewStateChange?: (state: BoardViewState) => void;
};

const NUDGE_STEP = 1;
const NUDGE_STEP_LARGE = 10;
const ZOOM_STEP = 1.28;
const CAMERA_ANIMATION_MS = 240;
const DRAG_THRESHOLD = 3;
const SNAP_THRESHOLD = 8;
const UNDO_LIMIT = 200;

function easeOutCubic(t: number) {
	return 1 - (1 - t) * (1 - t) * (1 - t);
}

export function createBoardEditor(options: BoardEditorOptions) {
	ensureBoardTextMeasurement();

	let base = $state.raw<BoardDocument>(options.document);
	let scene = $state.raw<BoardScene>(buildBoardScene(options.document));
	const draft = new Map<string, BoardItem | null>();
	let evaluated: ReadonlyMap<string, BoardItem> = new Map();
	const draftOrigins = new Map<string, BoardItem>();
	let played: ReadonlyMap<string, BoardItem> = new Map();
	let compiled: { animations: BoardDocument["animations"]; items: BoardDocument["items"]; value: ReturnType<typeof compileBoardAnimations> } | null = null;

	let camera = $state<BoardViewport>(normalizeViewport(options.viewport ?? { x: 0, y: 0, zoom: 1 }));
	let selection = $state<string[]>([]);
	let tool = $state<BoardToolId>(options.initialTool ?? "select");
	let interaction = $state<BoardInteraction>({ type: "idle" });
	let hoverId = $state<string | null>(null);
	let hoverPoint = $state<WorldPoint | null>(null);
	let hoverPointerType = $state("mouse");
	let editingId = $state<string | null>(null);
	let saveError = $state<string | null>(null);
	let pendingCommits = $state(0);
	let surfaceSize = $state<{ width: number; height: number }>({ width: 0, height: 0 });
	let playhead = $state<BoardPlayhead | null>(null);
	let recording = $state(false);
	type UndoEntry = { undo: BoardPatch; redo: BoardPatch };
	let undoStack = $state.raw<UndoEntry[]>([]);
	let redoStack = $state.raw<UndoEntry[]>([]);
	let draftTextId = $state<string | null>(null);
	let structureVersion = $state(0);
	let geometryVersion = $state(0);
	const recentlyAdded = new Set<string>();
	let toolStyles = $state(readBoardToolStyles());
	let snapGuides = $state<SnapGuide[]>([]);
	let spaceHeld = $state(false);
	let internalClipboard: BoardClipboardPayload | null = null;
	let pasteCount = 0;
	let cameraAnimation = 0;
	let pinch: { distance: number; midpoint: ScreenPoint; zoom: number } | null = null;
	const activePointers = new Map<number, ScreenPoint>();
	let currentKey: string | undefined = options.key;
	let pendingRemote: { document: BoardDocument; key: string | undefined } | null = null;

	const spatial = createSpatialIndex();
	let indexedScene: BoardScene | null = null;
	let spatialDirty: Set<string> | null = null;
	let mediaIdsByPath: Map<string, Set<string>> | null = null;
	const emptyIds: ReadonlySet<string> = new Set();

	function markAdded(ids: readonly string[]) {
		if (ids.length === 0) return;
		recentlyAdded.clear();
		for (const id of ids) recentlyAdded.add(id);
	}

	function displayItem(id: string): BoardItem | undefined {
		if (draft.has(id)) return draft.get(id) ?? undefined;
		return evaluated.get(id) ?? played.get(id) ?? base.items[id];
	}

	function displayDocument(): BoardDocument {
		if (draft.size === 0 && evaluated.size === 0 && played.size === 0) return base;
		const items = { ...base.items };
		for (const [id, item] of played) items[id] = item;
		for (const [id, item] of evaluated) items[id] = item;
		for (const [id, item] of draft) {
			if (item) items[id] = item;
			else delete items[id];
		}
		return { ...base, items };
	}

	function reevaluate() {
		if (!playhead || !base.animations[playhead.animationId]) {
			evaluated = new Map();
			return;
		}
		if (!compiled || compiled.animations !== base.animations || compiled.items !== base.items) {
			compiled = { animations: base.animations, items: base.items, value: compileBoardAnimations(base) };
		}
		evaluated = evaluateBoardAnimations(compiled.value, { [playhead.animationId]: playhead.time }).items;
	}

	function setPlayedItems(items: ReadonlyMap<string, BoardItem>) {
		const previous = played;
		played = new Map([...items].filter(([id]) => base.items[id]));
		const changed = new Set([...previous.keys(), ...played.keys()]);
		for (const id of changed) {
			if (draft.has(id) || evaluated.has(id) || sameJson(previous.get(id), played.get(id))) changed.delete(id);
		}
		if (changed.size) rescene(changed);
	}

	function rescene(ids?: Iterable<string>) {
		if (ids) {
			const changed = [...ids];
			scene = refreshBoardScene(scene, displayItem, changed);
			if (spatialDirty) {
				const affected = new Set<string>();
				const pending = [...changed];
				while (pending.length) {
					const id = pending.pop() as string;
					if (affected.has(id)) continue;
					affected.add(id);
					spatialDirty.add(id);
					pending.push(...scene.children(id), ...scene.binders(id));
				}
			}
		} else {
			scene = buildBoardScene(displayDocument(), scene);
			spatialDirty = null;
			mediaIdsByPath = null;
			structureVersion += 1;
		}
		geometryVersion += 1;
	}

	function setDraftItem(id: string, item: BoardItem | null) {
		if (!draft.has(id)) {
			const shown = displayItem(id);
			if (shown) draftOrigins.set(id, shown);
		}
		draft.set(id, item);
	}

	function writeDraft(changes: ReadonlyMap<string, BoardItem | null>, structural = false) {
		if (changes.size === 0) return;
		for (const [id, item] of changes) setDraftItem(id, item);
		if (!structural) {
			for (const [id, item] of changes) {
				const before = scene.get(id);
				if (!item || !before || before.parent !== item.parent || before.z !== item.z || !sameJson(arrowBindings(before), arrowBindings(item))) {
					structural = true;
					break;
				}
			}
		}
		rescene(structural ? undefined : changes.keys());
	}

	function ensureSpatial() {
		if (indexedScene === scene) return;
		const dirty = indexedScene ? spatialDirty : null;
		indexedScene = scene;
		spatialDirty = new Set();
		if (dirty === null) {
			const entries: SpatialEntry[] = scene.items.map((item, order) => ({ id: item.id, order, rect: boundsOf(item) }));
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
		if (item.type === "arrow") return arrowPathBounds(resolveSceneArrow(item as SceneItem<BoardArrowItem>, scene), item.style.strokeWidth);
		return shapeBounds(item);
	}

	function itemById(id: string): BoardSceneItem | null {
		return scene.get(id) ?? null;
	}

	function isLocked(item: BoardSceneItem | BoardItem): boolean {
		return item.locked === true;
	}

	function unlockedIds(ids: Iterable<string>): string[] {
		const result: string[] = [];
		for (const id of ids) {
			const item = scene.get(id);
			if (item && !isLocked(item)) result.push(id);
		}
		return result;
	}

	function rootsOf(ids: Iterable<string>): string[] {
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

	function mediaIdsForPath(path: string): ReadonlySet<string> {
		if (!mediaIdsByPath) {
			mediaIdsByPath = new Map();
			for (const item of scene.items) {
				if (item.type !== "image" && item.type !== "video" && item.type !== "audio") continue;
				const src = (item.props as { src: string }).src;
				const ids = mediaIdsByPath.get(src) ?? new Set<string>();
				ids.add(item.id);
				mediaIdsByPath.set(src, ids);
			}
		}
		return mediaIdsByPath.get(path) ?? emptyIds;
	}

	const items = $derived(scene.items);
	const selectedItems = $derived.by<BoardSceneItem[]>(() => {
		const current = scene;
		const result: BoardSceneItem[] = [];
		for (const id of selection) {
			const item = current.get(id);
			if (item) result.push(item);
		}
		return result;
	});
	const selectedFrames = $derived(selectedItems.map((item) => item.frame));
	const bounds = $derived(selectionBounds(selectedFrames));
	const selectionTransform = $derived(resolveSelectionTransform(selectedItems, bounds));
	const hoveredTransformControl = $derived.by(() =>
		interaction.type === "idle" && !pinch && tool === "select" && hoverPoint
			? selectionTransformControlAt(selectionTransform, hoverPoint, camera.zoom, hoverPointerType)
			: null,
	);
	const marquee = $derived.by<Rect | null>(() => {
		if (interaction.type !== "brushing") return null;
		const { start, current } = interaction;
		return { x: Math.min(start.x, current.x), y: Math.min(start.y, current.y), width: Math.abs(current.x - start.x), height: Math.abs(current.y - start.y) };
	});

	function routeDraft(): BoardDocument {
		return routeBoardEdits({ base, evaluated, draft, playhead, recording, displayed: draftOrigins });
	}

	function send(patch: BoardPatch) {
		if (options.readonly || isEmptyBoardPatch(patch)) return;
		pendingCommits += 1;
		void Promise.resolve(options.onCommit(patch))
			.then(() => {
				saveError = null;
			})
			.catch((error: unknown) => {
				saveError = error instanceof Error ? error.message : "Failed to sync board";
			})
			.finally(() => {
				pendingCommits -= 1;
			});
	}

	function adopt(next: BoardDocument, changedIds?: Iterable<string>) {
		const structural = played.size > 0 || !changedIds || next.animations !== base.animations || next.board !== base.board;
		base = next;
		played = new Map();
		draft.clear();
		draftOrigins.clear();
		reevaluate();
		if (structural || playhead) rescene();
		else {
			const ids = [...changedIds];
			const hierarchy = ids.some((id) => {
				const before = scene.get(id);
				const after = next.items[id];
				return !before || !after || before.parent !== after.parent || before.z !== after.z || !sameJson(arrowBindings(before), arrowBindings(after));
			});
			rescene(hierarchy ? undefined : ids);
		}
	}

	function commit(extra: { board?: BoardSettings; animations?: Record<string, BoardAnimation> } = {}, record = true) {
		const ids = [...draft.keys()];
		let target = routeDraft();
		if (extra.board) target = { ...target, board: extra.board };
		if (extra.animations) target = { ...target, animations: extra.animations };
		const redo = diffBoardEdits(base, target, ids);
		if (isEmptyBoardPatch(redo)) {
			adopt(base);
			return;
		}
		if (record) {
			const undo = diffBoardEdits(target, base, ids);
			undoStack = [...undoStack.slice(-UNDO_LIMIT + 1), { undo, redo }];
			redoStack = [];
		}
		adopt(target, ids);
		send(redo);
	}

	function commitItems(changes: ReadonlyMap<string, BoardItem | null>, record = true) {
		if (changes.size === 0) return;
		for (const [id, item] of changes) setDraftItem(id, item);
		commit({}, record);
	}

	function applyPatch(patch: BoardPatch) {
		const result = applyBoardPatchToDocument(base, patch, { cascade: true });
		if (!result.ok) {
			saveError = result.diagnostics[0]?.message ?? "Could not apply the change";
			return;
		}
		adopt(result.document, Object.keys(patch.items ?? {}));
		send(patch);
	}

	function undo() {
		const entry = undoStack.at(-1);
		if (!entry) return;
		undoStack = undoStack.slice(0, -1);
		redoStack = [...redoStack, entry];
		applyPatch(entry.undo);
	}

	function redo() {
		const entry = redoStack.at(-1);
		if (!entry) return;
		redoStack = redoStack.slice(0, -1);
		undoStack = [...undoStack, entry];
		applyPatch(entry.redo);
	}

	function retrySave() {
		saveError = null;
	}

	let settingsPreview = $state.raw<BoardSettings | null>(null);

	function previewSettings(settings: BoardSettings) {
		settingsPreview = settings;
	}

	function setSettings(settings: BoardSettings) {
		settingsPreview = null;
		if (!sameJson(settings, base.board)) commit({ board: settings });
	}

	function setCamera(viewport: BoardViewport) {
		camera = normalizeViewport(viewport, camera);
		hoverPoint = null;
		hoverId = null;
	}

	function cancelCameraAnimation() {
		if (cameraAnimation) cancelAnimationFrame(cameraAnimation);
		cameraAnimation = 0;
	}

	function animateCamera(target: BoardViewport) {
		cancelCameraAnimation();
		const from = normalizeViewport(camera);
		const to = normalizeViewport(target, from);
		const started = performance.now();
		const step = (now: number) => {
			const t = Math.min(1, (now - started) / CAMERA_ANIMATION_MS);
			const eased = easeOutCubic(t);
			setCamera({ x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased, zoom: from.zoom + (to.zoom - from.zoom) * eased });
			cameraAnimation = t < 1 ? requestAnimationFrame(step) : 0;
		};
		cameraAnimation = requestAnimationFrame(step);
	}

	function surfaceCenter(): ScreenPoint {
		return screenPoint(surfaceSize.width / 2, surfaceSize.height / 2);
	}

	function viewCenter(): WorldPoint {
		return pointToWorld(surfaceCenter(), camera);
	}

	function zoomAt(point: ScreenPoint, factor: number, animate = false) {
		const target = zoomAround(camera, point, camera.zoom * factor);
		if (animate) animateCamera(target);
		else setCamera(target);
	}

	function zoomIn() {
		zoomAt(surfaceCenter(), ZOOM_STEP, true);
	}

	function zoomOut() {
		zoomAt(surfaceCenter(), 1 / ZOOM_STEP, true);
	}

	function resetZoom() {
		animateCamera({ ...camera, zoom: 1 });
	}

	function contentBounds(ids?: Iterable<string>): Rect | null {
		const list = ids ? [...ids].flatMap((id) => (scene.get(id) ? [scene.get(id) as BoardSceneItem] : [])) : scene.items;
		return unionRects(list.map(boundsOf));
	}

	function fitView(focus: Parameters<typeof focusRect>[1] = {}) {
		const content = contentBounds();
		if (content && surfaceSize.width > 0) focusRect(content, { padding: FIT_PADDING, ...focus });
		else if (focus.animate === false) setCamera({ x: 0, y: 0, zoom: 1 });
		else animateCamera({ x: 0, y: 0, zoom: 1 });
	}

	function focusRect(
		rect: Rect,
		focus: { fit?: "contain" | "cover"; padding?: number; minZoom?: number; maxZoom?: number; animate?: boolean } = {},
	) {
		if (surfaceSize.width <= 0 || surfaceSize.height <= 0) return;
		const target = cameraForRect(rect, surfaceSize, { fit: focus.fit ?? "contain", padding: focus.padding ?? 32, minZoom: focus.minZoom, maxZoom: focus.maxZoom });
		if (focus.animate === false) setCamera(target);
		else animateCamera(target);
	}

	function focusItems(ids: Iterable<string>, focus?: Parameters<typeof focusRect>[1]) {
		const rect = contentBounds(ids);
		if (rect) focusRect(rect, focus);
	}

	function focusNode(id: string, focus?: Parameters<typeof focusRect>[1]) {
		focusItems([id], focus);
	}

	function focusSelection(focus?: Parameters<typeof focusRect>[1]) {
		const rect = contentBounds(selection);
		if (rect) focusRect(rect, focus);
		else fitView();
	}

	function setSelection(ids: string[]) {
		selection = ids;
	}

	function clearSelection() {
		selection = [];
	}

	function selectAll() {
		selection = scene.children(undefined).slice();
	}

	function maybeReturnToSelect() {
		if (!isContinuousBoardTool(tool)) tool = "select";
	}

	function styledToolId(value = tool): BoardStyledToolId | null {
		switch (value) {
			case "text":
			case "shape":
			case "draw":
			case "arrow":
			case "frame":
				return value;
			default:
				return null;
		}
	}

	function frameAt(point: WorldPoint, exclude?: ReadonlySet<string>): BoardSceneItem | null {
		ensureSpatial();
		for (const id of spatial.idsAtPoint(point)) {
			const item = scene.get(id);
			if (item?.type !== "frame" || exclude?.has(id)) continue;
			if (shapeHitTest(item, point)) return item;
		}
		return null;
	}

	function reparent(item: BoardItem, frame: BoardFrame, parent: string | undefined, box: Rect): BoardItem {
		const { parent: _previous, ...root } = item;
		const orphan = root as BoardItem;
		const next = parent ? ({ ...orphan, parent } as BoardItem) : orphan;
		const matrix = parent ? scene.layout.matrix(parent) : IDENTITY_MATRIX;
		return placeItem(next, frame, matrix, box);
	}

	function topZ(parent: string | undefined): number {
		let z = 0;
		for (const id of scene.children(parent)) z = Math.max(z, displayItem(id)?.z ?? 0);
		return z + 1;
	}

	function placeNew(entries: readonly BoardItemEntry[]): Map<string, BoardItem> {
		const created = new Set(entries.map((entry) => entry.id));
		const probe = buildBoardScene({ ...base, items: Object.fromEntries(entries.map((entry) => [entry.id, entry.item])) });
		const nextZ = new Map<string | undefined, number>();
		const changes = new Map<string, BoardItem>();
		for (const { id, item } of entries) {
			if (item.parent && created.has(item.parent)) {
				changes.set(id, item);
				continue;
			}
			const shown = probe.get(id);
			const container = shown && item.type !== "frame" && item.type !== "arrow" ? frameAt(rectCenter(shown.frame), created) : null;
			const value = container && shown ? reparent(item, shown.frame, container.id, probe.layout.box(id)) : item;
			const z = nextZ.get(container?.id) ?? topZ(container?.id);
			nextZ.set(container?.id, z + 1);
			changes.set(id, { ...value, z });
		}
		return changes;
	}

	function addEntries(entries: BoardItemEntry[], select = !isContinuousBoardTool(tool)) {
		if (options.readonly || entries.length === 0) return;
		const changes = placeNew(entries);
		markAdded([...changes.keys()]);
		selection = select ? [...changes.keys()] : [];
		commitItems(changes);
		maybeReturnToSelect();
	}

	function addApp(app: { appId: string; ref: string; url: string; name: string; icon?: string }, at: WorldPoint) {
		const entry = createAppBoardItem(app, at.x, at.y);
		addEntries([entry]);
		return entry.id;
	}

	function addFile(path: string, at: WorldPoint, snapshot?: BoardMediaSnapshot & BoardFileSnapshotFacts) {
		const entry = createFileNodeForPath(path, at.x, at.y, snapshot);
		addEntries([entry]);
		return entry.id;
	}

	function addTask(taskRunId: string, snapshot: BoardTaskSnapshot, at: WorldPoint, metadata?: Record<string, unknown>) {
		const entry = createTaskBoardItem(taskRunId, snapshot, at.x, at.y, metadata);
		addEntries([entry]);
		return entry.id;
	}

	function addTaskWithSources(
		taskRunId: string,
		snapshot: BoardTaskSnapshot,
		at: WorldPoint,
		sources: Array<{ itemId: string; sourcePortId: string; targetPortId: string }>,
		metadata?: Record<string, unknown>,
	) {
		if (options.readonly) return null;
		const task = createTaskBoardItem(taskRunId, snapshot, at.x, at.y, metadata);
		const arrows = sources
			.filter((source) => source.itemId !== task.id && scene.get(source.itemId))
			.map((source) => {
				const entry = createArrowBoardItem({ x: 0, y: 0 }, { item: task.id }, toolStyles.arrow.color, createBoardItemId(), toolStyles.arrow.size, { item: source.itemId });
				const props = (entry.item as BoardArrowItem).props;
				return {
					id: entry.id,
					item: {
						...entry.item,
						metadata: { boardFlow: { version: 1, kind: "content", sourcePortId: source.sourcePortId, targetPortId: source.targetPortId } },
						props: {
							...props,
							start: { item: source.itemId, anchor: "auto" as const, port: source.sourcePortId },
							end: { item: task.id, anchor: "auto" as const, port: source.targetPortId },
							relation: "input",
						},
					} as BoardItem,
				};
			});
		addEntries([task, ...arrows], false);
		selection = [task.id];
		return task.id;
	}

	function addText(text: string, at: WorldPoint) {
		addEntries([createTextBoardItem(text, at.x, at.y, toolStyles.text.color)]);
	}

	function addShape(at: WorldPoint) {
		const style = toolStyles.shape;
		addEntries([createShapeBoardItem(style.geometry, at.x, at.y, style.color)]);
	}

	function addFrame(at: WorldPoint) {
		addEntries([createFrameBoardItem(at.x, at.y, toolStyles.frame.color)]);
	}

	function commitBoxCreate(state: Extract<BoardInteraction, { type: "creatingBox" }>) {
		const dx = state.current.x - state.start.x;
		const dy = state.current.y - state.start.y;
		const click = Math.hypot(dx, dy) <= 6 / Math.max(camera.zoom, 0.0001);
		const minimum = state.kind === "frame" ? 48 : 24;
		const box = click
			? undefined
			: {
					x: Math.min(state.start.x, state.current.x),
					y: Math.min(state.start.y, state.current.y),
					width: Math.max(minimum, Math.abs(dx)),
					height: Math.max(minimum, Math.abs(dy)),
				};
		const geometry = isShapeKind(state.geometry) ? state.geometry : "rectangle";
		addEntries([
			state.kind === "shape"
				? createShapeBoardItem(geometry, state.start.x, state.start.y, state.color, state.id, box)
				: createFrameBoardItem(state.start.x, state.start.y, state.color, "Frame", state.id, box),
		]);
	}

	function commitDraw(id: string, points: BoardDrawPoint[], color: string, size: number) {
		if (points.length === 0) return;
		addEntries([createDrawBoardItem(points, color, size, id)]);
	}

	function beginTextDraft(at: WorldPoint) {
		const entry = createTextBoardItem("", at.x, at.y, toolStyles.text.color);
		writeDraft(placeNew([entry]), true);
		draftTextId = entry.id;
		selection = [entry.id];
		editingId = entry.id;
	}

	function commitTextEdit(id: string, text: string) {
		const isDraft = id === draftTextId;
		const target = displayItem(id);
		const empty = text.trim() === "" && (isDraft || target?.type === "text");
		editingId = null;
		draftTextId = null;
		if (empty) {
			if (isDraft) {
				draft.delete(id);
				rescene();
			} else deleteItem(id);
		} else updateText(id, text, isDraft);
		if (tool === "text") tool = "select";
		flushPendingRemote();
	}

	function deletionChanges(ids: Iterable<string>): { items: Map<string, BoardItem | null>; animations?: Record<string, BoardAnimation> } {
		const doomed = new Set<string>();
		for (const id of ids) {
			if (!scene.get(id)) continue;
			doomed.add(id);
			for (const child of scene.descendants(id)) doomed.add(child);
		}
		const changes = new Map<string, BoardItem | null>();
		for (const id of doomed) changes.set(id, null);
		for (const id of doomed) {
			for (const arrowId of scene.binders(id)) {
				if (doomed.has(arrowId) || changes.has(arrowId)) continue;
				const arrow = scene.get(arrowId) as SceneItem<BoardArrowItem> | undefined;
				if (!arrow) continue;
				const resolved = resolveSceneArrow(arrow, scene);
				const toLocal = invertMatrix(scene.layout.matrix(arrowId));
				const free = (end: BoardArrowEnd, point: WorldPoint): BoardArrowEnd => {
					if (!isArrowBinding(end) || !doomed.has(end.item)) return end;
					const local = applyMatrix(toLocal, point);
					return { x: local.x, y: local.y };
				};
				const { id: _id, frame: _frame, ...stored } = arrow;
				changes.set(arrowId, { ...stored, props: { ...arrow.props, start: free(arrow.props.start, resolved.start.point), end: free(arrow.props.end, resolved.end.point) } } as BoardItem);
			}
		}
		let animations: Record<string, BoardAnimation> | undefined;
		for (const [animationId, animation] of Object.entries(base.animations)) {
			const tracks = { ...animation.tracks };
			let changed = false;
			for (const [id, track] of Object.entries(tracks)) {
				const next = pruneBoardTrack(track, doomed);
				if (next === track) continue;
				changed = true;
				if (next) tracks[id] = next;
				else delete tracks[id];
			}
			if (!changed) continue;
			animations ??= { ...base.animations };
			animations[animationId] = { ...animation, tracks };
		}
		return { items: changes, ...(animations ? { animations } : {}) };
	}

	function deleteIds(ids: Iterable<string>) {
		const { items: changes, animations } = deletionChanges(ids);
		if (changes.size === 0) return;
		for (const [id, item] of changes) setDraftItem(id, item);
		commit(animations ? { animations } : {});
		selection = selection.filter((id) => !changes.has(id) || changes.get(id) !== null);
		if (editingId && changes.get(editingId) === null) editingId = null;
	}

	function deleteSelection() {
		const ids = unlockedIds(selection);
		if (ids.length === 0) return;
		deleteIds(ids);
		selection = [];
		editingId = null;
	}

	function deleteItem(id: string) {
		const target = scene.get(id);
		if (!target || isLocked(target)) return;
		deleteIds([id]);
	}

	function detachedSubtrees(ids: Iterable<string>): { items: Record<string, BoardItem>; roots: string[] } {
		const roots = rootsOf(ids);
		const items: Record<string, BoardItem> = {};
		for (const root of roots) {
			const item = scene.get(root);
			if (!item) continue;
			const { id: _id, frame, ...stored } = item;
			items[root] = reparent(stored as BoardItem, frame, undefined, scene.layout.box(root));
			for (const child of scene.descendants(root)) {
				const value = displayItem(child);
				if (value) items[child] = value;
			}
		}
		return { items, roots };
	}

	function arrowEndPoint(id: string, which: "start" | "end") {
		const arrow = scene.get(id) as SceneItem<BoardArrowItem> | undefined;
		if (arrow?.type !== "arrow") return null;
		const resolved = resolveSceneArrow(arrow, scene);
		return applyMatrix(invertMatrix(scene.layout.matrix(id)), (which === "start" ? resolved.start : resolved.end).point);
	}

	function duplicates(ids: string[], offset: number): Map<string, BoardItem> {
		const { items: copied } = detachedSubtrees(ids);
		for (const id of Object.keys(copied)) {
			for (const arrowId of scene.binders(id)) {
				const arrow = displayItem(arrowId);
				const shown = scene.get(arrowId);
				if (copied[arrowId] || !arrow || !shown || !arrowBindings(arrow).every((bound) => copied[bound])) continue;
				copied[arrowId] = reparent(arrow, shown.frame, undefined, scene.layout.box(arrowId));
			}
		}
		const idMap = new Map(Object.keys(copied).map((id) => [id, createBoardItemId()]));
		const moved = remapItems(
			copied,
			idMap,
			(item) => (item.parent && copied[item.parent] ? item : { ...item, position: { x: item.position.x + offset, y: item.position.y + offset } }),
			arrowEndPoint,
		);
		let z = topZ(undefined);
		return new Map(Object.entries(moved).map(([id, item]) => [id, item.parent ? item : { ...item, z: z++ }]));
	}

	function duplicateSelection() {
		if (options.readonly || selection.length === 0) return;
		const copies = duplicates(selection, DUPLICATE_OFFSET);
		if (copies.size === 0) return;
		const roots = [...copies].filter(([, item]) => !item.parent || !copies.has(item.parent)).map(([id]) => id);
		markAdded(roots);
		selection = roots;
		commitItems(copies);
	}

	function copySelection(): BoardClipboardPayload | null {
		if (selection.length === 0) return null;
		const { items: copied } = detachedSubtrees(selection);
		const origin = contentBounds(rootsOf(selection));
		const payload = origin ? encodeClipboard(copied, { x: origin.x, y: origin.y }) : null;
		if (payload) {
			internalClipboard = payload;
			pasteCount = 0;
		}
		return payload;
	}

	function cutSelection(): BoardClipboardPayload | null {
		const payload = copySelection();
		if (payload) deleteSelection();
		return payload;
	}

	function pasteClipboard(raw?: unknown, at?: WorldPoint) {
		if (options.readonly) return;
		const parsed = parseClipboard(raw) ?? (raw == null ? parseClipboard(internalClipboard) : null);
		if (!parsed) return;
		pasteCount += 1;
		const offset = at ?? { x: parsed.origin.x + defaultPasteOffset(pasteCount).x, y: parsed.origin.y + defaultPasteOffset(pasteCount).y };
		const pasted = materializeClipboard(parsed, offset);
		const entries = Object.entries(pasted).map(([id, item]) => ({ id, item }));
		const roots = entries.filter(({ item }) => !item.parent).map(({ id }) => id);
		const changes = placeNew(entries);
		markAdded(roots);
		selection = roots;
		commitItems(changes);
	}

	function placed(frames: ReadonlyMap<string, BoardFrame>): Map<string, BoardItem> {
		const changes = new Map<string, BoardItem>();
		for (const [id, frame] of frames) {
			const item = scene.get(id);
			if (item) changes.set(id, sceneItemToItem({ ...item, frame }, scene.layout));
		}
		return changes;
	}

	function nudgeSelection(dx: number, dy: number, large: boolean) {
		const ids = rootsOf(unlockedIds(selection));
		if (ids.length === 0) return;
		const step = large ? NUDGE_STEP_LARGE : NUDGE_STEP;
		const frames = new Map<string, BoardFrame>();
		for (const id of ids) {
			const frame = scene.get(id)?.frame;
			if (frame) frames.set(id, { ...frame, x: frame.x + dx * step, y: frame.y + dy * step });
		}
		commitItems(placed(frames));
	}

	function framesFor(ids: Iterable<string>): Map<string, BoardFrame> {
		const frames = new Map<string, BoardFrame>();
		for (const id of ids) {
			const frame = scene.get(id)?.frame;
			if (frame) frames.set(id, { ...frame });
		}
		return frames;
	}

	function alignSelection(mode: AlignMode) {
		const ids = rootsOf(unlockedIds(selection));
		if (ids.length < 2) return;
		commitItems(placed(alignFrames(framesFor(ids), mode)));
	}

	function distributeSelection(axis: DistributeAxis) {
		const ids = rootsOf(unlockedIds(selection));
		if (ids.length < 3) return;
		commitItems(placed(distributeFrames(framesFor(ids), axis)));
	}

	function editSelection(update: (item: BoardItem) => BoardItem | null, ids = unlockedIds(selection)) {
		const changes = new Map<string, BoardItem>();
		for (const id of ids) {
			const item = displayItem(id);
			const next = item ? update(item) : null;
			if (next && next !== item) changes.set(id, next);
		}
		commitItems(changes);
	}

	function toggleSelectionLock() {
		if (selection.length === 0) return;
		const lock = selectedItems.some((item) => !item.locked);
		editSelection((item) => {
			if (lock) return { ...item, locked: true };
			const { locked: _locked, ...unlocked } = item;
			return unlocked as BoardItem;
		}, selection);
	}

	function setSelectionColor(color: string) {
		editSelection((item) => {
			switch (item.type) {
				case "text":
					return { ...item, style: { ...item.style, fill: color } };
				case "shape":
				case "frame":
					return { ...item, style: { ...item.style, stroke: color, ...(item.style.fill ? { fill: color } : {}) } };
				case "draw":
				case "arrow":
					return { ...item, style: { ...item.style, stroke: color } };
				case "effect":
					return { ...item, style: { ...item.style, fill: color } };
				default:
					return null;
			}
		});
	}

	function setSelectionStyle(style: Partial<BoardItem["style"]>) {
		editSelection((item) => ({ ...item, style: { ...item.style, ...style } }) as BoardItem);
	}

	function setSelectionProps(type: string, props: Record<string, unknown>) {
		editSelection((item) => (item.type === type ? ({ ...item, props: { ...(item.props as object), ...props } } as BoardItem) : null));
	}

	function restack(front: boolean) {
		const ids = rootsOf(selection);
		if (ids.length === 0) return;
		const changes = new Map<string, BoardItem>();
		const byParent = new Map<string | undefined, string[]>();
		for (const id of ids) {
			const parent = scene.get(id)?.parent;
			byParent.set(parent, [...(byParent.get(parent) ?? []), id]);
		}
		for (const [parent, members] of byParent) {
			const siblings = scene.children(parent).map((id) => displayItem(id)?.z ?? 0);
			let z = front ? Math.max(0, ...siblings) + 1 : Math.min(0, ...siblings) - members.length;
			const ordered = members.sort((a, b) => scene.indexOf(a) - scene.indexOf(b));
			for (const id of ordered) {
				const item = displayItem(id);
				if (item) changes.set(id, { ...item, z: z++ });
			}
		}
		commitItems(changes);
	}

	function bringToFront() {
		restack(true);
	}

	function sendToBack() {
		restack(false);
	}

	function previewTextLayout(id: string, text: string) {
		const item = displayItem(id);
		if (item?.type !== "text" || item.props.text === text) return;
		writeDraft(new Map([[id, { ...item, props: { ...item.props, text } }]]));
	}

	function updateText(id: string, text: string, created = false) {
		const item = displayItem(id);
		if (!item || (item.type !== "text" && item.type !== "shape" && item.type !== "arrow" && item.type !== "frame")) return;
		const next = item.type === "arrow" || item.type === "frame"
			? { ...item, props: { ...item.props, label: text } }
			: { ...item, props: { ...item.props, text } };
		if (!created && sameJson(next, base.items[id])) {
			draft.delete(id);
			rescene([id]);
			return;
		}
		if (created) markAdded([id]);
		commitItems(new Map([[id, next as BoardItem]]));
	}

	function applyMediaFileChange(path: string, change: { size?: number; mtimeMs?: number; removed?: boolean }) {
		if (change.removed) return;
		const changes = new Map<string, BoardItem>();
		for (const id of mediaIdsForPath(path)) {
			const item = base.items[id];
			if (!item || (item.type !== "image" && item.type !== "video" && item.type !== "audio")) continue;
			const snapshot: BoardMediaSnapshot = { ...item.props.snapshot };
			if (change.size !== undefined) snapshot.size = change.size;
			if (change.mtimeMs !== undefined) snapshot.mtimeMs = change.mtimeMs;
			delete snapshot.naturalWidth;
			delete snapshot.naturalHeight;
			if (item.type === "audio") delete snapshot.durationMs;
			if (!sameJson(snapshot, item.props.snapshot ?? {})) changes.set(id, { ...item, props: { ...item.props, snapshot } } as BoardItem);
		}
		commitItems(changes, false);
	}

	function adoptMediaNaturalSizes(sizes: Array<{ id: string; width: number; height: number }>) {
		const changes = new Map<string, BoardItem>();
		for (const natural of sizes) {
			const item = base.items[natural.id];
			if (!item || natural.width <= 0 || natural.height <= 0) continue;
			if (item.type === "task") {
				const artifact = featuredTaskArtifact(item.props.snapshot.artifacts);
				if ((artifact?.type !== "image" && artifact?.type !== "video") || (artifact.naturalWidth && artifact.naturalHeight)) continue;
				const height = (item.size.width * natural.height) / natural.width;
				if (!Number.isFinite(height) || height <= 0) continue;
				changes.set(natural.id, {
					...item,
					position: { x: item.position.x, y: item.position.y + (item.size.height - height) / 2 },
					size: { ...item.size, height },
					props: {
						...item.props,
						snapshot: {
							...item.props.snapshot,
							artifacts: item.props.snapshot.artifacts.map((entry) => (entry.id === artifact.id ? { ...entry, naturalWidth: natural.width, naturalHeight: natural.height } : entry)),
						},
					},
				});
				continue;
			}
			if (item.type !== "image" && item.type !== "video") continue;
			if (item.props.snapshot?.naturalWidth && item.props.snapshot.naturalHeight) continue;
			const height = (item.size.width * natural.height) / natural.width;
			if (!Number.isFinite(height) || height <= 0) continue;
			changes.set(natural.id, {
				...item,
				position: { x: item.position.x, y: item.position.y + (item.size.height - height) / 2 },
				size: { ...item.size, height },
				props: { ...item.props, snapshot: { ...item.props.snapshot, naturalWidth: natural.width, naturalHeight: natural.height } },
			} as BoardItem);
		}
		commitItems(changes, false);
	}

	function applyFileSnapshots(snapshots: Array<{ id: string; snapshot: BoardFileSnapshotFacts; replace?: boolean }>) {
		const changes = new Map<string, BoardItem>();
		for (const entry of snapshots) {
			const item = base.items[entry.id];
			if (item?.type !== "file") continue;
			const merged = mergeFileSnapshot(item.props.snapshot, entry.snapshot, entry.replace === true);
			if (!sameJson(merged, item.props.snapshot ?? {})) changes.set(entry.id, { ...item, props: { ...item.props, snapshot: merged } });
		}
		commitItems(changes, false);
	}

	function applyTaskSnapshots(snapshots: ReadonlyMap<string, BoardTaskSnapshot>) {
		if (snapshots.size === 0) return;
		const changes = new Map<string, BoardItem>();
		for (const [id, item] of Object.entries(base.items)) {
			if (item.type !== "task") continue;
			const snapshot = snapshots.get(item.props.taskRunId);
			if (snapshot && !sameJson(snapshot, item.props.snapshot)) changes.set(id, { ...item, props: { ...item.props, snapshot } });
		}
		commitItems(changes, false);
	}

	function labelItemAt(point: WorldPoint): BoardSceneItem | null {
		ensureSpatial();
		const nearby = spatial.idsAtPoint(point);
		const candidates = selection.length === 1 ? [...selection, ...nearby] : nearby;
		for (const id of new Set(candidates)) {
			const item = scene.get(id);
			if (!item || isLocked(item)) continue;
			if (item.type === "frame" && rectContainsPoint({ x: item.frame.x, y: item.frame.y - 22, width: Math.max(48, item.frame.width * 0.5), height: 24 }, point)) return item;
			if (item.type === "arrow") {
				const resolved = resolveSceneArrow(item as SceneItem<BoardArrowItem>, scene);
				const radius = Math.max(10, (item.props.fontSize ?? 14) * 0.9) / Math.min(1, camera.zoom);
				if (Math.hypot(resolved.mid.x - point.x, resolved.mid.y - point.y) <= radius) return item;
			}
		}
		return null;
	}

	function hitsItem(item: BoardSceneItem, point: WorldPoint): boolean {
		if (item.type === "arrow") {
			const resolved = resolveSceneArrow(item as SceneItem<BoardArrowItem>, scene);
			return distanceToArrow(resolved, point) <= arrowHitRadius(item.style.strokeWidth) / Math.min(1, camera.zoom);
		}
		return shapeHitTest(item, point);
	}

	function topItemAt(point: WorldPoint, exclude?: ReadonlySet<string>): BoardSceneItem | null {
		ensureSpatial();
		for (const id of spatial.idsAtPoint(point)) {
			const item = scene.get(id);
			if (item && !exclude?.has(id) && hitsItem(item, point)) return item;
		}
		return null;
	}

	function idsInRect(rect: Rect): string[] {
		ensureSpatial();
		return spatial.idsInRect(rect);
	}

	function arrowHandleAt(point: WorldPoint): "start" | "end" | "mid" | null {
		if (selection.length !== 1) return null;
		const item = selectedItems[0];
		if (item?.type !== "arrow" || isLocked(item)) return null;
		const resolved = resolveSceneArrow(item as SceneItem<BoardArrowItem>, scene);
		const radius = (HANDLE_HIT_RADIUS + 2) / camera.zoom;
		const distance = (target: WorldPoint) => Math.hypot(target.x - point.x, target.y - point.y);
		const start = distance(resolved.start.point);
		const end = distance(resolved.end.point);
		const mid = distance(resolved.mid);
		if (start <= radius && start <= end && start <= mid) return "start";
		if (end <= radius && end <= mid) return "end";
		if (mid <= radius) return "mid";
		return null;
	}

	function connectTargetAt(point: WorldPoint, exclude: ReadonlySet<string>): string | null {
		const item = topItemAt(point, exclude);
		if (!item || isLocked(item) || item.type === "arrow") return null;
		return shapeCapabilities(item).canConnect ? item.id : null;
	}

	function computeTranslationSnap(moved: Map<string, BoardFrame>, skip: ReadonlySet<string>) {
		const movingBounds = selectionBounds([...moved.values()]);
		if (!movingBounds) return { dx: 0, dy: 0, guides: [] as SnapGuide[] };
		const view = surfaceSize.width > 0 ? { x: -camera.x / camera.zoom, y: -camera.y / camera.zoom, width: surfaceSize.width / camera.zoom, height: surfaceSize.height / camera.zoom } : null;
		const targets: Rect[] = [];
		for (const id of view ? idsInRect(view) : scene.items.map((item) => item.id)) {
			if (skip.has(id)) continue;
			const item = scene.get(id);
			if (item && shapeCapabilities(item).canSnap) targets.push(shapeBounds(item));
		}
		return computeSnap(movingBounds, targets, { threshold: SNAP_THRESHOLD / Math.max(camera.zoom, 0.0001), gridSize: gridSnapSize() });
	}

	function gridSnapSize(): number {
		const grid = base.board.grid;
		return grid?.visible === true ? (grid.size ?? 0) : 0;
	}

	function withSubtrees(ids: Iterable<string>): Set<string> {
		const result = new Set<string>();
		for (const id of ids) {
			result.add(id);
			for (const child of scene.descendants(id)) result.add(child);
		}
		return result;
	}

	function reparentDropped(ids: readonly string[]): Map<string, BoardItem> {
		const changes = new Map<string, BoardItem>();
		const moving = withSubtrees(ids);
		for (const id of ids) {
			const item = scene.get(id);
			if (!item || item.type === "arrow") continue;
			const container = frameAt(rectCenter(item.frame), moving);
			const parent = container?.id;
			if (parent === item.parent) continue;
			const stored = displayItem(id);
			if (!stored) continue;
			changes.set(id, { ...reparent(stored, item.frame, parent, scene.layout.box(id)), z: topZ(parent) + changes.size });
		}
		return changes;
	}

	function portItemId(): string | null {
		if (options.readonly || tool !== "select" || editingId) return null;
		if (interaction.type !== "idle" && interaction.type !== "creatingArrow") return null;
		const hoverReveals = !canTapSelectWithHand(hoverPointerType);
		const candidateId = selection.length === 1 ? selection[0] : hoverReveals ? hoverId : null;
		if (!candidateId) return null;
		const item = scene.get(candidateId);
		if (!item || isLocked(item) || item.type === "arrow") return null;
		return shapeCapabilities(item).canConnect ? item.id : null;
	}

	function visiblePorts(): Array<ConnectionPort & { itemId: string }> {
		const itemId = portItemId();
		const item = itemId ? scene.get(itemId) : null;
		if (!itemId || !item) return [];
		return connectionPorts(item.frame, camera.zoom).map((port) => ({ ...port, itemId }));
	}

	function connectionPortAt(point: WorldPoint, pointerType: string): (ConnectionPort & { itemId: string }) | null {
		const itemId = portItemId();
		const item = itemId ? scene.get(itemId) : null;
		if (!itemId || !item) return null;
		const port = portAt(item.frame, point, camera.zoom, pointerType);
		return port ? { ...port, itemId } : null;
	}

	function arrowEnd(point: WorldPoint, targetItemId: string | null, arrowMatrix = IDENTITY_MATRIX): BoardArrowEnd {
		if (targetItemId) return { item: targetItemId, anchor: "auto" };
		const local = applyMatrix(invertMatrix(arrowMatrix), point);
		return { x: local.x, y: local.y };
	}

	function commitArrow(gesture: Extract<BoardInteraction, { type: "creatingArrow" }>, cancelled: boolean) {
		const { start, current, startItemId, targetItemId } = gesture;
		const bound = !cancelled && targetItemId && targetItemId !== startItemId ? targetItemId : null;
		if (!bound && Math.hypot(current.x - start.x, current.y - start.y) < 2 / camera.zoom) return;
		const entry = createArrowBoardItem(
			start,
			bound ? { item: bound } : current,
			gesture.color,
			gesture.id,
			gesture.size,
			startItemId ? { item: startItemId, ...(gesture.startSide ? { anchor: { side: gesture.startSide, offset: 0.5 } } : {}) } : undefined,
		);
		addEntries([entry]);
	}

	function appendDrawSample(gesture: Extract<BoardInteraction, { type: "drawing" }>, event: BoardPointerEvent) {
		const points = appendBoardDrawSample(gesture.points, gesture.pointerId, event, camera.zoom);
		return points === gesture.points ? gesture : { ...gesture, points };
	}

	function beginPinch() {
		const [a, b] = [...activePointers.values()];
		if (!a || !b) return;
		pinch = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), midpoint: screenPoint((a.x + b.x) / 2, (a.y + b.y) / 2), zoom: camera.zoom };
		interaction = { type: "idle" };
	}

	function toggleInSelection(id: string) {
		selection = selection.includes(id) ? selection.filter((selected) => selected !== id) : [...selection, id];
	}

	function pointerDown(event: BoardPointerEvent) {
		cancelCameraAnimation();
		hoverPoint = event.world;
		hoverPointerType = event.pointerType;
		if (interaction.type === "drawing" && interaction.pointerId !== event.pointerId) return;
		activePointers.set(event.pointerId, event.screen);
		if (activePointers.size === 2) {
			beginPinch();
			return;
		}
		if (activePointers.size > 2) return;

		const additive = event.shiftKey || event.metaKey || event.ctrlKey;
		if (tool === "hand" || spaceHeld || event.button === 1) {
			const tapSelection = tool === "hand" && !spaceHeld && event.button !== 1 && canTapSelectWithHand(event.pointerType)
				? { targetId: topItemAt(event.world)?.id ?? null }
				: null;
			interaction = { type: "panning", start: event.screen, origin: { ...camera }, moved: false, tapSelection };
			return;
		}

		if (options.readonly) {
			const hit = topItemAt(event.world);
			if (hit) {
				if (additive) toggleInSelection(hit.id);
				else selection = [hit.id];
				interaction = { type: "idle" };
				return;
			}
			interaction = { type: "brushing", start: event.world, current: event.world, additive, baseSelection: selection };
			return;
		}

		if (tool === "draw") {
			const style = toolStyles.draw;
			interaction = { type: "drawing", id: createBoardItemId(), pointerId: event.pointerId, points: [{ x: event.world.x, y: event.world.y, p: event.pressure }], color: style.color, size: style.size };
			return;
		}
		if (tool === "arrow") {
			const style = toolStyles.arrow;
			const startItemId = connectTargetAt(event.world, emptyIds);
			interaction = { type: "creatingArrow", id: createBoardItemId(), start: event.world, current: event.world, startItemId, startSide: null, targetItemId: null, color: style.color, size: style.size };
			return;
		}
		if (tool === "shape" || tool === "frame") {
			interaction = {
				type: "creatingBox",
				id: createBoardItemId(),
				kind: tool,
				start: event.world,
				current: event.world,
				color: tool === "shape" ? toolStyles.shape.color : toolStyles.frame.color,
				geometry: toolStyles.shape.geometry,
			};
			return;
		}
		if (tool === "text") {
			beginTextDraft(event.world);
			return;
		}

		const port = connectionPortAt(event.world, event.pointerType);
		if (port) {
			const style = toolStyles.arrow;
			interaction = { type: "creatingArrow", id: createBoardItemId(), start: port.point, current: event.world, startItemId: port.itemId, startSide: port.side, targetItemId: null, color: style.color, size: style.size };
			return;
		}

		const arrowHandle = arrowHandleAt(event.world);
		const arrow = selectedItems[0];
		if (arrowHandle && arrow?.type === "arrow") {
			const { id: _id, frame: _frame, ...origin } = arrow;
			interaction = { type: "draggingArrowHandle", arrowId: arrow.id, which: arrowHandle, origin: origin as BoardArrowItem, targetItemId: null, moved: false };
			return;
		}

		const transformControl = selectionTransformControlAt(selectionTransform, event.world, camera.zoom, event.pointerType);
		if (transformControl?.kind === "rotate" && bounds) {
			const pivot = rectCenter(bounds);
			interaction = { type: "rotating", pivot, startAngle: angleFrom(pivot, event.world), current: event.world, origin: framesFor(rootsOf(unlockedIds(selection))), moved: false };
			return;
		}
		if (transformControl?.kind === "resize" && bounds) {
			const origin = framesFor(rootsOf(unlockedIds(selection)));
			const single = origin.size === 1 ? { ...([...origin.values()][0] as BoardFrame) } : null;
			interaction = { type: "resizing", handle: transformControl.handle, single, bounds, origin, moved: false };
			return;
		}

		const item = topItemAt(event.world);
		if (item) {
			if (additive) toggleInSelection(item.id);
			else if (!selection.includes(item.id)) selection = [item.id];
			const movable = rootsOf(unlockedIds(selection));
			interaction = movable.length === 0
				? { type: "idle" }
				: { type: "translating", start: event.world, origin: framesFor(movable), moved: false, duplicate: event.altKey };
			return;
		}

		interaction = { type: "brushing", start: event.world, current: event.world, additive, baseSelection: selection };
	}

	function angleFrom(center: WorldPoint, point: WorldPoint) {
		return (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI;
	}

	function pointerMove(event: BoardPointerEvent) {
		hoverPoint = event.world;
		hoverPointerType = event.pointerType;
		if (activePointers.has(event.pointerId)) activePointers.set(event.pointerId, event.screen);

		if (pinch && activePointers.size >= 2) {
			const [a, b] = [...activePointers.values()];
			if (a && b) {
				const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
				const midpoint = screenPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
				const zoomed = zoomAround(camera, midpoint, clampZoom(pinch.zoom * (distance / pinch.distance)));
				setCamera(panBy(zoomed, midpoint.x - pinch.midpoint.x, midpoint.y - pinch.midpoint.y));
				pinch = { ...pinch, midpoint };
			}
			return;
		}

		switch (interaction.type) {
			case "idle":
				hoverId = hoveredTransformControl ? null : (topItemAt(event.world)?.id ?? null);
				return;
			case "panning": {
				const dx = event.screen.x - interaction.start.x;
				const dy = event.screen.y - interaction.start.y;
				if (interaction.tapSelection && !interaction.moved && isWithinHandTapSlop(dx, dy)) return;
				if (!interaction.moved) interaction = { ...interaction, moved: true };
				setCamera(panBy(interaction.origin, dx, dy));
				return;
			}
			case "translating": {
				let dx = event.world.x - interaction.start.x;
				let dy = event.world.y - interaction.start.y;
				if (!interaction.moved) {
					if (Math.hypot(dx, dy) <= DRAG_THRESHOLD / camera.zoom) return;
					if (interaction.duplicate) {
						const clones = duplicates([...interaction.origin.keys()], 0);
						if (clones.size > 0) {
							writeDraft(clones, true);
							const roots = [...clones].filter(([, item]) => !item.parent || !clones.has(item.parent)).map(([id]) => id);
							selection = roots;
							interaction = { ...interaction, origin: framesFor(roots), duplicate: false, moved: true };
						} else interaction.moved = true;
					} else interaction.moved = true;
				}
				if (event.shiftKey) {
					if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
					else dx = 0;
				}
				const shift = (tx: number, ty: number) => {
					const frames = new Map<string, BoardFrame>();
					for (const [id, frame] of interaction.type === "translating" ? interaction.origin : []) frames.set(id, { ...frame, x: frame.x + tx, y: frame.y + ty });
					return frames;
				};
				let tx = dx;
				let ty = dy;
				if (!event.metaKey && !event.ctrlKey) {
					const snap = computeTranslationSnap(shift(dx, dy), withSubtrees(interaction.origin.keys()));
					tx += snap.dx;
					ty += snap.dy;
					snapGuides = snap.guides;
				} else snapGuides = [];
				writeDraft(placed(shift(tx, ty)));
				return;
			}
			case "resizing": {
				interaction.moved = true;
				const frames = new Map<string, BoardFrame>();
				if (interaction.single) {
					const id = [...interaction.origin.keys()][0] as string;
					const item = scene.get(id);
					const keepAspect = item ? shapeCapabilities(item).aspectLocked || event.shiftKey : event.shiftKey;
					frames.set(id, resizeFrame(interaction.single, interaction.handle, event.world, undefined, keepAspect));
				} else {
					const scaled = scaleFrames([...interaction.origin.values()], interaction.bounds, interaction.handle, event.world);
					[...interaction.origin.keys()].forEach((id, index) => {
						const frame = scaled[index];
						if (frame) frames.set(id, frame);
					});
				}
				writeDraft(placed(frames));
				return;
			}
			case "rotating": {
				interaction.moved = true;
				interaction.current = event.world;
				let delta = angleFrom(interaction.pivot, event.world) - interaction.startAngle;
				if (event.shiftKey) delta = Math.round(delta / 15) * 15;
				const rotated = rotateFrames([...interaction.origin.values()], interaction.pivot, delta);
				const frames = new Map<string, BoardFrame>();
				[...interaction.origin.keys()].forEach((id, index) => {
					const frame = rotated[index];
					if (frame) frames.set(id, { ...frame, rotation: normalizeRotation(frame.rotation) });
				});
				writeDraft(placed(frames));
				return;
			}
			case "draggingArrowHandle": {
				interaction.moved = true;
				const { arrowId, which, origin } = interaction;
				const arrow = scene.get(arrowId) as SceneItem<BoardArrowItem> | undefined;
				if (!arrow) return;
				if (which === "mid") {
					const resolved = resolveSceneArrow({ ...arrow, props: origin.props }, scene);
					const start = resolved.start.point;
					const end = resolved.end.point;
					const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
					const mid = worldPoint((start.x + end.x) / 2, (start.y + end.y) / 2);
					const bend = ((event.world.x - mid.x) * -(end.y - start.y) + (event.world.y - mid.y) * (end.x - start.x)) / (length * length);
					const route = origin.props.route === "straight" ? "curve" : origin.props.route;
					writeDraft(new Map([[arrowId, { ...origin, props: { ...origin.props, route, bend: Math.max(-0.85, Math.min(0.85, bend)) } } as BoardItem]]));
					snapGuides = [];
					return;
				}
				const targetItemId = connectTargetAt(event.world, new Set([arrowId]));
				let point = event.world;
				if (!targetItemId && !event.metaKey && !event.ctrlKey) {
					const snap = computeSnap({ x: point.x, y: point.y, width: 0, height: 0 }, scene.items.filter((item) => item.id !== arrowId && shapeCapabilities(item).canSnap).map((item) => shapeBounds(item)), {
						threshold: SNAP_THRESHOLD / Math.max(camera.zoom, 0.0001),
						gridSize: gridSnapSize(),
					});
					point = worldPoint(point.x + snap.dx, point.y + snap.dy);
					snapGuides = snap.guides;
				} else snapGuides = [];
				interaction = { ...interaction, targetItemId };
				const end = arrowEnd(point, targetItemId, scene.layout.matrix(arrowId));
				writeDraft(new Map([[arrowId, { ...origin, props: { ...origin.props, [which]: end } } as BoardItem]]), true);
				return;
			}
			case "brushing": {
				interaction = { ...interaction, current: event.world };
				const rect = marquee;
				if (!rect) return;
				const hits = idsInRect(rect).filter((id) => {
					const item = scene.get(id);
					return item && !item.parent && rectsIntersect(boundsOf(item), rect);
				});
				selection = interaction.additive ? [...new Set([...interaction.baseSelection, ...hits])] : hits;
				return;
			}
			case "drawing":
				if ((event.buttons & 1) === 0) return;
				interaction = appendDrawSample(interaction, event);
				return;
			case "creatingArrow": {
				const exclude = interaction.startItemId ? new Set([interaction.startItemId]) : emptyIds;
				interaction = { ...interaction, current: event.world, targetItemId: connectTargetAt(event.world, exclude) };
				return;
			}
			case "creatingBox":
				interaction = { ...interaction, current: event.world };
				return;
		}
	}

	function pointerUp(event: BoardPointerEvent) {
		hoverPoint = event.world;
		hoverPointerType = event.pointerType;
		activePointers.delete(event.pointerId);
		if (activePointers.size < 2) pinch = null;
		if (activePointers.size > 0) return;
		if (interaction.type === "drawing" && interaction.pointerId !== event.pointerId) return;

		const gesture = interaction;
		snapGuides = [];
		interaction = { type: "idle" };

		switch (gesture.type) {
			case "panning":
				if (gesture.tapSelection && !gesture.moved && !event.cancelled) {
					const targetId = gesture.tapSelection.targetId;
					selection = targetId && scene.get(targetId) ? [targetId] : [];
				}
				break;
			case "translating":
				if (gesture.moved) {
					for (const [id, item] of reparentDropped(rootsOf(selection))) setDraftItem(id, item);
					commit();
				}
				break;
			case "resizing":
			case "rotating":
			case "draggingArrowHandle":
				if (gesture.moved) commit();
				break;
			case "brushing":
				if (!gesture.additive && Math.hypot(gesture.current.x - gesture.start.x, gesture.current.y - gesture.start.y) <= 1 / camera.zoom) selection = [];
				break;
			case "drawing": {
				const finished = appendDrawSample(gesture, event);
				commitDraw(finished.id, finished.points, finished.color, finished.size);
				break;
			}
			case "creatingArrow":
				commitArrow(gesture, event.cancelled);
				break;
			case "creatingBox":
				commitBoxCreate(gesture);
				break;
		}
		flushPendingRemote();
	}

	function pointerLeave() {
		if (interaction.type !== "idle") return;
		hoverPoint = null;
		hoverId = null;
	}

	function wheel(point: ScreenPoint, deltaX: number, deltaY: number, zoomKey: boolean, deltaMode = 0) {
		cancelCameraAnimation();
		if (zoomKey) {
			setCamera(zoomAround(camera, point, camera.zoom * wheelZoomFactor(deltaY, deltaMode)));
			return;
		}
		setCamera(panBy(camera, -normalizeWheelDelta(deltaX, deltaMode) * 1.15, -normalizeWheelDelta(deltaY, deltaMode) * 1.15));
	}

	function setPlayhead(next: BoardPlayhead | null) {
		if (next && !base.animations[next.animationId]) next = null;
		if (sameJson(next, playhead)) return;
		playhead = next;
		if (!next) recording = false;
		draft.clear();
		draftOrigins.clear();
		reevaluate();
		rescene();
	}

	function setRecording(value: boolean) {
		recording = value && playhead !== null && !options.readonly;
	}

	function tracksFor(itemId: string): Map<string, [string, BoardTrack]> {
		const result = new Map<string, [string, BoardTrack]>();
		const animation = playhead ? base.animations[playhead.animationId] : undefined;
		if (!animation) return result;
		for (const [trackId, track] of Object.entries(animation.tracks)) if (track.target === itemId) result.set(track.property, [trackId, track]);
		return result;
	}

	function keyframeState(property: string): "none" | "animated" | "keyframe" {
		if (!playhead || selectedItems.length === 0) return "none";
		const time = Math.round(playhead.time);
		let animated = true;
		let keyed = true;
		for (const item of selectedItems) {
			const track = tracksFor(item.id).get(property)?.[1];
			if (!track) animated = false;
			if (!track?.keyframes.some((keyframe) => keyframe.at === time)) keyed = false;
		}
		return keyed ? "keyframe" : animated ? "animated" : "none";
	}

	function toggleKeyframe(property: string) {
		if (options.readonly || !playhead) return;
		const animation = base.animations[playhead.animationId];
		if (!animation) return;
		const time = Math.round(playhead.time);
		const tracks = { ...animation.tracks };
		const remove = keyframeState(property) === "keyframe";
		for (const item of selectedItems) {
			const existing = tracksFor(item.id).get(property);
			const shown = readPath(displayItem(item.id), property.split("."));
			if (remove && existing) {
				const keyframes = existing[1].keyframes.filter((keyframe) => keyframe.at !== time);
				if (keyframes.length) tracks[existing[0]] = { ...existing[1], keyframes };
				else delete tracks[existing[0]];
			} else if (!remove) {
				const [trackId, track]: [string, BoardTrack] = existing ?? [`${item.id}-${property.replaceAll(".", "-")}`, { target: item.id, property, keyframes: [], composite: "replace", interpolation: "auto" }];
				const keyframes = [...track.keyframes.filter((keyframe) => keyframe.at !== time), { at: time, value: shown }].sort((a, b) => a.at - b.at);
				tracks[trackId] = { ...track, keyframes };
			}
		}
		commit({ animations: { ...base.animations, [playhead.animationId]: { ...animation, duration: Math.max(animation.duration, time), tracks } } });
	}

	function createAnimation(name: string, duration = 5000): string {
		const id = createBoardItemId();
		commit({ animations: { ...base.animations, [id]: { name, duration, play: "manual", delay: 0, loop: false, end: "hold", markers: [], tracks: {} } } });
		setPlayhead({ animationId: id, time: 0 });
		return id;
	}

	function emitViewState() {
		if (!options.onViewStateChange) return;
		const visibleRect = surfaceSize.width > 0 && surfaceSize.height > 0
			? { x: -camera.x / camera.zoom, y: -camera.y / camera.zoom, width: surfaceSize.width / camera.zoom, height: surfaceSize.height / camera.zoom }
			: null;
		const selectedNodes = selectedItems.map((item) => {
			const title = titleForBoardItem(item).trim();
			return { id: item.id, type: item.type, ...(title ? { title } : {}) };
		});
		options.onViewStateChange({ visibleRect, selectedNodes });
	}

	$effect(() => {
		camera;
		surfaceSize;
		selectedItems;
		emitViewState();
	});

	function loadDocument(next: BoardDocument, key?: string) {
		if (untrack(() => next === base)) return;
		const sameDocument = key !== undefined && key === currentKey;
		if (sameDocument && (untrack(() => interaction.type !== "idle") || untrack(() => editingId))) {
			pendingRemote = { document: next, key };
			return;
		}
		applyRemote(next, key, sameDocument);
	}

	function applyRemote(next: BoardDocument, key: string | undefined, sameDocument: boolean) {
		currentKey = key;
		pendingRemote = null;
		if (sameDocument) {
			const added = Object.keys(next.items).filter((id) => !base.items[id]);
			markAdded(added);
			const changed = new Set<string>([...added, ...Object.keys(base.items).filter((id) => next.items[id] !== base.items[id])]);
			const keep = draftTextId ? draft.get(draftTextId) : undefined;
			adopt(next, changed);
			if (draftTextId && keep) writeDraft(new Map([[draftTextId, keep]]), true);
			selection = selection.filter((id) => scene.get(id));
			if (playhead && !next.animations[playhead.animationId]) setPlayhead(null);
			return;
		}
		base = next;
		draft.clear();
		draftOrigins.clear();
		played = new Map();
		playhead = null;
		recording = false;
		reevaluate();
		scene = buildBoardScene(next);
		spatialDirty = null;
		mediaIdsByPath = null;
		structureVersion += 1;
		geometryVersion += 1;
		undoStack = [];
		redoStack = [];
		selection = [];
		editingId = null;
		draftTextId = null;
		saveError = null;
	}

	function flushPendingRemote() {
		if (!pendingRemote) return;
		const pending = pendingRemote;
		pendingRemote = null;
		applyRemote(pending.document, pending.key, pending.key !== undefined && pending.key === currentKey);
	}

	function destroy() {
		cancelCameraAnimation();
		activePointers.clear();
	}

	return {
		get document() {
			return base;
		},
		get scene() {
			return scene;
		},
		get items() {
			return items;
		},
		get settings() {
			return settingsPreview ?? base.board;
		},
		get animations() {
			return base.animations;
		},
		get playhead() {
			return playhead;
		},
		get recording() {
			return recording;
		},
		get camera() {
			return camera;
		},
		get selection() {
			return selection;
		},
		get selectedItems() {
			return selectedItems;
		},
		get hasFocusableSelection() {
			return selectedItems.length > 0;
		},
		get bounds() {
			return bounds;
		},
		get selectionTransform() {
			return selectionTransform;
		},
		get hoveredTransformControl() {
			return hoveredTransformControl;
		},
		get pointerType() {
			return hoverPointerType;
		},
		get marquee() {
			return marquee;
		},
		get tool() {
			return tool;
		},
		get interaction() {
			return interaction;
		},
		get hoverId() {
			return hoverId;
		},
		get connectionPorts(): Array<{ itemId: string; x: number; y: number; radius: number }> {
			return visiblePorts().map((port) => ({ itemId: port.itemId, x: port.point.x, y: port.point.y, radius: CONNECTION_PORT_RADIUS }));
		},
		get hoveredConnectionPort(): { x: number; y: number } | null {
			if (!hoverPoint) return null;
			const port = connectionPortAt(hoverPoint, hoverPointerType);
			return port ? { x: port.point.x, y: port.point.y } : null;
		},
		get arrowDraft() {
			if (interaction.type !== "creatingArrow") return null;
			const target = interaction.targetItemId ? scene.get(interaction.targetItemId) : null;
			return {
				from: interaction.start,
				to: interaction.current,
				size: interaction.size,
				color: interaction.color,
				targetFrame: target?.frame ?? null,
			};
		},
		get bindTargetFrame(): BoardFrame | null {
			const id = interaction.type === "draggingArrowHandle" ? interaction.targetItemId : null;
			return id ? (scene.get(id)?.frame ?? null) : null;
		},
		get editingId() {
			return editingId;
		},
		get saveError() {
			return saveError;
		},
		get saving() {
			return pendingCommits > 0;
		},
		get canUndo() {
			return undoStack.length > 0;
		},
		get canRedo() {
			return redoStack.length > 0;
		},
		get hasContent() {
			return scene.items.length > 0;
		},
		get snapGuides() {
			return snapGuides;
		},
		get structureVersion() {
			return structureVersion;
		},
		get geometryVersion() {
			return geometryVersion;
		},
		consumeRecentlyAdded(): string[] {
			const ids = [...recentlyAdded];
			recentlyAdded.clear();
			return ids;
		},
		get gestureActive() {
			return interaction.type !== "idle";
		},
		get activeColor() {
			const id = styledToolId();
			return id ? toolStyles[id].color : toolStyles.text.color;
		},
		get activeShape() {
			return toolStyles.shape.geometry;
		},
		get activeStrokeSize() {
			return tool === "arrow" ? toolStyles.arrow.size : toolStyles.draw.size;
		},
		get spaceHeld() {
			return spaceHeld;
		},
		get selectionLocked() {
			return selectedItems.length > 0 && selectedItems.every((item) => item.locked);
		},
		set tool(value: BoardToolId) {
			if (options.readonly && value !== "hand" && value !== "select") {
				tool = "hand";
				return;
			}
			tool = value;
			if (value === "draw" || value === "arrow") {
				selection = [];
				editingId = null;
			}
		},
		set editingId(value: string | null) {
			editingId = value;
		},
		set surfaceSize(value: { width: number; height: number }) {
			surfaceSize = value;
		},
		set activeColor(value: string) {
			const id = styledToolId();
			if (!id || !isBoardColorId(value)) return;
			toolStyles[id].color = value;
			writeBoardToolStyles(toolStyles);
		},
		set activeShape(value: string) {
			if (!isShapeKind(value)) return;
			toolStyles.shape.geometry = value;
			writeBoardToolStyles(toolStyles);
		},
		set activeStrokeSize(value: number) {
			if (!Number.isFinite(value)) return;
			const size = clampBoardStrokeSize(value);
			if (tool === "arrow") toolStyles.arrow.size = size;
			else if (tool === "draw") toolStyles.draw.size = size;
			else return;
			writeBoardToolStyles(toolStyles);
		},
		set spaceHeld(value: boolean) {
			spaceHeld = value;
		},
		setSettings,
		previewSettings,
		setPlayhead,
		setPlayedItems,
		setRecording,
		keyframeState,
		toggleKeyframe,
		createAnimation,
		zoomIn,
		zoomOut,
		resetZoom,
		fitView,
		focusRect,
		focusItems,
		focusNode,
		focusSelection,
		zoomAt,
		setCamera,
		viewCenter,
		itemAt: topItemAt,
		labelItemAt,
		itemById,
		idsInRect,
		setSelection,
		clearSelection,
		selectAll,
		addApp,
		addFile,
		addTask,
		addTaskWithSources,
		addText,
		addShape,
		addFrame,
		beginTextDraft,
		commitTextEdit,
		deleteSelection,
		deleteItem,
		duplicateSelection,
		nudgeSelection,
		alignSelection,
		distributeSelection,
		toggleSelectionLock,
		copySelection,
		cutSelection,
		pasteClipboard,
		setSelectionColor,
		setSelectionStyle,
		setSelectionProps,
		bringToFront,
		sendToBack,
		updateText,
		previewTextLayout,
		applyMediaFileChange,
		adoptMediaNaturalSizes,
		applyFileSnapshots,
		applyTaskSnapshots,
		retrySave,
		undo,
		redo,
		pointerDown,
		pointerMove,
		pointerUp,
		pointerLeave,
		wheel,
		loadDocument,
		destroy,
	};
}

export type BoardEditor = ReturnType<typeof createBoardEditor>;
