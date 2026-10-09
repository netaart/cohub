import { variantSource } from "@neta-art/cohub/media";
import { Assets, Texture } from "pixi.js";
import { loadVideoThumbnailTexture } from "$lib/board/board-video-thumbnail";

export type BoardImageTexturePool = {
	acquire: (url: string) => Promise<Texture | null>;
	release: (url: string) => Promise<void>;
};

type Entry = {
	refs: number;
	texture: Texture | null;
	loading: Promise<Texture | null> | null;
	unloading: Promise<void> | null;
};

/** Load an image in the page's CORS context when Pixi's worker path fails. */
function loadImageElementTexture(url: string): Promise<Texture> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.crossOrigin = "anonymous";
		image.onload = () => {
			try {
				resolve(Texture.from(image));
			} catch (error) {
				reject(error);
			}
		};
		image.onerror = () =>
			reject(new Error(`Failed to load board image: ${url}`));
		image.src = url;
	});
}

/**
 * Bypass the HTTP cache: an `<img>` that fetched this URL without CORS leaves
 * an entry lacking CORS headers, and every CORS load of it then fails.
 */
async function loadUncachedTexture(url: string): Promise<Texture> {
	const response = await fetch(url, { cache: "no-store" });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return Texture.from(await createImageBitmap(await response.blob()));
}

/**
 * Keep Pixi's worker/ImageBitmap fast path, but recover through an anonymous
 * image element when that browser context rejects a cross-origin cover, then
 * through an uncached fetch when the cached copy is not CORS-readable.
 */
async function loadImageTexture(url: string): Promise<Texture> {
	try {
		// CDN stills keep their source's extension (`clip.mp4?x-oss-process=…`),
		// which would pick Pixi's video parser; they are always images.
		const asset = /[?&]x-oss-process=/.test(url)
			? { src: url, parser: "texture" }
			: url;
		return await Assets.load<Texture>(asset);
	} catch (workerError) {
		const errors: unknown[] = [workerError];
		for (const load of [loadImageElementTexture, loadUncachedTexture]) {
			try {
				return await load(url);
			} catch (error) {
				errors.push(error);
			}
		}
		throw new AggregateError(errors, `Failed to load board image: ${url}`);
	}
}

/** A CDN variant that fails to process falls back to the media it came from. */
export async function loadBoardImageTexture(url: string): Promise<Texture> {
	try {
		return await loadImageTexture(url);
	} catch (error) {
		const source = variantSource(url);
		if (!source) throw error;
		return source.type === "video"
			? loadVideoThumbnailTexture(source.url)
			: loadImageTexture(source.url);
	}
}

export async function unloadBoardImageTexture(
	url: string,
	texture: Texture | null,
) {
	await Assets.unload(url).catch(() => {});
	if (!texture?.destroyed) texture?.destroy(true);
}

/**
 * Share image textures by resolved URL without sharing Board ownership.
 *
 * Pixi's Assets cache is global, but its unload operation is not reference
 * counted. The pool adds that missing application-level ownership layer:
 * multiple Board managers share one load and texture, while the last release
 * is the only one allowed to unload it.
 */
export function createBoardImageTexturePool(options?: {
	loadTexture?: (url: string) => Promise<Texture | null>;
	unloadTexture?: (url: string, texture: Texture | null) => Promise<void>;
}): BoardImageTexturePool {
	const load = options?.loadTexture ?? loadBoardImageTexture;
	const unload = options?.unloadTexture ?? unloadBoardImageTexture;
	const entries = new Map<string, Entry>();

	function removeIfIdle(url: string, entry: Entry) {
		if (
			entry.refs === 0 &&
			entry.loading === null &&
			entry.unloading === null &&
			entry.texture === null &&
			entries.get(url) === entry
		) {
			entries.delete(url);
		}
	}

	function releaseFailedAcquire(url: string, entry: Entry) {
		entry.refs = Math.max(0, entry.refs - 1);
		removeIfIdle(url, entry);
	}

	function unloadIfIdle(url: string, entry: Entry): Promise<void> {
		if (entry.refs > 0 || entry.loading || entry.unloading || !entry.texture)
			return entry.unloading ?? Promise.resolve();

		const texture = entry.texture;
		entry.texture = null;
		const unloading = Promise.resolve()
			.then(() => unload(url, texture))
			.catch(() => {});
		entry.unloading = unloading;
		void unloading.finally(() => {
			if (entry.unloading === unloading) entry.unloading = null;
			removeIfIdle(url, entry);
		});
		return unloading;
	}

	async function acquire(url: string): Promise<Texture | null> {
		let entry = entries.get(url);
		if (!entry) {
			entry = {
				refs: 0,
				texture: null,
				loading: null,
				unloading: null,
			};
			entries.set(url, entry);
		}
		entry.refs += 1;

		if (entry.unloading) await entry.unloading;
		if (entry.texture) return entry.texture;

		if (!entry.loading) {
			const current = entry;
			entry.loading = Promise.resolve()
				.then(() => load(url))
				.then(
					(texture) => {
						current.loading = null;
						current.texture = texture;
						if (!texture) removeIfIdle(url, current);
						else void unloadIfIdle(url, current);
						return texture;
					},
					(error) => {
						current.loading = null;
						removeIfIdle(url, current);
						throw error;
					},
				);
		}

		try {
			const texture = await entry.loading;
			if (!texture) releaseFailedAcquire(url, entry);
			return texture;
		} catch (error) {
			releaseFailedAcquire(url, entry);
			throw error;
		}
	}

	async function release(url: string): Promise<void> {
		const entry = entries.get(url);
		if (!entry || entry.refs <= 0) return;
		entry.refs -= 1;
		if (entry.refs > 0) return;
		if (entry.loading) {
			try {
				await entry.loading;
			} catch {
				return;
			}
		}
		if (entry.refs === 0) await unloadIfIdle(url, entry);
		else removeIfIdle(url, entry);
	}

	return { acquire, release };
}

export const boardImageTexturePool = createBoardImageTexturePool();
