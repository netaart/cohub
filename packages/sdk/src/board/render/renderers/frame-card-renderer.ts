import { BOARD_FONT_STACK } from "@cohub/protocol/board-constants";
import type { BoardFrameItem } from "@cohub/protocol";
import { Container, Graphics, type Text } from "pixi.js";
import type { SceneItem } from "../../model/scene.js";
import { BOARD_FRAME_LABEL_LINE_HEIGHT, frameLabelOffset } from "../../model/text-metrics.js";
import { FRAME_LABEL_WEIGHT } from "../labels.js";
import { itemAlpha, itemColor } from "../palette.js";
import { dashPattern, roundRectPoints, tracePolyline, trimPolyline } from "../stroke.js";
import { syncTextResolution } from "../text-resolution.js";
import { createLabel, positionShell } from "./base-card-renderer.js";
import type { BoardCardRenderer, BoardRenderContext } from "./board-renderer-registry.js";
import { drawFarPlate } from "./far-plate.js";

type FrameParts = {
	root: Container;
	box: Graphics;
	label: Text;
	visualSig: string;
	textSig: string;
};

const partsByContainer = new WeakMap<Container, FrameParts>();

const DEFAULT_WASH = 0.04;

function sync(container: Container, item: SceneItem<BoardFrameItem>, context: BoardRenderContext) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	const { frame, style, props, locked } = item;
	positionShell(parts.root, item);

	const fill = itemColor(context, style.fill ?? style.stroke, "neutral", "fill");
	const fillAlpha = (style.fillOpacity ?? (style.fill ? 1 : DEFAULT_WASH)) * itemAlpha(context, style.fill ?? style.stroke);
	const baseStroke = itemColor(context, style.stroke, "neutral");
	const alpha = (style.stroke ? 1 : 0.55) * itemAlpha(context, style.stroke);
	const radius = style.radius ?? 4;
	const strokeWidth = style.strokeWidth ?? 1.5;
	const decorated = props.decoration !== "none";
	const visualSig = [props.decoration, frame.width, frame.height, fill, fillAlpha, baseStroke, alpha, radius, strokeWidth, style.dash, style.trim].join("|");
	if (visualSig !== parts.visualSig) {
		parts.visualSig = visualSig;
		parts.box.clear();
		if (decorated) parts.box.roundRect(0, 0, frame.width, frame.height, radius).fill({ color: fill, alpha: fillAlpha });
		const pattern = dashPattern(style.dash, strokeWidth);
		const trim = style.trim ?? 1;
		if (decorated && strokeWidth > 0 && trim > 0) {
			if (pattern || trim < 1) tracePolyline(parts.box, trimPolyline(roundRectPoints(frame.width, frame.height, radius), trim), pattern);
			else parts.box.roundRect(0, 0, frame.width, frame.height, radius);
			parts.box.stroke({ color: baseStroke, width: strokeWidth, alpha, cap: pattern || trim < 1 ? "round" : "butt", join: "round" });
		}
	}

	parts.label.visible = decorated;
	const title = locked ? `🔒 ${props.label}`.trim() : props.label;
	const labelColor = style.stroke ? baseStroke : context.palette.muted;
	const size = context.style.frameLabelSize;
	const textSig = [title, labelColor, context.style.font, size].join("|");
	if (textSig !== parts.textSig) {
		parts.textSig = textSig;
		parts.label.text = title;
		parts.label.style.fill = labelColor;
		parts.label.style.fontFamily = context.style.font;
		parts.label.style.fontSize = size;
		parts.label.style.lineHeight = size * BOARD_FRAME_LABEL_LINE_HEIGHT;
		const offset = frameLabelOffset(size);
		parts.label.position.set(offset.x, offset.y);
	}
	syncTextResolution(parts.label, context.textResolution);
}

export const frameCardRenderer: BoardCardRenderer = {
	id: "frame-card",
	canRender: (item) => item.type === "frame",
	create: (item, context) => {
		const root = new Container();
		const box = new Graphics();
		const label = createLabel(
			"",
			{ fill: context.palette.muted, fontFamily: BOARD_FONT_STACK, fontWeight: FRAME_LABEL_WEIGHT },
			context.textResolution,
		);
		root.addChild(box, label);
		partsByContainer.set(root, { root, box, label, visualSig: "", textSig: "" });
		if (item.type === "frame") sync(root, item as SceneItem<BoardFrameItem>, context);
		return root;
	},
	update: (container, item, context) => {
		if (item.type === "frame") sync(container, item as SceneItem<BoardFrameItem>, context);
	},
	resolution: (container, _item, context) => {
		const parts = partsByContainer.get(container);
		if (parts) syncTextResolution(parts.label, context.textResolution);
	},
	renderFar: (graphics, item, context) => {
		if (item.type !== "frame" || item.props.decoration === "none") return;
		drawFarPlate(graphics, item.frame, {
			fill: itemColor(context, item.style.fill ?? item.style.stroke, "neutral", "fill"),
			fillAlpha: Math.max(0.07, item.style.fillOpacity ?? (item.style.fill ? 1 : 0)) * itemAlpha(context, item.style.fill ?? item.style.stroke),
		});
	},
	destroy: (container) => {
		partsByContainer.delete(container);
		container.destroy({ children: true });
	},
};
