import {
	type AnimationPlayer,
	Container3D,
	Geometry3D,
	type GltfFormat,
	getAttributeData,
	glbToGltf,
	loadImages,
	Material3D,
	Mesh3D,
	Model3D,
	normalizeMeshopt,
	parseGltf,
	type Scene3DSource,
	setDracoDecoderPath,
} from "@pixi/3d";
import { BufferImageSource, ImageSource, Texture } from "pixi.js";
import { BOARD_MODEL_CLIP_LIMIT } from "@cohub/protocol/board-model";
import { type BoardModelClip, boardModelNodes } from "../../model/model-clips.js";
import { ensureModelWithin, fetchModelBytes, type ModelLoadOptions, type ModelSource, modelDecoders } from "./source.js";
import type { ModelStats } from "./view.js";

export type LoadedModel = {
	root: Container3D;
	player: AnimationPlayer | null;
	clips: BoardModelClip[];
	nodes: string[];
	stats: ModelStats;
	destroy(): void;
};

export type ModelAsset = {
	create(): LoadedModel;
	destroy(): void;
};

export const NEUTRAL = { baseColor: 0x9aa0a8, roughness: 0.62, metallic: 0.04 };

function measure(root: Container3D, counts: Pick<ModelStats, "materials" | "textures" | "clips" | "unit">): ModelStats {
	let triangles = 0;
	let vertices = 0;
	root.traverse((node) => {
		if (!(node instanceof Mesh3D)) return;
		const { geometry } = node;
		const drawn = geometry.indices.length || geometry.vertexCount;
		if (geometry.topology === "triangle-list") triangles += Math.floor(drawn / 3);
		else if (geometry.topology === "triangle-strip") triangles += Math.max(0, drawn - 2);
		vertices += geometry.vertexCount;
	});
	const bounds = root.getLocalBounds();
	const size: ModelStats["size"] = bounds.isEmpty() ? [0, 0, 0] : [bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z];
	return { triangles, vertices, size, ...counts };
}

type Fetch = (reference: string) => Promise<Uint8Array<ArrayBuffer>>;

const embedded = (uri: string) => /^(data|blob):/i.test(uri);

function blankTexture() {
	return new Texture({ source: new BufferImageSource({ resource: new Uint8Array([255, 255, 255, 255]), width: 1, height: 1 }) });
}

async function decodeTexture(bytes: Uint8Array<ArrayBuffer>) {
	const bitmap = await createImageBitmap(new Blob([bytes]));
	return new Texture({ source: new ImageSource({ resource: bitmap, alphaMode: "premultiply-alpha-on-upload", resolution: 1 }) });
}

function faceNormals(positions: Float32Array): Float32Array {
	const normals = new Float32Array(positions.length);
	const at = (index: number) => positions[index] as number;
	for (let i = 0; i + 9 <= positions.length; i += 9) {
		const ax = at(i + 3) - at(i);
		const ay = at(i + 4) - at(i + 1);
		const az = at(i + 5) - at(i + 2);
		const bx = at(i + 6) - at(i);
		const by = at(i + 7) - at(i + 1);
		const bz = at(i + 8) - at(i + 2);
		const nx = ay * bz - az * by;
		const ny = az * bx - ax * bz;
		const nz = ax * by - ay * bx;
		const length = Math.hypot(nx, ny, nz) || 1;
		for (let v = i; v < i + 9; v += 3) {
			normals[v] = nx / length;
			normals[v + 1] = ny / length;
			normals[v + 2] = nz / length;
		}
	}
	return normals;
}

function withFaceNormals(geometry: Geometry3D): Geometry3D {
	const indices = geometry.indices;
	const count = indices.length - (indices.length % 3);
	const expand = (name: string, size: number) => {
		if (!geometry.getAttribute(name)) return undefined;
		const data = getAttributeData(geometry, name, size);
		const out = new Float32Array(count * size);
		for (let i = 0; i < count; i += 1) {
			const vertex = (indices[i] ?? 0) * size;
			out.set(data.subarray(vertex, vertex + size), i * size);
		}
		return out;
	};
	const positions = expand("aPosition", 3) as Float32Array;
	const joints = expand("aJoints", 4);
	return new Geometry3D({
		positions,
		normals: faceNormals(positions),
		uvs: expand("aUV", 2),
		colors: expand("aColor", 4),
		...(joints ? { joints: Uint16Array.from(joints), weights: expand("aWeights", 4) } : {}),
	});
}

