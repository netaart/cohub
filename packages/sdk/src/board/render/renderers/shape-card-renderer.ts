import { Container, Graphics, GraphicsPath, Matrix, Text } from "pixi.js";
import type { BoardShapeItem } from "@cohub/protocol";
import { BOARD_FONT_STACK } from "@cohub/protocol/board-constants";
import type { SceneItem } from "../../model/scene.js";
import { type WorldPoint, worldPoint } from "../../model/geometry.js";
import { dashPattern, roundRectPoints, tracePolyline, trimPolyline } from "../stroke.js";
import { itemAlpha, itemColor } from "../palette.js";
import { syncTextResolution, syncTextWrapWidth } from "../text-resolution.js";
import { positionShell } from "./base-card-renderer.js";
import type { BoardCardRenderer, BoardRenderContext } from "./board-renderer-registry.js";
import { drawFarPlate } from "./far-plate.js";

const LABEL_PADDING = 8;
const DEFAULT_ROUNDED_RADIUS = 8;

type ShapeParts = {
	root: Container;
	shape: Graphics;
	label: Text;
	visualSig: string;
	textSig: string;
	wrapWidth: number;
};

const partsByContainer = new WeakMap<Container, ShapeParts>();
const pathCache = new Map<string, { path: GraphicsPath; bounds: { x: number; y: number; width: number; height: number } } | null>();

function parsedPath(d: string) {
	if (pathCache.has(d)) return pathCache.get(d) ?? null;
	let entry: { path: GraphicsPath; bounds: { x: number; y: number; width: number; height: number } } | null = null;
	try {
		const path = new GraphicsPath(d);
		const probe = new Graphics().path(path).fill(0);
		const bounds = probe.getLocalBounds();
		probe.destroy();
		entry = { path, bounds: { x: bounds.x, y: bounds.y, width: Math.max(1e-6, bounds.width), height: Math.max(1e-6, bounds.height) } };
	} catch {
		entry = null;
	}
	if (pathCache.size > 256) pathCache.clear();
	pathCache.set(d, entry);
	return entry;
}

export function traceShapeOutline(graphics: Graphics, props: BoardShapeItem["props"], width: number, height: number, radius?: number) {
	switch (props.geometry) {
		case "ellipse":
			graphics.ellipse(width / 2, height / 2, width / 2, height / 2);
			return;
		case "diamond":
			graphics.moveTo(width / 2, 0).lineTo(width, height / 2).lineTo(width / 2, height).lineTo(0, height / 2).closePath();
			return;
		case "triangle":
			graphics.moveTo(width / 2, 0).lineTo(width, height).lineTo(0, height).closePath();
			return;
		case "rounded":
			graphics.roundRect(0, 0, width, height, radius ?? DEFAULT_ROUNDED_RADIUS);
			return;
		case "path": {
			const parsed = props.path ? parsedPath(props.path) : null;
			if (!parsed) {
				graphics.rect(0, 0, width, height);
				return;
			}
			const sx = width / parsed.bounds.width;
			const sy = height / parsed.bounds.height;
			graphics.path(parsed.path.clone(true).transform(new Matrix(sx, 0, 0, sy, -parsed.bounds.x * sx, -parsed.bounds.y * sy)));
			return;
		}
		default:
			if (radius) graphics.roundRect(0, 0, width, height, radius);
			else graphics.rect(0, 0, width, height);
	}
}

function outlinePoints(geometry: BoardShapeItem["props"]["geometry"], width: number, height: number, radius: number): WorldPoint[] {
	const p = (x: number, y: number) => worldPoint(x, y);
	switch (geometry) {
		case "ellipse": {
			const segments = 64;
			return Array.from({ length: segments + 1 }, (_, index) => {
				const angle = -Math.PI / 2 + (index / segments) * Math.PI * 2;
				return p(width / 2 + (Math.cos(angle) * width) / 2, height / 2 + (Math.sin(angle) * height) / 2);
			});
		}
		case "diamond":
			return [p(width / 2, 0), p(width, height / 2), p(width / 2, height), p(0, height / 2), p(width / 2, 0)];
		case "triangle":
			return [p(width / 2, 0), p(width, height), p(0, height), p(width / 2, 0)];
		default:
			return roundRectPoints(width, height, radius);
	}
}

