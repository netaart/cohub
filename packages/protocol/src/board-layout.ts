
import {
	BOARD_ARROW_STROKE_SIZE,
	BOARD_DRAW_STROKE_SIZE,
	BOARD_TEXT_FONT_SIZE,
	BOARD_TEXT_MAX_FONT_SIZE,
	BOARD_TEXT_MIN_FONT_SIZE,
} from "./board-constants.js";
import type {
	BoardArrowAnchor,
	BoardArrowBinding,
	BoardArrowEnd,
	BoardArrowItem,
	BoardDrawPoint,
	BoardItem,
	BoardTextItem,
	BoardVec2,
} from "./board-model.js";

export type BoardRect = { x: number; y: number; width: number; height: number };
export type BoardFrame = BoardRect & { rotation: number };
export type BoardMatrix = readonly [number, number, number, number, number, number];

export const IDENTITY_MATRIX: BoardMatrix = [1, 0, 0, 1, 0, 0];

export function multiplyMatrix(parent: BoardMatrix, child: BoardMatrix): BoardMatrix {
	const [a1, b1, c1, d1, tx1, ty1] = parent;
	const [a2, b2, c2, d2, tx2, ty2] = child;
	return [
		a1 * a2 + c1 * b2,
		b1 * a2 + d1 * b2,
		a1 * c2 + c1 * d2,
		b1 * c2 + d1 * d2,
		a1 * tx2 + c1 * ty2 + tx1,
		b1 * tx2 + d1 * ty2 + ty1,
	];
}

export function invertMatrix(matrix: BoardMatrix): BoardMatrix {
	const [a, b, c, d, tx, ty] = matrix;
	const det = a * d - b * c || 1e-12;
	return [d / det, -b / det, -c / det, a / det, (c * ty - d * tx) / det, (b * tx - a * ty) / det];
}

export function applyMatrix(matrix: BoardMatrix, point: BoardVec2): BoardVec2 {
	const [a, b, c, d, tx, ty] = matrix;
	return { x: a * point.x + c * point.y + tx, y: b * point.x + d * point.y + ty };
}

export function scaleVector(scale: BoardItem["scale"]): BoardVec2 {
	return typeof scale === "number" ? { x: scale, y: scale } : scale;
}


export type BoardTextMeasurer = (text: string, fontSize: number, fontWeight: number, font: string) => number | null;

let textMeasurer: BoardTextMeasurer | undefined;

export function setBoardTextMeasurer(measurer?: BoardTextMeasurer): void {
	textMeasurer = measurer;
	textSizeCache.clear();
}

function isWideCharacter(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe4f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1faff) ||
		(code >= 0x20000 && code <= 0x3fffd)
	);
}

export function estimateTextWidth(text: string, fontSize: number): number {
	let ems = 0;
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		if (character === " ") ems += 0.28;
		else if (isWideCharacter(code)) ems += 1;
		else if (/[il.,:;'|!]/.test(character)) ems += 0.3;
		else if (/[mwMW@]/.test(character)) ems += 0.85;
		else if (/[A-Z0-9]/.test(character)) ems += 0.64;
		else ems += 0.55;
	}
	return ems * fontSize;
}

function measureLine(text: string, fontSize: number, fontWeight: number, font: string): number {
	return textMeasurer?.(text, fontSize, fontWeight, font) ?? estimateTextWidth(text, fontSize);
}

function wrapParagraph(paragraph: string, width: number, measure: (text: string) => number): string[] {
	if (!paragraph) return [""];
	const tokens = paragraph.match(/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60]|[^\s\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60]+|\s+/g) ?? [paragraph];
	const lines: string[] = [];
	let line = "";
	for (const token of tokens) {
		const candidate = line + token;
		if (!line || measure(candidate.trimEnd()) <= width) {
			line = candidate;
			continue;
		}
		lines.push(line.trimEnd());
		line = /^\s+$/.test(token) ? "" : token;
	}
	lines.push(line.trimEnd());
	return lines;
}

export type BoardTextLayout = { width: number; height: number; lines: string[]; lineHeight: number };

const textSizeCache = new Map<string, BoardTextLayout>();
const TEXT_CACHE_LIMIT = 4_096;

export function clampBoardFontSize(fontSize: number): number {
	return Math.min(BOARD_TEXT_MAX_FONT_SIZE, Math.max(BOARD_TEXT_MIN_FONT_SIZE, fontSize));
}

