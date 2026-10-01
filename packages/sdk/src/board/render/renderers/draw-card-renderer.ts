import { Container, Graphics, Mesh, MeshGeometry, Texture } from "pixi.js";
import { applyMatrix, type BoardDrawItem } from "@cohub/protocol";
import { BOARD_DRAW_STROKE_SIZE } from "@cohub/protocol/board-constants";
import { buildStrokeRibbonGeometry, computeDrawBounds } from "../../core/draw-geometry.js";
import type { SceneItem } from "../../core/scene.js";
import { itemColor } from "../palette.js";
import { positionShell } from "./base-card-renderer.js";
import type {
	BoardCardRenderer,
	BoardRenderContext,
} from "./board-renderer-registry.js";
import { drawFarStroke } from "./far-plate.js";

type DrawParts = {
	root: Container;
	stroke: Graphics | Mesh;
	sig: string;
	points: unknown;
	baseWidth: number;
};

const partsByContainer = new WeakMap<Container, DrawParts>();

function createCanvasStroke(
	positions: Float32Array,
	indices: Uint32Array,
	color: number,
	alpha: number,
): Graphics {
	const graphics = new Graphics();
	for (let offset = 0; offset < indices.length; offset += 3) {
		const a = (indices[offset] ?? 0) * 2;
		const b = (indices[offset + 1] ?? 0) * 2;
		const c = (indices[offset + 2] ?? 0) * 2;
		graphics
			.moveTo(positions[a] ?? 0, positions[a + 1] ?? 0)
			.lineTo(positions[b] ?? 0, positions[b + 1] ?? 0)
			.lineTo(positions[c] ?? 0, positions[c + 1] ?? 0)
			.closePath();
	}
	return graphics.fill({ color, alpha });
}

function sync(
	container: Container,
	item: SceneItem<BoardDrawItem>,
	context: BoardRenderContext,
) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	positionShell(parts.root, item);
	const selected = context.selectedIds.has(item.id);
	const hovered = context.hoveredId === item.id;
	const stroke = itemColor(context, item.style.stroke, "brand");
	const size = item.style.strokeWidth ?? BOARD_DRAW_STROKE_SIZE;
	const points = item.props.points;

	const sig = [points.length, size, selected, hovered, stroke].join("|");
	if (sig !== parts.sig || points !== parts.points) {
		parts.sig = sig;
		parts.points = points;
		parts.baseWidth = computeDrawBounds(points, size).width;

		const ribbon = buildStrokeRibbonGeometry(points, size);
		const alpha = selected || hovered ? 1 : 0.92;
		const nextStroke = context.rendererType !== "canvas"
			? new Mesh({
					geometry: new MeshGeometry({
						positions: ribbon.positions,
						indices: ribbon.indices,
					}),
					texture: Texture.WHITE,
				})
			: createCanvasStroke(ribbon.positions, ribbon.indices, stroke, alpha);
		if (nextStroke instanceof Mesh) {
			nextStroke.tint = stroke;
			nextStroke.alpha = alpha;
		}
		const previous = parts.stroke;
		parts.stroke = nextStroke;
		parts.root.removeChild(previous);
		previous.destroy();
		parts.root.addChild(nextStroke);
	}

	const previewScale = item.frame.width / Math.max(0.0001, parts.baseWidth);
	parts.stroke.scale.set(Number.isFinite(previewScale) ? previewScale : 1);
}

export const drawCardRenderer: BoardCardRenderer = {
	id: "draw-card",
	canRender: (item) => item.type === "draw",
	create: (item, context) => {
		const root = new Container();
		const stroke = new Graphics();
		root.addChild(stroke);
		partsByContainer.set(root, {
			root,
			stroke,
			sig: "",
			points: null,
			baseWidth: 0,
		});
		if (item.type === "draw") sync(root, item as SceneItem<BoardDrawItem>, context);
		return root;
	},
	update: (container, item, context) => {
		if (item.type === "draw") sync(container, item as SceneItem<BoardDrawItem>, context);
	},
	renderFar: (graphics, item, context) => {
		if (item.type !== "draw") return;
		const draw = item as SceneItem<BoardDrawItem>;
		const matrix = context.scene.layout.matrix(draw.id);
		const world = draw.props.points.map((point) => applyMatrix(matrix, point));
		drawFarStroke(graphics, world, {
			color: itemColor(context, draw.style.stroke, "brand"),
			width: draw.style.strokeWidth ?? BOARD_DRAW_STROKE_SIZE,
			alpha: 0.92,
		});
	},
	destroy: (container) => {
		partsByContainer.get(container)?.root.destroy({ children: true });
		partsByContainer.delete(container);
	},
};
