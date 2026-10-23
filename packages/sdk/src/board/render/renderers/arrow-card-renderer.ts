import { Container, Graphics, Text } from "pixi.js";
import type { BoardArrowItem } from "@cohub/protocol";
import { BOARD_ARROW_STROKE_SIZE, BOARD_FONT_STACK } from "@cohub/protocol/board-constants";
import { resolveSceneArrow } from "../../model/arrow-geometry.js";
import type { SceneItem } from "../../model/scene.js";
import { ARROW_LABEL, arrowLabelAnchor } from "../labels.js";
import { itemAlpha, itemColor } from "../palette.js";
import { dashPattern, endAngle, traceArrowhead, tracePolyline, trimPolyline } from "../stroke.js";
import { syncTextResolution } from "../text-resolution.js";
import { drawCardSurface } from "../surface.js";
import type { BoardCardRenderer, BoardRenderContext } from "./board-renderer-registry.js";
import { drawFarStroke } from "./far-plate.js";

type ArrowParts = {
	root: Container;
	line: Graphics;
	backdrop: Graphics;
	label: Text;
	lineSig: string;
	labelSig: string;
};

const partsByContainer = new WeakMap<Container, ArrowParts>();

function sync(container: Container, item: SceneItem<BoardArrowItem>, context: BoardRenderContext) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	parts.root.position.set(0, 0);
	parts.root.rotation = 0;
	parts.root.scale.set(1);
	const { props, style } = item;
	parts.line.alpha = itemAlpha(context, style.stroke);
	const color = itemColor(context, style.stroke, "brand");
	const size = style.strokeWidth ?? BOARD_ARROW_STROKE_SIZE;


	const resolved = resolveSceneArrow(item, context.scene);
	const path = trimPolyline(resolved.path, style.trim);
	const lineSig = [path.map((point) => `${point.x},${point.y}`).join(";"), color, size, style.dash, props.arrowStart, props.arrowEnd].join("|");
	if (lineSig !== parts.lineSig) {
		parts.lineSig = lineSig;
		parts.line.clear();
		const width = size;
		const stroke = { color, width, alpha: 0.92, cap: "round", join: "round" } as const;
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

	const labelSig = [props.label, props.fontSize, context.themeKey].join("|");
	if (labelSig !== parts.labelSig) {
		parts.labelSig = labelSig;
		parts.label.text = props.label;
		parts.label.style.fill = context.palette.text;
		parts.label.style.fontSize = props.fontSize;
		parts.label.style.lineHeight = props.fontSize * ARROW_LABEL.lineHeight;
		const padX = props.fontSize * ARROW_LABEL.padX;
		const padY = props.fontSize * ARROW_LABEL.padY;
		const { width, height } = parts.label;
		const plate = { x: -width / 2 - padX, y: -height / 2 - padY, width: width + padX * 2, height: height + padY * 2 };
		drawCardSurface(parts.backdrop.clear(), plate, { ...context.style, radius: Math.min(context.style.radius, plate.height / 2) }, {
			fill: context.palette.surface,
			border: context.palette.border,
		});
	}
	syncTextResolution(parts.label, context.textResolution);
	const visible = props.label.length > 0 && (style.trim === undefined || style.trim >= 0.5);
	parts.label.visible = visible;
	parts.backdrop.visible = visible;
	const mid = arrowLabelAnchor(resolved, style);
	parts.label.position.set(mid.x, mid.y);
	parts.backdrop.position.set(mid.x, mid.y);
}

export const arrowCardRenderer: BoardCardRenderer = {
	id: "arrow-card",
	canRender: (item) => item.type === "arrow",
	create: (item, context) => {
		const root = new Container();
		const line = new Graphics();
		const label = new Text({ text: "", style: { fill: 0xffffff, fontFamily: BOARD_FONT_STACK, fontSize: 14, fontWeight: ARROW_LABEL.fontWeight }, resolution: context.textResolution, roundPixels: true });
		label.anchor.set(0.5);
		const backdrop = new Graphics();
		root.addChild(line, backdrop, label);
		partsByContainer.set(root, { root, line, backdrop, label, lineSig: "", labelSig: "" });
		if (item.type === "arrow") sync(root, item as SceneItem<BoardArrowItem>, context);
		return root;
	},
	update: (container, item, context) => {
		if (item.type === "arrow") sync(container, item as SceneItem<BoardArrowItem>, context);
	},
	resolution: (container, _item, context) => {
		const parts = partsByContainer.get(container);
		if (parts) syncTextResolution(parts.label, context.textResolution);
	},
	renderFar: (graphics, item, context) => {
		if (item.type !== "arrow") return;
		const arrow = item as SceneItem<BoardArrowItem>;
		const resolved = resolveSceneArrow(arrow, context.scene);
		drawFarStroke(graphics, trimPolyline(resolved.path, arrow.style.trim), {
			color: itemColor(context, arrow.style.stroke, "brand"),
			width: arrow.style.strokeWidth ?? BOARD_ARROW_STROKE_SIZE,
			alpha: 0.85 * itemAlpha(context, arrow.style.stroke),
		});
	},
	destroy: (container) => {
		partsByContainer.get(container)?.root.destroy({ children: true });
		partsByContainer.delete(container);
	},
};