export function layoutBoardText(props: Pick<BoardTextItem["props"], "text" | "fontSize" | "fontWeight" | "font" | "lineHeight" | "width">): BoardTextLayout {
	const fontSize = clampBoardFontSize(props.fontSize ?? BOARD_TEXT_FONT_SIZE);
	const key = `${fontSize}|${props.fontWeight}|${props.font}|${props.lineHeight}|${props.width ?? ""}|${props.text}`;
	const cached = textSizeCache.get(key);
	if (cached) return cached;
	const measure = (text: string) => measureLine(text, fontSize, props.fontWeight ?? 500, props.font ?? "sans");
	const paragraphs = (props.text || "").split("\n");
	const lines = props.width
		? paragraphs.flatMap((paragraph) => wrapParagraph(paragraph, props.width as number, measure))
		: paragraphs;
	const lineHeight = fontSize * (props.lineHeight ?? 4 / 3);
	const widest = lines.reduce((max, line) => Math.max(max, measure(line)), 0);
	const layout = {
		width: Math.max(props.width ?? 0, widest, fontSize * 0.5),
		height: Math.max(1, lines.length) * lineHeight,
		lines,
		lineHeight,
	};
	if (textSizeCache.size >= TEXT_CACHE_LIMIT) textSizeCache.clear();
	textSizeCache.set(key, layout);
	return layout;
}


export function drawSampleRadius(strokeWidth: number, pressure: number): number {
	const clamped = Math.min(1, Math.max(0, pressure));
	return Math.max(0.5, (strokeWidth / 2) * (0.5 + clamped));
}

export function drawPointsBounds(points: readonly BoardDrawPoint[], strokeWidth: number): BoardRect {
	if (points.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const point of points) {
		const radius = drawSampleRadius(strokeWidth, point.p);
		minX = Math.min(minX, point.x - radius);
		minY = Math.min(minY, point.y - radius);
		maxX = Math.max(maxX, point.x + radius);
		maxY = Math.max(maxY, point.y + radius);
	}
	return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

export function pointsRect(points: readonly BoardVec2[]): BoardRect {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const point of points) {
		minX = Math.min(minX, point.x);
		minY = Math.min(minY, point.y);
		maxX = Math.max(maxX, point.x);
		maxY = Math.max(maxY, point.y);
	}
	if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 1, height: 1 };
	return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

export function isArrowBinding(end: BoardArrowEnd): end is BoardArrowBinding {
	return typeof (end as { item?: unknown }).item === "string";
}

export function arrowBindings(item: BoardItem): string[] {
	if (item.type !== "arrow") return [];
	const props = (item as BoardArrowItem).props;
	const ids = [props.start, props.end].filter(isArrowBinding).map((end) => end.item);
	return [...new Set(ids)];
}

export function bendControl(start: BoardVec2, end: BoardVec2, bend: number): BoardVec2 {
	const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
	if (!bend) return mid;
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const length = Math.hypot(dx, dy) || 1;
	const offset = bend * length;
	return { x: mid.x + (-dy / length) * offset, y: mid.y + (dx / length) * offset };
}


export type BoardItemLookup = (id: string) => BoardItem | undefined;

export type BoardLayout = {
	has(id: string): boolean;
	box(id: string): BoardRect;
	matrix(id: string): BoardMatrix;
	localMatrix(id: string): BoardMatrix;
	parentMatrix(id: string): BoardMatrix;
	bounds(id: string): BoardRect;
	frame(id: string): BoardFrame;
	arrowEnd(id: string, which: "start" | "end"): BoardVec2;
	invalidate(ids?: Iterable<string>): void;
};

const MAX_DEPTH = 64;

