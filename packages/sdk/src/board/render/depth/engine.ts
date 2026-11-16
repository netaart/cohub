import { FlatMaterial, Geometry3D, Mesh3D, type ShaderBit, View3D } from "@pixi/3d";
import { Matrix, type Renderer, type Texture } from "pixi.js";
import type { BoardDepthSurface } from "../../model/depth.js";
import { boardDepthEye } from "../../model/depth.js";
import { prepareModelRenderer } from "../model3d/renderer.js";
import type { BoardDepthBend } from "./bend.js";
import { type BoardDepthObjects, createBoardDepthObjects } from "./objects.js";

export type BoardDepthLayer = {
	id: string;
	surface: BoardDepthSurface;
	front: Texture;
	back: Texture | null;
	opacity: number;
	bend: { source: BoardDepthBend; width: number; height: number; amount: number; phase: number; shade: number } | null;
};

export type BoardDepthStage = {
	readonly view: View3D;
	readonly objects: BoardDepthObjects;
	resize(width: number, height: number): void;
	sync(layers: readonly BoardDepthLayer[]): void;
	readonly empty: boolean;
	destroy(): void;
};

const BACK_TINT = 0xc4c4c4;
const LIGHT: [number, number, number] = (() => {
	const [x, y, z] = [-0.42, -0.55, 0.72];
	const length = Math.hypot(x, y, z);
	return [x / length, -y / length, z / length];
})();

// Board pictures are premultiplied; materials premultiply what they draw, so take it out first.
const straightBit: ShaderBit = {
	name: "cohubDepthStraight",
	gl: { fragment: { material: "{ if (alpha > 0.0001) albedo /= alpha; }" } },
	gpu: { fragment: { material: "{ if (alpha > 0.0001) { albedo = albedo / alpha; } }" } },
};

const bendBits = new Map<string, ShaderBit>();

function bendBit(bend: BoardDepthBend): ShaderBit {
	let bit = bendBits.get(bend.key);
	if (bit) return bit;
	bit = {
		name: `cohubDepthBend${bend.key}`,
		bindings: { material: { cohubBasisX: "vec4<f32>", cohubBasisY: "vec4<f32>", cohubBasisZ: "vec4<f32>", cohubBend: "vec4<f32>", cohubLight: "vec4<f32>" } },
		gl: {
			header: bend.header,
			vertex: {
				beforeTransform: `{
	vec3 cohubOffset = cohubBend(uv, material.cohubBend.xy, material.cohubBend.z, material.cohubBend.w);
	position.xyz += material.cohubBasisX.xyz * cohubOffset.x + material.cohubBasisY.xyz * cohubOffset.y + material.cohubBasisZ.xyz * cohubOffset.z;
}`,
			},
			fragment: {
				material: `{
	vec3 cohubNormal = normalize(cross(dFdx(vPosition), dFdy(vPosition)));
	float cohubLit = dot(cohubNormal, material.cohubLight.xyz) - material.cohubLight.z;
	albedo *= clamp(1.0 + material.cohubLight.w * 1.1 * cohubLit, 0.35, 1.2);
}`,
			},
		},
	};
	if (bendBits.size >= 64) bendBits.delete(bendBits.keys().next().value as string);
	bendBits.set(bend.key, bit);
	return bit;
}

type Surface = {
	segments: number;
	bendKey: string | null;
	geometry: Geometry3D;
	front: Mesh3D;
	back: Mesh3D;
	frontMaterial: FlatMaterial;
	backMaterial: FlatMaterial;
	backTexture: Texture | null;
	frontTexture: Texture;
};

function createGeometry(segments: number): Geometry3D {
	const side = segments + 1;
	const count = side * side;
	const uvs = new Float32Array(count * 2);
	const indices = count > 65535 ? new Uint32Array(segments * segments * 6) : new Uint16Array(segments * segments * 6);
	for (let row = 0, v = 0; row < side; row++) for (let col = 0; col < side; col++, v++) uvs.set([col / segments, row / segments], v * 2);
	for (let row = 0, i = 0; row < segments; row++) {
		for (let col = 0; col < segments; col++, i += 6) {
			const a = row * side + col;
			const b = a + side;
			indices.set([a, b, a + 1, a + 1, b, b + 1], i);
		}
	}
	return new Geometry3D({ positions: new Float32Array(count * 3), colors: new Float32Array(count * 4).fill(1), uvs, indices, dynamic: true });
}

function createMaterial(texture: Texture, options: { back: boolean; mirrored: boolean; bend: BoardDepthBend | null }): FlatMaterial {
	const material = new FlatMaterial({
		baseColorTexture: texture,
		baseColor: options.back && !options.mirrored ? BACK_TINT : 0xffffff,
		vertexColors: true,
		alphaMode: "blend",
		fog: false,
		extraBits: options.bend ? [straightBit, bendBit(options.bend)] : [straightBit],
		...(options.mirrored ? { uvTransform: new Matrix(-1, 0, 0, 1, 1, 0) } : {}),
	});
	material.state.depthMask = true;
	if (options.back) material.state.clockwiseFrontFace = !material.state.clockwiseFrontFace;
	return material;
}

