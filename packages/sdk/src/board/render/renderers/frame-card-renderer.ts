import { BOARD_FONT_STACK } from "@cohub/protocol/board-constants";
import type { BoardFrameItem } from "@cohub/protocol";
import { Container, Graphics, type Text } from "pixi.js";
import type { SceneItem } from "../../core/scene.js";
import { itemColor } from "../palette.js";
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
	resolution: number;
};

const partsByContainer = new WeakMap<Container, FrameParts>();

const DEFAULT_WASH = 0.04;

function sync(container: Container, item: SceneItem<BoardFrameItem>, context: BoardRenderContext) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	const { frame, style, props, locked } = item;
	positionShell(parts.root, item);
	syncTextResolution(parts.label, parts, context.zoom);

	const selected = context.selectedIds.has(item.id);
	const hovered = context.hoveredId === item.id;
	const fill = itemColor(context, style.fill ?? style.stroke, "neutral", "fill");
	const fillAlpha = style.fillOpacity ?? (style.fill ? 1 : DEFAULT_WASH);
	const baseStroke = itemColor(context, style.stroke, "neutral");
	const stroke = selected ? context.palette.brand : baseStroke;
	const alpha = selected ? 1 : hovered ? 0.85 : 0.55;
	const radius = style.radius ?? 4;
	const strokeWidth = style.strokeWidth ?? 1.5;
	const visualSig = [frame.width, frame.height, selected, hovered, fill, fillAlpha, stroke, radius, strokeWidth].join("|");
	if (visualSig !== parts.visualSig) {
		parts.visualSig = visualSig;
		parts.box.clear();
		parts.box.roundRect(0, 0, frame.width, frame.height, radius).fill({ color: fill, alpha: fillAlpha });
		if (strokeWidth > 0 || selected) {
			parts.box.roundRect(0, 0, frame.width, frame.height, radius).stroke({ color: stroke, width: selected ? Math.max(2, strokeWidth) : strokeWidth, alpha });
		}
	}

	const title = locked ? `🔒 ${props.label || "Frame"}` : props.label || "Frame";
	const labelColor = style.stroke ? baseStroke : context.palette.muted;
	const textSig = [title, labelColor].join("|");
	if (textSig !== parts.textSig) {
		parts.textSig = textSig;
		parts.label.text = title;
		parts.label.style.fill = labelColor;
	}
	parts.label.position.set(4, -18);
}

export const frameCardRenderer: BoardCardRenderer = {
	id: "frame-card",
	canRender: (item) => item.type === "frame",
	create: (item, context) => {
		const root = new Container();
		const box = new Graphics();
		const label = createLabel("", { fill: context.palette.muted, fontFamily: BOARD_FONT_STACK, fontSize: 12, fontWeight: "600" });
		root.addChild(box, label);
		partsByContainer.set(root, { root, box, label, visualSig: "", textSig: "", resolution: label.resolution });
		if (item.type === "frame") sync(root, item as SceneItem<BoardFrameItem>, context);
		return root;
	},
	update: (container, item, context) => {
		if (item.type === "frame") sync(container, item as SceneItem<BoardFrameItem>, context);
	},
	renderFar: (graphics, item, context) => {
		if (item.type !== "frame") return;
		drawFarPlate(graphics, item.frame, {
			fill: itemColor(context, item.style.fill ?? item.style.stroke, "neutral", "fill"),
			fillAlpha: Math.max(0.07, item.style.fillOpacity ?? (item.style.fill ? 1 : 0)),
		});
	},
	destroy: (container) => {
		partsByContainer.delete(container);
		container.destroy({ children: true });
	},
};
