import { type ScreenPoint, screenPoint } from "./geometry.js";

type Linear = readonly [number, number, number, number];
type LayerStyle = { transform: string; rotate: string; scale: string };

export type ClientToLocalInput = {
	left: number;
	top: number;
	width: number;
	height: number;
	borderLeft: number;
	borderTop: number;
	zoom: number;
	styles: readonly LayerStyle[];
};

const IDENTITY: Linear = [1, 0, 0, 1];
const ANGLE_UNITS: Record<string, number> = { deg: Math.PI / 180, rad: 1, turn: Math.PI * 2, grad: Math.PI / 200 };

const multiply = ([a, b, c, d]: Linear, [e, f, g, h]: Linear): Linear =>
	[a * e + c * f, b * e + d * f, a * g + c * h, b * g + d * h];

function transformOf(value: string): Linear {
	const match = /^matrix(3d)?\((.+)\)$/.exec(value);
	if (!match?.[2]) return IDENTITY;
	const n = match[2].split(",").map(Number);
	return match[1] ? [n[0] ?? 1, n[1] ?? 0, n[4] ?? 0, n[5] ?? 1] : [n[0] ?? 1, n[1] ?? 0, n[2] ?? 0, n[3] ?? 1];
}

function rotateOf(value: string): Linear {
	const parts = value.trim().split(/\s+/);
	const angle = /^(-?[\d.]+)([a-z]+)$/.exec(parts.at(-1) ?? "");
	const axis = parts.slice(0, -1).join(" ");
	if (!angle || (axis && axis !== "z" && axis !== "0 0 1")) return IDENTITY;
	const radians = Number(angle[1]) * (ANGLE_UNITS[angle[2] ?? ""] ?? 0);
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	return [cos, sin, -sin, cos];
}

function scaleOf(value: string): Linear {
	if (value === "none") return IDENTITY;
	const [x = 1, y = x] = value.trim().split(/\s+/).map(Number);
	return [x, 0, 0, y];
}

/** Maps client coordinates into an element's padding-box layout pixels. */
export function clientToLocal(input: ClientToLocalInput): (clientX: number, clientY: number) => ScreenPoint {
	let matrix: Linear = [input.zoom, 0, 0, input.zoom];
	for (const style of input.styles) {
		matrix = multiply(multiply(multiply(rotateOf(style.rotate), scaleOf(style.scale)), transformOf(style.transform)), matrix);
	}
	const [a, b, c, d] = matrix;
	const { width, height } = input;
	const x = input.left - Math.min(0, a * width, c * height, a * width + c * height);
	const y = input.top - Math.min(0, b * width, d * height, b * width + d * height);
	const determinant = a * d - b * c;
	return (clientX, clientY) => determinant === 0
		? screenPoint(0, 0)
		: screenPoint(
			(d * (clientX - x) - c * (clientY - y)) / determinant - input.borderLeft,
			(a * (clientY - y) - b * (clientX - x)) / determinant - input.borderTop,
		);
}

export function elementClientToLocal(element: HTMLElement): (clientX: number, clientY: number) => ScreenPoint {
	const styles: LayerStyle[] = [];
	for (let node: HTMLElement | null = element; node; node = node.parentElement) styles.push(getComputedStyle(node));
	const rect = element.getBoundingClientRect();
	return clientToLocal({
		left: rect.left,
		top: rect.top,
		width: element.offsetWidth,
		height: element.offsetHeight,
		borderLeft: element.clientLeft,
		borderTop: element.clientTop,
		zoom: (element as { currentCSSZoom?: number }).currentCSSZoom ?? 1,
		styles,
	});
}
