import {
	type BoardArrowItem,
	type BoardDrawInputSample,
	type BoardDrawPoint,
	type BoardFrame,
	type BoardItem,
	type BoardSceneItem,
	type BoardViewport,
	appendBoardDrawSamples,
	clampZoom,
	createBoardItemId,
	frameHandlePosition,
	normalizeRotation,
	panBy,
	pointToWorld,
	type Rect,
	type ResizeHandle,
	rectCenter,
	rectContainsPoint,
	rectsIntersect,
	resizeFrame,
	resolveSceneArrow,
	rotateFrames,
	type SceneItem,
	type ScreenPoint,
	scaleFrames,
	screenPoint,
	selectionBounds,
	type WorldPoint,
	worldPoint,
	zoomAround,
} from "../model/index.js";
import { CONNECTION_PORT_RADIUS, type ConnectionPort, connectionPorts, connectionPortAt as portAt, portHitRadius } from "./connection-ports.js";
import type { EditorContext } from "./context.js";
import { BOARD_INPUT, boardDragSlop, isTouchLikePointer } from "./input.js";
import { selectionTransformControlAt } from "./selection-transform.js";
import { computeSnap, type SnapGuide } from "./snapping.js";
import { memo } from "./state.js";
import { isCreationBoardTool } from "./tool.js";

const SNAP_THRESHOLD = 8;
const SELECTION_TOUCH_PAD = 6;
const NO_IDS: ReadonlySet<string> = new Set();

type BoardPress = {
	type: "pressing";
	itemId: string;
	pointerId: number;
	pointerType: string;
	start: ScreenPoint;
	world: WorldPoint;
	camera: BoardViewport;
	at: number;
};

export type BoardTap = { at: number; activate?: string; select?: string[] };

export type BoardInteraction =
	| { type: "idle" }
	| BoardPress
	| {
			type: "panning";
			start: ScreenPoint;
			origin: BoardViewport;
			moved: boolean;
			tapSelection: { targetId: string | null; additive?: boolean } | null;
	  }
	| {
			type: "translating";
			start: WorldPoint;
			origin: Map<string, BoardFrame>;
			moved: boolean;
			duplicate: boolean;
			tap?: BoardTap;
			held?: boolean;
			dropTargetId?: string | null;
	  }
	| {
			type: "resizing";
			handle: ResizeHandle;
			single: BoardFrame | null;
			bounds: Rect;
			origin: Map<string, BoardFrame>;
			grab: { x: number; y: number };
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
			scope?: string;
	  }
	| { type: "drawing"; id: string; pointerId: number; points: BoardDrawPoint[]; color: string; size: number }
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
	| { type: "creatingText"; start: WorldPoint; current: WorldPoint; pointerType: string }
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
	samples?: readonly BoardDrawInputSample[];
};

