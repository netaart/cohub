import { BOARD_MONO_FONT_STACK } from "@cohub/protocol/board-constants";
import { Container, Graphics, Text } from "pixi.js";
import { syncTextResolution } from "../text-resolution.js";
import type { BoardSceneItem } from "../../model/scene.js";
import { cardElevation, drawCardSurface, traceCardOutline } from "../surface.js";
import { positionShell } from "./base-card-renderer.js";
import type {
	BoardCardRenderer,
	BoardRenderContext,
} from "./board-renderer-registry.js";
import { drawFarPlate } from "./far-plate.js";

type UnknownParts = {
	root: Container;
	box: Graphics;
	label: Text;
	visualSig: string;
	textSig: string;
};

const partsByContainer = new WeakMap<Container, UnknownParts>();

function sync(
	container: Container,
	item: BoardSceneItem,
	context: BoardRenderContext,
) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	positionShell(parts.root, item);
	const { width, height } = item.frame;
	const realType = item.type;
	const elevation = cardElevation(context, item.id);
	const visualSig = [width, height, elevation, context.themeKey].join("|");
	if (visualSig !== parts.visualSig) {
		parts.visualSig = visualSig;
		const rect = { x: 0, y: 0, width, height };
		drawCardSurface(parts.box.clear(), rect, context.style, {
			fill: context.palette.surface,
			fillAlpha: 0.7,
			border: context.palette.border,
			borderAlpha: 0.8,
			elevation,
		});
		traceCardOutline(parts.box, rect, context.style, -6).stroke({
			color: context.palette.muted,
			width: 1,
			alpha: 0.4,
		});
	}

	const textSig = [realType, context.palette.muted].join("|");
	if (textSig !== parts.textSig) {
		parts.textSig = textSig;
		parts.label.text = realType;
		parts.label.style.fill = context.palette.muted;
	}
	syncTextResolution(parts.label, context.textResolution);
	parts.label.position.set(width / 2, height / 2);
}

export const unknownCardRenderer: BoardCardRenderer = {
	id: "unknown-card",
	canRender: () => true,
	create: (item, context) => {
		const root = new Container();
		const box = new Graphics();
		box.context.batchMode = "batch";
		const label = new Text({
			text: "",
			style: { fontFamily: BOARD_MONO_FONT_STACK, fontSize: 11, fontWeight: "600" },
			resolution: context.textResolution,
			roundPixels: true,
		});
		label.anchor.set(0.5);
		root.addChild(box, label);
		partsByContainer.set(root, {
			root,
			box,
			label,
			visualSig: "",
			textSig: "",
		});
		sync(root, item, context);
		return root;
	},
	update: (container, item, context) => {
		sync(container, item, context);
	},
	resolution: (container, _item, context) => {
		const parts = partsByContainer.get(container);
		if (parts) syncTextResolution(parts.label, context.textResolution);
	},
	renderFar: (graphics, item, context) => {
		drawFarPlate(graphics, item.frame, {
			fill: context.palette.muted,
			fillAlpha: 0.2,
		});
	},
	destroy: (container) => {
		partsByContainer.get(container)?.root.destroy({ children: true });
		partsByContainer.delete(container);
	},
};
