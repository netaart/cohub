import type { SceneItem } from "../../model/scene.js";
import { BOARD_FONT_STACK } from "@cohub/protocol/board-constants";
import type { BoardAudioItem } from "@cohub/protocol";
import { Container, Graphics, Text } from "pixi.js";
import { drawAudioWaveform } from "../audio-waveform.js";
import {
	syncTextResolution,
	syncTextWrapWidth,
	textResolutionForZoom,
} from "../text-resolution.js";
import { positionShell } from "./base-card-renderer.js";
import type {
	BoardCardRenderer,
	BoardRenderContext,
} from "./board-renderer-registry.js";
import { drawFarPlate } from "./far-plate.js";

const RADIUS = 4;
const PLAY_RADIUS = 18;

type AudioParts = {
	root: Container;
	plate: Graphics;
	waveform: Graphics;
	chrome: Graphics;
	label: Text;
	sig: string;
	wrapWidth: number;
	resolution: number;
};

const partsByContainer = new WeakMap<Container, AudioParts>();

function sync(
	container: Container,
	item: SceneItem<BoardAudioItem>,
	context: BoardRenderContext,
) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	positionShell(parts.root, item);
	const { width, height } = item.frame;
	const selected = context.selectedIds.has(item.id);
	const hovered = context.hoveredId === item.id;
	const title = item.props.snapshot?.title ?? item.props.src.split("/").pop() ?? "Audio";

	syncTextResolution(parts.label, parts, context.zoom);
	if (parts.label.text !== title) parts.label.text = title;
	syncTextWrapWidth(parts.label, parts, Math.max(1, width - 24), false);
	parts.label.position.set(12, Math.max(8, height - parts.label.height - 8));

	const sig = [
		width,
		height,
		selected,
		hovered,
		title,
		parts.label.height,
		context.palette.surface,
		context.palette.brand,
		context.palette.border,
		context.palette.muted,
		context.palette.text,
	].join("|");
	if (sig === parts.sig) return;
	parts.sig = sig;

	parts.plate
		.clear()
		.roundRect(0, 0, width, height, RADIUS)
		.fill({ color: context.palette.surface, alpha: 0.98 })
		.roundRect(0, 0, width, height, RADIUS)
		.stroke({
			color: selected
				? context.palette.brand
				: hovered
					? context.palette.muted
					: context.palette.border,
			width: selected ? 2 : 1,
			alpha: selected ? 0.96 : 0.84,
		});

	const labelBand = Math.min(height * 0.38, parts.label.height + 16);
	const waveformInset = Math.min(24, width * 0.08);
	parts.waveform.clear();
	drawAudioWaveform(
		parts.waveform,
		`${item.props.src}:${item.props.snapshot?.mtimeMs ?? "unknown"}`,
		{
			x: waveformInset,
			y: 10,
			width: Math.max(1, width - waveformInset * 2),
			height: Math.max(8, height - labelBand - 16),
		},
		context.palette.brand,
	);

	const cx = width / 2;
	const cy = Math.max(PLAY_RADIUS + 6, (height - labelBand) / 2);
	parts.chrome
		.clear()
		.circle(cx, cy, PLAY_RADIUS)
		.fill({
			color: selected ? context.palette.brand : context.palette.surface,
			alpha: 0.92,
		});
	const triangle = PLAY_RADIUS * 0.58;
	parts.chrome
		.moveTo(cx - triangle * 0.35, cy - triangle * 0.62)
		.lineTo(cx - triangle * 0.35, cy + triangle * 0.62)
		.lineTo(cx + triangle * 0.72, cy)
		.closePath()
		.fill({ color: context.palette.text, alpha: 0.96 });
	parts.label.style.fill = context.palette.text;
}

export const audioCardRenderer: BoardCardRenderer = {
	id: "audio-card",
	canRender: (item) => item.type === "audio",
	create: (item, context) => {
		const root = new Container();
		const plate = new Graphics();
		const waveform = new Graphics();
		const chrome = new Graphics();
		const resolution = textResolutionForZoom(context.zoom);
		const label = new Text({
			text: "",
			style: {
				fill: context.palette.text,
				fontFamily: BOARD_FONT_STACK,
				fontSize: 12,
				fontWeight: "500",
				wordWrap: true,
			},
			resolution,
			roundPixels: true,
		});
		root.addChild(plate, waveform, chrome, label);
		partsByContainer.set(root, {
			root,
			plate,
			waveform,
			chrome,
			label,
			sig: "",
			wrapWidth: 0,
			resolution,
		});
		if (item.type === "audio") sync(root, item, context);
		return root;
	},
	update: (container, item, context) => {
		if (item.type === "audio") sync(container, item, context);
	},
	renderFar: (graphics, item, context) => {
		drawFarPlate(graphics, item.frame, {
			fill: context.palette.surface,
			fillAlpha: 0.96,
			accent: context.palette.brand,
			accentAlpha: 0.72,
		});
	},
	destroy: (container) => {
		partsByContainer.get(container)?.root.destroy({ children: true });
		partsByContainer.delete(container);
	},
};
