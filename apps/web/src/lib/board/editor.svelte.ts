import type { BoardSemanticCommand } from "@cohub/protocol";
import type {
	BoardFileSnapshot,
	BoardMediaSnapshot,
	DrawPoint,
} from "@neta-art/cohub/board";
import {
	anchorPointOnFrame,
	angleFromCenter,
	applyBoardSemanticCommands,
	boardDocumentToSemanticCommands,
	cameraForRect,
	clampZoom,
	connectionHitRadius,
	connectionHitTest,
	createBoardConnection,
	createConnectionGeometryCache,
	createConnectionIndex,
	type FrameLookup,
	featuredTaskArtifact,
	fitToContent,
	HANDLE_HIT_RADIUS,
	itemBounds,
	mergeFileSnapshot,
	normalizeRotation,
	normalizeViewport,
	panBy,
	pointsBounds,
	pointToWorld,
	type Rect,
	type ResizeHandle,
	rectCenter,
	rectContainsPoint,
	rectsIntersect,
	resizeFrame,
	resizeFrameToSize,
	rotateFrames,
	type ScreenPoint,
	scaleFrames,
	screenPoint,
	selectionBounds,
	shapeBounds,
	shapeCapabilities,
	shapeHitTest,
	translateArrow,
	unionRects,
	type WorldPoint,
	worldPoint,
	zoomAround,
} from "@neta-art/cohub/board";
import { untrack } from "svelte";
import { createCommitQueue } from "$lib/board/board-commit-queue";
import { reconcileExternal } from "$lib/board/board-document";
import { appendBoardDrawSample } from "$lib/board/board-draw-input";
import { createBoardItemId } from "$lib/board/board-id";
import {
	createAppBoardItem,
	createArrowBoardItem,
	createDrawBoardItem,
	createFileNodeForPath,
	createFrameBoardItem,
	createGeoBoardItem,
	createTaskBoardItem,
	createTextBoardItem,
	duplicateBoardItem,
	patchItemFrames,
	removeBoardItems,
	titleForBoardItem,
} from "$lib/board/board-items";
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
} from "$lib/board/core/clipboard";
import {
	CONNECTION_PORT_RADIUS,
	type ConnectionPort,
	connectionPorts,
	connectionPortAt as portAt,
	portHitRadius,
} from "$lib/board/core/connection-ports";
import {
	resolveSelectionTransform,
	selectionTransformControlAt,
} from "$lib/board/core/selection-transform";
import {
	arrowBoundsFor,
	arrowHitTest,
	resolveArrowFor,
} from "$lib/board/core/shapes";
import { computeSnap, type SnapGuide } from "$lib/board/core/snapping";
import "$lib/board/core/shapes";
import type {
	BoardArrowItem,
	BoardConnection,
	BoardConnectionAnchor,
	BoardDocument,
	BoardFrame,
	BoardItem,
	BoardItemStyle,
	BoardTaskSnapshot,
	BoardViewport,
} from "@neta-art/cohub/board";
import {
	type BoardStyledToolId,
	clampBoardStrokeSize,
	clampBoardTextFontSize,
	isBoardColorId,
	isGeoKind,
	measureBoardText,
} from "@neta-art/cohub/board";
import { ensureBoardTextMeasurement } from "@neta-art/cohub/board/render";
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

export type { BoardToolId } from "$lib/board/board-tool";
export type BoardEmphasis = BoardItemStyle["emphasis"];
export type { AlignMode, DistributeAxis };

/**
 * The synced portion of a board document (everything semantic ops describe).
 * The camera/viewport is deliberately excluded: it is local UI state, never
 * part of a transaction.
 */
type SyncedContent = {
	kind: BoardDocument["kind"];
	version: BoardDocument["version"];
	appearance: BoardDocument["appearance"];
	items: BoardItem[];
	connections: BoardConnection[];
};

export type BoardInteraction =
	| { type: "idle" }
	| {
			type: "panning";
			start: ScreenPoint;
			origin: BoardViewport;
			moved: boolean;
			/** Touch/pen Hand taps may select without turning a drag into an edit. */
			tapSelection: { targetId: string | null } | null;
	  }
	| {
			type: "translating";
			start: WorldPoint;
			origin: Map<string, BoardFrame>;
			/** Origin arrow items, so endpoints translate from their gesture-start
			 * positions (an arrow's geometry lives in its endpoints, not its frame). */
			arrowOrigin: Map<string, BoardArrowItem>;
			moved: boolean;
			/** Alt-drag: duplicate on first move, then translate the copies. */
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
			/** Selection at brush start, so an additive marquee can add and remove. */
			baseSelection: string[];
	  }
	| {
			type: "drawing";
			id: string;
			pointerId: number;
			/** Raw world-space samples collected so far. */
			points: DrawPoint[];
			color: string;
			size: number;
	  }
	| {
			type: "creatingArrow";
			id: string;
			start: WorldPoint;
			current: WorldPoint;
			color: string;
			size: number;
	  }
	/**
	 * Dragging a new relation out of a node's connection port.
	 *
	 * Nothing is written until the gesture lands on a valid target, so an abandoned
	 * drag leaves no trace — the same rule the text draft follows.
	 */
	| {
			type: "creatingConnection";
			sourceItemId: string;
			/** Port the drag started from, kept as the source anchor. */
			sourceAnchor: BoardConnectionAnchor;
			current: WorldPoint;
			/** Candidate under the pointer, or null while over empty space. */
			targetItemId: string | null;
	  }
	/** Re-pointing one end of an existing relation onto another node. */
	| {
			type: "draggingConnectionEnd";
			connectionId: string;
			which: "source" | "target";
			/** The relation as it was when the drag began, for a clean cancel. */
			origin: BoardConnection;
			current: WorldPoint;
			targetItemId: string | null;
			moved: boolean;
	  }
	| {
			type: "creatingBox";
			id: string;
			kind: "geo" | "frame";
			start: WorldPoint;
			current: WorldPoint;
			color: string;
			geo: string;
	  }
	| {
			type: "draggingArrowHandle";
			arrowId: string;
			which: "start" | "end" | "mid";
			origin: BoardArrowItem;
			moved: boolean;
	  };

/**
 * A pointer sample carrying both coordinate spaces. The stage performs the
 * screen→world conversion exactly once at the boundary; the editor then uses
 * `world` for geometry (hit testing, resize, rotate, translate, marquee) and
 * `screen` for viewport operations (panning, pinch).
 */
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
	/** True when the platform aborted the pointer sequence. */
	cancelled: boolean;
	/** Pen pressure 0..1; 0.5 for mouse/touch without pressure support. */
	pressure: number;
};

export type BoardViewState = {
	visibleRect: Rect | null;
	selectedNodes: Array<{ id: string; type: string; title?: string }>;
};

export type BoardEditorOptions = {
	document: BoardDocument;
	/** Tool shown on the first frame. Defaults to Select for existing callers. */
	initialTool?: BoardToolId;
	/** Stable identity (e.g. file path) used to tell a document switch from a remote refresh. */
	key?: string;
	/**
	 * View-only editor: navigation and selection stay live, but nothing is ever
	 * committed. The final guard for a published Board, independent of whatever
	 * chrome the host chooses to hide.
	 */
	readonly?: boolean;
	onCommit: (
		document: BoardDocument,
		before: BoardDocument,
		commands: BoardSemanticCommand[],
	) => void | Promise<void>;
	onViewStateChange?: (state: BoardViewState) => void;
};

const NUDGE_STEP = 1;
const NUDGE_STEP_LARGE = 10;
const ZOOM_STEP = 1.28;
const CAMERA_ANIMATION_MS = 240;
/** Pointer travel (screen px) before a press becomes a drag. */
const DRAG_THRESHOLD = 3;
/** Snap attraction radius in screen px (scaled to world by zoom). */
const SNAP_THRESHOLD = 8;

function easeOutCubic(t: number) {
	return 1 - (1 - t) * (1 - t) * (1 - t);
}

function toContent(document: BoardDocument): SyncedContent {
	return {
		kind: document.kind,
		version: document.version,
		appearance: document.appearance,
		items: document.items,
		connections: document.connections,
	};
}