function repairNormals(source: Scene3DSource) {
	for (const primitives of source.geometries) {
		primitives?.forEach((geometry, index) => {
			if (!geometry || geometry.getAttribute("aNormal") || geometry.morphTargetCount > 0) return;
			primitives[index] = withFaceNormals(geometry);
			geometry.destroy(true);
		});
	}
}

function neutralDefaults(source: Scene3DSource, json: GltfFormat): ((model: Model3D) => void) & { materials: Material3D[] } {
	const fallback = source.materials[json.materials?.length ?? 0];
	const plain = fallback && new Material3D(NEUTRAL);
	const painted = fallback && new Material3D({ ...NEUTRAL, baseColor: 0xffffff, vertexColors: true });
	const apply = (model: Model3D) => {
		if (!plain || !painted) return;
		model.traverse((node) => {
			if (node instanceof Mesh3D && node.material === fallback) node.material = node.geometry.getAttribute("aColor") ? painted : plain;
		});
	};
	return Object.assign(apply, { materials: plain && painted ? [plain, painted] : [] });
}

async function parseGltfModel(bytes: Uint8Array<ArrayBuffer>, binary: boolean, resolve: Fetch): Promise<ModelAsset> {
	let json: GltfFormat;
	let buffers: ArrayBuffer[];
	if (binary) {
		({ json, buffers } = glbToGltf(bytes.buffer));
	} else {
		json = JSON.parse(new TextDecoder().decode(bytes)) as GltfFormat;
		buffers = [];
	}
	if (json.extensionsUsed?.includes("KHR_draco_mesh_compression") && modelDecoders.draco) setDracoDecoderPath(modelDecoders.draco);
	const declared = json.buffers ?? [];
	await Promise.all(
		declared.map(async (buffer, index) => {
			if (buffers[index]) return;
			const uri = buffer.uri;
			const meshoptFallback = buffer.extensions?.EXT_meshopt_compression?.fallback || buffer.extensions?.KHR_meshopt_compression?.fallback;
			if (uri) {
				const data = await resolve(uri);
				buffers[index] = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
			} else if (meshoptFallback) buffers[index] = new ArrayBuffer(0);
			else throw new Error(`glTF buffer ${index} has no data`);
		}),
	);
	await normalizeMeshopt(json, buffers);
	const loader = {
		parsers: [],
		load: ({ src }: { src: string }) => resolve(src).then(decodeTexture).catch(blankTexture),
		unload: async () => {},
	};
	const images = await loadImages(json, "", Promise.resolve(buffers), loader as unknown as Parameters<typeof loadImages>[3]);
	const source = await parseGltf(json, buffers, images.textures);
	repairNormals(source);
	const neutral = neutralDefaults(source, json);
	const build = () => {
		const model = new Model3D({ source, autoUpdate: false });
		neutral(model);
		return model;
	};
	const probe = build();
	const labels = probe.player?.animationLabels ?? [];
	const clips = labels.slice(0, BOARD_MODEL_CLIP_LIMIT).map((name) => ({ name: name.slice(0, 240), durationMs: Math.round((probe.player?.getAnimation(name)?.duration ?? 0) * 1000) }));
	const nodes = boardModelNodes((json.nodes ?? []).map((node) => node.name));
	const stats = measure(probe, { materials: json.materials?.length ?? 0, textures: json.images?.length ?? 0, clips: labels.length, unit: "m" });
	probe.destroy({ children: true });
	return {
		create() {
			const model = build();
			if (labels[0]) model.player?.getState(labels[0]).gotoAndStop(0);
			return {
				root: model,
				player: labels.length ? (model.player ?? null) : null,
				clips,
				nodes,
				stats,
				destroy: () => model.destroy({ children: true }),
			};
		},
		destroy() {
			for (const material of [...neutral.materials, ...source.materials]) material?.destroy();
			source.destroy();
		},
	};
}

