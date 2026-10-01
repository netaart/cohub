import { Container, Graphics, GraphicsPath, Matrix, Text } from "pixi.js";
import type { BoardShapeItem } from "@cohub/protocol";
import { BOARD_FONT_STACK } from "@cohub/protocol/board-constants";
import type { SceneItem } from "../../core/scene.js";
import { type WorldPoint, worldPoint } from "../../geometry.js";
import { dashPattern, tracePolyline, trimPolyline } from "../stroke.js";
import { itemColor } from "../palette.js";
import { syncTextResolution, syncTextWrapWidth, textResolutionForZoom } from "../text-resolution.js";
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
	resolution: number;
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
		default: {
			const r = Math.min(radius, width / 2, height / 2);
			if (r <= 0) return [p(0, 0), p(width, 0), p(width, height), p(0, height), p(0, 0)];
			const corner = (cx: number, cy: number, from: number) =>
				Array.from({ length: 9 }, (_, index) => {
					const angle = from + (index / 8) * (Math.PI / 2);
					return p(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
				});
			return [
				...corner(width - r, r, -Math.PI / 2),
				...corner(width - r, height - r, 0),
				...corner(r, height - r, Math.PI / 2),
				...corner(r, r, Math.PI),
				p(width - r, 0),
			];
		}
	}
}

function sync(container: Container, item: SceneItem<BoardShapeItem>, context: BoardRenderContext) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	positionShell(parts.root, item);
	const { width, height } = item.frame;
	const { props, style } = item;
	const selected = context.selectedIds.has(item.id);
	const hovered = context.hoveredId === item.id;
	const stroke = itemColor(context, style.stroke ?? style.fill, "brand");
	const fill = itemColor(context, style.fill ?? style.stroke, "brand", "fill");
	const fillOpacity = style.fillOpacity ?? (style.fill ? 1 : 0);
	const strokeWidth = style.strokeWidth ?? 1.75;
	syncTextResolution(parts.label, parts, context.zoom);

	const visualSig = [width, height, selected, hovered, props.geometry, props.path, fill, fillOpacity, stroke, strokeWidth, style.dash, style.radius, style.trim, context.palette.muted].join("|");
	if (visualSig !== parts.visualSig) {
		parts.visualSig = visualSig;
		parts.shape.clear();
		if (fillOpacity > 0) {
			traceShapeOutline(parts.shape, props, width, height, style.radius);
			parts.shape.fill({ color: fill, alpha: fillOpacity });
		}
		const lineWidth = selected ? Math.max(2.5, strokeWidth) : strokeWidth;
		const pattern = dashPattern(style.dash, lineWidth);
		const partial = style.trim !== undefined && style.trim < 1;
		if (strokeWidth > 0 && (!partial || style.trim)) {
			if ((pattern || partial) && props.geometry !== "path") {
				const radius = style.radius ?? (props.geometry === "rounded" ? DEFAULT_ROUNDED_RADIUS : 0);
				tracePolyline(parts.shape, trimPolyline(outlinePoints(props.geometry, width, height, radius), style.trim), pattern);
			} else traceShapeOutline(parts.shape, props, width, height, style.radius);
			parts.shape.stroke({
				color: hovered && !selected ? context.palette.muted : stroke,
				width: lineWidth,
				alpha: selected ? 1 : hovered ? 0.95 : 0.85,
				cap: partial || pattern ? "round" : "butt",
				join: "round",
			});
		}
	}

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
	parts.label.position.set(width / 2, height / 2);
}

export const shapeCardRenderer: BoardCardRenderer = {
	id: "shape-card",
	canRender: (item) => item.type === "shape",
	create: (item, context) => {
		const root = new Container();
		const shape = new Graphics();
		const resolution = textResolutionForZoom(context.zoom);
		const label = new Text({
			text: "",
			style: { fill: 0xffffff, fontFamily: BOARD_FONT_STACK, fontSize: 20, fontWeight: "500", align: "center", wordWrap: true, lineHeight: 28 },
			resolution,
			roundPixels: true,
		});
		label.anchor.set(0.5);
		root.addChild(shape, label);
		partsByContainer.set(root, { root, shape, label, visualSig: "", textSig: "", wrapWidth: 0, resolution });
		if (item.type === "shape") sync(root, item as SceneItem<BoardShapeItem>, context);
		return root;
	},
	update: (container, item, context) => {
		if (item.type === "shape") sync(container, item as SceneItem<BoardShapeItem>, context);
	},
	renderFar: (graphics, item, context) => {
		if (item.type !== "shape") return;
		drawFarPlate(graphics, item.frame, {
			fill: itemColor(context, item.style.fill ?? item.style.stroke, "brand", "fill"),
			fillAlpha: Math.max(0.18, item.style.fillOpacity ?? 0),
			accent: itemColor(context, item.style.stroke, "brand"),
			accentAlpha: 0.9,
		});
	},
	destroy: (container) => {
		partsByContainer.get(container)?.root.destroy({ children: true });
		partsByContainer.delete(container);
	},
};
