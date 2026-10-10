import type {
	BoardDocument,
	BoardPatch,
	BoardRegistry,
	BoardScene,
	BoardSettings,
	BoardToolStyleMap,
	BoardViewport,
	WorldPoint,
} from "../model/index.js";
import type { BoardInteraction } from "./interaction.js";
import type { SnapGuide } from "./snapping.js";
import type { BoardEditorChannel, BoardEditorChannels } from "./state.js";
import type { BoardToolId } from "./tool.js";

export type BoardCameraPolicy = "follow" | "free";
export type BoardPlayhead = { animationId: string; time: number };
export type BoardUndoEntry = { undo: BoardPatch; redo: BoardPatch };

export type BoardEditorState = {
	base: BoardDocument;
	settingsPreview: BoardSettings | null;
	scene: BoardScene;
	structureVersion: number;
	geometryVersion: number;
	selection: string[];
	camera: BoardViewport;
	surfaceSize: { width: number; height: number };
	cameraPolicy: BoardCameraPolicy;
	tool: BoardToolId;
	toolStyles: BoardToolStyleMap;
	interaction: BoardInteraction;
	snapGuides: SnapGuide[];
	spaceHeld: boolean;
	hoverId: string | null;
	hoverPoint: WorldPoint | null;
	hoverPointerType: string;
	editingId: string | null;
	draftTextId: string | null;
	playhead: BoardPlayhead | null;
	recording: boolean;
	undoStack: BoardUndoEntry[];
	redoStack: BoardUndoEntry[];
	saveError: string | null;
	pendingCommits: number;
};

export const STATE_CHANNELS: { readonly [K in keyof BoardEditorState]: BoardEditorChannel } = {
	base: "document",
	settingsPreview: "document",
	scene: "scene",
	structureVersion: "scene",
	geometryVersion: "scene",
	selection: "selection",
	camera: "camera",
	surfaceSize: "camera",
	cameraPolicy: "camera",
	tool: "tool",
	toolStyles: "tool",
	interaction: "interaction",
	snapGuides: "interaction",
	spaceHeld: "interaction",
	hoverId: "hover",
	hoverPoint: "hover",
	hoverPointerType: "hover",
	editingId: "editing",
	draftTextId: "editing",
	playhead: "playback",
	recording: "playback",
	undoStack: "history",
	redoStack: "history",
	saveError: "status",
	pendingCommits: "status",
};

export type BoardEditorPreferences = {
	toolStyles: BoardToolStyleMap;
	cameraPolicy: BoardCameraPolicy;
};

export type BoardViewState = {
	visibleRect: { x: number; y: number; width: number; height: number } | null;
	selectedNodes: Array<{ id: string; type: string; title?: string }>;
};

export type BoardEditorOptions = {
	document: BoardDocument;
	registry?: BoardRegistry;
	viewport?: BoardViewport;
	initialTool?: BoardToolId;
	key?: string;
	readonly?: boolean;
	preferences?: Partial<BoardEditorPreferences>;
	onPreferencesChange?: (preferences: BoardEditorPreferences) => void;
	onCommit: (patch: BoardPatch) => void | Promise<void>;
	onViewStateChange?: (state: BoardViewState) => void;
	track?: (channel: BoardEditorChannel) => void;
};

export type EditorContext = {
	readonly options: BoardEditorOptions;
	readonly registry: BoardRegistry;
	readonly state: BoardEditorState;
	readonly channels: BoardEditorChannels;
	preferencesChanged(): void;
	document: import("./document.js").DocumentModule;
	query: import("./query.js").QueryModule;
	camera: import("./camera.js").CameraModule;
	selection: import("./selection.js").SelectionModule;
	creation: import("./creation.js").CreationModule;
	deletion: import("./deletion.js").DeletionModule;
	copy: import("./copy.js").CopyModule;
	interaction: import("./interaction.js").InteractionModule;
	animation: import("./animation.js").AnimationModule;
	snapshots: import("./snapshots.js").SnapshotsModule;
	remote: import("./remote.js").RemoteModule;
};
