import { layoutBoardText } from "@cohub/protocol";
import { BOARD_FONT_STACK } from "@cohub/protocol/board-constants";
import { resolveSceneArrow } from "../model/arrow-geometry.js";
import { type BoardViewport, degToRad, rotatePointAround, type WorldPoint, worldPoint, worldToScreen } from "../model/geometry.js";
import type { BoardScene, BoardSceneItem } from "../model/scene.js";
import {
	BOARD_FRAME_LABEL_LINE_HEIGHT,
	BOARD_FRAME_LABEL_SIZE,
	frameLabelOffset,
	layoutShapeLabel,
	SHAPE_LABEL_PADDING,
} from "../model/text-metrics.js";
import { ARROW_LABEL, arrowLabelAnchor, FRAME_LABEL_WEIGHT } from "./labels.js";
import type { BoardRenderStyle } from "./style.js";
import { type BoardTextStyle, boardTextStyle, canvasFont, canvasFontFamily, layoutTextLines } from "./text-measurement.js";

/** A content-box textarea at left/top, transformed by `rotate(rotation deg) scale(scale)` about its center. */
export type BoardTextEditLayout = {
	left: number;
	top: number;
	width: number;
	height: number;
	padding: { x: number; y: number };
	scale: number;
	rotation: number;
	font: BoardTextStyle;
	lineHeight: number;
	textAlign: "left" | "center" | "right";
	whiteSpace: "pre" | "pre-wrap";
	live: boolean;
};

export type BoardTextEditInput = {
	viewport: BoardViewport;
	scene: BoardScene;
	style?: Partial<Pick<BoardRenderStyle, "font" | "frameLabelSize">>;
	draft: string;
};

type Box = Omit<BoardTextEditLayout, "left" | "top"> & { center: WorldPoint };

function place({ center, ...box }: Box, viewport: BoardViewport): BoardTextEditLayout {
	const screen = worldToScreen(center, viewport);
	return {
		left: screen.x - box.width / 2 - box.padding.x,
		top: screen.y - box.height / 2 - box.padding.y,
		...box,
	};
}

function label(draft: string, font: BoardTextStyle, lineHeight: number) {
	const { lines, width } = layoutTextLines(draft, canvasFont(font));
	return { width: Math.max(width, font.fontSize * 4), height: lines.length * lineHeight };
}

export function boardTextEditLayout(item: BoardSceneItem, { viewport, scene, style, draft }: BoardTextEditInput): BoardTextEditLayout | null {
	const { frame } = item;
	const rotation = frame.rotation || 0;
	const center = worldPoint(frame.x + frame.width / 2, frame.y + frame.height / 2);
	const { zoom } = viewport;
	if (item.type === "text") {
		const { props } = item;
		const text = layoutBoardText({ ...props, text: draft });
		const scale = (zoom * frame.width) / text.width;
		return place(
			{
				center,
				width: text.width,
				height: text.height,
				padding: { x: 1 / scale, y: 0 },
				scale,
				rotation,
				font: boardTextStyle(props),
				lineHeight: text.lineHeight,
				textAlign: props.align ?? "left",
				whiteSpace: props.width ? "pre-wrap" : "pre",
				live: true,
			},
			viewport,
		);
	}
	if (item.type === "shape") {
		const { props } = item;
		const text = layoutShapeLabel({ text: draft, fontSize: props.fontSize }, frame.width);
		return place(
			{
				center,
				width: Math.max(0, frame.width - SHAPE_LABEL_PADDING * 2),
				height: Math.min(frame.height, text.height),
				padding: { x: SHAPE_LABEL_PADDING, y: Math.max(0, (frame.height - text.height) / 2) },
				scale: zoom,
				rotation,
				font: boardTextStyle({ font: "sans", fontSize: props.fontSize, fontWeight: 500 }),
				lineHeight: text.lineHeight,
				textAlign: props.align ?? "center",
				whiteSpace: "pre-wrap",
				live: false,
			},
			viewport,
		);
	}
	if (item.type === "frame") {
		const fontSize = style?.frameLabelSize ?? BOARD_FRAME_LABEL_SIZE;
		const lineHeight = fontSize * BOARD_FRAME_LABEL_LINE_HEIGHT;
		const font = { fontFamily: canvasFontFamily(style?.font ?? BOARD_FONT_STACK), fontSize, fontWeight: FRAME_LABEL_WEIGHT };
		const size = label(draft, font, lineHeight);
		const { x, y } = frameLabelOffset(fontSize);
		const local = worldPoint(frame.x + x + size.width / 2, frame.y + y + size.height / 2);
		return place(
			{
				center: rotation ? rotatePointAround(local, center, degToRad(rotation)) : local,
				...size,
				padding: { x: 4, y: 2 },
				scale: zoom,
				rotation,
				font,
				lineHeight,
				textAlign: "left",
				whiteSpace: "pre",
				live: false,
			},
			viewport,
		);
	}
	if (item.type === "arrow") {
		const { fontSize } = item.props;
		const font = { fontFamily: canvasFontFamily(BOARD_FONT_STACK), fontSize, fontWeight: ARROW_LABEL.fontWeight };
		const lineHeight = fontSize * ARROW_LABEL.lineHeight;
		return place(
			{
				center: arrowLabelAnchor(resolveSceneArrow(item, scene), item.style),
				...label(draft, font, lineHeight),
				padding: { x: fontSize * ARROW_LABEL.padX, y: fontSize * ARROW_LABEL.padY },
				scale: zoom,
				rotation: 0,
				font,
				lineHeight,
				textAlign: "center",
				whiteSpace: "pre",
				live: false,
			},
			viewport,
		);
	}
	return null;
}