export function createBoardLayout(
	lookup: BoardItemLookup,
	dependents?: (id: string) => Iterable<string>,
): BoardLayout {
	const boxes = new Map<string, BoardRect>();
	const matrices = new Map<string, BoardMatrix>();
	const bounds = new Map<string, BoardRect>();

	function matrixOf(id: string, depth = 0): BoardMatrix {
		const cached = matrices.get(id);
		if (cached) return cached;
		const item = lookup(id);
		if (!item) return IDENTITY_MATRIX;
		const parent = item.parent && depth < MAX_DEPTH && lookup(item.parent) ? matrixOf(item.parent, depth + 1) : IDENTITY_MATRIX;
		const matrix = multiplyMatrix(parent, localMatrixOf(id));
		matrices.set(id, matrix);
		return matrix;
	}

	function localMatrixOf(id: string): BoardMatrix {
		const item = lookup(id);
		if (!item) return IDENTITY_MATRIX;
		if (item.type === "arrow") return translate(item.position);
		const box = boxOf(id);
		const scale = scaleVector(item.scale);
		const radians = (item.rotation * Math.PI) / 180;
		const cos = Math.cos(radians);
		const sin = Math.sin(radians);
		const ox = box.x + item.origin.x * box.width;
		const oy = box.y + item.origin.y * box.height;
		const a = cos * scale.x;
		const b = sin * scale.x;
		const c = -sin * scale.y;
		const d = cos * scale.y;
		return [a, b, c, d, item.position.x + ox - (a * ox + c * oy), item.position.y + oy - (b * ox + d * oy)];
	}

	function boxOf(id: string, depth = 0): BoardRect {
		const cached = boxes.get(id);
		if (cached) return cached;
		const item = lookup(id);
		let box: BoardRect;
		if (!item) box = { x: 0, y: 0, width: 1, height: 1 };
		else if ("size" in item && item.size) box = { x: 0, y: 0, width: item.size.width, height: item.size.height };
		else if (item.type === "text") {
			const layout = layoutBoardText(item.props);
			box = { x: 0, y: 0, width: layout.width, height: layout.height };
		} else if (item.type === "draw") {
			box = drawPointsBounds(item.props.points, item.style.strokeWidth ?? BOARD_DRAW_STROKE_SIZE);
		} else if (item.type === "arrow") {
			const props = item.props;
			const toLocal = invertMatrix(multiplyMatrix(parentOf(item, depth), translate(item.position)));
			const start = isArrowBinding(props.start) ? applyMatrix(toLocal, resolveBoundEnd(item, props.start, props.end, depth)) : props.start;
			const end = isArrowBinding(props.end) ? applyMatrix(toLocal, resolveBoundEnd(item, props.end, props.start, depth)) : props.end;
			const points = [start, end, ...props.waypoints];
			if (props.bend) points.push(bendControl(start, end, props.bend));
			const rect = pointsRect(points);
			const pad = Math.max(8, (item.style.strokeWidth ?? BOARD_ARROW_STROKE_SIZE) * 2);
			box = { x: rect.x - pad, y: rect.y - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
		} else box = { x: 0, y: 0, width: 240, height: 160 };
		boxes.set(id, box);
		return box;
	}

	function parentOf(item: BoardItem, depth: number): BoardMatrix {
		return item.parent && depth < MAX_DEPTH && lookup(item.parent) ? matrixOf(item.parent, depth + 1) : IDENTITY_MATRIX;
	}

	function resolveBoundEnd(arrow: BoardArrowItem, end: BoardArrowBinding, other: BoardArrowEnd, depth: number): BoardVec2 {
		const target = lookup(end.item);
		const arrowSpace = multiplyMatrix(parentOf(arrow, depth), translate(arrow.position));
		if (!target || target.type === "arrow" || depth >= MAX_DEPTH) return applyMatrix(arrowSpace, { x: 0, y: 0 });
		const frame = frameOf(end.item, depth + 1);
		const toward = isArrowBinding(other)
			? lookup(other.item) && lookup(other.item)?.type !== "arrow" ? center(frameOf(other.item, depth + 1)) : center(frame)
			: applyMatrix(arrowSpace, other);
		return anchorPoint(frame, end.anchor, toward);
	}

	function frameOf(id: string, depth = 0): BoardFrame {
		boxOf(id, depth);
		const box = boxes.get(id) as BoardRect;
		const matrix = matrixOf(id, depth);
		const [a, b, c, d] = matrix;
		const centerPoint = applyMatrix(matrix, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
		const width = box.width * Math.hypot(a, b);
		const height = box.height * Math.hypot(c, d);
		return {
			x: centerPoint.x - width / 2,
			y: centerPoint.y - height / 2,
			width,
			height,
			rotation: (Math.atan2(b, a) * 180) / Math.PI,
		};
	}

	function boundsOf(id: string): BoardRect {
		const cached = bounds.get(id);
		if (cached) return cached;
		const box = boxOf(id);
		const matrix = matrixOf(id);
		const rect = pointsRect([
			applyMatrix(matrix, { x: box.x, y: box.y }),
			applyMatrix(matrix, { x: box.x + box.width, y: box.y }),
			applyMatrix(matrix, { x: box.x + box.width, y: box.y + box.height }),
			applyMatrix(matrix, { x: box.x, y: box.y + box.height }),
		]);
		bounds.set(id, rect);
		return rect;
	}

	function invalidate(ids?: Iterable<string>) {
		if (!ids) {
			boxes.clear();
			matrices.clear();
			bounds.clear();
			return;
		}
		const queue = [...ids];
		const seen = new Set<string>();
		while (queue.length) {
			const id = queue.pop() as string;
			if (seen.has(id)) continue;
			seen.add(id);
			boxes.delete(id);
			matrices.delete(id);
			bounds.delete(id);
			if (dependents) for (const next of dependents(id)) queue.push(next);
		}
	}

	return {
		has: (id) => lookup(id) !== undefined,
		box: (id) => boxOf(id),
		matrix: (id) => matrixOf(id),
		localMatrix: (id) => localMatrixOf(id),
		parentMatrix: (id) => {
			const item = lookup(id);
			return item ? parentOf(item, 0) : IDENTITY_MATRIX;
		},
		bounds: boundsOf,
		frame: (id) => frameOf(id),
		arrowEnd: (id, which) => {
			const item = lookup(id);
			if (item?.type !== "arrow") return { x: 0, y: 0 };
			const arrow = item as BoardArrowItem;
			const [end, other] = which === "start" ? [arrow.props.start, arrow.props.end] : [arrow.props.end, arrow.props.start];
			return isArrowBinding(end) ? resolveBoundEnd(arrow, end, other, 0) : applyMatrix(matrixOf(id), end);
		},
		invalidate,
	};
}

function translate(point: BoardVec2): BoardMatrix {
	return [1, 0, 0, 1, point.x, point.y];
}

function center(frame: BoardFrame): BoardVec2 {
	return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}

export function rotateAround(point: BoardVec2, pivot: BoardVec2, degrees: number): BoardVec2 {
	if (!degrees) return point;
	const radians = (degrees * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const dx = point.x - pivot.x;
	const dy = point.y - pivot.y;
	return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
}

export function framePoint(frame: BoardFrame, nx: number, ny: number): BoardVec2 {
	return rotateAround(
		{ x: frame.x + nx * frame.width, y: frame.y + ny * frame.height },
		center(frame),
		frame.rotation,
	);
}

export function autoAnchorSide(frame: BoardFrame, toward: BoardVec2): "top" | "right" | "bottom" | "left" {
	const local = rotateAround(toward, center(frame), -frame.rotation);
	const c = center(frame);
	const dx = (local.x - c.x) / Math.max(frame.width / 2, 1e-4);
	const dy = (local.y - c.y) / Math.max(frame.height / 2, 1e-4);
	if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
	return dy >= 0 ? "bottom" : "top";
}

export function sideAnchor(side: "top" | "right" | "bottom" | "left", offset: number): { x: number; y: number } {
	switch (side) {
		case "top":
			return { x: offset, y: 0 };
		case "bottom":
			return { x: offset, y: 1 };
		case "left":
			return { x: 0, y: offset };
		default:
			return { x: 1, y: offset };
	}
}

export function anchorPoint(frame: BoardFrame, anchor: BoardArrowAnchor, toward: BoardVec2): BoardVec2 {
	if (anchor === "auto") {
		const side = autoAnchorSide(frame, toward);
		const normalized = sideAnchor(side, 0.5);
		return framePoint(frame, normalized.x, normalized.y);
	}
	if ("side" in anchor) {
		const normalized = sideAnchor(anchor.side, anchor.offset);
		return framePoint(frame, normalized.x, normalized.y);
	}
	return framePoint(frame, anchor.x, anchor.y);
}

export function createDocumentLayout(items: Readonly<Record<string, BoardItem>>): BoardLayout {
	let index: Map<string, string[]> | null = null;
	const dependents = (id: string) => {
		if (!index) {
			index = new Map();
			for (const [itemId, item] of Object.entries(items)) {
				const refs = [...(item.parent ? [item.parent] : []), ...arrowBindings(item)];
				for (const ref of refs) {
					const list = index.get(ref) ?? [];
					list.push(itemId);
					index.set(ref, list);
				}
			}
		}
		return index.get(id) ?? [];
	};
	return createBoardLayout((id) => items[id], dependents);
}