function sync(container: Container, item: SceneItem<BoardShapeItem>, context: BoardRenderContext) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	positionShell(parts.root, item);
	const { width, height } = item.frame;
	const { props, style } = item;
	const stroke = itemColor(context, style.stroke ?? style.fill, "brand");
	const fill = itemColor(context, style.fill ?? style.stroke, "brand", "fill");
	const fillOpacity = (style.fillOpacity ?? (style.fill ? 1 : 0)) * itemAlpha(context, style.fill ?? style.stroke);
	const strokeAlpha = itemAlpha(context, style.stroke ?? style.fill);
	const strokeWidth = style.strokeWidth ?? 1.75;

	const visualSig = [width, height, props.geometry, props.path, fill, fillOpacity, stroke, strokeAlpha, strokeWidth, style.dash, style.radius, style.trim].join("|");
	if (visualSig !== parts.visualSig) {
		parts.visualSig = visualSig;
		parts.shape.clear();
		if (fillOpacity > 0) {
			traceShapeOutline(parts.shape, props, width, height, style.radius);
			parts.shape.fill({ color: fill, alpha: fillOpacity });
		}
		const pattern = dashPattern(style.dash, strokeWidth);
		const partial = style.trim !== undefined && style.trim < 1;
		if (strokeWidth > 0 && (!partial || style.trim)) {
			if ((pattern || partial) && props.geometry !== "path") {
				const radius = style.radius ?? (props.geometry === "rounded" ? DEFAULT_ROUNDED_RADIUS : 0);
				tracePolyline(parts.shape, trimPolyline(outlinePoints(props.geometry, width, height, radius), style.trim), pattern);
			} else traceShapeOutline(parts.shape, props, width, height, style.radius);
			parts.shape.stroke({
				color: stroke,
				width: strokeWidth,
				alpha: 0.85 * strokeAlpha,
				cap: partial || pattern ? "round" : "butt",
				join: "round",
			});
		}
	}

	parts.label.alpha = itemAlpha(context, style.stroke);
	const label = itemColor(context, style.stroke, "neutral", "label");
	const textSig = [props.text, label, props.fontSize, props.align].join("|");
	if (textSig !== parts.textSig) {
		parts.textSig = textSig;
		parts.label.text = props.text;
		parts.label.visible = props.text.length > 0;
		parts.label.style.fill = label;
		parts.label.style.fontSize = props.fontSize;
		parts.label.style.lineHeight = props.fontSize * 1.4;
		parts.label.style.align = props.align;
	}
	syncTextWrapWidth(parts.label, parts, Math.max(1, width - LABEL_PADDING * 2), context.resizingIds.has(item.id));
	syncTextResolution(parts.label, context.textResolution);
	parts.label.position.set(width / 2, height / 2);
}

export const shapeCardRenderer: BoardCardRenderer = {
	id: "shape-card",
	canRender: (item) => item.type === "shape",
	create: (item, context) => {
		const root = new Container();
		const shape = new Graphics();
		const label = new Text({
			text: "",
			style: { fill: 0xffffff, fontFamily: BOARD_FONT_STACK, fontSize: 20, fontWeight: "500", align: "center", wordWrap: true, lineHeight: 28 },
			resolution: context.textResolution,
			roundPixels: true,
		});
		label.anchor.set(0.5);
		root.addChild(shape, label);
		partsByContainer.set(root, { root, shape, label, visualSig: "", textSig: "", wrapWidth: 0 });
		if (item.type === "shape") sync(root, item as SceneItem<BoardShapeItem>, context);
		return root;
	},
	update: (container, item, context) => {
		if (item.type === "shape") sync(container, item as SceneItem<BoardShapeItem>, context);
	},
	resolution: (container, _item, context) => {
		const parts = partsByContainer.get(container);
		if (parts) syncTextResolution(parts.label, context.textResolution);
	},
	renderFar: (graphics, item, context) => {
		if (item.type !== "shape") return;
		drawFarPlate(graphics, item.frame, {
			fill: itemColor(context, item.style.fill ?? item.style.stroke, "brand", "fill"),
			fillAlpha: Math.max(0.18, item.style.fillOpacity ?? 0) * itemAlpha(context, item.style.fill ?? item.style.stroke),
			accent: itemColor(context, item.style.stroke, "brand"),
			accentAlpha: 0.9 * itemAlpha(context, item.style.stroke),
		});
	},
	destroy: (container) => {
		partsByContainer.get(container)?.root.destroy({ children: true });
		partsByContainer.delete(container);
	},
};
