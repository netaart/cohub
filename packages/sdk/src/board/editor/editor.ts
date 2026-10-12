import {
	type BoardDocument,
	type BoardFrame,
	type BoardStyledToolId,
	buildBoardScene,
	clampBoardStrokeSize,
	createBoardToolStyles,
	defaultBoardRegistry,
	isBoardColorId,
	isShapeKind,
	normalizeViewport,
	titleForBoardItem,
} from "../model/index.js";
import { createAnimationModule } from "./animation.js";
import { createCameraModule } from "./camera.js";
import {
	type BoardEditorOptions,
	type BoardEditorPreferences,
	type BoardEditorState,
	type EditorContext,
	STATE_CHANNELS,
} from "./context.js";
import { createCopyModule } from "./copy.js";
import { createCreationModule } from "./creation.js";
import { createDeletionModule } from "./deletion.js";
import { createDocumentModule } from "./document.js";
import { createInteractionModule } from "./interaction.js";
import { createQueryModule } from "./query.js";
import { createRemoteModule } from "./remote.js";
import { createSelectionModule } from "./selection.js";
import { createSnapshotsModule } from "./snapshots.js";
import { type BoardEditorChannel, createChannels, observable } from "./state.js";
import { type BoardToolId, isCreationBoardTool } from "./tool.js";

function styledToolId(tool: BoardToolId): BoardStyledToolId | null {
	switch (tool) {
		case "text":
		case "shape":
		case "draw":
		case "arrow":
		case "frame":
			return tool;
		default:
			return null;
	}
}

