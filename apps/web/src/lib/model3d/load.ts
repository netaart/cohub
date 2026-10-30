import {
	type GltfJson,
	gltfReferences,
	type ModelFormat,
	objMaterialLibraries,
	readGlbJson,
} from "@cohub/protocol/fs";
import {
	type AnimationClip,
	LoadingManager,
	type Material,
	Mesh,
	MeshPhongMaterial,
	MeshStandardMaterial,
	type Object3D,
} from "three";
import type { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
	ensureWithin,
	fetchModelBytes,
	type ModelLoadOptions,
	type ModelSource,
	type ResolveReference,
} from "./source";
import { disposeModel, materialsOf } from "./studio";

export type LoadedModel = {
	root: Object3D;
	animations: AnimationClip[];
	missing: string[];
};

type LoadInput = {
	format: ModelFormat;
	bytes: Uint8Array;
	resolveReference: ResolveReference;
};

type References = { resolved: Map<string, string>; missing: Set<string> };

async function resolveReferences(
	references: readonly string[],
	resolveReference: ResolveReference,
): Promise<References> {
	const resolved = new Map<string, string>();
	const missing = new Set<string>();
	await Promise.all(
		references.map(async (reference) => {
			const url = await resolveReference(reference).catch(() => null);
			if (url) resolved.set(reference, url);
			else missing.add(reference);
		}),
	);
	return { resolved, missing };
}

function guardedManager({ resolved, missing }: References) {
	const references = new Map([...resolved].map(([key, url]) => [url, key]));
	const manager = new LoadingManager();
	manager.setURLModifier((url) => {
		if (/^(data|blob):/i.test(url)) return url;
		const target = resolved.get(url);
		if (target) return target;
		missing.add(url);
		return "data:,";
	});
	manager.onError = (url) => {
		const reference = references.get(url);
		if (reference) missing.add(reference);
	};
	return manager;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const { buffer, byteOffset, byteLength } = bytes;
	return byteOffset === 0 && byteLength === buffer.byteLength
		? (buffer as ArrayBuffer)
		: (buffer.slice(byteOffset, byteOffset + byteLength) as ArrayBuffer);
}

const NEUTRAL_MATERIAL = {
	color: 0x9aa0a8,
	roughness: 0.62,
	metalness: 0.04,
};

const neutralMaterial = () => new MeshStandardMaterial(NEUTRAL_MATERIAL);

async function configureDecoders(loader: GLTFLoader, json: GltfJson) {
	const used = new Set(json.extensionsUsed ?? []);
	let dispose = () => {};
	if (used.has("KHR_draco_mesh_compression")) {
		const { createDracoLoader } = await import("./draco");
		const draco = createDracoLoader();
		loader.setDRACOLoader(draco);
		dispose = () => draco.dispose();
	}
	if (used.has("EXT_meshopt_compression")) {
		const { MeshoptDecoder } = await import(
			"three/addons/libs/meshopt_decoder.module.js"
		);
		loader.setMeshoptDecoder(MeshoptDecoder);
	}
	return dispose;
}

async function loadGltf({
	format,
	bytes,
	resolveReference,
}: LoadInput): Promise<LoadedModel> {
	const text = format === "gltf" ? new TextDecoder().decode(bytes) : null;
	const json =
		text === null ? readGlbJson(bytes) : (JSON.parse(text) as GltfJson);
	if (!json) throw new Error("Not a binary glTF file");
	const [references, { GLTFLoader }] = await Promise.all([
		resolveReferences(gltfReferences(json), resolveReference),
		import("three/addons/loaders/GLTFLoader.js"),
	]);
	const loader = new GLTFLoader(guardedManager(references));
	const disposeDecoders = await configureDecoders(loader, json);
	try {
		const gltf = await loader.parseAsync(text ?? toArrayBuffer(bytes), "");
		for (const material of materialsOf(gltf.scene)) {
			if (
				!(material instanceof MeshStandardMaterial) ||
				gltf.parser.associations.get(material)?.materials !== undefined
			) {
				continue;
			}
			material.roughness = NEUTRAL_MATERIAL.roughness;
			material.metalness = NEUTRAL_MATERIAL.metalness;
			if (!material.vertexColors) material.color.setHex(NEUTRAL_MATERIAL.color);
		}
		return {
			root: gltf.scene,
			animations: gltf.animations,
			missing: [...references.missing],
		};
	} finally {
		disposeDecoders();
	}
}

async function loadStl({ bytes }: LoadInput): Promise<LoadedModel> {
	const { STLLoader } = await import("three/addons/loaders/STLLoader.js");
	const geometry = new STLLoader().parse(toArrayBuffer(bytes));
	const material = neutralMaterial();
	material.vertexColors = geometry.hasAttribute("color");
	const mesh = new Mesh(geometry, material);
	// STL comes from CAD and printing tools, which are Z-up.
	mesh.rotation.x = -Math.PI / 2;
	return { root: mesh, animations: [], missing: [] };
}

const MTL_TEXTURE_KEYS = new Set([
	"map_kd",
	"map_ks",
	"map_ke",
	"norm",
	"map_bump",
	"bump",
	"disp",
	"map_d",
]);

function toStandardMaterial(source: MeshPhongMaterial): MeshStandardMaterial {
	const material = new MeshStandardMaterial({
		name: source.name,
		color: source.color,
		map: source.map,
		normalMap: source.normalMap,
		bumpMap: source.bumpMap,
		alphaMap: source.alphaMap,
		emissive: source.emissive,
		emissiveMap: source.emissiveMap,
		opacity: source.opacity,
		transparent: source.transparent,
		side: source.side,
		roughness: Math.sqrt(2 / (source.shininess + 2)),
		metalness: 0,
	});
	source.dispose();
	return material;
}

