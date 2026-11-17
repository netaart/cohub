import { MARK_COLOR_HEX, type Point, type Stroke } from "../types.ts";

export function drawStroke(
	ctx: CanvasRenderingContext2D,
	stroke: Stroke,
	options: { scale?: number } = {},
) {
	const scale = options.scale ?? 1;
	const color = MARK_COLOR_HEX[stroke.color];
	const width = Math.max(1, stroke.width * scale);
	ctx.save();
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.strokeStyle = color;
	ctx.fillStyle = color;
	ctx.lineWidth = width;

	if (stroke.tool === "pen") {
		drawPen(ctx, stroke.points, scale);
	} else if (stroke.tool === "arrow") {
		drawArrow(
			ctx,
			scalePoint(stroke.from, scale),
			scalePoint(stroke.to, scale),
			width,
		);
	} else {
		drawRect(ctx, scalePoint(stroke.a, scale), scalePoint(stroke.b, scale));
	}
	ctx.restore();
}

function scalePoint(point: Point, scale: number): Point {
	return { x: point.x * scale, y: point.y * scale };
}

function drawPen(
	ctx: CanvasRenderingContext2D,
	points: Point[],
	scale: number,
) {
	if (points.length === 0) return;
	if (points.length === 1) {
		const p = scalePoint(points[0], scale);
		ctx.beginPath();
		ctx.arc(p.x, p.y, ctx.lineWidth / 2, 0, Math.PI * 2);
		ctx.fill();
		return;
	}
	ctx.beginPath();
	const first = scalePoint(points[0], scale);
	ctx.moveTo(first.x, first.y);
	for (let i = 1; i < points.length; i++) {
		const p = scalePoint(points[i], scale);
		ctx.lineTo(p.x, p.y);
	}
	ctx.stroke();
}

function drawArrow(
	ctx: CanvasRenderingContext2D,
	from: Point,
	to: Point,
	width: number,
) {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const len = Math.hypot(dx, dy);
	if (len < 0.5) return;

	// Large filled head so the mark reads as an arrow, not a stick.
	const head = Math.max(18, Math.min(len * 0.35, width * 6.5));
	const half = Math.PI / 5.5; // ~33° each side — wide, assertive tip
	const angle = Math.atan2(dy, dx);
	const ux = dx / len;
	const uy = dy / len;
	// Stop the shaft short of the tip so it doesn't poke through the head.
	const shaftEnd = Math.max(0, len - head * 0.62);

	ctx.beginPath();
	ctx.moveTo(from.x, from.y);
	ctx.lineTo(from.x + ux * shaftEnd, from.y + uy * shaftEnd);
	ctx.stroke();

	ctx.beginPath();
	ctx.moveTo(to.x, to.y);
	ctx.lineTo(
		to.x - head * Math.cos(angle - half),
		to.y - head * Math.sin(angle - half),
	);
	ctx.lineTo(
		to.x - head * Math.cos(angle + half),
		to.y - head * Math.sin(angle + half),
	);
	ctx.closePath();
	ctx.fill();
}

function drawRect(ctx: CanvasRenderingContext2D, a: Point, b: Point) {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	const w = Math.abs(b.x - a.x);
	const h = Math.abs(b.y - a.y);
	if (w < 0.5 && h < 0.5) return;
	ctx.strokeRect(x, y, w, h);
}

/** Dim outside the crop and outline the selection. */
export function drawCropOverlay(
	ctx: CanvasRenderingContext2D,
	frameWidth: number,
	frameHeight: number,
	crop: { x: number; y: number; width: number; height: number } | null,
) {
	if (!crop) return;
	ctx.save();
	ctx.fillStyle = "rgba(0,0,0,0.45)";
	ctx.beginPath();
	ctx.rect(0, 0, frameWidth, frameHeight);
	ctx.rect(crop.x, crop.y, crop.width, crop.height);
	ctx.fill("evenodd");
	ctx.strokeStyle = "rgba(248,250,252,0.92)";
	ctx.lineWidth = 1.5;
	ctx.strokeRect(crop.x + 0.5, crop.y + 0.5, crop.width - 1, crop.height - 1);
	ctx.restore();
}