export function createBoardEditor(options: BoardEditorOptions) {
	const registry = options.registry ?? defaultBoardRegistry;
	const channels = createChannels();
	const track = options.track ?? (() => {});
	const preferences = options.preferences;
	const state = observable<BoardEditorState>(
		{
			base: options.document,
			settingsPreview: null,
			scene: buildBoardScene(options.document),
			structureVersion: 0,
			geometryVersion: 0,
			selection: [],
			camera: normalizeViewport(options.viewport ?? { x: 0, y: 0, zoom: 1 }),
			surfaceSize: { width: 0, height: 0 },
			cameraPolicy: preferences?.cameraPolicy ?? "follow",
			tool: options.initialTool ?? "select",
			toolStyles: preferences?.toolStyles ?? createBoardToolStyles(),
			interaction: { type: "idle" },
			snapGuides: [],
			spaceHeld: false,
			hoverId: null,
			hoverPoint: null,
			hoverPointerType: "mouse",
			editingId: null,
			draftTextId: null,
			playhead: null,
			recording: false,
			undoStack: [],
			redoStack: [],
			saveError: null,
			pendingCommits: 0,
		},
		STATE_CHANNELS,
		channels,
	);

	const ctx = {
		options,
		registry,
		state,
		channels,
		preferencesChanged() {
			options.onPreferencesChange?.({ toolStyles: state.toolStyles, cameraPolicy: state.cameraPolicy } satisfies BoardEditorPreferences);
		},
	} as EditorContext;
	ctx.document = createDocumentModule(ctx);
	ctx.query = createQueryModule(ctx);
	ctx.camera = createCameraModule(ctx);
	ctx.selection = createSelectionModule(ctx);
	ctx.creation = createCreationModule(ctx);
	ctx.deletion = createDeletionModule(ctx);
	ctx.copy = createCopyModule(ctx);
	ctx.interaction = createInteractionModule(ctx);
	ctx.animation = createAnimationModule(ctx);
	ctx.snapshots = createSnapshotsModule(ctx);
	ctx.remote = createRemoteModule(ctx);
	const { document, query, camera, selection, creation, deletion, copy, interaction, animation, snapshots, remote } = ctx;

	let viewStateQueued = false;
	function emitViewState() {
		viewStateQueued = false;
		const onViewStateChange = options.onViewStateChange;
		if (!onViewStateChange) return;
		const selectedNodes = selection.items().map((item) => {
			const title = titleForBoardItem(item).trim();
			return { id: item.id, type: item.type, ...(title ? { title } : {}) };
		});
		onViewStateChange({ visibleRect: camera.visibleRect(), selectedNodes });
	}
	function queueViewState() {
		if (viewStateQueued || !options.onViewStateChange) return;
		viewStateQueued = true;
		queueMicrotask(emitViewState);
	}
	const stopViewState = channels.subscribe(["camera", "selection", "scene"], queueViewState);
	queueViewState();

	function setToolStyle<K extends BoardStyledToolId>(tool: K, patch: Partial<BoardEditorState["toolStyles"][K]>) {
		state.toolStyles = { ...state.toolStyles, [tool]: { ...state.toolStyles[tool], ...patch } };
		ctx.preferencesChanged();
	}

	function read<T>(channel: BoardEditorChannel | readonly BoardEditorChannel[], value: () => T): T {
		if (typeof channel === "string") track(channel);
		else for (const each of channel) track(each);
		return value();
	}

	function tracked<A extends unknown[], R>(
		channels: readonly BoardEditorChannel[],
		query: (...args: A) => R,
	): (...args: A) => R {
		return (...args) => read(channels, () => query(...args));
	}

	return {
		registry,
		readonly: options.readonly === true,
		subscribe: channels.subscribe,

		get document(): BoardDocument {
			return read("document", () => state.base);
		},
		get settings() {
			return read("document", () => state.settingsPreview ?? state.base.board);
		},
		get animations() {
			return read("document", () => state.base.animations);
		},
		get scene() {
			return read("scene", () => state.scene);
		},
		get items() {
			return read("scene", () => state.scene.items);
		},
		get hasContent() {
			return read("scene", () => state.scene.items.length > 0);
		},
		get structureVersion() {
			return read("scene", () => state.structureVersion);
		},
		get geometryVersion() {
			return read("scene", () => state.geometryVersion);
		},
		get selection() {
			return read("selection", () => state.selection);
		},
		get selectedItems() {
			return read(["scene", "selection"], selection.items);
		},
		get hasFocusableSelection() {
			return read(["scene", "selection"], () => selection.items().length > 0);
		},
		get selectionLocked() {
			return read(["scene", "selection"], () => {
				const items = selection.items();
				return items.length > 0 && items.every((item) => item.locked);
			});
		},
		get bounds() {
			return read(["scene", "selection"], selection.bounds);
		},
		get selectionTransform() {
			return read(["scene", "selection"], selection.transform);
		},
		get camera() {
			return read("camera", () => state.camera);
		},
		get cameraPolicy() {
			return read("camera", () => state.cameraPolicy);
		},
		get playhead() {
			return read("playback", () => state.playhead);
		},
		get recording() {
			return read("playback", () => state.recording);
		},
		get tool() {
			return read("tool", () => state.tool);
		},
		set tool(value: BoardToolId) {
			if (options.readonly && value !== "hand" && value !== "select") {
				state.tool = "hand";
				return;
			}
			state.tool = value;
			if (isCreationBoardTool(value)) state.hoverId = null;
			if (value === "draw" || value === "arrow") {
				state.selection = [];
				state.editingId = null;
			}
		},
		get activeColor(): string {
			return read("tool", () => state.toolStyles[styledToolId(state.tool) ?? "text"].color);
		},
		set activeColor(value: string) {
			const tool = styledToolId(state.tool);
			if (tool && isBoardColorId(value)) setToolStyle(tool, { color: value });
		},
		get activeShape(): string {
			return read("tool", () => state.toolStyles.shape.geometry);
		},
		set activeShape(value: string) {
			if (isShapeKind(value)) setToolStyle("shape", { geometry: value });
		},
		get activeStrokeSize(): number {
			return read("tool", () => (state.tool === "arrow" ? state.toolStyles.arrow : state.toolStyles.draw).size);
		},
		set activeStrokeSize(value: number) {
			if (!Number.isFinite(value) || (state.tool !== "arrow" && state.tool !== "draw")) return;
			setToolStyle(state.tool, { size: clampBoardStrokeSize(value) });
		},
		get interaction() {
			return read("interaction", () => state.interaction);
		},
		get gestureActive() {
			return read("interaction", () => state.interaction.type !== "idle");
		},
		get marquee() {
			return read("interaction", interaction.marquee);
		},
		get snapGuides() {
			return read("interaction", () => state.snapGuides);
		},
		get spaceHeld() {
			return read("interaction", () => state.spaceHeld);
		},
		set spaceHeld(value: boolean) {
			state.spaceHeld = value;
		},
		get arrowDraft() {
			return read(["interaction", "scene"], () => {
				const gesture = state.interaction;
				if (gesture.type !== "creatingArrow") return null;
				const target = gesture.targetItemId ? state.scene.get(gesture.targetItemId) : null;
				return {
					from: gesture.start,
					to: gesture.current,
					size: gesture.size,
					color: gesture.color,
					targetFrame: target?.frame ?? null,
				};
			});
		},
		get bindTargetFrame(): BoardFrame | null {
			return read(["interaction", "scene"], () => {
				const gesture = state.interaction;
				const id = gesture.type === "draggingArrowHandle" ? gesture.targetItemId : null;
				return id ? (state.scene.get(id)?.frame ?? null) : null;
			});
		},
		get hoverId() {
			return read("hover", () => state.hoverId);
		},
		get pointerType() {
			return read("hover", () => state.hoverPointerType);
		},
		get hoveredTransformControl() {
			return read(["interaction", "hover", "tool", "camera", "scene", "selection"], interaction.hoveredControl);
		},
		get connectionPorts() {
			return read(["interaction", "hover", "tool", "camera", "scene", "selection", "editing"], interaction.ports);
		},
		get hoveredConnectionPort() {
			return read(["interaction", "hover", "tool", "camera", "scene", "selection", "editing"], interaction.hoveredPort);
		},
		get editingId() {
			return read("editing", () => state.editingId);
		},
		set editingId(value: string | null) {
			state.editingId = value;
		},
		get canUndo() {
			return read("history", () => state.undoStack.length > 0);
		},
		get canRedo() {
			return read("history", () => state.redoStack.length > 0);
		},
		get saveError() {
			return read("status", () => state.saveError);
		},
		get saving() {
			return read("status", () => state.pendingCommits > 0);
		},
		set surfaceSize(value: { width: number; height: number }) {
			state.surfaceSize = value;
		},

		loadDocument: remote.loadDocument,
		undo: document.undo,
		redo: document.redo,
		retrySave: () => {
			state.saveError = null;
		},
		setSettings: document.setSettings,
		previewSettings: document.previewSettings,
		setPlayedItems: document.setPlayedItems,
		consumeRecentlyAdded: document.consumeRecentlyAdded,

		itemAt: tracked(["scene", "camera"], query.itemAt),
		itemById: tracked(["scene"], query.itemById),
		labelItemAt: tracked(["scene", "camera", "selection"], query.labelItemAt),
		idsInRect: tracked(["scene"], query.idsInRect),

		setCamera: camera.setCamera,
		setCameraPolicy: camera.setCameraPolicy,
		takeCameraControl: camera.takeCameraControl,
		viewCenter: tracked(["camera"], camera.viewCenter),
		zoomAt: camera.zoomAt,
		zoomIn: camera.zoomIn,
		zoomOut: camera.zoomOut,
		resetZoom: camera.resetZoom,
		fitView: camera.fitView,
		focusRect: camera.focusRect,
		focusItems: camera.focusItems,
		focusNode: camera.focusNode,
		focusSelection: camera.focusSelection,
		wheel: camera.wheel,

		setSelection: selection.set,
		clearSelection: selection.clear,
		selectAll: selection.selectAll,
		nudgeSelection: selection.nudge,
		alignSelection: selection.align,
		distributeSelection: selection.distribute,
		toggleSelectionLock: selection.toggleLock,
		setSelectionColor: selection.setColor,
		setSelectionStyle: selection.setStyle,
		setSelectionProps: selection.setProps,
		bringToFront: selection.bringToFront,
		sendToBack: selection.sendToBack,

		addItem: creation.addItem,
		addApp: creation.addApp,
		addFile: creation.addFile,
		addTask: creation.addTask,
		addTaskWithSources: creation.addTaskWithSources,
		addText: creation.addText,
		addShape: creation.addShape,
		addFrame: creation.addFrame,
		beginTextDraft: creation.beginTextDraft,
		commitTextEdit: creation.commitTextEdit,
		updateText: creation.updateText,
		previewTextLayout: creation.previewTextLayout,
		deleteSelection: deletion.deleteSelection,
		deleteItem: deletion.deleteItem,
		duplicateSelection: copy.duplicateSelection,
		copySelection: copy.copySelection,
		cutSelection: copy.cutSelection,
		pasteClipboard: copy.pasteClipboard,

		applyMediaFileChange: snapshots.applyMediaFileChange,
		adoptMediaNaturalSizes: snapshots.adoptMediaNaturalSizes,
		applyFileSnapshots: snapshots.applyFileSnapshots,
		applyTaskSnapshots: snapshots.applyTaskSnapshots,

		setPlayhead: animation.setPlayhead,
		setRecording: animation.setRecording,
		keyframeState: tracked(["document", "scene", "selection", "playback"], animation.keyframeState),
		toggleKeyframe: animation.toggleKeyframe,
		removeKeyframe: animation.removeKeyframe,
		setKeyframeEase: animation.setKeyframeEase,
		createAnimation: animation.createAnimation,

		pointerDown: interaction.pointerDown,
		pointerMove: interaction.pointerMove,
		pointerUp: interaction.pointerUp,
		pointerLeave: interaction.pointerLeave,
		cancelPointerInteraction: interaction.cancel,

		destroy() {
			stopViewState();
			camera.cancelAnimation();
			interaction.destroy();
		},
	};
}

export type BoardEditor = ReturnType<typeof createBoardEditor>;
