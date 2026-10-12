import {
	type BoardArrowItem,
	type BoardDrawInputSample,
	type BoardDrawPoint,
	type BoardFrame,
	type BoardItem,
	type BoardViewport,
	appendBoardDrawSamples,
	clampZoom,
	createBoardItemId,
	normalizeRotation,
	panBy,
	type Rect,
	type ResizeHandle,
	rectCenter,
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
import { CONNECTION_PORT_RADIUS, type ConnectionPort, connectionPorts, connectionPortAt as portAt } from "./connection-ports.js";
import type { EditorContext } from "./context.js";
import { selectionTransformControlAt } from "./selection-transform.js";
import { computeSnap, type SnapGuide } from "./snapping.js";
import { memo } from "./state.js";
import { canTapSelectWithHand, isCreationBoardTool, isWithinHandTapSlop } from "./tool.js";

const DRAG_THRESHOLD = 3;
const SNAP_THRESHOLD = 8;
const NO_IDS: ReadonlySet<string> = new Set();

export type BoardInteraction =
	| { type: "idle" }
	| {
			type: "panning";
			start: ScreenPoint;
			origin: BoardViewport;
			moved: boolean;
			tapSelection: { targetId: string | null } | null;
	  }
	| { type: "translating"; start: WorldPoint; origin: Map<string, BoardFrame>; moved: boolean; duplicate: boolean }
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
	| { type: "brushing"; start: WorldPoint; current: WorldPoint; additive: boolean; baseSelection: string[] }
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

export function createInteractionModule(ctx: EditorContext) {
	const { state, options, registry } = ctx;
	const activePointers = new Map<number, ScreenPoint>();
	let pinch: { distance: number; midpoint: ScreenPoint; zoom: number } | null = null;

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
			] as const,
		(interaction, tool, hoverPoint, pointerType, zoom, transform) =>
			interaction.type === "idle" && !pinch && tool === "select" && hoverPoint
				? selectionTransformControlAt(transform, hoverPoint, zoom, pointerType)
				: null,
	);

	function gridSnapSize(): number {
		const grid = state.base.board.grid;
		return grid?.visible === true ? (grid.size ?? 0) : 0;
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

	function reparentDropped(ids: readonly string[]): Map<string, BoardItem> {
		const changes = new Map<string, BoardItem>();
		const moving = ctx.query.withSubtrees(ids);
		for (const id of ids) {
			const item = state.scene.get(id);
			if (!item || item.type === "arrow") continue;
			const parent = ctx.query.frameAt(rectCenter(item.frame), moving)?.id;
			if (parent === item.parent) continue;
			const stored = ctx.document.displayItem(id);
			if (!stored) continue;
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
		const hoverReveals = !canTapSelectWithHand(state.hoverPointerType);
		const candidateId = selection.length === 1 ? selection[0] : hoverReveals ? hoverId : null;
		if (!candidateId) return null;
		const item = scene.get(candidateId);
		if (!item || ctx.query.isLocked(item) || item.type === "arrow") return null;
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

	function beginPinch() {
		const [a, b] = [...activePointers.values()];
		if (!a || !b) return;
		pinch = {
			distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
			midpoint: screenPoint((a.x + b.x) / 2, (a.y + b.y) / 2),
			zoom: state.camera.zoom,
		};
		state.interaction = { type: "idle" };
	}

	function brush(event: BoardPointerEvent, additive: boolean) {
		state.interaction = {
			type: "brushing",
			start: event.world,
			current: event.world,
			additive,
			baseSelection: state.selection,
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

	function pointerDown(event: BoardPointerEvent) {
		ctx.camera.cancelAnimation();
		state.hoverPoint = event.world;
		state.hoverPointerType = event.pointerType;
		const { interaction, tool, spaceHeld, toolStyles, camera } = state;
		if (interaction.type === "drawing" && interaction.pointerId !== event.pointerId) return;
		activePointers.set(event.pointerId, event.screen);
		if (activePointers.size === 2) {
			beginPinch();
			return;
		}
		if (activePointers.size > 2) return;

		const additive = event.shiftKey || event.metaKey || event.ctrlKey;
		if (tool === "hand" || spaceHeld || event.button === 1) {
			const tapSelection =
				tool === "hand" && !spaceHeld && event.button !== 1 && canTapSelectWithHand(event.pointerType)
					? { targetId: ctx.query.itemAt(event.world)?.id ?? null }
					: null;
			state.interaction = { type: "panning", start: event.screen, origin: { ...camera }, moved: false, tapSelection };
			return;
		}

		if (options.readonly) {
			const hit = ctx.query.itemAt(event.world);
			if (!hit) return brush(event, additive);
			if (additive) ctx.selection.toggle(hit.id);
			else state.selection = [hit.id];
			state.interaction = { type: "idle" };
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
				ctx.creation.beginTextDraft(event.world);
				return;
		}

		const port = connectionPortAt(event.world, event.pointerType);
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
		const control = selectionTransformControlAt(ctx.selection.transform(), event.world, camera.zoom, event.pointerType);
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
		if (control?.kind === "resize" && bounds) {
			const origin = ctx.selection.framesFor(ctx.selection.movable());
			const single = origin.size === 1 ? { ...([...origin.values()][0] as BoardFrame) } : null;
			state.interaction = { type: "resizing", handle: control.handle, single, bounds, origin, moved: false };
			return;
		}

		const item = ctx.query.itemAt(event.world);
		if (!item) return brush(event, additive);
		if (additive) ctx.selection.toggle(item.id);
		else if (!state.selection.includes(item.id)) state.selection = [item.id];
		const movable = ctx.selection.movable();
		state.interaction =
			movable.length === 0
				? { type: "idle" }
				: {
						type: "translating",
						start: event.world,
						origin: ctx.selection.framesFor(movable),
						moved: false,
						duplicate: event.altKey,
					};
	}

	function pinchMove() {
		const [a, b] = [...activePointers.values()];
		if (!a || !b || !pinch) return;
		const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
		const midpoint = screenPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
		const zoomed = zoomAround(state.camera, midpoint, clampZoom(pinch.zoom * (distance / pinch.distance)));
		ctx.camera.setCamera(panBy(zoomed, midpoint.x - pinch.midpoint.x, midpoint.y - pinch.midpoint.y));
		pinch = { ...pinch, midpoint };
	}

	function translate(gesture: Extract<BoardInteraction, { type: "translating" }>, event: BoardPointerEvent) {
		let dx = event.world.x - gesture.start.x;
		let dy = event.world.y - gesture.start.y;
		let current = gesture;
		if (!current.moved) {
			if (Math.hypot(dx, dy) <= DRAG_THRESHOLD / state.camera.zoom) return;
			current = { ...current, moved: true };
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
			const snap = computeTranslationSnap(shift(dx, dy), ctx.query.withSubtrees(current.origin.keys()));
			tx += snap.dx;
			ty += snap.dy;
			state.snapGuides = snap.guides;
		} else state.snapGuides = [];
		ctx.document.writeDraft(ctx.selection.placed(shift(tx, ty)));
	}

	function resize(gesture: Extract<BoardInteraction, { type: "resizing" }>, event: BoardPointerEvent) {
		if (!gesture.moved) state.interaction = { ...gesture, moved: true };
		const frames = new Map<string, BoardFrame>();
		if (gesture.single) {
			const id = [...gesture.origin.keys()][0] as string;
			const item = state.scene.get(id);
			const keepAspect = item ? registry.capabilities(item).aspectLocked || event.shiftKey : event.shiftKey;
			frames.set(id, resizeFrame(gesture.single, gesture.handle, event.world, undefined, keepAspect));
		} else {
			const scaled = scaleFrames([...gesture.origin.values()], gesture.bounds, gesture.handle, event.world);
			[...gesture.origin.keys()].forEach((id, index) => {
				const frame = scaled[index];
				if (frame) frames.set(id, frame);
			});
		}
		ctx.document.writeDraft(ctx.selection.placed(frames));
	}

	function rotate(gesture: Extract<BoardInteraction, { type: "rotating" }>, event: BoardPointerEvent) {
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
		if (!gesture.moved) state.interaction = { ...gesture, moved: true };
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

	function pointerMove(event: BoardPointerEvent) {
		state.hoverPoint = event.world;
		state.hoverPointerType = event.pointerType;
		if (activePointers.has(event.pointerId)) activePointers.set(event.pointerId, event.screen);
		if (pinch && activePointers.size >= 2) return pinchMove();

		const interaction = state.interaction;
		switch (interaction.type) {
			case "idle":
				state.hoverId =
					isCreationBoardTool(state.tool) || hoveredControl() ? null : (ctx.query.itemAt(event.world)?.id ?? null);
				return;
			case "panning": {
				const dx = event.screen.x - interaction.start.x;
				const dy = event.screen.y - interaction.start.y;
				if (interaction.tapSelection && !interaction.moved && isWithinHandTapSlop(dx, dy)) return;
				if (!interaction.moved) state.interaction = { ...interaction, moved: true };
				ctx.camera.setCamera(panBy(interaction.origin, dx, dy));
				return;
			}
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
				const hits = ctx.query.idsInRect(rect).filter((id) => {
					const item = state.scene.get(id);
					return item && !item.parent && rectsIntersect(ctx.query.boundsOf(item), rect);
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
				state.interaction = { ...interaction, current: event.world };
				return;
		}
	}

	function pointerUp(event: BoardPointerEvent) {
		state.hoverPoint = event.world;
		state.hoverPointerType = event.pointerType;
		activePointers.delete(event.pointerId);
		if (activePointers.size < 2) pinch = null;
		if (activePointers.size > 0) return;
		const gesture = state.interaction;
		if (gesture.type === "drawing" && gesture.pointerId !== event.pointerId) return;

		state.snapGuides = [];
		state.interaction = { type: "idle" };

		switch (gesture.type) {
			case "panning":
				if (gesture.tapSelection && !gesture.moved && !event.cancelled) {
					const targetId = gesture.tapSelection.targetId;
					state.selection = targetId && state.scene.get(targetId) ? [targetId] : [];
				}
				break;
			case "translating":
				if (gesture.moved) {
					for (const [id, item] of reparentDropped(ctx.query.rootsOf(state.selection)))
						ctx.document.setDraftItem(id, item);
					ctx.document.commit();
				}
				break;
			case "resizing":
			case "rotating":
			case "draggingArrowHandle":
				if (gesture.moved) ctx.document.commit();
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
		}
		ctx.remote.flushPending();
	}

	function pointerLeave() {
		if (state.interaction.type !== "idle") return;
		state.hoverPoint = null;
		state.hoverId = null;
	}

	function cancel() {
		activePointers.clear();
		pinch = null;
		state.snapGuides = [];
		state.interaction = { type: "idle" };
		ctx.document.discardDraft();
		ctx.remote.flushPending();
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
		pointerDown,
		pointerMove,
		pointerUp,
		pointerLeave,
		cancel,
		destroy: () => activePointers.clear(),
	};
}

export type InteractionModule = ReturnType<typeof createInteractionModule>;
