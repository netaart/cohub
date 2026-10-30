import {
	applyMatrix,
	type BoardArrowEnd,
	type BoardArrowItem,
	type BoardDrawPoint,
	type BoardFileSnapshotFacts,
	type BoardItem,
	type BoardItemEntry,
	type BoardItemInput,
	type BoardMediaItemKind,
	type BoardMediaSnapshot,
	type BoardSceneItem,
	type BoardSessionSnapshot,
	type BoardTaskSnapshot,
	buildBoardScene,
	createAppBoardItem,
	createArrowBoardItem,
	createBoardItemId,
	createDrawBoardItem,
	createFileNodeForPath,
	createMediaBoardItem,
	createFrameBoardItem,
	createSessionBoardItem,
	createShapeBoardItem,
	createTaskBoardItem,
	createTextBoardItem,
	IDENTITY_MATRIX,
	invertMatrix,
	isShapeKind,
	rectCenter,
	type ShapeKind,
	TEXT_FONT_SIZE,
	type WorldPoint,
	worldPoint,
} from "../model/index.js";
import type { EditorContext } from "./context.js";
import { sameJson } from "./document-edits.js";
import type { BoardInteraction } from "./interaction.js";
import { boardDragSlop } from "./input.js";
import { isContinuousBoardTool } from "./tool.js";

const TEXT_MIN_WRAP_WIDTH = TEXT_FONT_SIZE * 2;

export function boardTextGestureWrap(
	{ start, current, pointerType }: { start: WorldPoint; current: WorldPoint; pointerType: string },
	zoom: number,
): { at: WorldPoint; width: number } | null {
	const width = Math.abs(current.x - start.x);
	if (width <= boardDragSlop(pointerType) / Math.max(zoom, 0.0001)) return null;
	return { at: worldPoint(Math.min(start.x, current.x), start.y), width: Math.max(TEXT_MIN_WRAP_WIDTH, width) };
}

export type BoardAppMetadata = Parameters<typeof createAppBoardItem>[0];
export type BoardTaskSource = { itemId: string; sourcePortId: string; targetPortId: string };

