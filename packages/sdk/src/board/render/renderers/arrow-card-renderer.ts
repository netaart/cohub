import { Container, Graphics, Text } from "pixi.js";
import type { BoardArrowItem } from "@cohub/protocol";
import { BOARD_ARROW_STROKE_SIZE, BOARD_FONT_STACK } from "@cohub/protocol/board-constants";
import { resolveSceneArrow, pathPointAt } from "../../core/arrow-geometry.js";
import type { SceneItem } from "../../core/scene.js";
import { itemColor } from "../palette.js";
import { dashPattern, endAngle, traceArrowhead, tracePolyline, trimPolyline } from "../stroke.js";
import { syncTextResolution, textResolutionForZoom } from "../text-resolution.js";
import type { BoardCardRenderer, BoardRenderContext } from "./board-renderer-registry.js";
import { drawFarStroke } from "./far-plate.js";

type ArrowParts = {
	root: Container;
	line: Graphics;
	backdrop: Graphics;
	label: Text;
	lineSig: string;
	labelSig: string;
	resolution: number;
};

const partsByContainer = new WeakMap<Container, ArrowParts>();

function sync(container: Container, item: SceneItem<BoardArrowItem>, context: BoardRenderContext) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	parts.root.position.set(0, 0);
	parts.root.rotation = 0;
	parts.root.scale.set(1);
	const { props, style } = item;
	const selected = context.selectedIds.has(item.id);
	const hovered = context.hoveredId === item.id;
	const color = itemColor(context, style.stroke, "brand");
	const size = style.strokeWidth ?? BOARD_ARROW_STROKE_SIZE;
	syncTextResolution(parts.label, parts, context.zoom);

	const resolved = resolveSceneArrow(item, context.scene);
	const path = trimPolyline(resolved.path, style.trim);
	const lineSig = [path.map((point) => `${point.x},${point.y}`).join(";"), selected, hovered, color, size, style.dash, props.arrowStart, props.arrowEnd].join("|");
	if (lineSig !== parts.lineSig) {
		parts.lineSig = lineSig;
		parts.line.clear();
		const width = selected ? size + 1 : size;
		const stroke = { color, width, alpha: selected || hovered ? 1 : 0.92, cap: "round", join: "round" } as const;
		tracePolyline(parts.line, path, dashPattern(style.dash, width));
		parts.line.stroke(stroke);
		const first = path[0];
		const last = path[path.length - 1];
		if (first && last) {
			const span = Math.hypot(last.x - first.x, last.y - first.y);
			const headSize = Math.min(Math.max(14, size * 5.5), Math.max(10, span * 0.28));
			const complete = style.trim === undefined || style.trim >= 1;
			const endDirection = endAngle(path, false);
			const startDirection = endAngle(path, true);
			if (props.arrowEnd && endDirection !== null && path.length > 1) traceArrowhead(parts.line, last, endDirection, headSize);
			if (props.arrowStart && startDirection !== null && complete) traceArrowhead(parts.line, first, startDirection, headSize);
			parts.line.stroke({ ...stroke, width: Math.max(1.5, width) });
		}
	}

	const labelSig = [props.label, context.palette.text, context.palette.bg, props.fontSize].join("|");
	if (labelSig !== parts.labelSig) {
		parts.labelSig = labelSig;
		parts.label.text = props.label;
		parts.label.style.fill = context.palette.text;
		parts.label.style.fontSize = props.fontSize;
		const padX = props.fontSize * 0.4;
		const padY = props.fontSize * 0.15;
		const { width, height } = parts.label;
		parts.backdrop.clear();
		parts.backdrop
			.roundRect(-width / 2 - padX, -height / 2 - padY, width + padX * 2, height + padY * 2, props.fontSize * 0.3)
			.fill({ color: context.palette.bg, alpha: 0.92 });
	}
	const visible = props.label.length > 0 && (style.trim === undefined || style.trim >= 0.5);
	parts.label.visible = visible;
	parts.backdrop.visible = visible;
	const mid = style.trim === undefined ? resolved.mid : pathPointAt(resolved.path, 0.5);
	parts.label.position.set(mid.x, mid.y);
	parts.backdrop.position.set(mid.x, mid.y);
}

export const arrowCardRenderer: BoardCardRenderer = {
	id: "arrow-card",
	canRender: (item) => item.type === "arrow",
	create: (item, context) => {
		const root = new Container();
		const line = new Graphics();
		const resolution = textResolutionForZoom(context.zoom);
		const label = new Text({ text: "", style: { fill: 0xffffff, fontFamily: BOARD_FONT_STACK, fontSize: 14, fontWeight: "500" }, resolution, roundPixels: true });
		label.anchor.set(0.5);
		const backdrop = new Graphics();
		root.addChild(line, backdrop, label);
		partsByContainer.set(root, { root, line, backdrop, label, lineSig: "", labelSig: "", resolution });
		if (item.type === "arrow") sync(root, item as SceneItem<BoardArrowItem>, context);
		return root;
	},
	update: (container, item, context) => {
		if (item.type === "arrow") sync(container, item as SceneItem<BoardArrowItem>, context);
	},
	renderFar: (graphics, item, context) => {
		if (item.type !== "arrow") return;
		const arrow = item as SceneItem<BoardArrowItem>;
		const resolved = resolveSceneArrow(arrow, context.scene);
		drawFarStroke(graphics, trimPolyline(resolved.path, arrow.style.trim), {
			color: itemColor(context, arrow.style.stroke, "brand"),
			width: arrow.style.strokeWidth ?? BOARD_ARROW_STROKE_SIZE,
			alpha: 0.85,
		});
	},
	destroy: (container) => {
		partsByContainer.get(container)?.root.destroy({ children: true });
		partsByContainer.delete(container);
	},
};
