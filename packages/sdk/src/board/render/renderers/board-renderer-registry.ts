import type { Container, Graphics, Texture } from "pixi.js";
import type { BoardSettings, BoardCustomItem, BoardFrame, BoardDocument, BoardTaskItem } from "@cohub/protocol";
import type { BoardShapeColors } from "../../model/palette.js";
import type { WorldPoint } from "../../model/geometry.js";
import type { BoardScene, BoardSceneItem, SceneItem } from "../../model/scene.js";
import type { BoardRenderStyle } from "../style.js";
import type { BoardLodKind } from "../lod.js";
import { mediaPlayHit } from "../media-interaction.js";
import { ensureBoardTextMeasurement } from "../text-measurement.js";
import { arrowCardRenderer } from "./arrow-card-renderer.js";
import { audioCardRenderer } from "./audio-card-renderer.js";
import { drawCardRenderer } from "./draw-card-renderer.js";
import { effectCardRenderer } from "./effect-card-renderer.js";
import { fileCardRenderer } from "./file-card-renderer.js";
import { frameCardRenderer } from "./frame-card-renderer.js";
import { shapeCardRenderer } from "./shape-card-renderer.js";
import { customCardRenderer } from "./custom-card-renderer.js";
import { imageCardRenderer } from "./image-card-renderer.js";
import { modelCardRenderer } from "./model-card-renderer.js";
import { taskCardRenderer } from "./task-card-renderer.js";
import { textCardRenderer } from "./text-card-renderer.js";
import { unknownCardRenderer } from "./unknown-card-renderer.js";
import { videoCardRenderer } from "./video-card-renderer.js";

export type BoardRenderPalette = {
	bg: number;
	surface: number;
	hover: number;
	border: number;
	brand: number;
	text: number;
	muted: number;
	rare: number;
	epic: number;
	legendary: number;
};

export type BoardScriptHost = {
	document?: (document: BoardDocument, time: number) => BoardDocument;
	ready?: (id: string) => boolean;
	revision?: (id: string) => number;
	frame: (item: SceneItem<BoardCustomItem>, time: number) => Texture | null;
	error: (id: string) => string | null;
	release: (id: string) => void;
};

export type BoardRenderLabels = {
	queued: string;
	generating: string;
	failed: string;
	previewUnavailable: string;
	noPreview: string;
};

export const DEFAULT_BOARD_RENDER_LABELS: BoardRenderLabels = {
	queued: "Queued",
	generating: "Generating",
	failed: "Failed",
	previewUnavailable: "Preview unavailable",
	noPreview: "No preview",
};

export type BoardRenderContext = {
	settings: BoardSettings;
	scene: BoardScene;
	selectedIds: Set<string>;
	hoveredId: string | null;
	resizingIds: Set<string>;
	liftedIds: ReadonlySet<string>;
	editingId?: string | null;
	palette: BoardRenderPalette;
	colors: BoardShapeColors;
	colorScheme: "dark" | "light";
	style: BoardRenderStyle;
	themeKey: string;
	rendererType: "gpu" | "canvas";
	zoom: number;
	/** Texture pixels per world unit for text; see `boardTextResolution`. */
	textResolution: number;
	time: number;
	reducedMotion: boolean;
	labels: BoardRenderLabels;
	taskRun: (taskRunId: string) => { status: BoardTaskItem["props"]["snapshot"]["status"]; startedAt?: string } | null;
	frameAt?: (id: string, time: number) => BoardFrame | undefined;
	scripts?: BoardScriptHost;
	assetKey: (item: BoardSceneItem) => string | null;
	getTexture: (key: string) => Texture | null;
	hasError: (key: string) => boolean;
	assetTone?: (key: string) => number | null;
	fileState: (path: string) => "ok" | "missing" | "unavailable";
	acquireTexture: (key: string, item: BoardSceneItem) => void;
	releaseTexture: (key: string) => void;
	hoveredHit?: { itemId: string; action: string } | null;
};

export type BoardCardHit = { action: string; cursor?: string };

export type BoardCardRenderer = {
	id: string;
	canRender: (item: BoardSceneItem, context: BoardRenderContext) => boolean;
	animated?: boolean;
	/** Opt in to updates on selection and hover changes. */
	observesSelection?: boolean;
	tick?: (container: Container, clock: number) => number | null;
	create: (item: BoardSceneItem, context: BoardRenderContext) => Container;
	update: (
		container: Container,
		item: BoardSceneItem,
		context: BoardRenderContext,
	) => void;
	/** Called when the zoom bucket or text resolution changes. */
	resolution?: (container: Container, item: BoardSceneItem, context: BoardRenderContext) => void;
	/** Runs on every zoom step; only update transforms and visibility. */
	zoom?: (container: Container, zoom: number) => void;
	/**
	 * Level of detail for `renderFar`: `size` is the world-unit measure kept
	 * legible (default: the long edge), held against the `BoardLod[kind]` threshold.
	 */
	lod?: { kind: BoardLodKind; size?: (item: BoardSceneItem) => number };
	hitAt?: (item: BoardSceneItem, point: WorldPoint, context: BoardRenderContext) => BoardCardHit | null;
	renderFar?: (
		graphics: Graphics,
		item: BoardSceneItem,
		context: BoardRenderContext,
	) => void;
	destroy?: (container: Container, context: BoardRenderContext) => void;
};

export type BoardCardRendererResolver = (
	item: BoardSceneItem,
	context: BoardRenderContext,
) => BoardCardRenderer;

const playable = (renderer: BoardCardRenderer): BoardCardRenderer => ({ ...renderer, hitAt: mediaPlayHit });

const builtinCardRenderers: readonly BoardCardRenderer[] = [
	textCardRenderer,
	imageCardRenderer,
	playable(videoCardRenderer),
	playable(audioCardRenderer),
	playable(modelCardRenderer),
	fileCardRenderer,
	playable(taskCardRenderer),
	shapeCardRenderer,
	drawCardRenderer,
	arrowCardRenderer,
	frameCardRenderer,
	effectCardRenderer,
	customCardRenderer,
];

/**
 * Pick a renderer per item: `renderers` first, then the built-ins. Items no
 * renderer claims draw as a labelled placeholder box.
 */
export function createBoardCardRendererResolver(
	renderers: Iterable<BoardCardRenderer> = [],
): BoardCardRendererResolver {
	const candidates = [...renderers, ...builtinCardRenderers];
	return (item, context) => {
		ensureBoardTextMeasurement();
		return (
			candidates.find((renderer) => renderer.canRender(item, context)) ??
			unknownCardRenderer
		);
	};
}

/** The built-in renderers alone. */
export const getBoardCardRenderer = createBoardCardRendererResolver();