export function createBoardEditor(options: BoardEditorOptions) {
	// The editor lays out text before any card renderer runs, and the model's
	// fallback metrics are only an estimate, so make sure the canvas measurer is
	// in place first.
	ensureBoardTextMeasurement();

	// ─── Reactive state ─────────────────────────────────────────────
	// Synced content and the local camera are held separately so the viewport
	// is never mistaken for persisted state. `document` composes them for
	// consumers that expect a full BoardDocument.
	// Raw: content is immutable and replaced wholesale.
	let synced = $state.raw<SyncedContent>(toContent(options.document));
	let camera = $state<BoardViewport>(
		normalizeViewport(options.document.viewport),
	);
	let selection = $state<string[]>([]);
	let tool = $state<BoardToolId>(options.initialTool ?? "select");
	let interaction = $state<BoardInteraction>({ type: "idle" });
	let hoverId = $state<string | null>(null);
	let hoverPoint = $state<WorldPoint | null>(null);
	let hoverPointerType = $state("mouse");
	let editingId = $state<string | null>(null);
	let saveError = $state<string | null>(null);
	/** In-flight commits, so the UI can show a saving state without polling. */
	let pendingCommits = $state(0);
	let surfaceSize = $state<{ width: number; height: number }>({
		width: 0,
		height: 0,
	});
	type UndoEntry = {
		undo: BoardSemanticCommand[];
		redo: BoardSemanticCommand[];
	};
	let undoStack = $state.raw<UndoEntry[]>([]);
	let redoStack = $state.raw<UndoEntry[]>([]);
	let localRev = $state(0);
	let committedRev = $state(0);
	let draftId = $state<string | null>(null);
	/** Bumped on item membership/order changes (not per-frame drags). */
	let structureVersion = $state(0);
	/** Bumped on geometry changes (nudge, align, drag commit). Stage cull cache
	 * keys on this so moved items re-enter/leave the viewport correctly. */
	let geometryVersion = $state(0);
	/** Local-only signal for the runtime; it is not persisted in the Board. */
	const recentlyAdded = new Set<string>();

	function markAdded(ids: readonly string[]) {
		if (ids.length === 0) return;
		// The runtime decides whether the burst is suitable for an entrance.
		recentlyAdded.clear();
		for (const id of ids) recentlyAdded.add(id);
	}

	// Creation styles are local UI preferences, never synced into the document.
	// Each tool keeps its own values so switching tools does not leak a drawing
	// color or stroke width into an unrelated shape.
	let toolStyles = $state(readBoardToolStyles());
	/** Alignment guides for the in-progress drag, in world space (for rendering). */
	let snapGuides = $state<SnapGuide[]>([]);
	/** Space-bar temporary hand tool (does not change the persistent tool). */
	let spaceHeld = $state(false);
	/** Internal clipboard fallback when the system clipboard is unavailable. */
	let internalClipboard: BoardClipboardPayload | null = null;
	/** Paste count for progressive offset when pasting repeatedly in place. */
	let pasteCount = 0;

	let cameraAnimation = 0;
	let pinch: { distance: number; midpoint: ScreenPoint; zoom: number } | null =
		null;
	const activePointers = new Map<number, ScreenPoint>();

	// Undo history is local and optimistic: it records user actions as they
	// happen, independent of whether/when they sync. `undoBaseline` is the
	// document at the last recorded step; each step diffs against it.
	let undoBaseline: BoardDocument = {
		...toContent(options.document),
		viewport: options.document.viewport,
	};
	// Bumped on genuine external loads so stale in-flight commit results are ignored.
	let syncGeneration = 0;
	// Identity of the loaded document, to distinguish a document switch (reset
	// camera) from a remote refresh of the same document (keep camera).
	let currentKey: string | undefined = options.key;
	// The last document state the server is known to have (our last successful
	// commit, or the last external refresh). Rebase diffs local changes against it.
	let externalBaseline: BoardDocument = {
		...toContent(options.document),
		viewport: options.document.viewport,
	};
	// A remote refresh deferred because the user is mid-gesture or editing.
	let pendingRemote: { doc: BoardDocument; key: string | undefined } | null =
		null;

	// Serial persistence: diffs immutable snapshots against a running baseline.
	const queue = createCommitQueue(async (document, before, commands) => {
		await options.onCommit(document, before, commands);
	});
	queue.reset({
		...toContent(options.document),
		viewport: options.document.viewport,
	});

	// Spatial index over item bounding boxes. Full rebuilds for membership
	// changes; dirty-entry upserts during gestures so a drag never pays O(n).
	const spatial = createSpatialIndex();
	let spatialVersion = 0;
	let indexedVersion = -1;
	let itemsById = new Map<string, BoardItem>();
	/** Document index per id, kept alongside `itemsById` for incremental upserts. */
	let indexById = new Map<string, number>();
	/** Pending dirty ids for incremental spatial updates (null = full rebuild). */
	let spatialDirty: Set<string> | null = null;
	/** Lazily rebuilt only after item membership or references can change. */
	let mediaIdsByPath: Map<string, Set<string>> | null = null;
	const emptyMediaIds: ReadonlySet<string> = new Set();

	/**
	 * Connection index, rebuilt only when the relation set changes.
	 *
	 * Moving a node must cost that node's degree, not a scan of every relation on
	 * the board — which is the difference between a drag that stays smooth on a
	 * densely connected board and one that does not.
	 */
	let connectionIndex = createConnectionIndex([]);
	let indexedConnections: BoardConnection[] | null = null;
	/** Separate from the renderer's cache, which resolves against display frames. */
	const connectionGeometry = createConnectionGeometryCache();

	function ensureConnectionIndex() {
		const connections = synced.connections;
		if (indexedConnections === connections) return;
		connectionIndex = createConnectionIndex(connections);
		connectionGeometry.retain(connections);
		indexedConnections = connections;
	}

	/** Connections touching any of the given nodes. */
	function connectionsForNodes(nodeIds: Iterable<string>): BoardConnection[] {
		ensureConnectionIndex();
		const seen = new Set<string>();
		const result: BoardConnection[] = [];
		for (const nodeId of nodeIds) {
			for (const connectionId of connectionIndex.byNode(nodeId)) {
				if (seen.has(connectionId)) continue;
				seen.add(connectionId);
				const connection = connectionIndex.get(connectionId);
				if (connection) result.push(connection);
			}
		}
		return result;
	}

	function mediaIdsForPath(path: string): ReadonlySet<string> {
		if (!mediaIdsByPath) {
			mediaIdsByPath = new Map();
			for (const item of synced.items) {
				if (
					item.type !== "image" &&
					item.type !== "video" &&
					item.type !== "audio"
				)
					continue;
				const ids = mediaIdsByPath.get(item.ref.path) ?? new Set<string>();
				ids.add(item.id);
				mediaIdsByPath.set(item.ref.path, ids);
			}
		}
		return mediaIdsByPath.get(path) ?? emptyMediaIds;
	}

	function bumpSpatial(dirtyIds?: Iterable<string>) {
		spatialVersion += 1;
		if (!dirtyIds) {
			spatialDirty = null;
			return;
		}
		if (spatialDirty === null) return; // already needs full rebuild
		for (const id of dirtyIds) spatialDirty.add(id);
	}

	function bumpStructure() {
		structureVersion += 1;
	}

	function bumpGeometry() {
		geometryVersion += 1;
	}

	function ensureSpatial() {
		if (indexedVersion === spatialVersion) return;
		const current = synced.items;
		const dirty = spatialDirty;
		spatialDirty = new Set();
		indexedVersion = spatialVersion;

		if (dirty === null || itemsById.size === 0) {
			// Full rebuild path (membership change or first index).
			const entries: SpatialEntry[] = [];
			itemsById = new Map();
			indexById = new Map();
			current.forEach((item, index) => {
				itemsById.set(item.id, item);
				indexById.set(item.id, index);
				entries.push({
					id: item.id,
					order: index,
					rect: itemBounds(item.frame),
				});
			});
			spatial.rebuild(entries);
			return;
		}

		// Incremental path: membership and order are unchanged (a structural change
		// forces the full rebuild above), so only the dirty ids need re-reading.
		// This is what keeps a drag off the O(n) path — the previous index is still
		// valid, so each dirty item is found directly instead of by scanning.
		const upserts = new Map<string, SpatialEntry | null>();
		for (const id of dirty) {
			const index = indexById.get(id);
			const item = index === undefined ? undefined : current[index];
			if (index === undefined || !item || item.id !== id) {
				// The id moved or vanished without a structural bump; drop it and let
				// the next full rebuild restore consistency.
				itemsById.delete(id);
				indexById.delete(id);
				upserts.set(id, null);
				continue;
			}
			itemsById.set(id, item);
			upserts.set(id, {
				id,
				order: index,
				rect: itemBounds(item.frame),
			});
		}
		spatial.upsert(upserts);
	}

	// ─── Derived ────────────────────────────────────────────────────
	const document = $derived<BoardDocument>({ ...synced, viewport: camera });
	const items = $derived(synced.items);
	const dirty = $derived(localRev > committedRev);
	/**
	 * Selected items, resolved through the id index.
	 *
	 * Deliberately not `items.filter(item => selection.includes(item.id))`: that is
	 * O(items x selection), which turns select-all on a large board into a
	 * quadratic scan on every dependent read.
	 */
	const selectedItems = $derived.by<BoardItem[]>(() => {
		if (selection.length === 0) return [];
		// Track the item snapshot explicitly. `ensureSpatial` can return before
		// reading it when a pointer hit-test already refreshed the index.
		const currentItems = items;
		if (currentItems.length === 0) return [];
		ensureSpatial();
		const result: BoardItem[] = [];
		for (const id of selection) {
			const item = itemsById.get(id);
			if (item) result.push(item);
		}
		return result;
	});
	const selectedFrames = $derived(selectedItems.map((item) => item.frame));
	const bounds = $derived(selectionBounds(selectedFrames));
	const selectionTransform = $derived(
		resolveSelectionTransform(selectedItems, bounds),
	);
	const hoveredTransformControl = $derived.by(() =>
		interaction.type === "idle" && !pinch && tool === "select" && hoverPoint
			? selectionTransformControlAt(
					selectionTransform,
					hoverPoint,
					camera.zoom,
					hoverPointerType,
				)
			: null,
	);
	const hoveredConnectionId = $derived.by<string | null>(() => {
		if (hoverPointerType === "touch" || hoverId || !hoverPoint) return null;
		return connectionAt(hoverPoint)?.id ?? null;
	});
	const marquee = $derived.by<Rect | null>(() => {
		if (interaction.type !== "brushing") return null;
		const start = interaction.start;
		const current = interaction.current;
		return {
			x: Math.min(start.x, current.x),
			y: Math.min(start.y, current.y),
			width: Math.abs(current.x - start.x),
			height: Math.abs(current.y - start.y),
		};
	});

	// ─── Mutation + persistence ─────────────────────────────────────
	function setItems(
		next: BoardItem[],
		structural = true,
		dirtyIds?: Iterable<string>,
	) {
		synced = { ...synced, items: next };
		bumpSpatial(dirtyIds);
		if (structural) {
			mediaIdsByPath = null;
			bumpStructure();
		}
		// Membership changes and targeted geometry patches both move world bounds.
		if (structural || dirtyIds) bumpGeometry();
		localRev += 1;
	}

	/**
	 * Replace the relation set.
	 *
	 * Structural by definition: a connection has no geometry to patch — adding or
	 * removing one changes what is drawn, while everything about *where* it is drawn
	 * comes from the nodes. So this bumps structure and never takes a dirty set.
	 */
	function setConnections(next: BoardConnection[]) {
		synced = { ...synced, connections: next };
		bumpStructure();
		bumpGeometry();
		localRev += 1;
	}

	function setAppearance(appearance: BoardDocument["appearance"]) {
		if (JSON.stringify(synced.appearance) === JSON.stringify(appearance))
			return;
		synced = { ...synced, appearance };
		localRev += 1;
	}

	/** Replace items and connections together, as one atomic change. */
	function setContent(
		nextItems: BoardItem[],
		nextConnections: BoardConnection[],
	) {
		synced = { ...synced, items: nextItems, connections: nextConnections };
		mediaIdsByPath = null;
		bumpSpatial();
		bumpStructure();
		bumpGeometry();
		localRev += 1;
	}

	function isLocked(item: BoardItem): boolean {
		return item.locked === true;
	}

	/** Filter a selection down to unlocked items (locked shapes stay put). */
	function unlockedIds(ids: Iterable<string>): string[] {
		ensureSpatial();
		const result: string[] = [];
		for (const id of ids) {
			const item = itemsById.get(id);
			if (item && !isLocked(item)) result.push(id);
		}
		return result;
	}

	/**
	 * Record the current document as one undo step (diffed against the last
	 * recorded step). Purely local and synchronous — it does not wait for sync,
	 * so an action is undoable even if its upload is still pending or fails.
	 */
	function recordUndoStep() {
		const redo = boardDocumentToSemanticCommands(undoBaseline, document);
		if (redo.length === 0) return;
		const undo = boardDocumentToSemanticCommands(document, undoBaseline);
		undoStack = [...undoStack, { undo, redo }];
		redoStack = [];
		undoBaseline = document;
	}

	/** Sync the current document to the server (no undo semantics here). */
	function requestCommit() {
		if (options.readonly) return;
		const snapshot = document;
		const rev = localRev;
		const gen = syncGeneration;
		pendingCommits += 1;
		void queue
			.commit(snapshot)
			.then((outcome) => {
				// A genuine external load happened since; this result is stale.
				if (gen !== syncGeneration) return;
				if (outcome.ok) {
					committedRev = Math.max(committedRev, rev);
					// The server now has this snapshot; it is the new rebase baseline.
					externalBaseline = snapshot;
					saveError = null;
				} else {
					saveError =
						outcome.error instanceof Error
							? outcome.error.message
							: "Failed to sync board";
				}
			})
			.finally(() => {
				pendingCommits -= 1;
			});
	}

	function retrySave() {
		saveError = null;
		requestCommit();
	}

	/** A user action: record an undo step, then sync. */
	function commitAction() {
		recordUndoStep();
		requestCommit();
	}

	function commitAppearance(appearance: BoardDocument["appearance"]) {
		setAppearance(appearance);
		commitAction();
	}

	function undo() {
		const entry = undoStack.at(-1);
		if (!entry) return;
		undoStack = undoStack.slice(0, -1);
		redoStack = [...redoStack, entry];
		const next = applyBoardSemanticCommands(document, entry.undo);
		setAppearance(next.appearance);
		setContent(next.items, next.connections);
		undoBaseline = document;
		requestCommit();
	}

	function redo() {
		const entry = redoStack.at(-1);
		if (!entry) return;
		redoStack = redoStack.slice(0, -1);
		undoStack = [...undoStack, entry];
		const next = applyBoardSemanticCommands(document, entry.redo);
		setAppearance(next.appearance);
		setContent(next.items, next.connections);
		undoBaseline = document;
		requestCommit();
	}

	// ─── Camera (local UI state) ────────────────────────────────────
	function setCamera(viewport: BoardViewport) {
		camera = normalizeViewport(viewport, camera);
		// A cached world-space hover is invalid under the new camera transform.
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
			setCamera({
				x: from.x + (to.x - from.x) * eased,
				y: from.y + (to.y - from.y) * eased,
				zoom: from.zoom + (to.zoom - from.zoom) * eased,
			});
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

	function fitView() {
		const content = selectionBounds(synced.items.map((item) => item.frame));
		if (!content || surfaceSize.width === 0) {
			animateCamera({ x: 0, y: 0, zoom: 1 });
			return;
		}
		animateCamera(fitToContent(content, surfaceSize));
	}

	function focusRect(
		rect: Rect,
		options: {
			fit?: "contain" | "cover";
			padding?: number;
			minZoom?: number;
			maxZoom?: number;
			animate?: boolean;
		} = {},
	) {
		if (surfaceSize.width <= 0 || surfaceSize.height <= 0) return;
		const target = cameraForRect(rect, surfaceSize, {
			fit: options.fit ?? "contain",
			padding: options.padding ?? 32,
			minZoom: options.minZoom,
			maxZoom: options.maxZoom,
		});
		if (options.animate === false) setCamera(target);
		else animateCamera(target);
	}

	function focusItems(
		ids: Iterable<string>,
		options?: Parameters<typeof focusRect>[1],
	) {
		const frames = [...ids].flatMap((id) => {
			const item = itemById(id);
			return item ? [item.frame] : [];
		});
		const rect = selectionBounds(frames);
		if (rect) focusRect(rect, options);
	}

	function focusNode(id: string, options?: Parameters<typeof focusRect>[1]) {
		focusItems([id], options);
	}

	function focusSelection(options?: Parameters<typeof focusRect>[1]) {
		const rects: Rect[] = [];
		const itemRect = selectionBounds(selectedItems.map((item) => item.frame));
		if (itemRect) rects.push(itemRect);
		for (const id of selection) {
			const connection = connectionById(id);
			const resolved = connection
				? resolveConnectionGeometry(connection)
				: null;
			const bounds = resolved ? pointsBounds(resolved.path, 1) : null;
			if (bounds) rects.push(bounds);
		}
		const rect = unionRects(rects);
		if (rect) focusRect(rect, options);
		else fitView();
	}

	// ─── Selection ──────────────────────────────────────────────────
	function setSelection(ids: string[]) {
		selection = ids;
	}

	function clearSelection() {
		selection = [];
	}

	function selectAll() {
		selection = synced.items.map((item) => item.id);
	}

	// ─── Commands ───────────────────────────────────────────────────
	/** Draw stays active for consecutive strokes; other creation tools are one-shot. */
	function maybeReturnToSelect() {
		if (!isContinuousBoardTool(tool)) tool = "select";
	}

	/**
	 * The style bucket a tool draws from.
	 *
	 * The Connect tool maps to the `connection` bucket: tool ids name the gesture,
	 * style keys name the thing produced, and those differ here.
	 */
	function styledToolId(value = tool): BoardStyledToolId | null {
		switch (value) {
			case "text":
			case "geo":
			case "draw":
			case "arrow":
			case "frame":
				return value;
			default:
				return null;
		}
	}

	function addItemAt(item: BoardItem, opts?: { select?: boolean }) {
		setItems([...synced.items, item]);
		markAdded([item.id]);
		// Consecutive strokes stay unobstructed; one-shot tools surface their result.
		const shouldSelect = opts?.select ?? !isContinuousBoardTool(tool);
		selection = shouldSelect ? [item.id] : [];
		commitAction();
		maybeReturnToSelect();
	}

	/**
	 * Place a workspace file on the board.
	 *
	 * Every file is accepted: images, videos and audio become media nodes, and everything
	 * else becomes a file card. A board should never refuse a file — it only varies
	 * in how much detail it can show — so this always returns the created node's id
	 * for the caller to enrich once a preview has been read.
	 */
	function addApp(
		app: {
			appId: string;
			ref: string;
			url: string;
			name: string;
			icon?: string;
		},
		at: WorldPoint,
	) {
		const item = createAppBoardItem(app, at.x, at.y);
		addItemAt(item);
		return item.id;
	}

	function addFile(
		path: string,
		at: WorldPoint,
		snapshot?: {
			title?: string;
			mimeType?: string;
			size?: number;
			mtimeMs?: number;
			naturalWidth?: number;
			naturalHeight?: number;
		},
	) {
		const item = createFileNodeForPath(path, at.x, at.y, snapshot);
		addItemAt(item);
		return item.id;
	}

	function addTask(
		taskRunId: string,
		snapshot: BoardTaskSnapshot,
		at: WorldPoint,
		metadata?: Record<string, unknown>,
	) {
		const item = createTaskBoardItem(taskRunId, snapshot, at.x, at.y, metadata);
		addItemAt(item);
		return item.id;
	}

	/** Add a task and its source edges as one undoable Board change. */
	function addTaskWithSources(
		taskRunId: string,
		snapshot: BoardTaskSnapshot,
		at: WorldPoint,
		sources: Array<{
			nodeId: string;
			sourcePortId: string;
			targetPortId: string;
		}>,
		metadata?: Record<string, unknown>,
	) {
		if (options.readonly) return null;
		const item = createTaskBoardItem(taskRunId, snapshot, at.x, at.y, metadata);
		const connections = sources
			.filter((source) => source.nodeId !== item.id && itemById(source.nodeId))
			.map((source) =>
				createBoardConnection({
					id: createBoardItemId(),
					sourceItemId: source.nodeId,
					targetItemId: item.id,
					sourcePortId: source.sourcePortId,
					targetPortId: source.targetPortId,
					relation: "input",
					direction: "forward",
					metadata: {
						boardFlow: {
							version: 1,
							kind: "content",
							sourcePortId: source.sourcePortId,
							targetPortId: source.targetPortId,
						},
					},
				}),
			);
		setContent(
			[...synced.items, item],
			[...synced.connections, ...connections],
		);
		markAdded([item.id]);
		selection = [item.id];
		commitAction();
		return item.id;
	}

	function addText(text: string, at: WorldPoint) {
		addItemAt(createTextBoardItem(text, at.x, at.y, toolStyles.text.color));
	}

	function addGeo(at: WorldPoint) {
		const style = toolStyles.geo;
		addItemAt(createGeoBoardItem(style.geo, at.x, at.y, style.color));
	}

	function addFrame(at: WorldPoint) {
		addItemAt(createFrameBoardItem(at.x, at.y, toolStyles.frame.color));
	}

	/** Finish a shape/frame drag-create, using its default size for a short click. */
	function commitBoxCreate(state: {
		id: string;
		kind: "geo" | "frame";
		start: WorldPoint;
		current: WorldPoint;
		color: string;
		geo: string;
	}) {
		const dx = state.current.x - state.start.x;
		const dy = state.current.y - state.start.y;
		const dist = Math.hypot(dx, dy);
		const threshold = 6 / Math.max(camera.zoom, 0.0001);
		if (dist <= threshold) {
			if (state.kind === "geo") {
				addItemAt(
					createGeoBoardItem(
						state.geo,
						state.start.x,
						state.start.y,
						state.color,
						state.id,
					),
				);
			} else {
				addItemAt(
					createFrameBoardItem(
						state.start.x,
						state.start.y,
						state.color,
						"Frame",
						state.id,
					),
				);
			}
			return;
		}
		const x = Math.min(state.start.x, state.current.x);
		const y = Math.min(state.start.y, state.current.y);
		const width = Math.max(24, Math.abs(dx));
		const height = Math.max(24, Math.abs(dy));
		const frame = { x, y, width, height, rotation: 0 };
		if (state.kind === "geo") {
			const item = createGeoBoardItem(state.geo, x, y, state.color, state.id);
			if (item.type === "geo") item.frame = frame;
			addItemAt(item);
			return;
		}
		const item = createFrameBoardItem(x, y, state.color, "Frame", state.id);
		if (item.type === "frame") {
			item.frame = {
				...frame,
				width: Math.max(48, width),
				height: Math.max(48, height),
			};
		}
		addItemAt(item);
	}

	/** Commit a finished freehand stroke as a draw item (drops empty strokes). */
	function commitDraw(
		id: string,
		points: DrawPoint[],
		color: string,
		size: number,
	) {
		if (points.length === 0) return;
		addItemAt(createDrawBoardItem(points, color, size, id));
	}

	/** Commit a finished arrow (drops degenerate zero-length arrows). */
	function commitArrow(
		id: string,
		start: WorldPoint,
		end: WorldPoint,
		color: string,
		size: number,
	) {
		if (Math.hypot(end.x - start.x, end.y - start.y) < 2) return;
		addItemAt(createArrowBoardItem(start, end, color, id, size));
	}

	/**
	 * Start inline text as a local-only draft (double-click on empty board). It is
	 * not marked dirty, recorded in undo, or synced until the edit is confirmed
	 * non-empty, so an abandoned draft leaves no trace.
	 */
	function beginTextDraft(at: WorldPoint) {
		const item = createTextBoardItem("", at.x, at.y, toolStyles.text.color);
		synced = { ...synced, items: [...synced.items, item] };
		bumpSpatial();
		bumpStructure();
		draftId = item.id;
		selection = [item.id];
		editingId = item.id;
	}

	/** Finish an inline text edit, handling drafts and empty results. */
	function commitTextEdit(id: string, text: string) {
		const isDraft = id === draftId;
		const target = itemById(id);
		// An emptied text item (or an abandoned draft) is removed; a geo keeps its
		// shape and simply loses its label.
		const shouldDelete =
			text.trim() === "" && (isDraft || target?.type === "text");
		if (shouldDelete) {
			if (isDraft) {
				// Never synced — drop it without an op.
				synced = {
					...synced,
					items: removeBoardItems(synced.items, new Set([id])),
				};
				bumpSpatial();
				bumpStructure();
			} else {
				deleteItem(id);
			}
		} else {
			updateText(id, text);
		}
		editingId = null;
		draftId = null;
		if (tool === "text") tool = "select";
		// Apply any remote refresh deferred for the duration of this edit.
		flushPendingRemote();
	}

	/**
	 * Remove nodes together with every relation that names them.
	 *
	 * A relation to a deleted node is not a relation, and the server refuses to
	 * store one, so the cascade is explicit and lands in the same change: one undo
	 * step brings back both the nodes and their relations.
	 */
	function removeNodes(ids: Set<string>) {
		// Degree-bounded instead of scanning every relation: removing a node costs
		// its own connections via the index, not the board's whole relation set.
		const incident = connectionsForNodes(ids);
		if (incident.length === 0) {
			setItems(removeBoardItems(synced.items, ids));
			return;
		}
		const dropped = new Set(incident.map((connection) => connection.id));
		setContent(
			removeBoardItems(synced.items, ids),
			synced.connections.filter((connection) => !dropped.has(connection.id)),
		);
	}

	function deleteSelection() {
		// A selected relation is deleted on its own terms: removing an edge must not
		// take the nodes it happened to join with it.
		const connectionIds = selection.filter((id) => connectionById(id));
		const movable = unlockedIds(selection);
		if (movable.length === 0 && connectionIds.length === 0) return;
		const ids = new Set(movable);
		if (connectionIds.length > 0) {
			const dropped = new Set(connectionIds);
			setContent(
				removeBoardItems(synced.items, ids),
				synced.connections.filter(
					(connection) =>
						!dropped.has(connection.id) &&
						!ids.has(connection.source.itemId) &&
						!ids.has(connection.target.itemId),
				),
			);
		} else {
			removeNodes(ids);
		}
		selection = [];
		editingId = null;
		commitAction();
	}

	function deleteItem(id: string) {
		const target = itemById(id);
		if (!target || isLocked(target)) return;
		const ids = new Set([id]);
		removeNodes(ids);
		selection = selection.filter((selectedId) => !ids.has(selectedId));
		if (editingId && ids.has(editingId)) editingId = null;
		commitAction();
	}

	/**
	 * Clone items and the relations *between* them.
	 *
	 * Relations are duplicated only when both endpoints are part of the copy: a
	 * clone pointing back at the original would be a relation the user never drew.
	 * Returned separately from the items because connections are not items \u2014 the
	 * caller commits both together.
	 */
	function materializeDuplicates(
		sourceIds: string[],
		/** 0 for Alt-drag (drag provides the offset); default displaces the copy. */
		offset?: number,
	): { items: BoardItem[]; connections: BoardConnection[] } {
		const sourceSet = new Set(sourceIds);
		const sources: BoardItem[] = [];
		// Document order for z-order preservation on duplicate/paste.
		for (const item of synced.items) {
			if (sourceSet.has(item.id)) sources.push(item);
		}
		if (sources.length === 0) return { items: [], connections: [] };

		const pairs = sources.map((item) => ({
			source: item,
			copy:
				offset === undefined
					? duplicateBoardItem(item)
					: duplicateBoardItem(item, offset),
		}));
		const idMap = new Map(
			pairs.map(({ source, copy }) => [source.id, copy.id] as const),
		);

		const connections = synced.connections.flatMap((connection) => {
			const source = idMap.get(connection.source.itemId);
			const target = idMap.get(connection.target.itemId);
			if (!source || !target) return [];
			return [
				{
					...connection,
					id: createBoardItemId(),
					source: { ...connection.source, nodeId: source },
					target: { ...connection.target, nodeId: target },
				},
			];
		});

		return { items: pairs.map(({ copy }) => copy), connections };
	}

	function duplicateSelection() {
		if (selection.length === 0) return;
		const copies = materializeDuplicates(selection);
		if (copies.items.length === 0) return;
		setContent(
			[...synced.items, ...copies.items],
			[...synced.connections, ...copies.connections],
		);
		markAdded(copies.items.map((copy) => copy.id));
		selection = copies.items.map((copy) => copy.id);
		commitAction();
	}

	function nudgeSelection(dx: number, dy: number, large: boolean) {
		const movable = unlockedIds(selection);
		if (movable.length === 0) return;
		const step = large ? NUDGE_STEP_LARGE : NUDGE_STEP;
		const ids = new Set(movable);
		const frames = new Map<string, BoardFrame>();
		for (const item of synced.items) {
			if (!ids.has(item.id)) continue;
			frames.set(item.id, {
				...item.frame,
				x: item.frame.x + dx * step,
				y: item.frame.y + dy * step,
			});
		}
		setItems(patchItemFrames(synced.items, frames), false, ids);
		commitAction();
	}

	function alignSelection(mode: AlignMode) {
		const movable = unlockedIds(selection);
		if (movable.length < 2) return;
		const frames = framesFor(movable);
		const patches = alignFrames(frames, mode);
		if (patches.size === 0) return;
		setItems(patchItemFrames(synced.items, patches), false, patches.keys());
		bumpStructure();
		commitAction();
	}

	function distributeSelection(axis: DistributeAxis) {
		const movable = unlockedIds(selection);
		if (movable.length < 3) return;
		const frames = framesFor(movable);
		const patches = distributeFrames(frames, axis);
		if (patches.size === 0) return;
		setItems(patchItemFrames(synced.items, patches), false, patches.keys());
		bumpStructure();
		commitAction();
	}

	function toggleSelectionLock() {
		if (selection.length === 0) return;
		const ids = new Set(selection);
		const shouldLock = selectedItems.some((item) => !item.locked);
		setItems(
			synced.items.map((item) =>
				ids.has(item.id)
					? shouldLock
						? { ...item, locked: true }
						: { ...item, locked: false }
					: item,
			),
		);
		commitAction();
	}

	function copySelection(): BoardClipboardPayload | null {
		if (selection.length === 0) return null;
		const ids = new Set(selection);
		// Document order, not selection order: clipboard paste must preserve
		// z-order regardless of the order items were clicked into the selection.
		// Single pass over the document, membership checked once per item.
		const items: BoardItem[] = [];
		for (const item of synced.items) {
			if (ids.has(item.id)) items.push(item);
		}
		const payload = encodeClipboard(items);
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
		// Always re-validate: external clipboard is untrusted, and even the internal
		// payload goes through parse for a single code path.
		const parsed =
			parseClipboard(raw) ??
			(raw == null ? parseClipboard(internalClipboard) : null);
		if (!parsed) return;
		pasteCount += 1;
		const offset = at
			? { x: at.x, y: at.y }
			: {
					x: parsed.origin.x + defaultPasteOffset(pasteCount).x,
					y: parsed.origin.y + defaultPasteOffset(pasteCount).y,
				};
		const pasted = materializeClipboard(parsed, offset);
		if (pasted.items.length === 0) return;
		setContent(
			[...synced.items, ...pasted.items],
			[...synced.connections, ...pasted.connections],
		);
		markAdded(pasted.items.map((item) => item.id));
		selection = pasted.items.map((item) => item.id);
		commitAction();
	}

	function setSelectionEmphasis(emphasis: BoardEmphasis) {
		const movable = unlockedIds(selection);
		if (movable.length === 0) return;
		const ids = new Set(movable);
		const next = synced.items.map((item) =>
			ids.has(item.id)
				? {
						...item,
						style: {
							...item.style,
							variant: item.style?.variant ?? "default",
							size: item.style?.size ?? "md",
							effects: item.style?.effects ?? [],
							emphasis,
						},
					}
				: item,
		);
		setItems(next);
		commitAction();
	}

	/**
	 * Set the palette color on selected text, geo, draw, arrow and frame shapes.
	 * Shapes without a color field are left untouched.
	 */
	function setSelectionColor(color: string) {
		const movable = unlockedIds(selection);
		if (movable.length === 0) return;
		const ids = new Set(movable);
		let changed = false;
		const next = synced.items.map((item) => {
			if (!ids.has(item.id) || isLocked(item)) return item;
			if (
				item.type === "text" ||
				item.type === "geo" ||
				item.type === "draw" ||
				item.type === "arrow" ||
				item.type === "frame"
			) {
				changed = true;
				return { ...item, color };
			}
			return item;
		});
		if (!changed) return;
		setItems(next);
		commitAction();
	}

	function bringToFront() {
		if (selection.length === 0) return;
		const ids = new Set(selection);
		// Single partition pass: selection membership is checked once per item
		// instead of two full scans (chosen + rest).
		const chosen: BoardItem[] = [];
		const rest: BoardItem[] = [];
		for (const item of synced.items) {
			(ids.has(item.id) ? chosen : rest).push(item);
		}
		setItems([...rest, ...chosen]);
		commitAction();
	}

	function sendToBack() {
		if (selection.length === 0) return;
		const ids = new Set(selection);
		const chosen: BoardItem[] = [];
		const rest: BoardItem[] = [];
		for (const item of synced.items) {
			(ids.has(item.id) ? chosen : rest).push(item);
		}
		setItems([...chosen, ...rest]);
		commitAction();
	}

	/**
	 * Bake a finished resize into the shapes whose *content* scales rather than
	 * just their box: text re-rasterises at a new font size, freehand strokes have
	 * their points and width scaled. During the drag these are previewed with a
	 * cheap GPU transform (see the renderers), so this is the single point where
	 * the expensive, authoritative geometry is written.
	 */
	function finalizeContentResize(
		gesture: Extract<BoardInteraction, { type: "resizing" }>,
	) {
		const originById = gesture.origin;
		const next = synced.items.map((item) => {
			const origin = originById.get(item.id);
			if (!origin) return item;
			const current = item.frame;
			const scale = current.width / Math.max(0.0001, origin.width);
			if (scale === 1) return item;

			if (item.type === "text") {
				const fontSize = clampBoardTextFontSize(item.fontSize * scale);
				const measured = measureBoardText(item.text, fontSize);
				if (gesture.single) {
					return {
						...item,
						fontSize,
						frame: resizeFrameToSize(
							origin,
							gesture.handle,
							measured.width,
							measured.height,
						),
					};
				}
				const center = rectCenter(current);
				return {
					...item,
					fontSize,
					frame: {
						...current,
						x: center.x - measured.width / 2,
						y: center.y - measured.height / 2,
						width: measured.width,
						height: measured.height,
					},
				};
			}

			if (item.type === "draw") {
				return {
					...item,
					size: item.size * scale,
					points: item.points.map((point) => ({
						x: point.x * scale,
						y: point.y * scale,
						p: point.p,
					})),
				};
			}

			return item;
		});
		if (next.some((item, index) => item !== synced.items[index]))
			setItems(next, false, originById.keys());
	}

	/** Invalidate synced display facts after the authoritative media file changes. */
	function applyMediaFileChange(
		path: string,
		change: { size?: number; mtimeMs?: number; removed?: boolean },
	) {
		if (change.removed) return;
		const targetIds = mediaIdsForPath(path);
		if (targetIds.size === 0) return;
		const dirty: string[] = [];
		const next = synced.items.map((item) => {
			if (
				item.type !== "image" &&
				item.type !== "video" &&
				item.type !== "audio"
			)
				return item;
			if (!targetIds.has(item.id)) return item;
			const snapshot: BoardMediaSnapshot & { durationMs?: number } = {
				...item.snapshot,
			};
			if (change.size !== undefined) snapshot.size = change.size;
			if (change.mtimeMs !== undefined) snapshot.mtimeMs = change.mtimeMs;
			delete snapshot.naturalWidth;
			delete snapshot.naturalHeight;
			if (item.type === "audio") delete snapshot.durationMs;
			if (JSON.stringify(snapshot) === JSON.stringify(item.snapshot ?? {}))
				return item;
			dirty.push(item.id);
			return { ...item, snapshot };
		});
		if (dirty.length === 0) return;
		setItems(next, false, dirty);
		undoBaseline = document;
		requestCommit();
	}

	/**
	 * Adopt the intrinsic pixel size of media whose dimensions were unknown at
	 * creation time. The frame keeps its chosen width and corrects only its height,
	 * anchored at the center. This derived repair is synced but stays out of undo.
	 */
	function adoptMediaNaturalSizes(
		sizes: Array<{ id: string; width: number; height: number }>,
	) {
		if (sizes.length === 0) return;
		const byId = new Map(sizes.map((entry) => [entry.id, entry]));
		const dirty: string[] = [];
		const next = synced.items.map((item) => {
			const natural = byId.get(item.id);
			if (!natural || natural.width <= 0 || natural.height <= 0) return item;

			if (item.type === "task") {
				const artifact = featuredTaskArtifact(item.snapshot.artifacts);
				if (artifact?.type !== "image" && artifact?.type !== "video") {
					return item;
				}
				// Already recorded: never re-correct (and never fight the user's resize).
				if (artifact.naturalWidth && artifact.naturalHeight) return item;
				const height = (item.frame.width * natural.height) / natural.width;
				if (!Number.isFinite(height) || height <= 0) return item;
				dirty.push(item.id);
				const center = rectCenter(item.frame);
				return {
					...item,
					snapshot: {
						...item.snapshot,
						artifacts: item.snapshot.artifacts.map((entry) =>
							entry.id === artifact.id
								? {
										...entry,
										naturalWidth: natural.width,
										naturalHeight: natural.height,
									}
								: entry,
						),
					},
					frame: {
						...item.frame,
						y: center.y - height / 2,
						height,
					},
				};
			}

			if (item.type !== "image" && item.type !== "video") return item;
			// Already recorded: never re-correct (and never fight the user's resize).
			if (item.snapshot?.naturalWidth && item.snapshot.naturalHeight)
				return item;
			const height = (item.frame.width * natural.height) / natural.width;
			if (!Number.isFinite(height) || height <= 0) return item;
			dirty.push(item.id);
			const center = rectCenter(item.frame);
			return {
				...item,
				snapshot: {
					...item.snapshot,
					naturalWidth: natural.width,
					naturalHeight: natural.height,
				},
				frame: {
					...item.frame,
					y: center.y - height / 2,
					height,
				},
			};
		});
		if (dirty.length === 0) return;
		setItems(next, false, dirty);
		// Keep this repair out of undo: advance the baseline so the next real user
		// action does not diff it back in.
		undoBaseline = document;
		requestCommit();
	}

	/**
	 * Adopt freshly-read display facts for file cards.
	 *
	 * The snapshot is a cache of the referenced file, so this is a data repair, not
	 * a user action: it stays off the undo stack (advancing the baseline so the next
	 * real edit does not diff it back in) and is committed so other clients get an
	 * instant first paint instead of each re-reading the file.
	 *
	 * The frame is deliberately left alone. A cover band is sized as a fraction of
	 * whatever height the card has, so a snapshot arriving late never resizes a card
	 * under the user.
	 */
	/**
	 * Fold freshly read file previews into their cards. `replace` marks a read that
	 * describes the file as it is now, so its omissions are authoritative — see
	 * mergeFileSnapshot.
	 */
	function applyFileSnapshots(
		snapshots: Array<{
			id: string;
			snapshot: BoardFileSnapshot;
			replace?: boolean;
		}>,
	) {
		if (snapshots.length === 0) return;
		const byId = new Map(snapshots.map((entry) => [entry.id, entry]));
		const dirty: string[] = [];
		const next = synced.items.map((item) => {
			if (item.type !== "file") return item;
			const entry = byId.get(item.id);
			if (!entry) return item;
			const merged = mergeFileSnapshot(
				item.snapshot,
				entry.snapshot,
				entry.replace === true,
			);
			// Skip when nothing actually changed, so this never manufactures a commit.
			if (JSON.stringify(merged) === JSON.stringify(item.snapshot ?? {}))
				return item;
			dirty.push(item.id);
			return { ...item, snapshot: merged };
		});
		if (dirty.length === 0) return;
		setItems(next, false, dirty);
		undoBaseline = document;
		requestCommit();
	}

	/**
	 * Resize a text item's frame to fit in-progress input, without touching the
	 * persisted text. The inline editor calls this on every keystroke so the box
	 * tracks width and line breaks live; the text itself (and the undo step) is
	 * still recorded once, when the edit is committed.
	 */
	function applyTaskSnapshots(
		snapshots: ReadonlyMap<string, BoardTaskSnapshot>,
	) {
		if (snapshots.size === 0) return;
		const dirty: string[] = [];
		const next = synced.items.map((item) => {
			if (item.type !== "task") return item;
			const snapshot = snapshots.get(item.taskRunId);
			if (
				!snapshot ||
				JSON.stringify(snapshot) === JSON.stringify(item.snapshot)
			)
				return item;
			dirty.push(item.id);
			return { ...item, snapshot };
		});
		if (dirty.length === 0) return;
		setItems(next, false, dirty);
		undoBaseline = document;
		requestCommit();
	}

	function previewTextLayout(id: string, text: string) {
		const target = itemById(id);
		if (target?.type !== "text") return;
		const size = measureBoardText(text, target.fontSize);
		if (
			target.frame.width === size.width &&
			target.frame.height === size.height
		)
			return;
		setItems(
			synced.items.map((item) =>
				item.id === id ? { ...item, frame: { ...item.frame, ...size } } : item,
			),
			false,
			[id],
		);
	}

	function updateText(id: string, text: string) {
		const target = itemById(id);
		if (!target || (target.type !== "text" && target.type !== "geo")) return;
		if (target.text === text) return;
		setItems(
			synced.items.map((item) => {
				if (item.id !== id) return item;
				if (item.type === "geo") return { ...item, text };
				if (item.type !== "text") return item;
				const size = measureBoardText(text, item.fontSize);
				return {
					...item,
					text,
					frame: {
						...item.frame,
						width: size.width,
						height: size.height,
					},
				};
			}),
		);
		commitAction();
	}

	// ─── Hit testing (world space) ──────────────────────────────────
	function topItemAt(point: WorldPoint): BoardItem | null {
		// The index yields AABB candidates topmost-first; refine with a shape-aware
		// exact test (rotated boxes, geo outlines, strokes, arrow curves) and take
		// the first match.
		ensureSpatial();
		for (const id of spatial.idsAtPoint(point)) {
			const item = itemsById.get(id);
			if (!item) continue;
			const hit =
				item.type === "arrow"
					? arrowHitTest(item, point)
					: shapeHitTest(item, point);
			if (hit) return item;
		}
		return null;
	}

	/** Frame lookup over the current items, for resolving arrow bindings. */
	function frameLookup(): FrameLookup {
		ensureSpatial();
		return (id) => itemsById.get(id)?.frame;
	}

	/** Ids of items whose bounds intersect a world-space rect (viewport culling). */
	function idsInRect(rect: Rect): string[] {
		ensureSpatial();
		return spatial.idsInRect(rect);
	}

	/**
	 * O(1) item lookup by id, backed by the spatial index's item map. Per-frame
	 * callers must use this instead of scanning `items`: an O(n) scan per lookup
	 * is the difference between a board that scales to thousands of nodes and one
	 * that does not.
	 */
	function itemById(id: string): BoardItem | null {
		ensureSpatial();
		return itemsById.get(id) ?? null;
	}

	/**
	 * Hit-test arrow endpoint handles for a single selected arrow. Returns which
	 * endpoint is under the pointer, or null.
	 */
	function arrowHandleAt(point: WorldPoint): "start" | "end" | "mid" | null {
		if (selection.length !== 1) return null;
		const item = selectedItems[0];
		if (item?.type !== "arrow") return null;
		if (isLocked(item)) return null;
		const resolved = resolveArrowFor(item);
		const radius = (HANDLE_HIT_RADIUS + 2) / camera.zoom;
		const distStart = Math.hypot(
			resolved.start.x - point.x,
			resolved.start.y - point.y,
		);
		const distEnd = Math.hypot(
			resolved.end.x - point.x,
			resolved.end.y - point.y,
		);
		const distMid = Math.hypot(
			resolved.control.x - point.x,
			resolved.control.y - point.y,
		);
		// Prefer endpoints over mid when they overlap.
		if (distStart <= radius && distStart <= distEnd && distStart <= distMid)
			return "start";
		if (distEnd <= radius && distEnd <= distMid) return "end";
		if (distMid <= radius) return "mid";
		return null;
	}

	/**
	 * When moving frames, also move unlocked items whose center currently lies
	 * inside a selected frame. Membership is spatial (no parentId).
	 */
	function expandFrameChildren(ids: string[]): string[] {
		const selected = new Set(ids);
		const frames = synced.items.filter(
			(item) =>
				item.type === "frame" && selected.has(item.id) && !isLocked(item),
		);
		if (frames.length === 0) return ids;
		const extra: string[] = [];
		for (const item of synced.items) {
			if (selected.has(item.id) || isLocked(item)) continue;
			if (item.type === "frame") continue;
			const cx = item.frame.x + item.frame.width / 2;
			const cy = item.frame.y + item.frame.height / 2;
			for (const frame of frames) {
				const f = frame.frame;
				if (
					cx >= f.x &&
					cx <= f.x + f.width &&
					cy >= f.y &&
					cy <= f.y + f.height
				) {
					extra.push(item.id);
					break;
				}
			}
		}
		return extra.length ? [...ids, ...extra] : ids;
	}

	function framesFor(ids: string[]): Map<string, BoardFrame> {
		const frames = new Map<string, BoardFrame>();
		for (const item of synced.items) {
			if (ids.includes(item.id)) frames.set(item.id, { ...item.frame });
		}
		return frames;
	}

	/** Origin snapshot of the selected arrow items (geometry lives in endpoints). */
	function arrowsFor(ids: string[]): Map<string, BoardArrowItem> {
		const arrows = new Map<string, BoardArrowItem>();
		for (const item of synced.items) {
			if (item.type === "arrow" && ids.includes(item.id))
				arrows.set(item.id, item);
		}
		return arrows;
	}

	/**
	 * Snap a set of frames being translated against the other items on the board
	 * (and the grid when visible). Returns the corrective delta and the guide
	 * lines to render. Threshold scales with zoom so it feels constant on screen.
	 */
	function computeTranslationSnap(moved: Map<string, BoardFrame>) {
		const movingBounds = selectionBounds([...moved.values()]);
		if (!movingBounds) return { dx: 0, dy: 0, guides: [] as SnapGuide[] };
		const targets: Rect[] = [];
		for (const item of synced.items) {
			if (moved.has(item.id)) continue;
			if (!shapeCapabilities(item).canSnap) continue;
			targets.push(shapeBounds(item));
		}
		const grid = gridSnapSize();
		return computeSnap(movingBounds, targets, {
			threshold: SNAP_THRESHOLD / Math.max(camera.zoom, 0.0001),
			gridSize: grid,
		});
	}

	/** Grid size for snapping only when a visible grid is enabled. */
	function gridSnapSize(): number {
		const grid = document.appearance.grid;
		return grid?.visible === true ? (grid.size ?? 0) : 0;
	}

	/** Patch arrow bend, keeping its frame consistent with the new curve. */
	function applyArrowBend(arrowId: string, bend: number) {
		setItems(
			synced.items.map((item) => {
				if (item.id !== arrowId || item.type !== "arrow") return item;
				const next: BoardArrowItem = { ...item, bend };
				return { ...next, frame: { ...arrowBoundsFor(next), rotation: 0 } };
			}),
			false,
			[arrowId],
		);
	}

	/** Patch one arrow endpoint, keeping its frame consistent. */
	function applyArrowEndpoint(
		arrowId: string,
		which: "start" | "end",
		point: WorldPoint,
	) {
		setItems(
			synced.items.map((item) => {
				if (item.id !== arrowId || item.type !== "arrow") return item;
				const next: BoardArrowItem = {
					...item,
					[which]: { x: point.x, y: point.y },
				};
				return { ...next, frame: { ...arrowBoundsFor(next), rotation: 0 } };
			}),
			false,
			[arrowId],
		);
	}

	// ─── Connections ────────────────────────────────────────────────

	/** A connection by id, or null. */
	function connectionById(id: string): BoardConnection | null {
		ensureConnectionIndex();
		return connectionIndex.get(id) ?? null;
	}

	/** Resolve a connection's world geometry against the live node frames. */
	function resolveConnectionGeometry(connection: BoardConnection) {
		return connectionGeometry.get(connection, frameLookup())?.resolved ?? null;
	}

	/**
	 * The topmost connection under a point, or null.
	 *
	 * Connections are tested against their resolved path rather than a bounding
	 * box, so clicking inside the wide empty area spanned by a long diagonal
	 * relation does not select it.
	 */
	function connectionAt(point: WorldPoint): BoardConnection | null {
		ensureConnectionIndex();
		const lookup = frameLookup();
		// Later connections sit above earlier ones, matching document order.
		for (let index = synced.connections.length - 1; index >= 0; index -= 1) {
			const connection = synced.connections[index];
			if (!connection) continue;
			const geometry = connectionGeometry.get(connection, lookup);
			const radius = connectionHitRadius(connection.style.size);
			if (!geometry || !rectContainsPoint(geometry.bounds, point, radius))
				continue;
			if (connectionHitTest(geometry.resolved, point, connection.style.size))
				return connection;
		}
		return null;
	}

	/** Create a relation between two nodes. Returns its id, or null if refused. */
	function connectNodes(input: {
		sourceItemId: string;
		targetItemId: string;
		sourceAnchor?: BoardConnectionAnchor;
		targetAnchor?: BoardConnectionAnchor;
	}): string | null {
		if (options.readonly) return null;
		const source = itemById(input.sourceItemId);
		const target = itemById(input.targetItemId);
		if (!source || !target) return null;
		if (!shapeCapabilities(source).canConnect) return null;
		if (!shapeCapabilities(target).canConnect) return null;
		// Re-drawing an existing relation is a no-op rather than a duplicate edge:
		// the second one would be invisible underneath the first. Found via the
		// connection index (source degree) instead of scanning every relation.
		const existing = connectionsForNodes([input.sourceItemId]).find(
			(connection) => connection.target.itemId === input.targetItemId,
		);
		if (existing) return existing.id;
		const connection = createBoardConnection({
			id: createBoardItemId(),
			sourceItemId: input.sourceItemId,
			targetItemId: input.targetItemId,
			...(input.sourceAnchor ? { sourceAnchor: input.sourceAnchor } : {}),
			...(input.targetAnchor ? { targetAnchor: input.targetAnchor } : {}),
			style: {
				color: toolStyles.connection.color,
				size: toolStyles.connection.size,
			},
		});
		setConnections([...synced.connections, connection]);
		commitAction();
		return connection.id;
	}

	/** Patch a relation (direction, label, style, routing, endpoints). */
	function updateConnection(
		connectionId: string,
		patch: Partial<Omit<BoardConnection, "id">>,
		commit = true,
	) {
		if (options.readonly) return;
		let changed = false;
		const next = synced.connections.map((connection) => {
			if (connection.id !== connectionId) return connection;
			changed = true;
			return { ...connection, ...patch };
		});
		if (!changed) return;
		setConnections(next);
		if (commit) commitAction();
	}

	/**
	 * Nodes that should show connection ports.
	 *
	 * Ports appear for a single selected node, and on hover for a fine pointer.
	 * Restricting to one node keeps the canvas quiet: showing four ports per node
	 * across a multi-selection would add more chrome than affordance. Touch gets
	 * ports on selection only, since there is no hover to reveal them.
	 */
	function portNodeId(): string | null {
		if (options.readonly) return null;
		if (tool !== "select") return null;
		if (
			interaction.type !== "idle" &&
			interaction.type !== "creatingConnection"
		)
			return null;
		if (editingId) return null;
		// Hover only reveals ports for a pointer that can hover at all; touch and pen
		// rely on selection, so ports never appear under a finger that is just panning.
		const hoverReveals = !canTapSelectWithHand(hoverPointerType);
		const candidateId =
			selection.length === 1 ? selection[0] : hoverReveals ? hoverId : null;
		if (!candidateId) return null;
		const item = itemById(candidateId);
		if (!item || isLocked(item)) return null;
		return shapeCapabilities(item).canConnect ? item.id : null;
	}

	/** Ports currently shown, for the overlay and for hit testing. */
	function visiblePorts(): Array<ConnectionPort & { nodeId: string }> {
		const nodeId = portNodeId();
		if (!nodeId) return [];
		const item = itemById(nodeId);
		if (!item) return [];
		return connectionPorts(item.frame, camera.zoom).map((port) => ({
			...port,
			nodeId,
		}));
	}

	/** The port under a point, or null. */
	function connectionPortAt(
		point: WorldPoint,
		pointerType: string,
	): (ConnectionPort & { nodeId: string }) | null {
		const nodeId = portNodeId();
		if (!nodeId) return null;
		const item = itemById(nodeId);
		if (!item) return null;
		const port = portAt(item.frame, point, camera.zoom, pointerType);
		return port ? { ...port, nodeId } : null;
	}

	/** Endpoint handles of the selected relation, for re-pointing it. */
	function connectionEndpointAt(
		point: WorldPoint,
		pointerType: string,
	): { connection: BoardConnection; which: "source" | "target" } | null {
		if (options.readonly || selection.length !== 1) return null;
		const connection = connectionById(selection[0] ?? "");
		if (!connection) return null;
		const resolved = resolveConnectionGeometry(connection);
		if (!resolved) return null;
		const radius = portHitRadius(pointerType) / Math.max(camera.zoom, 0.0001);
		const toSource = Math.hypot(
			resolved.source.point.x - point.x,
			resolved.source.point.y - point.y,
		);
		const toTarget = Math.hypot(
			resolved.target.point.x - point.x,
			resolved.target.point.y - point.y,
		);
		if (toSource <= radius && toSource <= toTarget)
			return { connection, which: "source" };
		if (toTarget <= radius) return { connection, which: "target" };
		return null;
	}

	/** A connectable node under a point, excluding one id. */
	function connectTargetAt(
		point: WorldPoint,
		excludeId?: string,
	): string | null {
		const item = topItemAt(point);
		if (!item || item.id === excludeId) return null;
		if (isLocked(item)) return null;
		return shapeCapabilities(item).canConnect ? item.id : null;
	}

	function deleteConnection(connectionId: string) {
		if (options.readonly) return;
		const next = synced.connections.filter(
			(connection) => connection.id !== connectionId,
		);
		if (next.length === synced.connections.length) return;
		setConnections(next);
		selection = selection.filter((id) => id !== connectionId);
		commitAction();
	}

	// ─── Pointer interaction state machine ─────────────────────────
	function appendDrawSample(
		gesture: Extract<BoardInteraction, { type: "drawing" }>,
		event: BoardPointerEvent,
	) {
		const points = appendBoardDrawSample(
			gesture.points,
			gesture.pointerId,
			event,
			camera.zoom,
		);
		return points === gesture.points ? gesture : { ...gesture, points };
	}

	function beginPinch() {
		const points = [...activePointers.values()];
		const [a, b] = points;
		if (!a || !b) return;
		pinch = {
			distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
			midpoint: screenPoint((a.x + b.x) / 2, (a.y + b.y) / 2),
			zoom: camera.zoom,
		};
		interaction = { type: "idle" };
	}

	function pointerDown(event: BoardPointerEvent) {
		cancelCameraAnimation();
		hoverPoint = event.world;
		hoverPointerType = event.pointerType;
		// A second contact during a stroke is usually palm input, not a new gesture.
		if (
			interaction.type === "drawing" &&
			interaction.pointerId !== event.pointerId
		)
			return;
		activePointers.set(event.pointerId, event.screen);
		if (activePointers.size === 2) {
			beginPinch();
			return;
		}
		if (activePointers.size > 2) return;

		const additive = event.shiftKey || event.metaKey || event.ctrlKey;
		// Hand tool, temporary Space hand, or middle mouse — pan.
		// (Alt is reserved for drag-duplicate; no longer pans.)
		if (tool === "hand" || spaceHeld || event.button === 1) {
			const tapSelection =
				tool === "hand" &&
				!spaceHeld &&
				event.button !== 1 &&
				canTapSelectWithHand(event.pointerType)
					? { targetId: topItemAt(event.world)?.id ?? null }
					: null;
			interaction = {
				type: "panning",
				start: event.screen,
				origin: { ...camera },
				moved: false,
				tapSelection,
			};
			return;
		}

		// View-only: selection and marquee stay live because they only read the
		// document, but every gesture below this point mutates it (create, translate,
		// resize, rotate, arrow handles). Refusing them here — in the interaction
		// state machine — is what makes a published Board actually immutable, rather
		// than merely unsaved.
		if (options.readonly) {
			const hit = topItemAt(event.world);
			if (hit) {
				selection = additive
					? selection.includes(hit.id)
						? selection.filter((id) => id !== hit.id)
						: [...selection, hit.id]
					: [hit.id];
				interaction = { type: "idle" };
				return;
			}
			interaction = {
				type: "brushing",
				start: event.world,
				current: event.world,
				additive,
				baseSelection: selection,
			};
			return;
		}

		// Creation tools take over the primary pointer before any of the
		// select-tool handle/hit logic below.
		if (tool === "draw") {
			const style = toolStyles.draw;
			interaction = {
				type: "drawing",
				id: createBoardItemId(),
				pointerId: event.pointerId,
				points: [{ x: event.world.x, y: event.world.y, p: event.pressure }],
				color: style.color,
				size: style.size,
			};
			return;
		}
		if (tool === "arrow") {
			const style = toolStyles.arrow;
			interaction = {
				type: "creatingArrow",
				id: createBoardItemId(),
				start: event.world,
				current: event.world,
				color: style.color,
				size: style.size,
			};
			return;
		}
		if (tool === "geo" || tool === "frame") {
			const color =
				tool === "geo" ? toolStyles.geo.color : toolStyles.frame.color;
			interaction = {
				type: "creatingBox",
				id: createBoardItemId(),
				kind: tool,
				start: event.world,
				current: event.world,
				color,
				geo: toolStyles.geo.geo,
			};
			return;
		}
		if (tool === "text") {
			beginTextDraft(event.world);
			return;
		}

		// A connection port beats every box control: it sits outside the node, so a
		// press there can only mean "start a relation".
		const port = connectionPortAt(event.world, event.pointerType);
		if (port) {
			interaction = {
				type: "creatingConnection",
				sourceItemId: port.nodeId,
				sourceAnchor: { kind: "side", side: port.side, offset: 0.5 },
				current: event.world,
				targetItemId: null,
			};
			return;
		}

		// Endpoint handles of the selected relation, so an existing edge can be
		// re-pointed without deleting it.
		const endpointHandle = connectionEndpointAt(event.world, event.pointerType);
		if (endpointHandle) {
			interaction = {
				type: "draggingConnectionEnd",
				connectionId: endpointHandle.connection.id,
				which: endpointHandle.which,
				origin: endpointHandle.connection,
				current: event.world,
				targetItemId: null,
				moved: false,
			};
			return;
		}

		// Arrow endpoint handles take priority over box resize/rotate.
		const arrowHandle = arrowHandleAt(event.world);
		if (arrowHandle) {
			const arrow = selectedItems[0];
			if (arrow && arrow.type === "arrow") {
				interaction = {
					type: "draggingArrowHandle",
					arrowId: arrow.id,
					which: arrowHandle,
					origin: arrow,
					moved: false,
				};
				return;
			}
		}

		const transformControl = selectionTransformControlAt(
			selectionTransform,
			event.world,
			camera.zoom,
			event.pointerType,
		);
		if (transformControl?.kind === "rotate" && bounds) {
			const pivot = rectCenter(bounds);
			interaction = {
				type: "rotating",
				pivot,
				startAngle: angleFromCenter(pivot, event.world),
				current: event.world,
				origin: framesFor(selection),
				moved: false,
			};
			return;
		}

		if (transformControl?.kind === "resize" && bounds) {
			const origin = framesFor(selection);
			interaction = {
				type: "resizing",
				handle: transformControl.handle,
				single:
					selection.length === 1
						? (() => {
								const frame = origin.get(selection[0] ?? "");
								return frame ? { ...frame } : null;
							})()
						: null,
				bounds,
				origin,
				moved: false,
			};
			return;
		}

		const item = topItemAt(event.world);
		if (!item) {
			// Nodes win over relations: a connection is only selectable where no node
			// covers it, so a line crossing a card never steals that card's click.
			const connection = connectionAt(event.world);
			if (connection) {
				selection = additive
					? selection.includes(connection.id)
						? selection.filter((id) => id !== connection.id)
						: [...selection, connection.id]
					: [connection.id];
				interaction = { type: "idle" };
				return;
			}
		}
		if (item) {
			if (additive) {
				selection = selection.includes(item.id)
					? selection.filter((id) => id !== item.id)
					: [...selection, item.id];
			} else if (!selection.includes(item.id)) {
				selection = [item.id];
			}
			const movable = unlockedIds(selection);
			// Locked-only selection: allow re-select but not translate.
			if (movable.length === 0) {
				interaction = { type: "idle" };
				return;
			}
			const withChildren = expandFrameChildren(movable);
			interaction = {
				type: "translating",
				start: event.world,
				origin: framesFor(withChildren),
				arrowOrigin: arrowsFor(withChildren),
				moved: false,
				duplicate: event.altKey,
			};
			return;
		}

		interaction = {
			type: "brushing",
			start: event.world,
			current: event.world,
			additive,
			baseSelection: selection,
		};
	}

	function pointerMove(event: BoardPointerEvent) {
		hoverPoint = event.world;
		hoverPointerType = event.pointerType;
		if (activePointers.has(event.pointerId))
			activePointers.set(event.pointerId, event.screen);

		if (pinch && activePointers.size >= 2) {
			const points = [...activePointers.values()];
			const [a, b] = points;
			if (a && b) {
				const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
				const midpoint = screenPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
				const zoom = clampZoom(pinch.zoom * (distance / pinch.distance));
				const zoomed = zoomAround(camera, midpoint, zoom);
				setCamera(
					panBy(
						zoomed,
						midpoint.x - pinch.midpoint.x,
						midpoint.y - pinch.midpoint.y,
					),
				);
				pinch = { ...pinch, midpoint };
			}
			return;
		}

		if (interaction.type === "idle") {
			hoverId = hoveredTransformControl
				? null
				: (topItemAt(event.world)?.id ?? null);
			return;
		}

		if (interaction.type === "panning") {
			const dx = event.screen.x - interaction.start.x;
			const dy = event.screen.y - interaction.start.y;
			if (
				interaction.tapSelection &&
				!interaction.moved &&
				isWithinHandTapSlop(dx, dy)
			)
				return;
			if (!interaction.moved) interaction = { ...interaction, moved: true };
			setCamera(panBy(interaction.origin, dx, dy));
			return;
		}

		if (interaction.type === "translating") {
			let dx = event.world.x - interaction.start.x;
			let dy = event.world.y - interaction.start.y;
			// Ignore sub-threshold jitter so a plain click never mutates frames
			// (which would otherwise leave the board permanently "Pending").
			if (!interaction.moved) {
				if (Math.hypot(dx, dy) <= DRAG_THRESHOLD / camera.zoom) return;
				// Alt-drag: spawn duplicates once, then translate the copies.
				if (interaction.duplicate) {
					// In-place clones (offset 0); the drag delta provides the visual shift.
					const clones = materializeDuplicates(
						[...interaction.origin.keys()],
						0,
					);
					if (clones.items.length > 0) {
						setContent(
							[...synced.items, ...clones.items],
							[...synced.connections, ...clones.connections],
						);
						selection = clones.items.map((copy) => copy.id);
						interaction = {
							...interaction,
							origin: framesFor(selection),
							arrowOrigin: arrowsFor(selection),
							duplicate: false,
							moved: true,
						};
					} else {
						interaction.moved = true;
					}
				} else {
					interaction.moved = true;
				}
			}
			// Shift locks movement to the dominant axis.
			if (event.shiftKey) {
				if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
				else dx = 0;
			}
			const preview = new Map<string, BoardFrame>();
			for (const [id, frame] of interaction.origin) {
				const arrow = interaction.arrowOrigin.get(id);
				preview.set(
					id,
					arrow
						? translateArrow(arrow, dx, dy).frame
						: { ...frame, x: frame.x + dx, y: frame.y + dy },
				);
			}
			// Ctrl/Meta opts out of snapping (Alt is drag-duplicate).
			let sx = 0;
			let sy = 0;
			if (!event.metaKey && !event.ctrlKey) {
				const snap = computeTranslationSnap(preview);
				sx = snap.dx;
				sy = snap.dy;
				snapGuides = snap.guides;
			} else {
				snapGuides = [];
			}
			const tx = dx + sx;
			const ty = dy + sy;
			const arrowPatches = new Map<string, BoardArrowItem>();
			const frames = new Map<string, BoardFrame>();
			for (const [id, frame] of interaction.origin) {
				const arrow = interaction.arrowOrigin.get(id);
				if (arrow) arrowPatches.set(id, translateArrow(arrow, tx, ty));
				else frames.set(id, { ...frame, x: frame.x + tx, y: frame.y + ty });
			}
			const dirty = [...interaction.origin.keys()];
			setItems(
				synced.items.map((item) => {
					const patchedArrow = arrowPatches.get(item.id);
					if (patchedArrow) return patchedArrow;
					const frame = frames.get(item.id);
					return frame ? { ...item, frame } : item;
				}),
				false,
				dirty,
			);
			return;
		}

		if (interaction.type === "resizing") {
			interaction.moved = true;
			const frames = new Map<string, BoardFrame>();
			if (interaction.single) {
				const id = [...interaction.origin.keys()][0];
				const item = id ? itemById(id) : null;
				if (id) {
					// Aspect-locked shapes (text, media, strokes) never distort; for the
					// rest Shift opts into proportional resize.
					const keepAspect = item
						? shapeCapabilities(item).aspectLocked || event.shiftKey
						: event.shiftKey;
					const resized = resizeFrame(
						interaction.single,
						interaction.handle,
						event.world,
						undefined,
						keepAspect,
					);
					frames.set(id, resized);
				}
			} else {
				const scaled = scaleFrames(
					[...interaction.origin.values()],
					interaction.bounds,
					interaction.handle,
					event.world,
				);
				let index = 0;
				for (const id of interaction.origin.keys()) {
					const frame = scaled[index];
					if (frame) frames.set(id, frame);
					index += 1;
				}
			}
			setItems(
				synced.items.map((item) => {
					const frame = frames.get(item.id);
					if (!frame) return item;
					return { ...item, frame };
				}),
				false,
				frames.keys(),
			);
			return;
		}

		if (interaction.type === "rotating") {
			interaction.moved = true;
			interaction.current = event.world;
			let delta =
				angleFromCenter(interaction.pivot, event.world) -
				interaction.startAngle;
			// Shift snaps rotation to 15° increments.
			if (event.shiftKey) delta = Math.round(delta / 15) * 15;
			const rotated = rotateFrames(
				[...interaction.origin.values()],
				interaction.pivot,
				delta,
			);
			const frames = new Map<string, BoardFrame>();
			let index = 0;
			for (const id of interaction.origin.keys()) {
				const frame = rotated[index];
				if (frame) frames.set(id, frame);
				index += 1;
			}
			setItems(patchItemFrames(synced.items, frames), false, frames.keys());
			return;
		}

		if (interaction.type === "draggingArrowHandle") {
			interaction.moved = true;
			const arrowId = interaction.arrowId;
			const which = interaction.which;

			if (which === "mid") {
				const origin = interaction.origin;
				const start = origin.start;
				const end = origin.end;
				const dx = end.x - start.x;
				const dy = end.y - start.y;
				const length = Math.hypot(dx, dy) || 1;
				// Signed distance from chord to pointer along the perpendicular.
				const mid = worldPoint((start.x + end.x) / 2, (start.y + end.y) / 2);
				const nx = -dy / length;
				const ny = dx / length;
				const bend =
					((event.world.x - mid.x) * nx + (event.world.y - mid.y) * ny) /
					length;
				const clamped = Math.max(-0.85, Math.min(0.85, bend));
				applyArrowBend(arrowId, clamped);
				snapGuides = [];
				return;
			}

			// Snap the free endpoint to nearby shape edges.
			let point = event.world;
			if (!event.metaKey && !event.ctrlKey) {
				const snap = computeSnap(
					{ x: point.x, y: point.y, width: 0, height: 0 },
					synced.items
						.filter(
							(item) => item.id !== arrowId && shapeCapabilities(item).canSnap,
						)
						.map((item) => shapeBounds(item)),
					{
						threshold: SNAP_THRESHOLD / Math.max(camera.zoom, 0.0001),
						gridSize: gridSnapSize(),
					},
				);
				point = worldPoint(point.x + snap.dx, point.y + snap.dy);
				snapGuides = snap.guides;
			} else {
				snapGuides = [];
			}
			applyArrowEndpoint(arrowId, which, point);
			return;
		}

		if (interaction.type === "brushing") {
			interaction = { ...interaction, current: event.world };
			const rect = marquee;
			if (!rect) return;
			ensureSpatial();
			const hits: string[] = [];
			for (const id of spatial.idsInRect(rect)) {
				const item = itemsById.get(id);
				if (item && rectsIntersect(itemBounds(item.frame), rect)) hits.push(id);
			}
			selection = interaction.additive
				? [...new Set([...interaction.baseSelection, ...hits])]
				: hits;
			return;
		}

		if (interaction.type === "drawing") {
			// Only the pointer that started this stroke may contribute samples.
			if ((event.buttons & 1) === 0) return;
			interaction = appendDrawSample(interaction, event);
			return;
		}

		if (interaction.type === "creatingArrow") {
			interaction = { ...interaction, current: event.world };
			return;
		}

		if (interaction.type === "creatingConnection") {
			// The candidate is resolved every frame so the highlight tracks the pointer
			// exactly; nothing is written until the gesture ends.
			interaction = {
				...interaction,
				current: event.world,
				targetItemId: connectTargetAt(event.world, interaction.sourceItemId),
			};
			return;
		}

		if (interaction.type === "draggingConnectionEnd") {
			const fixedEnd =
				interaction.which === "source"
					? interaction.origin.target.itemId
					: interaction.origin.source.itemId;
			interaction = {
				...interaction,
				current: event.world,
				targetItemId: connectTargetAt(event.world, fixedEnd),
				moved: true,
			};
			return;
		}

		if (interaction.type === "creatingBox") {
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
		if (
			interaction.type === "drawing" &&
			interaction.pointerId !== event.pointerId
		)
			return;

		// Snapshot the gesture before clearing it. Deferred remotes must land
		// first so the local commit is recorded as the latest undo step.
		const gesture = interaction;
		snapGuides = [];
		interaction = { type: "idle" };
		flushPendingRemote();

		if (
			gesture.type === "panning" &&
			gesture.tapSelection &&
			!gesture.moved &&
			!event.cancelled
		) {
			const targetId = gesture.tapSelection.targetId;
			selection = targetId && itemById(targetId) ? [targetId] : [];
		} else if (gesture.type === "translating" && gesture.moved) {
			bumpStructure();
			commitAction();
		} else if (gesture.type === "resizing" && gesture.moved) {
			finalizeContentResize(gesture);
			bumpStructure();
			commitAction();
		} else if (gesture.type === "rotating" && gesture.moved) {
			normalizeRotations();
			bumpStructure();
			commitAction();
		} else if (gesture.type === "draggingArrowHandle" && gesture.moved) {
			bumpStructure();
			commitAction();
		} else if (gesture.type === "brushing" && !gesture.additive) {
			// A click on empty space (no real drag) clears the selection.
			const dx = gesture.current.x - gesture.start.x;
			const dy = gesture.current.y - gesture.start.y;
			if (Math.hypot(dx, dy) <= 1 / camera.zoom) selection = [];
		} else if (gesture.type === "drawing") {
			const finished = appendDrawSample(gesture, event);
			commitDraw(finished.id, finished.points, finished.color, finished.size);
		} else if (gesture.type === "creatingArrow") {
			commitArrow(
				gesture.id,
				gesture.start,
				gesture.current,
				gesture.color,
				gesture.size,
			);
		} else if (gesture.type === "creatingConnection") {
			// A drag that ended on nothing creates nothing. There is no sensible
			// half-relation to store, and inventing a node here would be a surprise.
			const targetItemId = event.cancelled
				? null
				: (gesture.targetItemId ??
					connectTargetAt(gesture.current, gesture.sourceItemId));
			if (targetItemId) {
				const created = connectNodes({
					sourceItemId: gesture.sourceItemId,
					targetItemId,
					sourceAnchor: gesture.sourceAnchor,
				});
				// Select the new relation so its inspector is immediately available.
				if (created) selection = [created];
			}
		} else if (gesture.type === "draggingConnectionEnd") {
			const fixedEnd =
				gesture.which === "source"
					? gesture.origin.target.itemId
					: gesture.origin.source.itemId;
			const targetItemId = event.cancelled
				? null
				: (gesture.targetItemId ?? connectTargetAt(gesture.current, fixedEnd));
			// Dropping on empty space leaves the relation exactly as it was: an edge
			// with one end nowhere is not a state the model can hold.
			if (targetItemId) {
				const endpoint = gesture.which === "source" ? "source" : "target";
				const current = gesture.origin[endpoint];
				if (current.itemId !== targetItemId) {
					updateConnection(gesture.connectionId, {
						[endpoint]: { nodeId: targetItemId, anchor: { kind: "auto" } },
					} as Partial<Omit<BoardConnection, "id">>);
				}
			}
		} else if (gesture.type === "creatingBox") {
			commitBoxCreate(gesture);
		}
	}

	function pointerLeave() {
		if (interaction.type !== "idle") return;
		hoverPoint = null;
		hoverId = null;
	}

	function normalizeRotations() {
		const ids = new Set(selection);
		const frames = new Map<string, BoardFrame>();
		for (const item of synced.items) {
			if (!ids.has(item.id) || !item.frame.rotation) continue;
			const normalized = normalizeRotation(item.frame.rotation);
			if (normalized !== item.frame.rotation)
				frames.set(item.id, { ...item.frame, rotation: normalized });
		}
		if (frames.size > 0) setItems(patchItemFrames(synced.items, frames));
	}

	// ─── Wheel ──────────────────────────────────────────────────────
	function wheel(
		point: ScreenPoint,
		deltaX: number,
		deltaY: number,
		zoomKey: boolean,
		deltaMode = 0,
	) {
		cancelCameraAnimation();
		if (zoomKey) {
			setCamera(
				zoomAround(
					camera,
					point,
					camera.zoom * wheelZoomFactor(deltaY, deltaMode),
				),
			);
		} else {
			// Slightly faster pan so two-finger scroll keeps up with zoom.
			const dx = normalizeWheelDelta(deltaX, deltaMode);
			const dy = normalizeWheelDelta(deltaY, deltaMode);
			setCamera(panBy(camera, -dx * 1.15, -dy * 1.15));
		}
	}

	// ─── View state reporting ───────────────────────────────────────
	function emitViewState() {
		if (!options.onViewStateChange) return;
		const visibleRect =
			surfaceSize.width > 0 && surfaceSize.height > 0
				? {
						x: -camera.x / camera.zoom,
						y: -camera.y / camera.zoom,
						width: surfaceSize.width / camera.zoom,
						height: surfaceSize.height / camera.zoom,
					}
				: null;
		const selectedNodes = selectedItems.flatMap((item) => {
			const title = titleForBoardItem(item).trim();
			return [{ id: item.id, type: item.type, ...(title ? { title } : {}) }];
		});
		options.onViewStateChange({ visibleRect, selectedNodes });
	}

	$effect(() => {
		camera;
		surfaceSize;
		selectedItems;
		emitViewState();
	});

	// ─── Lifecycle ──────────────────────────────────────────────────
	function loadDocument(next: BoardDocument, key?: string) {
		// Ignore our own committed snapshots echoed back through the prop; only
		// genuine external documents replace local state.
		if (untrack(() => queue.isEcho(next))) return;
		const sameDocument = key !== undefined && key === currentKey;
		// Defer a same-document refresh while a gesture or text edit is in
		// progress: applying it now would leave the in-flight interaction
		// pointing at replaced nodes. It is applied (rebased) once the
		// interaction ends, via flushPendingRemote().
		if (sameDocument && (interaction.type !== "idle" || editingId)) {
			pendingRemote = { doc: next, key };
			return;
		}
		applyRemote(next, key, sameDocument);
	}

	/**
	 * Adopt an external document.
	 * - Same-document refresh: preserve uncommitted local changes by rebasing
	 *   them onto the remote document (diff against the last known server state,
	 *   re-apply on top), then sync the result. Conflict policy follows
	 *   applyBoardOps: for a given node a delete beats a concurrent patch, and
	 *   local changes are applied last (local wins on same-field edits).
	 * - Document switch: adopt the new document as-is and drop the previous
	 *   document's local state (its changes belong to that document, not this one).
	 */
	function applyRemote(
		next: BoardDocument,
		key: string | undefined,
		sameDocument: boolean,
	) {
		currentKey = key;
		// A fresh external document supersedes any deferred refresh.
		pendingRemote = null;
		const previousIds = sameDocument
			? new Set(synced.items.map((item) => item.id))
			: null;
		const { merged, hadLocalChanges } = reconcileExternal(
			externalBaseline,
			document,
			next,
			sameDocument,
		);
		synced = toContent(merged);
		if (previousIds) {
			markAdded(
				merged.items
					.filter((item) => !previousIds.has(item.id))
					.map((item) => item.id),
			);
		}
		mediaIdsByPath = null;
		bumpSpatial();
		bumpStructure();
		// A document switch resets the camera; a same-document refresh keeps it.
		if (!sameDocument) setCamera(next.viewport);
		// The remote document is the server truth we rebased onto; the commit
		// outcome advances the baseline to `merged` once it lands.
		externalBaseline = next;
		undoBaseline = merged;
		syncGeneration += 1;
		queue.reset({ ...toContent(next), viewport: camera });
		if (hadLocalChanges) {
			localRev = 1;
			committedRev = 0;
			requestCommit();
		} else {
			localRev = 0;
			committedRev = 0;
		}
		// Local history is document-scoped. Same-document remotes rebase content
		// but keep undo/redo; only a document switch drops it.
		if (!sameDocument) {
			undoStack = [];
			redoStack = [];
		}
		// Keep the selection for items that still exist after a same-document
		// refresh; a document switch starts fresh.
		if (sameDocument) {
			const surviving = new Set(merged.items.map((item) => item.id));
			selection = selection.filter((id) => surviving.has(id));
		} else {
			selection = [];
		}
		editingId = null;
		draftId = null;
		saveError = null;
	}

	/** Apply a remote refresh deferred during a gesture or edit. */
	function flushPendingRemote() {
		if (!pendingRemote) return;
		const pending = pendingRemote;
		pendingRemote = null;
		const sameDocument =
			pending.key !== undefined && pending.key === currentKey;
		applyRemote(pending.doc, pending.key, sameDocument);
	}

	function destroy() {
		cancelCameraAnimation();
		activePointers.clear();
	}

	return {
		get document() {
			return document;
		},
		get items() {
			return items;
		},
		get appearance() {
			return synced.appearance;
		},
		get connections() {
			return synced.connections;
		},
		/**
		 * The single selected relation, or null.
		 *
		 * Selection holds ids of both nodes and connections, so consumers ask for the
		 * one they can act on rather than filtering the mixed list themselves.
		 */
		get selectedConnection() {
			if (selection.length !== 1) return null;
			return connectionById(selection[0] ?? "");
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
			return (
				selectedItems.length > 0 ||
				selection.some((id) => connectionById(id) !== null)
			);
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
		/**
		 * The connection under the pointer, for hit-test feedback.
		 *
		 * Only computed when the selection is clear or a connection is already
		 * selected, so a node-hover never cross-fires with a connection-hover.
		 */
		/**
		 * Connection ports to draw, in world space with their draw radius.
		 *
		 * Ports are the only way to start a relation, so this is what makes the
		 * feature reachable at all. The editor resolves them (it owns the
		 * zoom-normalised offsets) and the renderer just draws circles.
		 */
		get connectionPorts(): Array<{ x: number; y: number; radius: number }> {
			return visiblePorts().map((port) => ({
				x: port.point.x,
				y: port.point.y,
				radius: CONNECTION_PORT_RADIUS,
			}));
		},
		/** The port under the pointer, so the renderer can enlarge it. */
		get hoveredConnectionPort(): { x: number; y: number } | null {
			if (!hoverPoint) return null;
			const port = connectionPortAt(hoverPoint, hoverPointerType);
			return port ? { x: port.point.x, y: port.point.y } : null;
		},
		/**
		 * The relation currently being dragged, shaped for the overlay.
		 *
		 * Covers both creating a new relation and re-pointing an existing one, since
		 * the visual is the same: a line from a fixed anchor to the live pointer,
		 * plus a highlight on the node it would attach to.
		 */
		get connectionDraft() {
			if (interaction.type === "creatingConnection") {
				const source = itemById(interaction.sourceItemId);
				if (!source) return null;
				const from = anchorPointOnFrame(interaction.sourceAnchor, source.frame);
				const target = interaction.targetItemId
					? itemById(interaction.targetItemId)
					: null;
				return {
					from: { x: from.x, y: from.y },
					to: { x: interaction.current.x, y: interaction.current.y },
					size: toolStyles.connection.size,
					targetFrame: target ? target.frame : null,
				};
			}
			if (interaction.type === "draggingConnectionEnd") {
				const connection = connectionById(interaction.connectionId);
				if (!connection) return null;
				// The end being dragged moves; the other stays put.
				const fixedEndpoint =
					interaction.which === "source"
						? connection.target
						: connection.source;
				const fixedNode = itemById(fixedEndpoint.itemId);
				if (!fixedNode) return null;
				const from = anchorPointOnFrame(fixedEndpoint.anchor, fixedNode.frame);
				const target = interaction.targetItemId
					? itemById(interaction.targetItemId)
					: null;
				return {
					from: { x: from.x, y: from.y },
					to: { x: interaction.current.x, y: interaction.current.y },
					size: connection.style.size,
					targetFrame: target ? target.frame : null,
				};
			}
			return null;
		},
		get hoveredConnectionId() {
			return hoveredConnectionId;
		},
		get editingId() {
			return editingId;
		},
		get dirty() {
			return dirty;
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
			return synced.items.length > 0;
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
		/**
		 * True while a pointer gesture is mutating the document. Renderers use this
		 * to skip work that only stale (non-gesture) nodes would need.
		 */
		get gestureActive() {
			return interaction.type !== "idle";
		},
		get activeColor() {
			const id = styledToolId();
			return id ? toolStyles[id].color : toolStyles.text.color;
		},
		get activeGeo() {
			return toolStyles.geo.geo;
		},
		get activeStrokeSize() {
			if (tool === "arrow") return toolStyles.arrow.size;
			return toolStyles.draw.size;
		},
		get spaceHeld() {
			return spaceHeld;
		},
		get selectionLocked() {
			return (
				selectedItems.length > 0 && selectedItems.every((item) => item.locked)
			);
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
		previewAppearance: setAppearance,
		setAppearance: commitAppearance,
		set activeColor(value: string) {
			const id = styledToolId();
			if (!id || !isBoardColorId(value)) return;
			toolStyles[id].color = value;
			writeBoardToolStyles(toolStyles);
		},
		set activeGeo(value: string) {
			if (!isGeoKind(value)) return;
			toolStyles.geo.geo = value;
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
		connectNodes,
		updateConnection,
		deleteConnection,
		connectionById,
		connectionAt,
		connectionsForNodes,
		visiblePorts,
		resolveConnectionGeometry,
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
		addGeo,
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
		setSelectionEmphasis,
		setSelectionColor,
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
