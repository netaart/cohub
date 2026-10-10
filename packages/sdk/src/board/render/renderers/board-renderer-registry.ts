import type { Container, Graphics, Texture } from "pixi.js";
import type { BoardSettings, BoardSketchItem } from "@cohub/protocol";
import type { BoardShapeColors } from "../../model/palette.js";
import type { BoardScene, BoardSceneItem, SceneItem } from "../../model/scene.js";
import { ensureBoardTextMeasurement } from "../text-measurement.js";
import { arrowCardRenderer } from "./arrow-card-renderer.js";
import { audioCardRenderer } from "./audio-card-renderer.js";
import { drawCardRenderer } from "./draw-card-renderer.js";
import { effectCardRenderer } from "./effect-card-renderer.js";
import { fileCardRenderer } from "./file-card-renderer.js";
import { frameCardRenderer } from "./frame-card-renderer.js";
import { shapeCardRenderer } from "./shape-card-renderer.js";
import { sketchCardRenderer } from "./sketch-card-renderer.js";
import { imageCardRenderer } from "./image-card-renderer.js";
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

export type BoardSketchHost = {
	frame: (item: SceneItem<BoardSketchItem>, time: number, resolution: number) => Texture | null;
	error: (id: string) => string | null;
	release: (id: string) => void;
};

export type BoardRenderContext = {
	settings: BoardSettings;
	scene: BoardScene;
	selectedIds: Set<string>;
	hoveredId: string | null;
	resizingIds: Set<string>;
	palette: BoardRenderPalette;
	colors: BoardShapeColors;
	colorScheme: "dark" | "light";
	rendererType: "gpu" | "canvas";
	zoom: number;
	time: number;
	sketches?: BoardSketchHost;
	assetKey: (item: BoardSceneItem) => string | null;
	getTexture: (key: string) => Texture | null;
	hasError: (key: string) => boolean;
	fileState: (path: string) => "ok" | "missing" | "unavailable";
	acquireTexture: (key: string) => void;
	releaseTexture: (key: string) => void;
};

export type BoardCardRenderer = {
	id: string;
	canRender: (item: BoardSceneItem, context: BoardRenderContext) => boolean;
	animated?: boolean;
	create: (item: BoardSceneItem, context: BoardRenderContext) => Container;
	update: (
		container: Container,
		item: BoardSceneItem,
		context: BoardRenderContext,
	) => void;
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

const builtinCardRenderers: readonly BoardCardRenderer[] = [
	textCardRenderer,
	imageCardRenderer,
	videoCardRenderer,
	audioCardRenderer,
	fileCardRenderer,
	taskCardRenderer,
	shapeCardRenderer,
	drawCardRenderer,
	arrowCardRenderer,
	frameCardRenderer,
	effectCardRenderer,
	sketchCardRenderer,
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
