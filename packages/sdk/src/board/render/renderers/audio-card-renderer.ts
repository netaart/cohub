import { getMediaResourceTitle } from "../../model/media.js";
import type { SceneItem } from "../../model/scene.js";
import type { BoardAudioItem } from "@cohub/protocol";
import { Container, Graphics, Text } from "pixi.js";
import { drawAudioWaveform } from "../audio-waveform.js";
import { formatBoardDuration } from "../card-tag.js";
import { cardElevation, drawCardSurface } from "../surface.js";
import { fitTextToWidth } from "../text-fit.js";
import { boardCardDetailed } from "../lod.js";
import { syncTextResolution } from "../text-resolution.js";
import { positionShell } from "./base-card-renderer.js";
import type { BoardCardRenderer, BoardRenderContext } from "./board-renderer-registry.js";
import { drawFarPlate } from "./far-plate.js";
import { drawMediaPlayKey } from "./media-key.js";

export const AUDIO_PADDING = 14;
export const AUDIO_KEY_RADIUS = 16;
const GAP = 12;
const WAVE_HEIGHT = 16;

type AudioParts = {
	root: Container;
	plate: Graphics;
	wave: Graphics;
	title: Text;
	sig: string;
};

const partsByContainer = new WeakMap<Container, AudioParts>();

export function audioKeyCenter(width: number, height: number) {
	const radius = Math.min(AUDIO_KEY_RADIUS, Math.max(8, height / 2 - 8), width / 4);
	return { x: AUDIO_PADDING + radius, y: height / 2, radius };
}

function sync(container: Container, item: SceneItem<BoardAudioItem>, context: BoardRenderContext) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	syncContent(parts, item, context);
	syncTextResolution(parts.title, context.textResolution);
}

function syncContent(parts: AudioParts, item: SceneItem<BoardAudioItem>, context: BoardRenderContext) {
	positionShell(parts.root, item);
	const { width, height } = item.frame;
	const title = item.props.snapshot?.title ?? getMediaResourceTitle(item.props.src);
	const durationMs = item.props.snapshot?.durationMs;
	const detailed = boardCardDetailed(context.zoom);
	const elevation = cardElevation(context, item.id);
	const sig = [width, height, title, durationMs ?? "", detailed, elevation, item.props.src, item.props.snapshot?.mtimeMs ?? "", context.themeKey].join("|");
	if (sig === parts.sig) return;
	parts.sig = sig;

	drawCardSurface(parts.plate.clear(), { x: 0, y: 0, width, height }, context.style, {
		fill: context.palette.surface,
		border: context.palette.border,
		borderAlpha: 0.85,
		elevation,
	});
	const key = audioKeyCenter(width, height);
	drawMediaPlayKey(parts.plate, key.x, key.y, key.radius, context, true);

	const left = key.x + key.radius + GAP;
	const right = width - AUDIO_PADDING;
	const room = right - left;
	parts.title.visible = detailed && room > 24;
	parts.wave.clear();
	if (!parts.title.visible) return;

	parts.title.style.fontFamily = context.style.font;
	parts.title.style.fill = context.palette.text;
	fitTextToWidth(parts.title, durationMs ? `${title} · ${formatBoardDuration(durationMs)}` : title, room);

	const withWave = height >= 56;
	const block = parts.title.height + (withWave ? 6 + WAVE_HEIGHT : 0);
	const top = (height - block) / 2;
	parts.title.position.set(left, top);
	if (withWave) {
		drawAudioWaveform(
			parts.wave,
			`${item.props.src}:${item.props.snapshot?.mtimeMs ?? "unknown"}`,
			{ x: left, y: top + parts.title.height + 6, width: room, height: WAVE_HEIGHT },
			context.palette.muted,
			0.45,
			context.style.corner === "pixel",
		);
	}
}

export const audioCardRenderer: BoardCardRenderer = {
	id: "audio-card",
	canRender: (item) => item.type === "audio",
	create: (item, context) => {
		const root = new Container();
		const plate = new Graphics();
		const wave = new Graphics();
		const title = new Text({ text: "", style: { fontSize: 13, fontWeight: "600" }, resolution: context.textResolution, roundPixels: true });
		root.addChild(plate, wave, title);
		partsByContainer.set(root, { root, plate, wave, title, sig: "" });
		if (item.type === "audio") sync(root, item, context);
		return root;
	},
	update: (container, item, context) => {
		if (item.type === "audio") sync(container, item, context);
	},
	resolution: (container, item, context) => {
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
