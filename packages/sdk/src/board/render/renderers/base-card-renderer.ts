import { BOARD_FONT_STACK } from "@cohub/protocol/board-constants";
import { Container, Graphics, Text } from "pixi.js";
import type { BoardFrame } from "@cohub/protocol";
import { getBoardResolution } from "../text-resolution.js";
import type { BoardRenderPalette } from "./board-renderer-registry.js";

export const CARD_RADIUS = 10;
export const CARD_PADDING = 12;
export const FOOTER_HEIGHT = 34;

const TEXT_OPTIONS = {
	resolution: getBoardResolution(),
	roundPixels: true,
} as const;

export function createLabel(text: string, style: Record<string, unknown>) {
	return new Text({ ...TEXT_OPTIONS, text, style });
}

export type CardShellState = {
	width: number;
	height: number;
	selected: boolean;
	hovered: boolean;
	accent: number;
	title: string;
};

export type CardShell = {
	root: Container;
	content: Container;
	contentRect: () => { x: number; y: number; width: number; height: number };
	update: (
		state: CardShellState,
		palette: BoardRenderPalette,
		footer: boolean,
	) => void;
	destroy: () => void;
};

export function createCardShell(): CardShell {
	const root = new Container();
	const background = new Graphics();
	const content = new Container();
	const mask = new Graphics();
	const footerBg = new Graphics();
	const title = createLabel("", {
		fill: 0xffffff,
		fontFamily: BOARD_FONT_STACK,
		fontSize: 12,
		fontWeight: "500",
		wordWrap: true,
	});

	content.mask = mask;
	root.addChild(background, mask, content, footerBg, title);

	let last: (CardShellState & { footer: boolean; paletteKey: string }) | null =
		null;

	function paletteKeyOf(palette: BoardRenderPalette): string {
		return `${palette.surface}|${palette.border}|${palette.hover}|${palette.text}|${palette.muted}`;
	}

	function contentRectFor(width: number, height: number, footer: boolean) {
		const bottom = footer ? FOOTER_HEIGHT : CARD_PADDING;
		return {
			x: CARD_PADDING,
			y: CARD_PADDING,
			width: Math.max(1, width - CARD_PADDING * 2),
			height: Math.max(1, height - CARD_PADDING - bottom),
		};
	}

	function draw(
		state: CardShellState,
		palette: BoardRenderPalette,
		footer: boolean,
	) {
		const { width, height, selected, hovered, accent } = state;

		background.clear();
		background
			.roundRect(0, 0, width, height, CARD_RADIUS)
			.fill({ color: palette.surface, alpha: 0.98 });
		const borderColor = selected
			? accent
			: hovered
				? palette.muted
				: palette.border;
		background.roundRect(0, 0, width, height, CARD_RADIUS).stroke({
			color: borderColor,
			width: selected ? 2 : 1,
			alpha: selected ? 0.95 : hovered ? 0.9 : 0.8,
		});

		mask.clear();
		const rect = contentRectFor(width, height, footer);
		mask.roundRect(rect.x, rect.y, rect.width, rect.height, 4).fill({
			color: 0xffffff,
		});

		footerBg.clear();
		footerBg.visible = footer;
		title.visible = footer;
		if (footer) {
			const fx = 1;
			const fy = height - FOOTER_HEIGHT;
			const fw = width - 2;
			const fh = FOOTER_HEIGHT - 1;
			const r = CARD_RADIUS - 1;
			footerBg
				.moveTo(fx, fy)
				.lineTo(fx + fw, fy)
				.lineTo(fx + fw, fy + fh - r)
				.arcTo(fx + fw, fy + fh, fx + fw - r, fy + fh, r)
				.lineTo(fx + r, fy + fh)
				.arcTo(fx, fy + fh, fx, fy + fh - r, r)
				.lineTo(fx, fy)
				.fill({ color: palette.hover, alpha: 0.55 });
			title.text = state.title;
			title.style.fill = palette.text;
			title.style.wordWrapWidth = width - CARD_PADDING * 2;
			title.x = CARD_PADDING;
			title.y = height - FOOTER_HEIGHT + (FOOTER_HEIGHT - title.height) / 2;
		}
	}

	function update(
		state: CardShellState,
		palette: BoardRenderPalette,
		footer: boolean,
	) {
		const paletteKey = paletteKeyOf(palette);
		const changed =
			!last ||
			last.width !== state.width ||
			last.height !== state.height ||
			last.selected !== state.selected ||
			last.hovered !== state.hovered ||
			last.accent !== state.accent ||
			last.title !== state.title ||
			last.footer !== footer ||
			last.paletteKey !== paletteKey;
		if (changed) {
			draw(state, palette, footer);
			last = { ...state, footer, paletteKey };
		}
	}

	function destroy() {
		root.destroy({ children: true });
	}

	return {
		root,
		content,
		contentRect: () =>
			contentRectFor(last?.width ?? 0, last?.height ?? 0, last?.footer ?? true),
		update,
		destroy,
	};
}

export function positionShell(root: Container, item: { frame: BoardFrame }) {
	const { x, y, width, height, rotation } = item.frame;
	root.pivot.set(width / 2, height / 2);
	root.x = x + width / 2;
	root.y = y + height / 2;
	root.rotation = ((rotation || 0) * Math.PI) / 180;
}