function angleFrom(center: WorldPoint, point: WorldPoint) {
	return (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI;
}

export type BoardActivation = {
	itemId: string;
	pointerType: string;
	selected: boolean;
};

export type BoardTransformEnd = {
	ids: string[];
	operation: "move" | "resize" | "rotate" | "arrow";
	cancelled: boolean;
};

type Sample = { t: number; x: number; y: number };

export function createInteractionModule(ctx: EditorContext) {
	const { state, options, registry } = ctx;
	const transformListeners = new Set<(event: BoardTransformEnd) => void>();
	const activationListeners = new Set<(event: BoardActivation) => void>();
	const activePointers = new Map<number, ScreenPoint>();
	let pinch: { distance: number; midpoint: ScreenPoint; zoom: number } | null = null;
	let last: BoardPointerEvent | null = null;
	let press: { screen: ScreenPoint; pointerType: string } | null = null;
	let travelled = false;
	let samples: Sample[] = [];
	let penSeen = false;

	function transformEnd(gesture: BoardInteraction, cancelled: boolean) {
		if (!transformListeners.size || !("moved" in gesture) || !gesture.moved) return;
		let event: BoardTransformEnd;
		if (gesture.type === "translating" || gesture.type === "resizing" || gesture.type === "rotating") {
			event = { ids: [...gesture.origin.keys()], operation: gesture.type === "translating" ? "move" : gesture.type === "resizing" ? "resize" : "rotate", cancelled };
		} else if (gesture.type === "draggingArrowHandle") {
			event = { ids: [gesture.arrowId], operation: "arrow", cancelled };
		} else return;
		for (const listener of transformListeners) listener(event);
	}

	function activate(itemId: string, at: number, pointerType: string, selected: boolean) {
		if (performance.now() - at > BOARD_INPUT.tapMs || !state.scene.get(itemId)) return;
		for (const listener of activationListeners) listener({ itemId, pointerType, selected });
	}

	function browsing(): boolean {
		return options.readonly === true || ctx.frames.view()?.present === true;
	}

	function opensOnTap(item: BoardSceneItem) {
		return registry.activation(item, browsing()) === "tap";
	}

	function holdsFrame(pointerType: string): boolean {
		const view = ctx.frames.view();
		return view !== null && (view.present || (options.readonly === true && isTouchLikePointer(pointerType)));
	}

	function pan(origin: BoardViewport, dx: number, dy: number, pointerType: string) {
		if (!holdsFrame(pointerType)) ctx.camera.setCamera(panBy(origin, dx, dy));
		else if (pointerType !== "mouse") ctx.camera.show(panBy(origin, dx, dy), false);
	}

	function dragged(event: BoardPointerEvent): boolean {
		if (travelled || !press) return travelled;
		travelled = Math.hypot(event.screen.x - press.screen.x, event.screen.y - press.screen.y) > boardDragSlop(press.pointerType);
		return travelled;
	}

	const marquee = memo(
		() => [state.interaction] as const,
		(interaction): Rect | null => {
			if (interaction.type !== "brushing") return null;
			const { start, current } = interaction;
			return {
				x: Math.min(start.x, current.x),
				y: Math.min(start.y, current.y),
				width: Math.abs(current.x - start.x),
				height: Math.abs(current.y - start.y),
			};
		},
	);

	const hoveredControl = memo(
		() =>
			[
				state.interaction,
				state.tool,
				state.hoverPoint,
				state.hoverPointerType,
				state.camera.zoom,
				ctx.selection.transform(),
				state.controlOutset,
			] as const,
		(interaction, tool, hoverPoint, pointerType, zoom, transform, outset) =>
			interaction.type === "idle" && !pinch && tool === "select" && hoverPoint
				? selectionTransformControlAt(transform, hoverPoint, zoom, pointerType, outset)
				: null,
	);

	function gridSnapSize(): number {
		const grid = state.base.board.grid;
		return grid?.snap ? grid.size : 0;
	}

	function snapThreshold() {
		return SNAP_THRESHOLD / Math.max(state.camera.zoom, 0.0001);
	}

	function computeTranslationSnap(moved: Map<string, BoardFrame>, skip: ReadonlySet<string>) {
		const movingBounds = selectionBounds([...moved.values()]);
		if (!movingBounds) return { dx: 0, dy: 0, guides: [] as SnapGuide[] };
		const view = ctx.camera.visibleRect();
		const targets: Rect[] = [];
		for (const id of view ? ctx.query.idsInRect(view) : state.scene.items.map((item) => item.id)) {
			if (skip.has(id)) continue;
			const item = state.scene.get(id);
			if (item && registry.capabilities(item).canSnap) targets.push(registry.bounds(item));
		}
		return computeSnap(movingBounds, targets, { threshold: snapThreshold(), gridSize: gridSnapSize() });
	}

	let subtrees: { origin: ReadonlyMap<string, BoardFrame>; ids: ReadonlySet<string> } | null = null;
	function movingWith(origin: ReadonlyMap<string, BoardFrame>): ReadonlySet<string> {
		if (subtrees?.origin !== origin) subtrees = { origin, ids: ctx.query.withSubtrees(origin.keys()) };
		return subtrees.ids;
	}

	function dropParents(origin: ReadonlyMap<string, BoardFrame>, untilFrame = false): Map<string, string | undefined> {
		const parents = new Map<string, string | undefined>();
		const moving = movingWith(origin);
		for (const id of origin.keys()) {
			const item = state.scene.get(id);
			if (!item || item.type === "arrow") continue;
			const parent = ctx.query.frameAt(rectCenter(item.frame), moving)?.id;
			if (parent === item.parent) continue;
			parents.set(id, parent);
			if (untilFrame && parent) break;
		}
		return parents;
	}

	function reparentDropped(origin: ReadonlyMap<string, BoardFrame>): Map<string, BoardItem> {
		const changes = new Map<string, BoardItem>();
		for (const [id, parent] of dropParents(origin)) {
			const item = state.scene.get(id);
			const stored = ctx.document.displayItem(id);
			if (!item || !stored) continue;
			changes.set(id, {
				...ctx.document.reparent(stored, item.frame, parent, state.scene.layout.box(id)),
				z: ctx.document.topZ(parent) + changes.size,
			});
		}
		return changes;
	}

	function portItemId(): string | null {
		const { tool, editingId, interaction, selection, hoverId, scene } = state;
		if (options.readonly || tool !== "select" || editingId) return null;
		if (interaction.type !== "idle" && interaction.type !== "creatingArrow") return null;
		const hoverReveals = !isTouchLikePointer(state.hoverPointerType);
		const candidateId = selection.length === 1 ? selection[0] : hoverReveals ? hoverId : null;
		if (!candidateId) return null;
		const item = scene.get(candidateId);
		if (!item || ctx.query.isLocked(item) || item.type === "arrow") return null;
		if (!selection.includes(item.id) && opensOnTap(item)) return null;
		return registry.capabilities(item).canConnect ? item.id : null;
	}

	function visiblePorts(): Array<ConnectionPort & { itemId: string }> {
		const itemId = portItemId();
		const item = itemId ? state.scene.get(itemId) : null;
		if (!itemId || !item) return [];
		return connectionPorts(item.frame, state.camera.zoom).map((port) => ({ ...port, itemId }));
	}

	function connectionPortAt(point: WorldPoint, pointerType: string): (ConnectionPort & { itemId: string }) | null {
		const itemId = portItemId();
		const item = itemId ? state.scene.get(itemId) : null;
		if (!itemId || !item) return null;
		const port = portAt(item.frame, point, state.camera.zoom, pointerType);
		return port ? { ...port, itemId } : null;
	}

	function land(gesture: BoardInteraction) {
		switch (gesture.type) {
			case "translating":
				if (!gesture.moved) return;
				for (const [id, item] of reparentDropped(gesture.origin)) ctx.document.setDraftItem(id, item);
				ctx.document.commit();
				break;
			case "resizing":
			case "rotating":
			case "draggingArrowHandle":
				if (!gesture.moved) return;
				ctx.document.commit();
				break;
			default:
				return;
		}
		transformEnd(gesture, false);
	}

	function beginPinch() {
		const [a, b] = [...activePointers.values()];
		if (!a || !b) return;
		const gesture = state.interaction;
		state.interaction = { type: "idle" };
		state.snapGuides = [];
		land(gesture);
		ctx.remote.flushPending();
		pinch = {
			distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
			midpoint: screenPoint((a.x + b.x) / 2, (a.y + b.y) / 2),
			zoom: state.camera.zoom,
		};
		last = null;
	}

	function brushable(scope: string | undefined): (item: BoardSceneItem) => boolean {
		const enclosing = new Set<string>();
		for (let id = scope; id && !enclosing.has(id); id = state.scene.get(id)?.parent) enclosing.add(id);
		return (item) => !enclosing.has(item.id) && (item.parent === undefined || enclosing.has(item.parent));
	}

	function brush(event: BoardPointerEvent, additive: boolean) {
		const scope = ctx.query.frameAt(event.world)?.id;
		state.interaction = {
			type: "brushing",
			start: event.world,
			current: event.world,
			additive,
			baseSelection: state.selection,
			...(scope ? { scope } : {}),
		};
	}

	function arrowGesture(
		start: WorldPoint,
		current: WorldPoint,
		startItemId: string | null,
		startSide: "top" | "right" | "bottom" | "left" | null,
	): BoardInteraction {
		const { arrow } = state.toolStyles;
		return {
			type: "creatingArrow",
			id: createBoardItemId(),
			start,
			current,
			startItemId,
			startSide,
			targetItemId: null,
			color: arrow.color,
			size: arrow.size,
		};
	}

	function plainPrimary(event: BoardPointerEvent) {
		return event.button === 0 && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
	}

	function pressCard(event: BoardPointerEvent): boolean {
		if (!plainPrimary(event)) return false;
		const item = ctx.query.pickAt(event.world, event.pointerType);
		if (!item || (!options.readonly && ctx.selection.carries(item.id)) || !opensOnTap(item)) return false;
		state.interaction = {
			type: "pressing",
			itemId: item.id,
			pointerId: event.pointerId,
			pointerType: event.pointerType,
			start: event.screen,
			world: event.world,
			camera: { ...state.camera },
			at: performance.now(),
		};
		return true;
	}

	function releasePress(gesture: BoardPress, event: BoardPointerEvent) {
		if (!dragged(event)) return;
		const dx = event.screen.x - gesture.start.x;
		const dy = event.screen.y - gesture.start.y;
		const item = state.scene.get(gesture.itemId);
		const movable =
			!browsing() &&
			state.tool === "select" &&
			item &&
			!ctx.query.isLocked(item) &&
			registry.capabilities(item).canMove;
		if (!movable) {
			state.interaction = { type: "panning", start: gesture.start, origin: gesture.camera, moved: true, tapSelection: null };
			pan(gesture.camera, dx, dy, event.pointerType);
			return;
		}
		const translating: Extract<BoardInteraction, { type: "translating" }> = {
			type: "translating",
			start: gesture.world,
			origin: ctx.selection.framesFor([gesture.itemId]),
			moved: false,
			duplicate: false,
		};
		state.interaction = translating;
		translate(translating, event);
	}

	function pickUp(): BoardSceneItem | null {
		const gesture = state.interaction;
		if (browsing() || pinch || travelled) return null;
		if (gesture.type === "translating") {
			const id = state.selection[0];
			if (!id || gesture.moved || gesture.origin.size === 0) return null;
			state.interaction = { ...gesture, tap: undefined, held: true };
			return state.scene.get(id) ?? null;
		}
		const id =
			gesture.type === "pressing" ? gesture.itemId : gesture.type === "panning" && !gesture.moved ? gesture.tapSelection?.targetId : null;
		const item = id ? state.scene.get(id) : null;
		if (!item || ctx.query.isLocked(item) || !registry.capabilities(item).canMove) return null;
		state.selection = [item.id];
		state.tool = "select";
		state.interaction = {
			type: "translating",
			start: last?.world ?? (gesture.type === "pressing" ? gesture.world : rectCenter(item.frame)),
			origin: ctx.selection.framesFor([item.id]),
			moved: false,
			duplicate: false,
			held: true,
		};
		return item;
	}

	function keepsSelection(point: WorldPoint): boolean {
		const zoom = Math.max(state.camera.zoom, 0.0001);
		const bounds = ctx.selection.bounds();
		if (bounds && rectContainsPoint(bounds, point, SELECTION_TOUCH_PAD / zoom)) return true;
		if (selectionTransformControlAt(ctx.selection.transform(), point, zoom, "touch", state.controlOutset)) return true;
		if (ctx.query.arrowHandleAt(point)) return true;
		const reach = portHitRadius("touch") / zoom;
		return visiblePorts().some((port) => Math.hypot(port.point.x - point.x, port.point.y - point.y) <= reach);
	}

	function browseByTouch(event: BoardPointerEvent) {
		if (options.readonly || event.pointerType !== "touch" || state.tool !== "select") return;
		if (keepsSelection(event.world)) return;
		if (ctx.chosenTool === "select" && state.selection.length === 0) return;
		state.selection = [];
		state.tool = "hand";
		ctx.chosenTool = null;
	}

	function grabsSelection(point: WorldPoint): boolean {
		const bounds = ctx.selection.bounds();
		if (!bounds || !rectContainsPoint(bounds, point)) return false;
		if (state.selection.length > 1 && !ctx.query.itemAt(point)) return true;
		return ctx.selection.movable().some((id) => {
			const item = state.scene.get(id);
			return item?.type === "frame" && registry.hitTest(item, point);
		});
	}

	function translateSelection(event: BoardPointerEvent, tap?: BoardTap) {
		state.interaction = {
			type: "translating",
			start: event.world,
			origin: ctx.selection.framesFor(ctx.selection.movable()),
			moved: false,
			duplicate: event.altKey,
			...(tap ? { tap } : {}),
		};
	}

	function pointerDown(event: BoardPointerEvent) {
		const caught = ctx.camera.stop();
		state.hoverPoint = event.world;
		state.hoverPointerType = event.pointerType;
		const { interaction, toolStyles, camera } = state;
		if (interaction.type === "drawing" && interaction.pointerId !== event.pointerId) return;
		activePointers.set(event.pointerId, event.screen);
		if (activePointers.size === 2) {
			beginPinch();
			return;
		}
		if (activePointers.size > 2) return;

		if (state.enteredId && ctx.query.pickAt(event.world, event.pointerType)?.id !== state.enteredId) state.enteredId = null;
		last = event;
		press = { screen: event.screen, pointerType: event.pointerType };
		travelled = false;
		samples = [];
		if (event.pointerType === "pen") penSeen = true;
		const touch = isTouchLikePointer(event.pointerType);
		if (caught && touch) {
			state.interaction = { type: "panning", start: event.screen, origin: { ...camera }, moved: false, tapSelection: null };
			return;
		}
		if (ctx.frames.view()?.present) {
			if (!pressCard(event)) state.interaction = { type: "panning", start: event.screen, origin: { ...camera }, moved: false, tapSelection: null };
			return;
		}
		browseByTouch(event);

		const { tool, spaceHeld } = state;
		const additive = event.shiftKey || event.metaKey || event.ctrlKey;
		if (!spaceHeld && (tool === "hand" || options.readonly) && pressCard(event)) return;
		const fingerOnPenCanvas = tool === "draw" && event.pointerType === "touch" && penSeen;
		if (tool === "hand" || spaceHeld || event.button === 1 || fingerOnPenCanvas) {
			const picks = tool === "hand" && !spaceHeld && event.button === 0 && (touch || options.readonly);
			state.interaction = {
				type: "panning",
				start: event.screen,
				origin: { ...camera },
				moved: false,
				tapSelection: picks ? { targetId: ctx.query.pickAt(event.world, event.pointerType)?.id ?? null } : null,
			};
			return;
		}

		if (options.readonly) {
			const hit = ctx.query.pickAt(event.world, event.pointerType);
			if (!hit) return brush(event, additive);
			state.interaction = { type: "panning", start: event.screen, origin: { ...camera }, moved: false, tapSelection: { targetId: hit.id, additive } };
			return;
		}

		switch (tool) {
			case "draw": {
				const points: BoardDrawPoint[] = [];
				appendBoardDrawSamples(points, [event], camera.zoom);
				state.interaction = {
					type: "drawing",
					id: createBoardItemId(),
					pointerId: event.pointerId,
					points,
					color: toolStyles.draw.color,
					size: toolStyles.draw.size,
				};
				return;
			}
			case "arrow":
				state.interaction = arrowGesture(event.world, event.world, ctx.query.connectTargetAt(event.world), null);
				return;
			case "shape":
			case "frame":
				state.interaction = {
					type: "creatingBox",
					id: createBoardItemId(),
					kind: tool,
					start: event.world,
					current: event.world,
					color: tool === "shape" ? toolStyles.shape.color : toolStyles.frame.color,
					geometry: toolStyles.shape.geometry,
				};
				return;
			case "text":
				if (!state.editingId) state.interaction = { type: "creatingText", start: event.world, current: event.world, pointerType: event.pointerType };
				return;
		}

		const item = ctx.query.pickAt(event.world, event.pointerType);
		const onSelected = touch && item !== null && ctx.selection.carries(item.id);
		const port = onSelected ? null : connectionPortAt(event.world, event.pointerType);
		if (port) {
			state.interaction = arrowGesture(port.point, event.world, port.itemId, port.side);
			return;
		}

		const arrowHandle = ctx.query.arrowHandleAt(event.world);
		const arrow = ctx.selection.items()[0];
		if (arrowHandle && arrow?.type === "arrow") {
			const { id: _id, frame: _frame, ...origin } = arrow;
			state.interaction = {
				type: "draggingArrowHandle",
				arrowId: arrow.id,
				which: arrowHandle,
				origin: origin as BoardArrowItem,
				targetItemId: null,
				moved: false,
			};
			return;
		}

		const bounds = ctx.selection.bounds();
		const transform = ctx.selection.transform();
		const control = selectionTransformControlAt(transform, event.world, camera.zoom, event.pointerType, state.controlOutset);
		if (control?.kind === "rotate" && bounds) {
			const pivot = rectCenter(bounds);
			state.interaction = {
				type: "rotating",
				pivot,
				startAngle: angleFrom(pivot, event.world),
				current: event.world,
				origin: ctx.selection.framesFor(ctx.selection.movable()),
				moved: false,
			};
			return;
		}
		if (control?.kind === "resize" && bounds && transform) {
			const origin = ctx.selection.framesFor(ctx.selection.movable());
			const single = origin.size === 1 ? { ...([...origin.values()][0] as BoardFrame) } : null;
			const edge = frameHandlePosition(transform.frame, control.handle);
			const grab = { x: edge.x - event.world.x, y: edge.y - event.world.y };
			state.interaction = { type: "resizing", handle: control.handle, single, bounds, origin, grab, moved: false };
			return;
		}

		if (pressCard(event)) return;
		const at = performance.now();
		const selection = state.selection;
		if (!item) {
			if (!additive && grabsSelection(event.world)) return translateSelection(event, { at, select: [] });
			return brush(event, additive);
		}
		const selected = selection.includes(item.id);
		let tap: BoardTap | undefined;
		if (additive) {
			if (selected) tap = { at, select: selection.filter((id) => id !== item.id) };
			else state.selection = [...selection, item.id];
		} else if (!ctx.selection.carries(item.id)) state.selection = [item.id];
		else if (!selected || selection.length > 1) tap = { at, select: [item.id] };
		if (plainPrimary(event) && opensOnTap(item) && (!selected || selection.length === 1)) tap = { at, activate: item.id };
		translateSelection(event, tap);
	}

	function pinchMove() {
		const [a, b] = [...activePointers.values()];
		if (!a || !b || !pinch) return;
		const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
		const midpoint = screenPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
		const zoomed = zoomAround(state.camera, midpoint, clampZoom(pinch.zoom * (distance / pinch.distance)));
		const next = panBy(zoomed, midpoint.x - pinch.midpoint.x, midpoint.y - pinch.midpoint.y);
		if (ctx.frames.view()?.present) ctx.camera.show(next, false);
		else ctx.camera.setCamera(next);
		pinch = { ...pinch, midpoint };
		sample(midpoint);
	}

	function sample(point: ScreenPoint) {
		const t = performance.now();
		samples.push({ t, x: point.x, y: point.y });
		while (samples.length > 2 && (samples[0] as Sample).t < t - BOARD_INPUT.flingSampleMs) samples.shift();
	}

	function releaseVelocity(): { vx: number; vy: number } {
		const now = performance.now();
		const recent = samples.filter((entry) => entry.t >= now - BOARD_INPUT.flingSampleMs);
		const first = recent[0];
		const final = recent.at(-1);
		if (!first || !final || final.t - first.t < 8) return { vx: 0, vy: 0 };
		const dt = Math.max(now, final.t) - first.t;
		return { vx: (final.x - first.x) / dt, vy: (final.y - first.y) / dt };
	}

	function translate(gesture: Extract<BoardInteraction, { type: "translating" }>, event: BoardPointerEvent) {
		let dx = event.world.x - gesture.start.x;
		let dy = event.world.y - gesture.start.y;
		let current = gesture;
		if (!current.moved) {
			if (!dragged(event)) return;
			current = { ...current, moved: true, tap: undefined };
			if (gesture.duplicate) {
				const clones = ctx.copy.duplicates([...gesture.origin.keys()], 0);
				if (clones.size > 0) {
					ctx.document.writeDraft(clones, true);
					const roots = ctx.copy.rootsOfCopies(clones);
					state.selection = roots;
					current = { ...current, origin: ctx.selection.framesFor(roots), duplicate: false };
				}
			}
			state.interaction = current;
		}
		if (event.shiftKey) {
			if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
			else dx = 0;
		}
		const shift = (tx: number, ty: number) => {
			const frames = new Map<string, BoardFrame>();
			for (const [id, frame] of current.origin) frames.set(id, { ...frame, x: frame.x + tx, y: frame.y + ty });
			return frames;
		};
		let tx = dx;
		let ty = dy;
		if (!event.metaKey && !event.ctrlKey) {
			const snap = computeTranslationSnap(shift(dx, dy), movingWith(current.origin));
			tx += snap.dx;
			ty += snap.dy;
			state.snapGuides = snap.guides;
		} else state.snapGuides = [];
		ctx.document.writeDraft(ctx.selection.placed(shift(tx, ty)));
		let dropTargetId: string | null = null;
		for (const parent of dropParents(current.origin, true).values()) if (parent) dropTargetId = parent;
		if ((current.dropTargetId ?? null) !== dropTargetId) state.interaction = { ...current, dropTargetId };
	}

	function resize(gesture: Extract<BoardInteraction, { type: "resizing" }>, event: BoardPointerEvent) {
		if (!gesture.moved) {
			if (!dragged(event)) return;
			state.interaction = { ...gesture, moved: true };
		}
		const frames = new Map<string, BoardFrame>();
		const point = worldPoint(event.world.x + gesture.grab.x, event.world.y + gesture.grab.y);
		if (gesture.single) {
			const id = [...gesture.origin.keys()][0] as string;
			const item = state.scene.get(id);
			const keepAspect = item ? registry.capabilities(item).aspectLocked || event.shiftKey : event.shiftKey;
			frames.set(id, resizeFrame(gesture.single, gesture.handle, point, undefined, keepAspect));
		} else {
			const scaled = scaleFrames([...gesture.origin.values()], gesture.bounds, gesture.handle, point);
			[...gesture.origin.keys()].forEach((id, index) => {
				const frame = scaled[index];
				if (frame) frames.set(id, frame);
			});
		}
		ctx.document.writeDraft(ctx.selection.placed(frames));
	}

	function rotate(gesture: Extract<BoardInteraction, { type: "rotating" }>, event: BoardPointerEvent) {
		if (!gesture.moved && !dragged(event)) return;
		state.interaction = { ...gesture, moved: true, current: event.world };
		let delta = angleFrom(gesture.pivot, event.world) - gesture.startAngle;
		if (event.shiftKey) delta = Math.round(delta / 15) * 15;
		const rotated = rotateFrames([...gesture.origin.values()], gesture.pivot, delta);
		const frames = new Map<string, BoardFrame>();
		[...gesture.origin.keys()].forEach((id, index) => {
			const frame = rotated[index];
			if (frame) frames.set(id, { ...frame, rotation: normalizeRotation(frame.rotation) });
		});
		ctx.document.writeDraft(ctx.selection.placed(frames));
	}

	function dragArrowHandle(gesture: Extract<BoardInteraction, { type: "draggingArrowHandle" }>, event: BoardPointerEvent) {
		if (!gesture.moved) {
			if (!dragged(event)) return;
			state.interaction = { ...gesture, moved: true };
		}
		const { arrowId, which, origin } = gesture;
		const { scene } = state;
		const arrow = scene.get(arrowId) as SceneItem<BoardArrowItem> | undefined;
		if (!arrow) return;
		if (which === "mid") {
			const resolved = resolveSceneArrow({ ...arrow, props: origin.props }, scene);
			const start = resolved.start.point;
			const end = resolved.end.point;
			const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
			const mid = worldPoint((start.x + end.x) / 2, (start.y + end.y) / 2);
			const bend =
				((event.world.x - mid.x) * -(end.y - start.y) + (event.world.y - mid.y) * (end.x - start.x)) /
				(length * length);
			const route = origin.props.route === "straight" ? "curve" : origin.props.route;
			const props = { ...origin.props, route, bend: Math.max(-0.85, Math.min(0.85, bend)) };
			ctx.document.writeDraft(new Map([[arrowId, { ...origin, props } as BoardItem]]));
			state.snapGuides = [];
			return;
		}
		const targetItemId = ctx.query.connectTargetAt(event.world, new Set([arrowId]));
		let point = event.world;
		if (!targetItemId && !event.metaKey && !event.ctrlKey) {
			const snap = computeSnap(
				{ x: point.x, y: point.y, width: 0, height: 0 },
				scene.items
					.filter((item) => item.id !== arrowId && registry.capabilities(item).canSnap)
					.map((item) => registry.bounds(item)),
				{ threshold: snapThreshold(), gridSize: gridSnapSize() },
			);
			point = worldPoint(point.x + snap.dx, point.y + snap.dy);
			state.snapGuides = snap.guides;
		} else state.snapGuides = [];
		state.interaction = { ...(state.interaction as typeof gesture), targetItemId };
		const end = ctx.creation.arrowEnd(point, targetItemId, scene.layout.matrix(arrowId));
		ctx.document.writeDraft(new Map([[arrowId, { ...origin, props: { ...origin.props, [which]: end } } as BoardItem]]), true);
	}

	function move(event: BoardPointerEvent) {
		const interaction = state.interaction;
		switch (interaction.type) {
			case "idle":
				state.hoverId =
					isCreationBoardTool(state.tool) || hoveredControl() || ctx.frames.view()?.present
						? null
						: (ctx.query.pickAt(event.world, event.pointerType)?.id ?? null);
				return;
			case "panning": {
				const held = holdsFrame(event.pointerType);
				if ((interaction.tapSelection || held) && !interaction.moved && !dragged(event)) return;
				if (!interaction.moved) state.interaction = { ...interaction, moved: true };
				pan(interaction.origin, event.screen.x - interaction.start.x, event.screen.y - interaction.start.y, event.pointerType);
				sample(event.screen);
				return;
			}
			case "pressing":
				return releasePress(interaction, event);
			case "translating":
				return translate(interaction, event);
			case "resizing":
				return resize(interaction, event);
			case "rotating":
				return rotate(interaction, event);
			case "draggingArrowHandle":
				return dragArrowHandle(interaction, event);
			case "brushing": {
				state.interaction = { ...interaction, current: event.world };
				const rect = marquee();
				if (!rect) return;
				const reaches = brushable(interaction.scope);
				const hits = ctx.query.idsInRect(rect).filter((id) => {
					const item = state.scene.get(id);
					return item && reaches(item) && !ctx.query.isLocked(item) && rectsIntersect(ctx.query.boundsOf(item), rect);
				});
				state.selection = interaction.additive ? [...new Set([...interaction.baseSelection, ...hits])] : hits;
				return;
			}
			case "drawing":
				if (event.pointerId !== interaction.pointerId || (event.buttons & 1) === 0) return;
				if (appendBoardDrawSamples(interaction.points, event.samples ?? [event], state.camera.zoom))
					state.interaction = { ...interaction };
				return;
			case "creatingArrow": {
				const exclude = interaction.startItemId ? new Set([interaction.startItemId]) : NO_IDS;
				state.interaction = {
					...interaction,
					current: event.world,
					targetItemId: ctx.query.connectTargetAt(event.world, exclude),
				};
				return;
			}
			case "creatingBox":
			case "creatingText":
				state.interaction = { ...interaction, current: event.world };
				return;
		}
	}

	function pointerMove(event: BoardPointerEvent) {
		state.hoverPoint = event.world;
		state.hoverPointerType = event.pointerType;
		if (activePointers.has(event.pointerId)) activePointers.set(event.pointerId, event.screen);
		else if (activePointers.size > 0) return;
		if (pinch && activePointers.size >= 2) return pinchMove();
		if (activePointers.size === 1) last = event;
		move(event);
	}

	function follow() {
		const gesture = state.interaction.type;
		if (!last || pinch || activePointers.size !== 1) return;
		if (gesture === "idle" || gesture === "panning" || gesture === "pressing" || gesture === "drawing") return;
		const { samples: _samples, ...input } = last;
		move({ ...input, world: pointToWorld(input.screen, state.camera) });
	}

	function pointerUp(event: BoardPointerEvent) {
		state.hoverPoint = event.world;
		state.hoverPointerType = event.pointerType;
		if (!activePointers.delete(event.pointerId) && activePointers.size > 0) return;
		if (pinch) {
			if (activePointers.size >= 2) return;
			pinch = null;
			samples = [];
			const [rest] = activePointers.values();
			if (rest) state.interaction = { type: "panning", start: rest, origin: { ...state.camera }, moved: true, tapSelection: null };
			return;
		}
		if (activePointers.size > 0) return;
		const gesture = state.interaction;
		if (gesture.type === "drawing" && gesture.pointerId !== event.pointerId) return;
		if (event.cancelled) return cancel();

		state.snapGuides = [];
		state.interaction = { type: "idle" };
		last = null;
		press = null;

		switch (gesture.type) {
			case "panning": {
				const tap = gesture.tapSelection;
				if (ctx.frames.view()?.present && !gesture.moved) ctx.frames.tap(event.screen.x, event.pointerType);
				else if (gesture.moved && holdsFrame(event.pointerType)) {
					const { vx, vy } = releaseVelocity();
					if (Math.abs(state.camera.zoom / gesture.origin.zoom - 1) > 0.01) ctx.frames.refit(true);
					else ctx.frames.swipe(event.screen.x - gesture.start.x, event.screen.y - gesture.start.y, vx, vy);
				} else if (tap && !gesture.moved) {
					const target = tap.targetId && state.scene.get(tap.targetId) ? tap.targetId : null;
					if (tap.additive && target) ctx.selection.toggle(target);
					else state.selection = target ? [target] : [];
					if (target && event.pointerType === "touch" && !options.readonly) state.tool = "select";
				} else if (gesture.moved && isTouchLikePointer(event.pointerType)) {
					const { vx, vy } = releaseVelocity();
					ctx.camera.fling(vx, vy);
				}
				break;
			}
			case "pressing":
				activate(gesture.itemId, gesture.at, gesture.pointerType, false);
				break;
			case "translating":
				if (gesture.moved) land(gesture);
				else if (gesture.tap?.activate) activate(gesture.tap.activate, gesture.tap.at, event.pointerType, true);
				else if (gesture.tap?.select) ctx.selection.set(gesture.tap.select);
				break;
			case "resizing":
			case "rotating":
			case "draggingArrowHandle":
				land(gesture);
				break;
			case "brushing":
				if (
					!gesture.additive &&
					Math.hypot(gesture.current.x - gesture.start.x, gesture.current.y - gesture.start.y) <=
						1 / state.camera.zoom
				)
					state.selection = [];
				break;
			case "drawing": {
				const pressure = gesture.points.at(-1)?.p ?? event.pressure;
				appendBoardDrawSamples(gesture.points, [{ world: event.world, pressure }], state.camera.zoom);
				ctx.creation.commitDraw(gesture.id, gesture.points, gesture.color, gesture.size);
				break;
			}
			case "creatingArrow":
				ctx.creation.commitArrow(gesture, event.cancelled);
				break;
			case "creatingBox":
				ctx.creation.commitBox(gesture);
				break;
			case "creatingText":
				ctx.creation.commitTextGesture(gesture);
				break;
		}
		ctx.remote.flushPending();
	}

	function pointerLeave() {
		if (state.interaction.type !== "idle") return;
		state.hoverPoint = null;
		state.hoverId = null;
	}

	function cancel() {
		const gesture = state.interaction;
		activePointers.clear();
		pinch = null;
		last = null;
		press = null;
		state.snapGuides = [];
		state.interaction = { type: "idle" };
		ctx.document.discardDraft();
		ctx.remote.flushPending();
		transformEnd(gesture, true);
	}

	const ports = memo(
		() =>
			[
				state.scene,
				state.selection,
				state.hoverId,
				state.hoverPointerType,
				state.interaction,
				state.tool,
				state.editingId,
				state.camera.zoom,
			] as const,
		(..._inputs) =>
			visiblePorts().map((port) => ({
				itemId: port.itemId,
				x: port.point.x,
				y: port.point.y,
				radius: CONNECTION_PORT_RADIUS,
			})),
	);

	const hoveredPort = memo(
		() => [ports(), state.hoverPoint] as const,
		(_ports, hoverPoint): { x: number; y: number } | null => {
			if (!hoverPoint) return null;
			const port = connectionPortAt(hoverPoint, state.hoverPointerType);
			return port ? { x: port.point.x, y: port.point.y } : null;
		},
	);

	return {
		marquee,
		hoveredControl,
		ports,
		hoveredPort,
		opensOnTap,
		pointerDown,
		pointerMove,
		pointerUp,
		pointerLeave,
		follow,
		cancel,
		pickUp,
		subscribeTransforms(listener: (event: BoardTransformEnd) => void) {
			transformListeners.add(listener);
			return () => { transformListeners.delete(listener); };
		},
		subscribeActivations(listener: (event: BoardActivation) => void) {
			activationListeners.add(listener);
			return () => { activationListeners.delete(listener); };
		},
		destroy() { activePointers.clear(); transformListeners.clear(); activationListeners.clear(); },
	};
}

export type InteractionModule = ReturnType<typeof createInteractionModule>;
