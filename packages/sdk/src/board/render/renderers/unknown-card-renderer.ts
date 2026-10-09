import { BOARD_MONO_FONT_STACK } from "@cohub/protocol/board-constants";
import { Container, Graphics, Text } from "pixi.js";
import {
	syncTextResolution,
	textResolutionForZoom,
} from "../text-resolution.js";
import type { BoardSceneItem } from "../../core/scene.js";
import { positionShell } from "./base-card-renderer.js";
import type {
	BoardCardRenderer,
	BoardRenderContext,
} from "./board-renderer-registry.js";
import { drawFarPlate } from "./far-plate.js";

const RADIUS = 10;

type UnknownParts = {
	root: Container;
	box: Graphics;
	label: Text;
	visualSig: string;
	textSig: string;
	resolution: number;
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
	const selected = context.selectedIds.has(item.id);
	const realType = item.type;
	syncTextResolution(parts.label, parts, context.zoom);
	const visualSig = [
		width,
		height,
		selected,
		context.palette.surface,
		context.palette.brand,
		context.palette.border,
		context.palette.muted,
	].join("|");
	if (visualSig !== parts.visualSig) {
		parts.visualSig = visualSig;
		parts.box.clear();
		parts.box
			.roundRect(0, 0, width, height, RADIUS)
			.fill({ color: context.palette.surface, alpha: 0.7 })
			.roundRect(0, 0, width, height, RADIUS)
			.stroke({
				color: selected ? context.palette.brand : context.palette.border,
				width: selected ? 2 : 1,
				alpha: 0.8,
			});
		parts.box.roundRect(6, 6, width - 12, height - 12, RADIUS - 4).stroke({
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
	parts.label.position.set(width / 2, height / 2);
}

export const unknownCardRenderer: BoardCardRenderer = {
	id: "unknown-card",
	canRender: () => true,
	create: (item, context) => {
		const root = new Container();
		const box = new Graphics();
		const resolution = textResolutionForZoom(context.zoom);
		const label = new Text({
			text: "",
			style: { fontFamily: BOARD_MONO_FONT_STACK, fontSize: 11, fontWeight: "600" },
			resolution,
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
			resolution,
		});
		sync(root, item, context);
		return root;
	},
	update: (container, item, context) => {
		sync(container, item, context);
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