export async function createBoardDepthStage(renderer: Renderer): Promise<BoardDepthStage> {
	await prepareModelRenderer(renderer);
	const view = new View3D({
		width: 1,
		height: 1,
		cull: "off",
		// No tone curve: lifted pictures must keep the exact colours they have on the Board.
		environment: { skyColor: 0xffffff, groundColor: 0x8a857e, intensity: 0.75 },
		toneMapping: "none",
	});
	view.eventMode = "none";
	view.label = "board-depth";
	const objects = createBoardDepthObjects(view, LIGHT);
	const surfaces = new Map<string, Surface>();
	let size = { width: 0, height: 0 };

	function aim(width: number, height: number) {
		const eye = boardDepthEye({ x: 0, y: 0, zoom: 1, width, height });
		const camera = view.camera;
		camera.fov = (2 * Math.atan(height / 2 / eye.distance) * 180) / Math.PI;
		camera.near = Math.max(1, eye.distance * 0.01);
		camera.far = eye.distance * 8;
		camera.position.set(eye.x, -eye.y, eye.distance);
		camera.lookAt({ x: eye.x, y: -eye.y, z: 0 });
	}

	function release(id: string) {
		const entry = surfaces.get(id);
		if (!entry) return;
		surfaces.delete(id);
		for (const mesh of [entry.front, entry.back]) {
			mesh.removeFromParent();
			mesh.destroy();
		}
		entry.frontMaterial.destroy();
		entry.backMaterial.destroy();
		entry.geometry.destroy();
	}

	function surfaceFor(layer: BoardDepthLayer): Surface {
		const { segments } = layer.surface;
		const bendKey = layer.bend?.source.key ?? null;
		let entry = surfaces.get(layer.id);
		if (entry && entry.segments !== segments) {
			release(layer.id);
			entry = undefined;
		}
		if (!entry) {
			const geometry = createGeometry(segments);
			const frontMaterial = createMaterial(layer.front, { back: false, mirrored: false, bend: layer.bend?.source ?? null });
			const backMaterial = createMaterial(layer.back ?? layer.front, { back: true, mirrored: layer.back !== null, bend: layer.bend?.source ?? null });
			const front = new Mesh3D({ geometry, material: frontMaterial, castShadow: false, receiveShadow: false });
			const back = new Mesh3D({ geometry, material: backMaterial, castShadow: false, receiveShadow: false });
			view.root.addChild(front, back);
			entry = { segments, bendKey, geometry, front, back, frontMaterial, backMaterial, frontTexture: layer.front, backTexture: layer.back };
			surfaces.set(layer.id, entry);
			return entry;
		}
		if (entry.bendKey !== bendKey || (entry.backTexture === null) !== (layer.back === null)) {
			release(layer.id);
			return surfaceFor(layer);
		}
		if (entry.frontTexture !== layer.front) {
			(entry.frontMaterial.textures as Record<string, Texture>).baseColor = layer.front;
			entry.frontTexture = layer.front;
			if (!layer.back) (entry.backMaterial.textures as Record<string, Texture>).baseColor = layer.front;
		}
		if (layer.back && entry.backTexture !== layer.back) {
			(entry.backMaterial.textures as Record<string, Texture>).baseColor = layer.back;
			entry.backTexture = layer.back;
		}
		return entry;
	}

	return {
		view,
		objects,
		resize(width, height) {
			const w = Math.max(1, Math.round(width));
			const h = Math.max(1, Math.round(height));
			if (w === size.width && h === size.height) return;
			size = { width: w, height: h };
			view.setSize(w, h);
			aim(w, h);
		},
		sync(layers) {
			const wanted = new Set(layers.map((layer) => layer.id));
			for (const id of [...surfaces.keys()]) if (!wanted.has(id)) release(id);
			for (const layer of layers) {
				const entry = surfaceFor(layer);
				if (layer.back) entry.backMaterial.alpha = layer.opacity;
				const { surface } = layer;
				const source = layer.bend ? surface.flat : surface.positions;
				const positions = entry.geometry.positions as Float32Array;
				for (let i = 0; i < source.length; i += 3) {
					positions[i] = source[i] as number;
					positions[i + 1] = -(source[i + 1] as number);
					positions[i + 2] = source[i + 2] as number;
				}
				const colors = entry.geometry.attributes.aColor?.buffer.data as Float32Array | undefined;
				if (colors) {
					const tones = surface.tones;
					for (let v = 0; v < tones.length; v++) {
						const tone = layer.bend ? 1 : (tones[v] as number);
						colors[v * 4] = tone;
						colors[v * 4 + 1] = tone;
						colors[v * 4 + 2] = tone;
					}
					entry.geometry.attributes.aColor?.buffer.update();
				}
				entry.geometry.attributes.aPosition?.buffer.update();
				if (layer.bend) {
					const [bx, by, bz] = surface.basis;
					const toView = (vector: readonly number[]) => [vector[0] as number, -(vector[1] as number), vector[2] as number, 0];
					for (const material of [entry.frontMaterial, entry.backMaterial]) {
						const data = material.data as Record<string, unknown>;
						data.cohubBasisX = toView(bx);
						data.cohubBasisY = toView(by);
						data.cohubBasisZ = toView(bz);
						data.cohubBend = [layer.bend.width, layer.bend.height, layer.bend.amount, layer.bend.phase];
						data.cohubLight = [...LIGHT, layer.bend.shade];
					}
				}
			}
		},
		get empty() {
			return surfaces.size === 0 && objects.empty;
		},
		destroy() {
			for (const id of [...surfaces.keys()]) release(id);
			objects.destroy();
			view.destroy({ children: true });
		},
	};
}
