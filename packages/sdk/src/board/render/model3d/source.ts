import { parseBoardMediaSource } from "@cohub/protocol/board-model";
import { type ModelFormat, resolveModelReference } from "@cohub/protocol/fs";
import type { BoardAssetSource } from "../../model/media-playback.js";

export type ModelLoadOptions = {
	signal: AbortSignal;
	maxBytes?: number;
	onProgress?: (fraction: number) => void;
};

export type ModelReferenceResolver = (reference: string, signal: AbortSignal) => Promise<string | null>;

export type ModelSource = {
	key: string;
	name: string;
	format: ModelFormat;
	size: number | null;
	read: (options: ModelLoadOptions) => Promise<Uint8Array>;
	references: ModelReferenceResolver;
};

export type ModelDecoders = {
	draco?: { jsUrl: string; wasmUrl: string };
};

export const modelDecoders: ModelDecoders = {};

export function setModelDecoders(decoders: ModelDecoders) {
	Object.assign(modelDecoders, decoders);
}

export class ModelTooLargeError extends Error {
	override name = "ModelTooLargeError";
	constructor() {
		super("Model is larger than the preview limit");
	}
}

export function ensureModelWithin(size: number, maxBytes: number | undefined) {
	if (maxBytes !== undefined && size > maxBytes) throw new ModelTooLargeError();
}

export async function fetchModelBytes(
	url: string,
	{
		signal,
		maxBytes,
		onProgress,
		expectedSize,
		consumeBytes,
	}: ModelLoadOptions & { expectedSize?: number | null; consumeBytes?: (size: number) => void },
): Promise<Uint8Array<ArrayBuffer>> {
	const response = await fetch(url, { signal });
	if (!response.ok) throw new Error(`Model download failed (${response.status})`);
	const total = expectedSize || Number(response.headers.get("content-length")) || 0;
	try {
		ensureModelWithin(total, maxBytes);
	} catch (error) {
		await response.body?.cancel().catch(() => {});
		throw error;
	}
	if (!response.body) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		ensureModelWithin(bytes.byteLength, maxBytes);
		consumeBytes?.(bytes.byteLength);
		return bytes;
	}
	const reader = response.body.getReader();
	let buffer = new Uint8Array(Math.min(total || 1024 * 1024, 1024 * 1024));
	let loaded = 0;
	let reported = -1;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const next = loaded + value.byteLength;
			ensureModelWithin(next, maxBytes);
			consumeBytes?.(value.byteLength);
			if (next > buffer.byteLength) {
				const grown = new Uint8Array(Math.max(buffer.byteLength * 2, next));
				grown.set(buffer.subarray(0, loaded));
				buffer = grown;
			}
			buffer.set(value, loaded);
			loaded = next;
			if (!onProgress || !total) continue;
			const percent = Math.min(100, Math.floor((loaded / total) * 100));
			if (percent !== reported) {
				reported = percent;
				onProgress(percent / 100);
			}
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	}
	return loaded === buffer.byteLength ? buffer : buffer.slice(0, loaded);
}

export function spaceModelReferences(path: string, resolvePath: (path: string, signal: AbortSignal) => Promise<string | null>): ModelReferenceResolver {
	return async (reference, signal) => {
		const target = resolveModelReference(path, reference);
		return target ? resolvePath(target, signal) : null;
	};
}

export function urlModelReferences(baseUrl: string): ModelReferenceResolver {
	return async (reference) => {
		try {
			const url = new URL(reference, baseUrl);
			return /^https?:$/.test(url.protocol) ? url.href : null;
		} catch {
			return null;
		}
	};
}

export type BoardModelRequest = {
	key: string;
	src: string;
	format: ModelFormat;
	size?: number;
	name?: string;
};

export function boardModelSource(request: BoardModelRequest, assets: BoardAssetSource): ModelSource | null {
	const source = parseBoardMediaSource(request.src);
	if (!source) return null;
	const resolvePath = async (path: string) => (await assets.resolveFile(path))?.url ?? null;
	const url = source.kind === "url" ? async () => source.value : () => resolvePath(source.value);
	return {
		key: request.key,
		name: request.name ?? request.src,
		format: request.format,
		size: request.size ?? null,
		async read(options) {
			const resolved = await url();
			if (!resolved) throw new Error("Model is unavailable");
			return fetchModelBytes(resolved, { ...options, expectedSize: request.size });
		},
		references: source.kind === "url" ? urlModelReferences(source.value) : spaceModelReferences(source.value, resolvePath),
	};
}
