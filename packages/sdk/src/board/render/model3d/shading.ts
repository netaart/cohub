import { type BaseMaterial3D, FlatMaterial, Geometry3D, getAttributeData, Material3D, Mesh3D, type ShaderBit, type View3D } from "@pixi/3d";
import type { Texture } from "pixi.js";
import { type LoadedModel, NEUTRAL } from "./load.js";
import type { ModelShading } from "./view.js";

export type ModelShader = {
	shading: ModelShading;
	wireframe: boolean;
	destroy(): void;
};

const WIRE_COLOR = 0x14161a;

const normalsBit: ShaderBit = {
	name: "cohubModelNormals",
	gpu: { fragment: { material: "{ let n = normalize(select(-input.vNormal, input.vNormal, input.frontFacing)); albedo = decodeColor(n * 0.5 + vec3<f32>(0.5)); }" } },
	gl: { fragment: { material: "{ vec3 n = normalize(gl_FrontFacing ? vNormal : -vNormal); albedo = decodeColor(n * 0.5 + vec3(0.5)); }" } },
};

// Pulls lines a hair towards the camera so they win the depth test.
const wireBit: ShaderBit = {
	name: "cohubModelWire",
	gpu: { vertex: { afterTransform: "{ clipPosition.z -= 0.0004 * clipPosition.w; }" } },
	gl: { vertex: { afterTransform: "{ gl_Position.z -= 0.0004 * gl_Position.w; }" } },
};

type Part = { mesh: Mesh3D; material: BaseMaterial3D; wire?: Mesh3D | null };

function edgeIndices(indices: ArrayLike<number>, vertexCount: number): Uint16Array | Uint32Array {
	const triangles = Math.floor(indices.length / 3);
	const edges = vertexCount <= 0xffff ? new Uint16Array(triangles * 6) : new Uint32Array(triangles * 6);
	for (let i = 0, at = 0; i < triangles * 3; i += 3, at += 6) {
		const a = indices[i] as number;
		const b = indices[i + 1] as number;
		const c = indices[i + 2] as number;
		edges[at] = a;
		edges[at + 1] = edges[at + 2] = b;
		edges[at + 3] = edges[at + 4] = c;
		edges[at + 5] = a;
	}
	return edges;
}

// Reads @pixi/3d 0.1 private fields: morph deltas move into the renderer store.
function morphTargets(source: Geometry3D): { positions: Float32Array }[] | undefined {
	if (source._morphTargets) return source._morphTargets;
	const store = source._morphStore;
	const count = source.morphTargetCount;
	const vertices = source.vertexCount;
	if (!store || !count || source._morphDeltaBase < 0) return undefined;
	const stride = source._morphDeltaFloats / (vertices * count);
	const targets = Array.from({ length: count }, () => ({ positions: new Float32Array(vertices * 3) }));
	for (let vertex = 0; vertex < vertices; vertex += 1)
		for (let target = 0; target < count; target += 1) {
			const from = source._morphDeltaBase + (vertex * count + target) * stride;
			(targets[target] as { positions: Float32Array }).positions.set(store.data.subarray(from, from + 3), vertex * 3);
		}
	return targets;
}

function wireGeometry(source: Geometry3D): Geometry3D {
	const skinned = source.getAttribute("aJoints") && source.getAttribute("aWeights");
	const vertexCount = source.vertexCount;
	const indices = source.indices.length ? source.indices : Uint32Array.from({ length: vertexCount }, (_, index) => index);
	return new Geometry3D({
		positions: getAttributeData(source, "aPosition", 3),
		joints: skinned ? Uint16Array.from(getAttributeData(source, "aJoints", 4)) : undefined,
		weights: skinned ? getAttributeData(source, "aWeights", 4) : undefined,
		morphTargets: morphTargets(source),
		indices: edgeIndices(indices, vertexCount),
		topology: "line-list",
	});
}

export function createModelShader(model: LoadedModel, view: View3D): ModelShader {
	const parts: Part[] = [];
	model.root.traverse((node) => {
		if (node instanceof Mesh3D && node.geometry.topology === "triangle-list") parts.push({ mesh: node, material: node.material });
	});
	const lit = { toneMapping: view.toneMapping, exposure: view.exposure };
	const derived = new Map<string, BaseMaterial3D>();
	let wireMaterial: FlatMaterial | null = null;
	let shading: ModelShading = "standard";
	let wireframe = false;

	function derive(mode: Exclude<ModelShading, "standard">, source: BaseMaterial3D): BaseMaterial3D {
		const key = mode === "color" ? `color:${source.uid}` : `${mode}:${source.doubleSided}`;
		let material = derived.get(key);
		if (material) return material;
		const doubleSided = source.doubleSided;
		if (mode === "clay") material = new Material3D({ ...NEUTRAL, doubleSided });
		else if (mode === "normals") material = new FlatMaterial({ doubleSided, extraBits: [normalsBit] });
		else
			material = new FlatMaterial({
				doubleSided,
				baseColor: source.baseColor,
				alpha: source.alpha,
				alphaMode: source.alphaMode,
				alphaCutoff: source.alphaCutoff,
				baseColorTexture: (source.textures as Record<string, Texture | undefined>).baseColor,
				uvTransform: source.uvTransform,
				vertexColors: source.vertexColors,
			});
		derived.set(key, material);
		return material;
	}

	function wireOf(part: Part): Mesh3D | null {
		if (part.wire !== undefined) return part.wire;
		try {
			wireMaterial ??= new FlatMaterial({ baseColor: WIRE_COLOR, extraBits: [wireBit] });
			part.wire = new Mesh3D({ geometry: wireGeometry(part.mesh.geometry), material: wireMaterial, skeleton: part.mesh.skeleton, weights: part.mesh.weights, castShadow: false });
			part.wire.visible = false;
			part.mesh.addChild(part.wire);
		} catch {
			part.wire = null;
		}
		return part.wire;
	}

	return {
		get shading() {
			return shading;
		},
		set shading(mode) {
			if (mode === shading) return;
			shading = mode;
			for (const part of parts) part.mesh.material = mode === "standard" ? part.material : derive(mode, part.material);
			const flat = mode === "color" || mode === "normals";
			view.toneMapping = flat ? "none" : lit.toneMapping;
			view.exposure = flat ? 1 : lit.exposure;
		},
		get wireframe() {
			return wireframe;
		},
		set wireframe(value) {
			if (value === wireframe) return;
			wireframe = value;
			for (const part of parts) {
				const wire = value ? wireOf(part) : part.wire;
				if (wire) wire.visible = value;
			}
		},
		destroy() {
			for (const part of parts) {
				part.mesh.material = part.material;
				if (!part.wire) continue;
				part.wire.removeFromParent();
				part.wire.geometry.destroy(true);
				part.wire.destroy();
			}
			for (const material of derived.values()) material.destroy();
			wireMaterial?.destroy();
			Object.assign(view, lit);
		},
	};
}
