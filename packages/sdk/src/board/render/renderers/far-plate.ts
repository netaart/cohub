
import type { Graphics } from "pixi.js";
import { degToRad } from "../../geometry.js";
import type { BoardFrame } from "@cohub/protocol";

const FAR_STROKE_MAX_POINTS = 24;

const ACCENT_RATIO = 0.14;
const ACCENT_MIN = 2;
const ACCENT_MAX = 10;

function traceFrame(
	graphics: Graphics,
	frame: BoardFrame,
	inset = 0,
	heightOverride?: number,
) {
	const x = frame.x + inset;
	const y = frame.y + inset;
	const width = Math.max(0, frame.width - inset * 2);
	const height = Math.max(0, (heightOverride ?? frame.height) - inset * 2);
	if (!frame.rotation) {
		graphics.rect(x, y, width, height);
		return;
	}
	const cx = frame.x + frame.width / 2;
	const cy = frame.y + frame.height / 2;
	const angle = degToRad(frame.rotation);
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const corner = (px: number, py: number) => {
		const dx = px - cx;
		const dy = py - cy;
		return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
	};
	const a = corner(x, y);
	const b = corner(x + width, y);
	const c = corner(x + width, y + height);
	const d = corner(x, y + height);
	graphics
		.moveTo(a.x, a.y)
		.lineTo(b.x, b.y)
		.lineTo(c.x, c.y)
		.lineTo(d.x, d.y)
		.closePath();
}

export type FarPlateStyle = {
	fill: number;
	fillAlpha?: number;
	accent?: number;
	accentAlpha?: number;
};

export function drawFarPlate(
	graphics: Graphics,
	frame: BoardFrame,
	style: FarPlateStyle,
) {
	if (frame.width <= 0 || frame.height <= 0) return;
	traceFrame(graphics, frame);
	graphics.fill({ color: style.fill, alpha: style.fillAlpha ?? 1 });
	if (style.accent === undefined) return;
	const band = Math.min(
		ACCENT_MAX,
		Math.max(ACCENT_MIN, frame.height * ACCENT_RATIO),
	);
	traceFrame(graphics, frame, 0, band);
	graphics.fill({ color: style.accent, alpha: style.accentAlpha ?? 0.9 });
}

export function farStrokeSamples<T>(points: readonly T[]): readonly T[] {
	if (points.length <= FAR_STROKE_MAX_POINTS) return points;
	const step = Math.ceil(points.length / FAR_STROKE_MAX_POINTS);
	const out: T[] = [];
	for (let i = 0; i < points.length - 1; i += step) out.push(points[i] as T);
	out.push(points[points.length - 1] as T);
	return out;
}

export function drawFarStroke(
	graphics: Graphics,
	points: ReadonlyArray<{ x: number; y: number }>,
	style: { color: number; width: number; alpha?: number },
) {
	const samples = farStrokeSamples(points);
	if (samples.length < 2) return;
	const first = samples[0] as { x: number; y: number };
	graphics.moveTo(first.x, first.y);
	for (let i = 1; i < samples.length; i += 1) {
		const point = samples[i] as { x: number; y: number };
		graphics.lineTo(point.x, point.y);
	}
	graphics.stroke({
		color: style.color,
		width: style.width,
		alpha: style.alpha ?? 0.9,
	});
}
