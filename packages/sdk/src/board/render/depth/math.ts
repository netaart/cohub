import type { ShaderBit, View3D } from "@pixi/3d";
import type { BoardProjection, BoardVec3 } from "../../model/view-camera.js";

export type Vec3 = [number, number, number];
export type Mat3 = [Vec3, Vec3, Vec3];

export function apply(m: Mat3, v: readonly number[]): Vec3 {
	const [x, y, z] = v as [number, number, number];
	return [m[0][0] * x + m[0][1] * y + m[0][2] * z, m[1][0] * x + m[1][1] * y + m[1][2] * z, m[2][0] * x + m[2][1] * y + m[2][2] * z];
}

export function multiply(a: Mat3, b: Mat3): Mat3 {
	const row = (r: Vec3): Vec3 => [0, 1, 2].map((col) => r[0] * (b[0][col] as number) + r[1] * (b[1][col] as number) + r[2] * (b[2][col] as number)) as Vec3;
	return [row(a[0]), row(a[1]), row(a[2])];
}

export function transpose(m: Mat3): Mat3 {
	return [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]];
}

export function axisRotation(axis: readonly number[], angle: number): Mat3 {
	const [x, y, z] = axis as [number, number, number];
	const c = Math.cos(angle);
	const s = Math.sin(angle);
	const t = 1 - c;
	return [
		[c + x * x * t, x * y * t - z * s, x * z * t + y * s],
		[y * x * t + z * s, c + y * y * t, y * z * t - x * s],
		[z * x * t - y * s, z * y * t + x * s, c + z * z * t],
	];
}

export function quaternion(m: Mat3): [number, number, number, number] {
	const [[a, b, c], [d, e, f], [g, h, i]] = m;
	const trace = a + e + i;
	if (trace > 0) {
		const s = 0.5 / Math.sqrt(trace + 1);
		return [(h - f) * s, (c - g) * s, (d - b) * s, 0.25 / s];
	}
	if (a > e && a > i) {
		const s = 2 * Math.sqrt(1 + a - e - i);
		return [0.25 * s, (b + d) / s, (c + g) / s, (h - f) / s];
	}
	if (e > i) {
		const s = 2 * Math.sqrt(1 + e - a - i);
		return [(b + d) / s, 0.25 * s, (f + h) / s, (c - g) / s];
	}
	const s = 2 * Math.sqrt(1 + i - a - e);
	return [(c + g) / s, (f + h) / s, 0.25 * s, (d - b) / s];
}

export function toScene(projection: BoardProjection, x: number, y: number, z: number): Vec3 {
	return [x - projection.center.x, projection.center.y - y, z];
}

export function fromScene(projection: BoardProjection, x: number, y: number, z: number): Vec3 {
	return [x + projection.center.x, projection.center.y - y, z];
}

const flip = (v: BoardVec3): Vec3 => [v[0], -v[1], v[2]];

const sizes = new WeakMap<View3D, string>();

export function aimBoardCamera(view: View3D, projection: BoardProjection) {
	const { width, height, focal, distance, eye, right, up, forward } = projection;
	const size = `${width}x${height}`;
	if (sizes.get(view) !== size) {
		sizes.set(view, size);
		view.setSize(width, height);
	}
	const camera = view.camera;
	camera.fov = (2 * Math.atan(height / 2 / focal) * 180) / Math.PI;
	camera.near = distance * 0.02;
	camera.far = distance * 12;
	const [x, y, z] = toScene(projection, eye[0], eye[1], eye[2]);
	camera.position.set(x, y, z);
	const [r, u, b] = [flip(right), flip(up), flip([-forward[0], -forward[1], -forward[2]])];
	const [qx, qy, qz, qw] = quaternion([[r[0], u[0], b[0]], [r[1], u[1], b[1]], [r[2], u[2], b[2]]]);
	camera.quaternion.set(qx, qy, qz, qw);
}

export const straightBit: ShaderBit = {
	name: "cohubDepthStraight",
	gl: { fragment: { material: "{ if (alpha > 0.0001) albedo /= alpha; }" } },
	gpu: { fragment: { material: "{ if (alpha > 0.0001) { albedo = albedo / alpha; } }" } },
};
