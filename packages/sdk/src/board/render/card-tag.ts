import { Container, Graphics, Text } from "pixi.js";
import type { BoardRenderContext } from "./renderers/board-renderer-registry.js";
import { fitTextToWidth } from "./text-fit.js";
import { syncTextResolution } from "./text-resolution.js";

export type CardGlyph = "image" | "video" | "audio" | "model" | "file" | "task";

export const CARD_TAG_SIZE = 11;
const ICON = 12;
const GAP = 5;
const LIFT = 6;
const MAX_GROWTH = 1.25;
const MIN_READABLE = 7;

const SECOND = 1000;

export function formatBoardDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / SECOND));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = String(total % 60).padStart(2, "0");
	return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

const PIXEL_GLYPHS: Record<CardGlyph, readonly string[]> = {
	image: ["######", "#....#", "#.#..#", "#.##.#", "######", "......"],
	video: ["######", "#.#..#", "#.##.#", "#.#..#", "######", "......"],
	audio: ["...#..", "...##.", "...#.#", "...#..", ".###..", ".###.."],
	model: ["..#...", ".###..", "#####.", "#####.", ".###..", "..#..."],
	file: ["####..", "#..##.", "#...##", "#....#", "#....#", "######"],
	task: ["..#...", ".###..", "#####.", ".###..", "..#...", "......"],
};

function drawLineGlyph(graphics: Graphics, glyph: CardGlyph, color: number) {
	const line = { color, width: 1.25, alpha: 1, cap: "round", join: "round" } as const;
	switch (glyph) {
		case "image":
			graphics.roundRect(1, 2, 10, 8, 1.5).stroke(line);
			graphics.moveTo(2.5, 9).lineTo(5, 6).lineTo(7, 8).lineTo(8.5, 6.5).lineTo(10, 8).stroke(line);
			return;
		case "video":
			graphics.roundRect(1, 2.5, 10, 7, 1.5).stroke(line);
			graphics.poly([5, 4.5, 5, 7.5, 7.5, 6]).fill({ color });
			return;
		case "audio":
			for (const [x, height] of [[2.5, 3], [5, 7], [7.5, 9], [10, 5]] as const)
				graphics.moveTo(x, 6 - height / 2).lineTo(x, 6 + height / 2);
			graphics.stroke(line);
			return;
		case "model":
			traceCube(graphics, 6, 6, 4.5).stroke(line);
			return;
		case "file":
			graphics.poly([2.5, 1, 7.5, 1, 9.5, 3, 9.5, 11, 2.5, 11]).stroke(line);
			graphics.moveTo(7.5, 1).lineTo(7.5, 3).lineTo(9.5, 3).stroke(line);
			return;
		case "task":
			graphics.poly([6, 1, 7.3, 4.7, 11, 6, 7.3, 7.3, 6, 11, 4.7, 7.3, 1, 6, 4.7, 4.7]).fill({ color });
			return;
	}
}

export function traceCube(graphics: Graphics, cx: number, cy: number, radius: number) {
	const dx = radius * 0.866;
	const dy = radius / 2;
	graphics
		.poly([cx, cy - radius, cx + dx, cy - dy, cx + dx, cy + dy, cx, cy + radius, cx - dx, cy + dy, cx - dx, cy - dy])
		.moveTo(cx - dx, cy - dy)
		.lineTo(cx, cy)
		.lineTo(cx + dx, cy - dy)
		.moveTo(cx, cy)
		.lineTo(cx, cy + radius);
	return graphics;
}

export function drawCardGlyph(graphics: Graphics, glyph: CardGlyph, color: number, pixel: boolean) {
	if (!pixel) {
		drawLineGlyph(graphics, glyph, color);
		return;
	}
	const rows = PIXEL_GLYPHS[glyph];
	rows.forEach((row, y) => {
		for (let x = 0; x < row.length; x += 1) if (row[x] === "#") graphics.rect(x * 2, y * 2, 2, 2);
	});
	graphics.fill({ color });
}

export type CardTag = {
	root: Container;
	icon: Graphics;
	text: Text | null;
	sig: string;
	width: number;
};

export function createCardTag(): CardTag {
	const root = new Container({ label: "card-tag" });
	const icon = new Graphics();
	root.addChild(icon);
	root.visible = false;
	return { root, icon, text: null, sig: "", width: 0 };
}

function tagScale(zoom: number) {
	return Math.min(MAX_GROWTH, Math.max(1, 1 / Math.max(zoom, 0.01)));
}

export function zoomCardTag(tag: CardTag, zoom: number) {
	if (!tag.text || !tag.sig) return;
	const scale = tagScale(zoom);
	const span = ICON + GAP + tag.text.width;
	tag.root.scale.set(scale);
	tag.root.position.set(0, -(ICON + LIFT) * scale);
	tag.root.visible = CARD_TAG_SIZE * scale * zoom >= MIN_READABLE && span * scale <= tag.width + 0.5;
}

export function syncCardTag(
	tag: CardTag,
	input: { glyph: CardGlyph; text: string; width: number },
	context: BoardRenderContext,
) {
	tag.width = input.width;
	if (!input.text || input.width <= ICON * 2) {
		tag.sig = "";
		tag.root.visible = false;
		return;
	}
	if (!tag.text) {
		tag.text = new Text({
			text: "",
			style: { fontFamily: context.style.font, fontSize: CARD_TAG_SIZE, fontWeight: "500" },
			roundPixels: true,
		});
		tag.root.addChild(tag.text);
	}
	const sig = [input.glyph, input.text, input.width, context.themeKey].join("|");
	if (sig !== tag.sig) {
		tag.sig = sig;
		const color = context.palette.muted;
		const pixel = context.style.icons === "pixel";
		drawCardGlyph(tag.icon.clear(), input.glyph, color, pixel);
		tag.text.style.fill = color;
		tag.text.style.fontFamily = context.style.font;
		fitTextToWidth(tag.text, input.text, Math.max(1, input.width - ICON - GAP));
		tag.text.position.set(ICON + GAP, (ICON - tag.text.height) / 2);
	}
	syncTextResolution(tag.text, context.textResolution * tagScale(context.zoom));
	zoomCardTag(tag, context.zoom);
}
