import { Container, Graphics, Mesh, MeshGeometry, Texture } from "pixi.js";
import { applyMatrix, type BoardDrawItem, type BoardDrawPoint, type BoardRect } from "@cohub/protocol";
import { BOARD_DRAW_STROKE_SIZE } from "@cohub/protocol/board-constants";
import {
	computeDrawBounds,
	createStrokeRibbonBuilder,
	type StrokeRibbonBuilder,
	type StrokeRibbonMesh,
	trimDrawPoints,
} from "../../model/draw-geometry.js";
import type { SceneItem } from "../../model/scene.js";
import { itemColor } from "../palette.js";
import { positionShell } from "./base-card-renderer.js";
import type {
	BoardCardRenderer,
	BoardRenderContext,
} from "./board-renderer-registry.js";
import { drawFarStroke, farStrokeSamples } from "./far-plate.js";

type DrawParts = {
	root: Container;
	stroke: Graphics | Mesh | null;
	ribbon: StrokeRibbonBuilder | null;
	uvs: Float32Array;
	points: readonly BoardDrawPoint[] | null;
	count: number;
	size: number;
	trim: number | undefined;
	paint: number | null;
	box: BoardRect;
};

const partsByContainer = new WeakMap<Container, DrawParts>();

function fillRibbon(graphics: Graphics, ribbon: StrokeRibbonMesh, color: number) {
	const { positions, indices } = ribbon;
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
	return graphics.fill({ color });
}

function replaceStroke<T extends Graphics | Mesh>(parts: DrawParts, next: T): T {
	if (parts.stroke) {
		parts.root.removeChild(parts.stroke);
		parts.stroke.destroy();
	}
	parts.stroke = next;
	parts.root.addChild(next);
	return next;
}

function tessellate(parts: DrawParts, points: readonly BoardDrawPoint[], size: number, paint: number | null) {
	parts.ribbon ??= createStrokeRibbonBuilder(size);
	const ribbon = parts.ribbon.build(points);
	if (paint !== null) {
		const graphics = parts.stroke instanceof Graphics ? parts.stroke.clear() : replaceStroke(parts, new Graphics());
		fillRibbon(graphics, ribbon, paint);
		return;
	}
	if (ribbon.indices.length === 0) {
		if (parts.stroke) parts.stroke.visible = false;
		return;
	}
	if (parts.uvs.length < ribbon.positions.length) parts.uvs = new Float32Array(ribbon.positions.length * 2);
	const { positions, indices } = ribbon;
	const uvs = parts.uvs.subarray(0, positions.length);
	if (parts.stroke instanceof Mesh) {
		const geometry = parts.stroke.geometry;
		geometry.positions = positions;
		geometry.uvs = uvs;
		geometry.indices = indices;
		parts.stroke.visible = true;
		return;
	}
	replaceStroke(parts, new Mesh({ geometry: new MeshGeometry({ positions, uvs, indices }), texture: Texture.WHITE }));
}

function sync(
	container: Container,
	item: SceneItem<BoardDrawItem>,
	context: BoardRenderContext,
) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	positionShell(parts.root, item);
	const { points } = item.props;
	const size = item.style.strokeWidth ?? BOARD_DRAW_STROKE_SIZE;
	const trim = item.style.trim;
	const color = itemColor(context, item.style.stroke, "brand");
	const paint = context.rendererType === "canvas" ? color : null;

	if (points !== parts.points || points.length !== parts.count || size !== parts.size || trim !== parts.trim || paint !== parts.paint) {
		if (size !== parts.size) parts.ribbon = null;
		parts.points = points;
		parts.count = points.length;
		parts.size = size;
		parts.trim = trim;
		parts.paint = paint;
		parts.box = computeDrawBounds(points, size);
		tessellate(parts, trimDrawPoints(points, trim), size, paint);
	}
	const stroke = parts.stroke;
	if (!stroke) return;
	// Opaque: the ribbon's caps and folds overlap.
	if (stroke instanceof Mesh) stroke.tint = color;
	const { box } = parts;
	const sx = item.frame.width / box.width;
	const sy = item.frame.height / box.height;
	stroke.scale.set(sx, sy);
	stroke.position.set(-box.x * sx, -box.y * sy);
}

export const drawCardRenderer: BoardCardRenderer = {
	id: "draw-card",
	canRender: (item) => item.type === "draw",
	create: (item, context) => {
		const root = new Container();
		partsByContainer.set(root, {
			root,
			stroke: null,
			ribbon: null,
			uvs: new Float32Array(0),
			points: null,
			count: 0,
			size: 0,
			trim: undefined,
			paint: null,
			box: { x: 0, y: 0, width: 1, height: 1 },
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
		const samples = farStrokeSamples(trimDrawPoints(draw.props.points, draw.style.trim));
		drawFarStroke(graphics, samples.map((point) => applyMatrix(matrix, point)), {
			color: itemColor(context, draw.style.stroke, "brand"),
			width: draw.style.strokeWidth ?? BOARD_DRAW_STROKE_SIZE,
			alpha: 1,
		});
	},
	destroy: (container) => {
		partsByContainer.get(container)?.root.destroy({ children: true });
		partsByContainer.delete(container);
	},
};