async function loadMaterials(
	source: string,
	resolveReference: ResolveReference,
	missing: Set<string>,
) {
	const libraries = objMaterialLibraries(source);
	if (libraries.length === 0) return null;
	const [{ MTLLoader }, found] = await Promise.all([
		import("three/addons/loaders/MTLLoader.js"),
		resolveReferences(libraries, resolveReference),
	]);
	for (const reference of found.missing) missing.add(reference);
	const creator = new MTLLoader().parse("", "");
	const references: References = { resolved: new Map(), missing };
	const libraryMaterials = await Promise.all(
		[...found.resolved].map(async ([library, url]) => {
			try {
				const response = await fetch(url);
				if (!response.ok)
					throw new Error(`Material download failed (${response.status})`);
				const parsed = new MTLLoader().parse(await response.text(), "");
				await Promise.all(
					Object.values(parsed.materialsInfo).flatMap((info) =>
						Object.entries(info)
							.filter(([key]) => MTL_TEXTURE_KEYS.has(key))
							.map(async ([key, value]) => {
								const normalized = String(value).trim().replace(/\s+/g, " ");
								const texture = parsed.getTextureParams(normalized, {}).url;
								const target = await resolveReference(texture, library).catch(
									() => null,
								);
								if (target) references.resolved.set(target, target);
								else missing.add(`${library}: ${texture}`);
								// Resolve before merging so each MTL keeps its own directory.
								Object.assign(info, {
									[key]:
										normalized.slice(0, -texture.length) + (target ?? "data:,"),
								});
							}),
					),
				);
				return parsed.materialsInfo;
			} catch {
				missing.add(library);
				return {};
			}
		}),
	);
	creator.setMaterials(Object.assign({}, ...libraryMaterials));

	const manager = guardedManager(references);
	let started = false;
	const settled = new Promise<void>((resolve) => {
		manager.onStart = () => {
			started = true;
		};
		manager.onLoad = resolve;
	});
	creator.setManager(manager);
	creator.preload();
	if (started) await settled;
	for (const reference of references.missing) missing.add(reference);
	return creator;
}

async function loadObj({
	bytes,
	resolveReference,
}: LoadInput): Promise<LoadedModel> {
	const source = new TextDecoder().decode(bytes);
	const missing = new Set<string>();
	const [{ OBJLoader }, materials] = await Promise.all([
		import("three/addons/loaders/OBJLoader.js"),
		loadMaterials(source, resolveReference, missing),
	]);
	const loader = new OBJLoader();
	if (materials) loader.setMaterials(materials);
	const root = loader.parse(source);
	const fallback = materials ? null : neutralMaterial();
	const converted = new Map<Material, Material>();
	const convert = (material: Material) => {
		if (fallback) {
			material.dispose();
			return fallback;
		}
		if (!(material instanceof MeshPhongMaterial)) return material;
		let next = converted.get(material);
		if (!next) {
			next = toStandardMaterial(material);
			converted.set(material, next);
		}
		return next;
	};
	root.traverse((object) => {
		if (!(object instanceof Mesh)) return;
		object.material = Array.isArray(object.material)
			? object.material.map(convert)
			: convert(object.material);
	});
	return { root, animations: [], missing: [...missing] };
}

const LOADERS: Record<ModelFormat, (input: LoadInput) => Promise<LoadedModel>> =
	{ glb: loadGltf, gltf: loadGltf, stl: loadStl, obj: loadObj };

export function loadModel(input: LoadInput): Promise<LoadedModel> {
	return LOADERS[input.format](input);
}

export async function loadModelSource(
	{ format, size, read, references }: ModelSource,
	options: ModelLoadOptions,
): Promise<LoadedModel> {
	options.signal.throwIfAborted();
	if (size !== null) ensureWithin(size, options.maxBytes);
	const controller = new AbortController();
	const signal = AbortSignal.any([options.signal, controller.signal]);
	const urls: string[] = [];
	let totalBytes = 0;
	const consumeBytes = (bytes: number) => {
		totalBytes += bytes;
		try {
			ensureWithin(totalBytes, options.maxBytes);
		} catch (error) {
			controller.abort(error);
			throw error;
		}
	};
	const resolveReference = references(signal);
	const resources = new Map<string, Promise<string>>();
	const load = async () => {
		const bytes = await read({ ...options, signal });
		signal.throwIfAborted();
		consumeBytes(bytes.byteLength);
		const model = await loadModel({
			format,
			bytes,
			resolveReference: async (reference, relativeTo) => {
				signal.throwIfAborted();
				const url = await resolveReference(reference, relativeTo);
				if (!url) return null;
				let resource = resources.get(url);
				if (!resource) {
					resource = fetchModelBytes(url, {
						signal,
						maxBytes: options.maxBytes,
						consumeBytes,
					}).then((data) => {
						signal.throwIfAborted();
						const local = URL.createObjectURL(new Blob([data]));
						urls.push(local);
						return local;
					});
					resources.set(url, resource);
				}
				return resource;
			},
		});
		if (signal.aborted) {
			disposeModel(model.root);
			signal.throwIfAborted();
		}
		return model;
	};
	let onAbort = () => {};
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([load(), aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
		controller.abort();
		for (const url of urls) URL.revokeObjectURL(url);
	}
}