function stlTriangles(bytes: Uint8Array<ArrayBuffer>): Float32Array {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const count = bytes.byteLength >= 84 ? view.getUint32(80, true) : -1;
	const binary = count > 0 && 84 + count * 50 <= bytes.byteLength;
	if (binary && (84 + count * 50 === bytes.byteLength || !/^\s*solid\b/.test(new TextDecoder().decode(bytes.subarray(0, 80))))) {
		const positions = new Float32Array(count * 9);
		for (let face = 0; face < count; face += 1) {
			const offset = 84 + face * 50 + 12;
			for (let i = 0; i < 9; i += 1) positions[face * 9 + i] = view.getFloat32(offset + i * 4, true);
		}
		return positions;
	}
	const text = new TextDecoder().decode(bytes);
	const values: number[] = [];
	for (const match of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) values.push(Number(match[1]), Number(match[2]), Number(match[3]));
	if (values.length < 9 || values.some((value) => !Number.isFinite(value))) throw new Error("Not an STL file");
	return new Float32Array(values.slice(0, values.length - (values.length % 9)));
}

function parseStl(bytes: Uint8Array<ArrayBuffer>): ModelAsset {
	const positions = stlTriangles(bytes);
	const geometry = new Geometry3D({ positions, normals: faceNormals(positions) });
	const material = new Material3D(NEUTRAL);
	const build = () => {
		const root = new Container3D();
		root.addChild(new Mesh3D({ geometry, material, rotation: { x: -Math.PI / 2, y: 0, z: 0 } }));
		return root;
	};
	const probe = build();
	const stats = measure(probe, { materials: 0, textures: 0, clips: 0, unit: null });
	probe.destroy({ children: true });
	return {
		create() {
			const root = build();
			return { root, player: null, clips: [], nodes: [], stats, destroy: () => root.destroy({ children: true }) };
		},
		destroy() {
			geometry.destroy(true);
			material.destroy();
		},
	};
}

export async function loadModel(source: ModelSource, options: ModelLoadOptions): Promise<LoadedModel> {
	const asset = await loadModelAsset(source, options);
	const model = asset.create();
	return {
		...model,
		destroy() {
			model.destroy();
			asset.destroy();
		},
	};
}

export async function loadModelAsset(source: ModelSource, options: ModelLoadOptions): Promise<ModelAsset> {
	options.signal.throwIfAborted();
	if (source.size !== null) ensureModelWithin(source.size, options.maxBytes);
	const controller = new AbortController();
	const signal = AbortSignal.any([options.signal, controller.signal]);
	let total = 0;
	const consumeBytes = (bytes: number) => {
		total += bytes;
		try {
			ensureModelWithin(total, options.maxBytes);
		} catch (error) {
			controller.abort(error);
			throw error;
		}
	};
	const fetched = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
	const resolve: Fetch = (reference) => {
		let pending = fetched.get(reference);
		if (!pending) {
			pending = (async () => {
				// Embedded data is part of the file already counted.
				if (embedded(reference)) return fetchModelBytes(reference, { signal });
				const url = await source.references(reference, signal);
				if (!url) throw new Error(`Missing ${reference}`);
				return fetchModelBytes(url, { signal, maxBytes: options.maxBytes, consumeBytes });
			})();
			fetched.set(reference, pending);
		}
		return pending;
	};
	try {
		const bytes = await source.read({ ...options, signal });
		consumeBytes(bytes.byteLength);
		const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
		const asset = source.format === "stl" ? parseStl(buffer) : await parseGltfModel(buffer, source.format === "glb", resolve);
		if (signal.aborted) {
			asset.destroy();
			signal.throwIfAborted();
		}
		return asset;
	} finally {
		controller.abort();
	}
}
