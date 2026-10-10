import {
	applyMatrix,
	type BoardArrowEnd,
	type BoardArrowItem,
	type BoardDrawPoint,
	type BoardFileSnapshotFacts,
	type BoardItem,
	type BoardItemEntry,
	type BoardItemInput,
	type BoardMediaSnapshot,
	type BoardTaskSnapshot,
	buildBoardScene,
	createAppBoardItem,
	createArrowBoardItem,
	createBoardItemId,
	createDrawBoardItem,
	createFileNodeForPath,
	createFrameBoardItem,
	createShapeBoardItem,
	createTaskBoardItem,
	createTextBoardItem,
	IDENTITY_MATRIX,
	invertMatrix,
	isShapeKind,
	rectCenter,
	type ShapeKind,
	type WorldPoint,
} from "../model/index.js";
import type { EditorContext } from "./context.js";
import { sameJson } from "./document-edits.js";
import type { BoardInteraction } from "./interaction.js";
import { isContinuousBoardTool } from "./tool.js";

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

	function returnToSelect() {
		if (!isContinuousBoardTool(state.tool)) state.tool = "select";
	}

	function add(
		entries: BoardItemEntry[],
		{ select = !isContinuousBoardTool(state.tool), enter = true }: { select?: boolean; enter?: boolean } = {},
	) {
		if (options.readonly || entries.length === 0) return;
		const changes = placeNew(entries);
		if (enter) ctx.document.markAdded([...changes.keys()]);
		state.selection = select ? [...changes.keys()] : [];
		ctx.document.commitItems(changes);
		returnToSelect();
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
	) {
		if (options.readonly) return null;
		const { arrow } = state.toolStyles;
		const task = createTaskBoardItem(taskRunId, snapshot, at.x, at.y, metadata);
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
		const geometry = isShapeKind(gesture.geometry) ? gesture.geometry : "rectangle";
		const { x, y } = gesture.start;
		add(
			[
				gesture.kind === "shape"
					? createShapeBoardItem(geometry, x, y, gesture.color, gesture.id, box)
					: createFrameBoardItem(x, y, gesture.color, "Frame", gesture.id, box),
			],
			{ enter: false },
		);
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

	function beginTextDraft(at: WorldPoint) {
		const entry = createTextBoardItem("", at.x, at.y, state.toolStyles.text.color);
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
		addFile: (path: string, at: WorldPoint, snapshot?: BoardMediaSnapshot & BoardFileSnapshotFacts) =>
			addOne(createFileNodeForPath(path, at.x, at.y, snapshot)),
		addTask: (taskRunId: string, snapshot: BoardTaskSnapshot, at: WorldPoint, metadata?: Record<string, unknown>) =>
			addOne(createTaskBoardItem(taskRunId, snapshot, at.x, at.y, metadata)),
		addTaskWithSources,
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
		beginTextDraft,
		previewTextLayout,
		updateText,
		commitTextEdit,
	};
}

export type CreationModule = ReturnType<typeof createCreationModule>;
