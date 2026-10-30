import { type ModelFormat, resolveModelReference } from "@cohub/protocol/fs";
import type { SpaceFsFileResponse } from "@neta-art/cohub";

export type ModelLoadOptions = {
	signal: AbortSignal;
	maxBytes?: number;
	onProgress?: (fraction: number) => void;
};

export type ResolveReference = (
	reference: string,
	relativeTo?: string,
) => Promise<string | null>;

/** Kept free of three so SSR can build it; `loadModelSource` loads it on the client. */
export type ModelSource = {
	key: string;
	name: string;
	format: ModelFormat;
	size: number | null;
	read: (options: ModelLoadOptions) => Promise<Uint8Array>;
	references: (signal: AbortSignal) => ResolveReference;
};

export class ModelTooLargeError extends Error {
	override name = "ModelTooLargeError";
	constructor() {
		super("Model is larger than the preview limit");
	}
}

export function ensureWithin(size: number, maxBytes: number | undefined) {
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
	}: ModelLoadOptions & {
		expectedSize?: number | null;
		consumeBytes?: (size: number) => void;
	},
): Promise<Uint8Array<ArrayBuffer>> {
	const response = await fetch(url, { signal });
	if (!response.ok) {
		throw new Error(`Model download failed (${response.status})`);
	}
	const total =
		expectedSize || Number(response.headers.get("content-length")) || 0;
	try {
		ensureWithin(total, maxBytes);
	} catch (error) {
		await response.body?.cancel().catch(() => {});
		throw error;
	}
	if (!response.body) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		ensureWithin(bytes.byteLength, maxBytes);
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
			ensureWithin(next, maxBytes);
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

function decodeBase64(value: string): Uint8Array {
	const native = (Uint8Array as { fromBase64?: (value: string) => Uint8Array })
		.fromBase64;
	if (native) return native(value);
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

export function readFileModelBytes(
	file: SpaceFsFileResponse,
	options: ModelLoadOptions,
): Promise<Uint8Array> {
	if (file.delivery === "url") {
		if (!file.url) return Promise.reject(new Error("Model URL is missing"));
		return fetchModelBytes(file.url, { ...options, expectedSize: file.size });
	}
	return Promise.resolve(
		file.encoding === "base64"
			? decodeBase64(file.content)
			: new TextEncoder().encode(file.content),
	);
}

export function workspaceReferences(
	basePath: string,
	resolvePath: (path: string) => Promise<string | null>,
): ResolveReference {
	return async (reference, relativeTo) => {
		const context = relativeTo
			? resolveModelReference(basePath, relativeTo)
			: basePath;
		if (!context) return null;
		const path = resolveModelReference(context, reference);
		return path ? resolvePath(path) : null;
	};
}

export function remoteReferences(baseUrl: string): ResolveReference {
	return async (reference, relativeTo) => {
		try {
			const url = new URL(reference, new URL(relativeTo ?? "", baseUrl));
			return /^https?:$/.test(url.protocol) ? url.href : null;
		} catch {
			return null;
		}
	};
}