export function createCreationModule(ctx: EditorContext) {
	const { state, options } = ctx;

	function placeNew(entries: readonly BoardItemEntry[]): Map<string, BoardItem> {
		const created = new Set(entries.map((entry) => entry.id));
		const probe = buildBoardScene({
			...state.base,
			items: Object.fromEntries(entries.map((entry) => [entry.id, entry.item])),
		});
		const nextZ = new Map<string | undefined, number>();
		const changes = new Map<string, BoardItem>();
		for (const { id, item } of entries) {
			if (item.parent && created.has(item.parent)) {
				changes.set(id, item);
				continue;
			}
			const shown = probe.get(id);
			const container =
				shown && item.type !== "frame" && item.type !== "arrow" ? ctx.query.frameAt(rectCenter(shown.frame), created) : null;
			const value =
				container && shown ? ctx.document.reparent(item, shown.frame, container.id, probe.layout.box(id)) : item;
			const z = nextZ.get(container?.id) ?? ctx.document.topZ(container?.id);
			nextZ.set(container?.id, z + 1);
			changes.set(id, { ...value, z });
		}
		return changes;
	}

	function sceneWith(id: string, item: BoardItem) {
		const items: Record<string, BoardItem> = { [id]: item };
		for (let cursor = item.parent; cursor && !items[cursor]; ) {
			const ancestor = ctx.document.displayItem(cursor);
			if (!ancestor) break;
			items[cursor] = ancestor;
			cursor = ancestor.parent;
		}
		return buildBoardScene({ ...state.base, items });
	}

	function transformKeyed(): ReadonlySet<string> {
		const ids = new Set<string>();
		for (const animation of Object.values(state.base.animations))
			for (const track of Object.values(animation.tracks))
				if (/^(position|rotation|scale)(\.|$)/.test(track.property)) ids.add(track.target);
		return ids;
	}

	/** A new frame nests in the frame around it; a drawn one also adopts the siblings it encloses. */
	function encloseNew({ id, item }: BoardItemEntry, adopt: boolean): Map<string, BoardItem> {
		const drawn = sceneWith(id, item);
		const shown = drawn.get(id) as BoardSceneItem;
		const rect = ctx.query.boundsOf(shown, drawn);
		const parent = ctx.query.frameAround(rect)?.id;
		const frame = { ...ctx.document.reparent(item, shown.frame, parent, drawn.layout.box(id)), z: ctx.document.topZ(parent) };
		const changes = new Map<string, BoardItem>([[id, frame]]);
		if (!adopt || state.playhead) return changes;
		const keyed = transformKeyed();
		const placed = sceneWith(id, frame);
		for (const child of ctx.query.enclosedIn(rect, parent)) {
			const stored = ctx.document.displayItem(child.id);
			if (!stored || child.type === "arrow" || ctx.query.isLocked(child) || keyed.has(child.id)) continue;
			const adopted = ctx.document.reparent(stored, child.frame, id, state.scene.layout.box(child.id), placed);
			changes.set(child.id, { ...adopted, z: changes.size });
		}
		return changes;
	}

	function returnToSelect() {
		if (!isContinuousBoardTool(state.tool)) state.tool = "select";
	}

	type AddOptions = { select?: boolean; enter?: boolean };

	function commitNew(
		ids: string[],
		changes: ReadonlyMap<string, BoardItem>,
		{ select = !isContinuousBoardTool(state.tool), enter = true }: AddOptions,
	) {
		if (enter) ctx.document.markAdded(ids);
		state.selection = select ? ids : [];
		ctx.document.commitItems(changes);
		returnToSelect();
	}

	function add(entries: BoardItemEntry[], behavior: AddOptions = {}) {
		if (options.readonly || entries.length === 0) return;
		commitNew(entries.map((entry) => entry.id), placeNew(entries), behavior);
	}

	function addOne(entry: BoardItemEntry): string {
		add([entry]);
		return entry.id;
	}

	function addItem(type: string, input: BoardItemInput): string | null {
		if (options.readonly) return null;
		return addOne(ctx.registry.create(type, input));
	}

	function addTaskWithSources(
		taskRunId: string,
		snapshot: BoardTaskSnapshot,
		at: WorldPoint,
		sources: BoardTaskSource[],
		metadata?: Record<string, unknown>,
		aspect?: number,
	) {
		if (options.readonly) return null;
		const { arrow } = state.toolStyles;
		const task = createTaskBoardItem(taskRunId, snapshot, at.x, at.y, metadata, undefined, aspect);
		const arrows = sources
			.filter((source) => source.itemId !== task.id && state.scene.get(source.itemId))
			.map((source) => {
				const entry = createArrowBoardItem(
					{ x: 0, y: 0 },
					{ item: task.id },
					arrow.color,
					createBoardItemId(),
					arrow.size,
					{ item: source.itemId },
				);
				const props = (entry.item as BoardArrowItem).props;
				return {
					id: entry.id,
					item: {
						...entry.item,
						metadata: {
							boardFlow: {
								version: 1,
								kind: "content",
								sourcePortId: source.sourcePortId,
								targetPortId: source.targetPortId,
							},
						},
						props: {
							...props,
							start: { item: source.itemId, anchor: "auto" as const, port: source.sourcePortId },
							end: { item: task.id, anchor: "auto" as const, port: source.targetPortId },
							relation: "input",
						},
					} as BoardItem,
				};
			});
		add([task, ...arrows], { select: false });
		state.selection = [task.id];
		return task.id;
	}

	function commitBox(gesture: Extract<BoardInteraction, { type: "creatingBox" }>) {
		if (options.readonly) return;
		const dx = gesture.current.x - gesture.start.x;
		const dy = gesture.current.y - gesture.start.y;
		const click = Math.hypot(dx, dy) <= 6 / Math.max(state.camera.zoom, 0.0001);
		const minimum = gesture.kind === "frame" ? 48 : 24;
		const box = click
			? undefined
			: {
					x: Math.min(gesture.start.x, gesture.current.x),
					y: Math.min(gesture.start.y, gesture.current.y),
					width: Math.max(minimum, Math.abs(dx)),
					height: Math.max(minimum, Math.abs(dy)),
				};
		const { x, y } = gesture.start;
		if (gesture.kind === "frame") {
			const frame = createFrameBoardItem(x, y, gesture.color, "Frame", gesture.id, box);
			return commitNew([frame.id], encloseNew(frame, !click), { enter: false });
		}
		const geometry = isShapeKind(gesture.geometry) ? gesture.geometry : "rectangle";
		add([createShapeBoardItem(geometry, x, y, gesture.color, gesture.id, box)], { enter: false });
	}

	function commitDraw(id: string, points: BoardDrawPoint[], color: string, size: number) {
		if (points.length === 0) return;
		add([createDrawBoardItem(points, color, size, id)], { enter: false });
	}

	function arrowEnd(point: WorldPoint, targetItemId: string | null, arrowMatrix = IDENTITY_MATRIX): BoardArrowEnd {
		if (targetItemId) return { item: targetItemId, anchor: "auto" };
		const local = applyMatrix(invertMatrix(arrowMatrix), point);
		return { x: local.x, y: local.y };
	}

	function commitArrow(gesture: Extract<BoardInteraction, { type: "creatingArrow" }>, cancelled: boolean) {
		const { start, current, startItemId, targetItemId } = gesture;
		const bound = !cancelled && targetItemId && targetItemId !== startItemId ? targetItemId : null;
		if (!bound && Math.hypot(current.x - start.x, current.y - start.y) < 2 / state.camera.zoom) return;
		const entry = createArrowBoardItem(
			start,
			bound ? { item: bound } : current,
			gesture.color,
			gesture.id,
			gesture.size,
			startItemId
				? { item: startItemId, ...(gesture.startSide ? { anchor: { side: gesture.startSide, offset: 0.5 } } : {}) }
				: undefined,
		);
		add([entry], { enter: false });
	}

	function commitTextGesture(gesture: Extract<BoardInteraction, { type: "creatingText" }>) {
		if (options.readonly) return;
		const wrap = boardTextGestureWrap(gesture, state.camera.zoom);
		beginTextDraft(wrap?.at ?? gesture.start, wrap?.width);
	}

	function beginTextDraft(at: WorldPoint, width?: number) {
		const entry = createTextBoardItem("", at.x, at.y, state.toolStyles.text.color, undefined, width);
		ctx.document.writeDraft(placeNew([entry]), true);
		state.draftTextId = entry.id;
		state.selection = [entry.id];
		state.editingId = entry.id;
	}

	function previewTextLayout(id: string, text: string) {
		const item = ctx.document.displayItem(id);
		if (item?.type !== "text" || item.props.text === text) return;
		ctx.document.writeDraft(new Map([[id, { ...item, props: { ...item.props, text } }]]));
	}

	function updateText(id: string, text: string, created = false) {
		const item = ctx.document.displayItem(id);
		if (!item || (item.type !== "text" && item.type !== "shape" && item.type !== "arrow" && item.type !== "frame")) return;
		const next =
			item.type === "arrow" || item.type === "frame"
				? { ...item, props: { ...item.props, label: text } }
				: { ...item, props: { ...item.props, text } };
		if (!created && sameJson(next, state.base.items[id])) {
			ctx.document.dropDraftItem(id);
			ctx.document.rescene([id]);
			return;
		}
		ctx.document.commitItems(new Map([[id, next as BoardItem]]));
	}

	function commitTextEdit(id: string, text: string) {
		const isDraft = id === state.draftTextId;
		const target = ctx.document.displayItem(id);
		const empty = text.trim() === "" && (isDraft || target?.type === "text");
		state.editingId = null;
		state.draftTextId = null;
		if (empty) {
			if (isDraft) {
				ctx.document.dropDraftItem(id);
				ctx.document.rescene();
			} else ctx.deletion.deleteItem(id);
		} else updateText(id, text, isDraft);
		if (state.tool === "text") state.tool = "select";
		ctx.remote.flushPending();
	}

	const styles = () => state.toolStyles;

	return {
		placeNew,
		add,
		addItem,
		addApp: (app: BoardAppMetadata, at: WorldPoint) => addOne(createAppBoardItem(app, at.x, at.y)),
		addMedia: (src: string, at: WorldPoint, options: { kind?: BoardMediaItemKind; snapshot?: BoardMediaSnapshot } = {}) =>
			addOne(createMediaBoardItem(src, at.x, at.y, options.snapshot, undefined, options.kind)),
		addFile: (path: string, at: WorldPoint, snapshot?: BoardMediaSnapshot & BoardFileSnapshotFacts) =>
			addOne(createFileNodeForPath(path, at.x, at.y, snapshot)),
		addTask: (taskRunId: string, snapshot: BoardTaskSnapshot, at: WorldPoint, metadata?: Record<string, unknown>, aspect?: number) =>
			addOne(createTaskBoardItem(taskRunId, snapshot, at.x, at.y, metadata, undefined, aspect)),
		addTaskWithSources,
		addSession: (sessionId: string, snapshot: BoardSessionSnapshot, at: WorldPoint) =>
			addOne(createSessionBoardItem(sessionId, snapshot, at.x, at.y)),
		addText: (text: string, at: WorldPoint) => {
			add([createTextBoardItem(text, at.x, at.y, styles().text.color)]);
		},
		addShape: (at: WorldPoint, geometry?: ShapeKind) => {
			const { shape } = styles();
			add([createShapeBoardItem(geometry ?? shape.geometry, at.x, at.y, shape.color)]);
		},
		addFrame: (at: WorldPoint) => {
			add([createFrameBoardItem(at.x, at.y, styles().frame.color)]);
		},
		commitBox,
		commitDraw,
		commitArrow,
		arrowEnd,
		commitTextGesture,
		beginTextDraft,
		previewTextLayout,
		updateText,
		commitTextEdit,
	};
}

export type CreationModule = ReturnType<typeof createCreationModule>;
