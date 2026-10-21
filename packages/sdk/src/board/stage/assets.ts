import {
	type BoardAssetUrlOptions,
	type BoardSceneItem,
	type BoardTaskArtifact,
	boardImageKeySource,
	featuredTaskArtifact,
	imageAssetKey,
	boardModelFormat,
	isBoardModelItem,
	parseBoardMediaSource,
} from "../model/index.js";
import type { ModelFormat } from "@cohub/protocol/fs";
import {
	imageVariantUrl,
	MEDIA_VARIANT_SIZES,
	type MediaVariantSize,
	mediaVariantSize,
	probeMediaInfo,
	variantSource,
	videoFrameUrl,
} from "../../media.js";
import { taskArtifactPreviewUrl } from "@cohub/protocol";
import { Texture } from "pixi.js";
import {
	DEFAULT_LRU_BUDGET,
	type LruBudget,
	type LruEntry,
	selectLruEvictions,
} from "./lru.js";
import {
	type BoardImageTexturePool,
	boardImageTexturePool,
	loadBoardImageTexture,
	unloadBoardImageTexture,
} from "./texture-pool.js";
import {
	loadVideoThumbnailTexture,
	videoTextureNaturalSize,
} from "../render/index.js";

type BoardUrlMedia = "image" | "video";
type BoardAssetMedia = BoardUrlMedia | "model";
type BoardAssetSource = {
	kind: "file" | "url";
	media: BoardAssetMedia;
	value: string;
};

function taskPreviewKey(artifact: BoardTaskArtifact | undefined) {
	const cover = taskArtifactPreviewUrl(artifact);
	if (cover) return `url:${cover}`;
	if (artifact?.type !== "video") return null;
	const frame = videoFrameUrl(artifact.url, 768);
	return frame ? `url:${frame}` : `video-url:${encodeURIComponent(artifact.url)}`;
}

const LARGEST_VARIANT = MEDIA_VARIANT_SIZES[MEDIA_VARIANT_SIZES.length - 1] as number;

export function boardTextureEdge(item: BoardSceneItem, scale: number): number {
	const crop = item.type === "image" ? item.props.crop : undefined;
	const pixels = Math.max(item.frame.width / (crop?.w || 1), item.frame.height / (crop?.h || 1)) * scale;
	return pixels > LARGEST_VARIANT ? Number.POSITIVE_INFINITY : mediaVariantSize(pixels);
}

function variantUrl(source: string, edge: number): string | null {
	if (!(edge <= LARGEST_VARIANT)) return null;
	const url = imageVariantUrl(source, edge as MediaVariantSize);
	return url && url !== source ? url : null;
}

const STILL_MEDIA = ["video", "model"] as const;

function stillKey(
	media: (typeof STILL_MEDIA)[number],
	src: string,
	mtimeMs: number | undefined,
) {
	const source = parseBoardMediaSource(src);
	if (!source) return null;
	return source.kind === "url"
		? `${media}-url:${encodeURIComponent(source.value)}`
		: `${media}:${encodeURIComponent(source.value)}:${mtimeMs ?? "unknown"}`;
}

export function boardAssetKey(item: BoardSceneItem): string | null {
	if (item.type === "task") return taskPreviewKey(featuredTaskArtifact(item.props.snapshot.artifacts));
	if (item.type === "video") return stillKey("video", item.props.src, item.props.snapshot?.mtimeMs);
	if (item.type === "file" && isBoardModelItem(item)) return stillKey("model", item.props.src, item.props.snapshot?.mtimeMs);
	return imageAssetKey(item);
}

function keySource(key: string): BoardAssetSource | null {
	let baseKey = key;
	if (key.startsWith("local:")) {
		const separator = key.indexOf(":", 6);
		if (separator < 0) return null;
		baseKey = key.slice(separator + 1);
	}
	for (const media of STILL_MEDIA) {
		if (baseKey.startsWith(`${media}-url:`)) {
			try {
				return {
					kind: "url",
					media,
					value: decodeURIComponent(baseKey.slice(media.length + 5)),
				};
			} catch {
				return null;
			}
		}
		if (baseKey.startsWith(`${media}:`)) {
			const separator = baseKey.lastIndexOf(":");
			if (separator <= media.length) return null;
			try {
				return {
					kind: "file",
					media,
					value: decodeURIComponent(baseKey.slice(media.length + 1, separator)),
				};
			} catch {
				return null;
			}
		}
	}
	const image = boardImageKeySource(baseKey);
	return image ? { ...image, media: "image" } : null;
}

type Size = { width: number; height: number };

type Entry = {
	media: BoardAssetMedia;
	source: string | null;
	url: string | null;
	texture: Texture | null;
	/** Bound of the loaded texture; Infinity once it cannot sharpen further. */
	edge: number;
	want: number;
	/** Original pixel size: undefined until known, null once a probe is pending or failed. */
	natural: Size | null | undefined;
	refs: number;
	loading: boolean;
	error: boolean;
	attempts: number;
	retryAt: number;
	retryTimer: ReturnType<typeof setTimeout> | null;
	lastUsedAt: number;
};

type Loaded = { texture: Texture; url: string; edge: number };
type Load = (entry: Entry) => Promise<Loaded | null>;
type Start = (entry: Entry) => void;
type Task = { key: string; media: BoardAssetMedia; load: Load };

export type BoardModelPreviewRequest = {
	key: string;
	src: string;
	format: ModelFormat;
	size?: number;
};

export type BoardModelPreviews = {
	load: (request: BoardModelPreviewRequest) => Promise<ImageBitmap>;
	maxBytes?: number;
};

export type BoardAssetManager = {
	assetKey: (item: BoardSceneItem) => string | null;
	invalidatePath: (path: string) => void;
	requestItem: (item: BoardSceneItem, edge?: number) => void;
	getTexture: (key: string) => Texture | null;
	getNaturalSize: (key: string) => Size | null;
	hasError: (key: string) => boolean;
	acquire: (key: string) => void;
	release: (key: string) => void;
	withTextures: <T>(
		items: BoardSceneItem[],
		use: (textures: Map<string, Texture>) => T | Promise<T>,
		options?: { timeoutMs?: number; edge?: (item: BoardSceneItem) => number },
	) => Promise<T>;
	subscribe: (listener: (key: string) => void) => () => void;
	destroy: () => void;
};

const MAX_RETRY_DELAY = 30_000;

function footprintOf(texture: Texture | null): number {
	if (!texture) return 0;
	const width = texture.width || 0;
	const height = texture.height || 0;
	return width * height * 4;
}

export type BoardAssetManagerOptions = {
	/** Resolve a Space file path to a URL a texture can load from; null when unavailable. */
	resolveFileUrl: (path: string, options?: BoardAssetUrlOptions) => Promise<string | null>;
	concurrency?: number;
	videoConcurrency?: number;
	loadVideoPreviews?: boolean;
	modelPreviews?: BoardModelPreviews;
	lruBudget?: LruBudget;
	imageTexturePool?: BoardImageTexturePool;
	loadTexture?: (
		url: string,
		media: BoardUrlMedia,
	) => Promise<Texture | null>;
	unloadTexture?: (
		url: string,
		texture: Texture | null,
		media: BoardAssetMedia,
	) => Promise<void>;
	now?: () => number;
};

export function createBoardAssetManager(
	options: BoardAssetManagerOptions,
): BoardAssetManager {
	const concurrency = Math.max(1, options.concurrency ?? 6);
	const limits: Record<BoardAssetMedia, number> = {
		image: concurrency,
		video: Math.max(1, Math.min(options.videoConcurrency ?? 2, concurrency)),
		model: 1,
	};
	const budget = options.lruBudget ?? DEFAULT_LRU_BUDGET;
	const now = options.now ?? (() => Date.now());
	const imagePool = options.imageTexturePool ?? boardImageTexturePool;
	const useSharedImagePool = !options.loadTexture && !options.unloadTexture;
	const loadTexture =
		options.loadTexture ??
		((url, media) =>
			media === "video"
				? loadVideoThumbnailTexture(url)
				: useSharedImagePool
					? imagePool.acquire(url)
					: loadBoardImageTexture(url));
	const pendingUnloads = new Map<string, Promise<void>>();
	const unloadTexture =
		options.unloadTexture ??
		(async (url, texture, media) => {
			if (media !== "image" || !url) {
				const resource = texture?.source.resource as { close?: () => void } | undefined;
				texture?.destroy(true);
				resource?.close?.();
				return;
			}
			if (useSharedImagePool) {
				await imagePool.release(url);
				return;
			}
			await unloadBoardImageTexture(url, texture);
		});
	function releaseTexture(key: string, url: string, texture: Texture | null) {
		const media = keySource(key)?.media ?? "image";
		const pendingKey = `${media}:${url}`;
		const promise = unloadTexture(url, texture, media)
			.catch(() => {})
			.then(() => {
				if (url && pendingUnloads.get(pendingKey) === promise)
					pendingUnloads.delete(pendingKey);
			});
		if (url) pendingUnloads.set(pendingKey, promise);
	}
	const retiring = new Set<() => void>();
	function retire(key: string, url: string, texture: Texture) {
		const release = () => {
			if (retiring.delete(release)) releaseTexture(key, url, texture);
		};
		retiring.add(release);
		if (typeof requestAnimationFrame === "function") requestAnimationFrame(release);
		else setTimeout(release, 0);
	}
	const resolveFileUrl = options.resolveFileUrl;

	const entries = new Map<string, Entry>();
	const pathVersions = new Map<string, number>();
	const starters = new Map<string, Start>();
	const failedModels = new Set<string>();
	const queue: Task[] = [];
	const listeners = new Set<(key: string) => void>();
	let active = 0;
	const activeByMedia: Record<BoardAssetMedia, number> = {
		image: 0,
		video: 0,
		model: 0,
	};
	let disposed = false;

	function notify(key: string) {
		for (const listener of listeners) listener(key);
	}

	function managedAssetKey(item: BoardSceneItem): string | null {
		const key = boardAssetKey(item);
		if (!key) return null;
		const source = keySource(key);
		if (source?.media === "video" && options.loadVideoPreviews === false)
			return null;
		if (source?.media === "model" && !modelPreviewable(item)) return null;
		if (source?.kind !== "file") return key;
		const version = pathVersions.get(source.value) ?? 0;
		return version > 0 ? `local:${version}:${key}` : key;
	}

	function clearRetry(entry: Entry) {
		if (entry.retryTimer) {
			clearTimeout(entry.retryTimer);
			entry.retryTimer = null;
		}
	}

	function ensureEntry(key: string): Entry {
		let entry = entries.get(key);
		if (!entry) {
			entry = {
				media: keySource(key)?.media ?? "image",
				source: null,
				url: null,
				texture: null,
				edge: 0,
				want: 0,
				natural: undefined,
				refs: 0,
				loading: false,
				error: false,
				attempts: 0,
				retryAt: 0,
				retryTimer: null,
				lastUsedAt: now(),
			};
			entries.set(key, entry);
		}
		return entry;
	}

	function scheduleRetry(key: string, entry: Entry) {
		clearRetry(entry);
		const delay = Math.max(0, entry.retryAt - now());
		entry.retryTimer = setTimeout(() => {
			entry.retryTimer = null;
			if (disposed || entries.get(key) !== entry) return;
			if (entry.refs <= 0 || entry.texture || entry.loading) return;
			const start = starters.get(key);
			if (!start) return;
			entry.error = false;
			start(entry);
		}, delay);
	}

	function evict(key: string, entry: Entry) {
		clearRetry(entry);
		starters.delete(key);
		if (entry.url || entry.texture)
			releaseTexture(key, entry.url ?? "", entry.texture);
		entries.delete(key);
	}

	function trim() {
		const cooling: LruEntry[] = [];
		for (const [key, entry] of entries) {
			if (entry.refs <= 0 && entry.texture && !entry.loading)
				cooling.push({
					key,
					lastUsedAt: entry.lastUsedAt,
					bytes: footprintOf(entry.texture),
				});
		}
		const evictions = selectLruEvictions(cooling, budget);
		for (const key of evictions) {
			const entry = entries.get(key);
			if (entry) evict(key, entry);
		}
	}

	function adopt(key: string, entry: Entry, loaded: Loaded | null, error?: unknown) {
		entry.loading = false;
		if (entries.get(key) !== entry) {
			if (loaded) releaseTexture(key, loaded.url, loaded.texture);
			return;
		}
		if (loaded) {
			const replaced = entry.texture;
			const replacedUrl = entry.url ?? "";
			const { texture } = loaded;
			entry.error = false;
			entry.attempts = 0;
			entry.texture = texture;
			entry.url = loaded.url;
			entry.edge = loaded.edge;
			if (loaded.edge === Number.POSITIVE_INFINITY && !variantSource(loaded.url))
				entry.natural = videoTextureNaturalSize(texture) ?? { width: texture.width, height: texture.height };
			entry.lastUsedAt = now();
			if (entry.refs <= 0) trim();
			else notify(key);
			if (replaced) retire(key, replacedUrl, replaced);
			refine(key, entry);
			return;
		}
		if (entry.texture) {
			entry.edge = Number.POSITIVE_INFINITY;
			notify(key);
			return;
		}
		const media = entry.media;
		entry.error = true;
		entry.attempts += 1;
		entry.retryAt = now() + Math.min(1000 * 2 ** entry.attempts, MAX_RETRY_DELAY);
		console.warn(`[board] failed to load preview for ${key}`, error);
		if (media === "model") failedModels.add(key);
		if (entry.refs <= 0) evict(key, entry);
		else {
			if (media !== "model") scheduleRetry(key, entry);
			notify(key);
		}
	}

	function refinable(entry: Entry) {
		return entry.media === "image" && entry.refs > 0 && entry.texture !== null && entry.source !== null && entry.want > entry.edge;
	}

	function refine(key: string, entry: Entry) {
		if (refinable(entry) && !entry.loading && entry.source)
			enqueue(key, "image", textureLoad("image", entry.source));
	}

	function enqueue(key: string, media: BoardAssetMedia, load: Load) {
		if (queue.some((task) => task.key === key)) return;
		queue.push({ key, media, load });
		pump();
	}

	function pump() {
		while (!disposed && active < concurrency && queue.length > 0) {
			const taskIndex = queue.findIndex(({ media }) => activeByMedia[media] < limits[media]);
			if (taskIndex < 0) return;
			const [task] = queue.splice(taskIndex, 1);
			if (!task) continue;
			const entry = entries.get(task.key);
			if (!entry || entry.loading || (entry.texture && !refinable(entry))) continue;
			entry.loading = true;
			active += 1;
			activeByMedia[task.media] += 1;
			const done = (loaded: Loaded | null, error?: unknown) => {
				active -= 1;
				activeByMedia[task.media] -= 1;
				adopt(task.key, entry, loaded, error);
				if (!disposed) pump();
			};
			task.load(entry).then(
				(loaded) => done(loaded),
				(error) => done(null, error),
			);
		}
	}

	function textureLoad(media: BoardUrlMedia, source: string): Load {
		return async (entry) => {
			entry.source = source;
			const edge = entry.want;
			const variant = media === "image" ? variantUrl(source, edge) : null;
			const url = variant ?? source;
			const pending = pendingUnloads.get(`${media}:${url}`);
			if (pending) await pending;
			if (disposed) return null;
			const texture = await loadTexture(url, media);
			if (!texture) return null;
			const full = !variant || Math.max(texture.width, texture.height) < edge;
			return { texture, url, edge: full ? Number.POSITIVE_INFINITY : edge };
		};
	}
	function resolveFile(key: string, media: BoardUrlMedia, path: string): Start {
		return (entry) => {
			const fresh = entry.attempts > 0;
			entry.loading = true;
			resolveFileUrl(path, fresh ? { fresh } : undefined).then(
				(url) => {
					if (disposed || entries.get(key) !== entry) return;
					if (entry.refs <= 0) return evict(key, entry);
					if (!url) return adopt(key, entry, null, new Error(`Unavailable file: ${path}`));
					entry.loading = false;
					enqueue(key, media, textureLoad(media, url));
				},
				(error: unknown) => {
					if (!disposed) adopt(key, entry, null, error);
				},
			);
		};
	}

	function probeNaturalSize(key: string, entry: Entry, source: string) {
		entry.natural = null;
		void probeMediaInfo(source, { type: "image" }).then(({ width, height }) => {
			if (disposed || entries.get(key) !== entry || !width || !height) return;
			entry.natural = { width, height };
			notify(key);
		});
	}

	function modelPreviewable(item: BoardSceneItem) {
		const previews = options.modelPreviews;
		if (!previews) return false;
		const size = item.type === "file" ? item.props.snapshot?.size : undefined;
		return size === undefined || size <= (previews.maxBytes ?? Number.POSITIVE_INFINITY);
	}

	function modelLoader(item: BoardSceneItem, key: string): Load | null {
		const previews = options.modelPreviews;
		if (!previews || item.type !== "file") return null;
		const { src, snapshot } = item.props;
		const format = boardModelFormat(src, snapshot?.mimeType);
		if (!format) return null;
		const request = { key, src, format, size: snapshot?.size };
		return async () => ({ texture: Texture.from(await previews.load(request)), url: "", edge: Number.POSITIVE_INFINITY });
	}

	function starter(item: BoardSceneItem, key: string, source: BoardAssetSource): Start | null {
		if (source.media === "model") {
			const load = modelLoader(item, key);
			return load ? () => enqueue(key, "model", load) : null;
		}
		const media = source.media;
		if (source.kind === "file") return resolveFile(key, media, source.value);
		const load = textureLoad(media, source.value);
		return () => enqueue(key, media, load);
	}

	const manager: BoardAssetManager = {
		assetKey: managedAssetKey,
		invalidatePath(path) {
			if (disposed) return;
			const stale = [...entries.keys()].filter((key) => {
				const source = keySource(key);
				return source?.kind === "file" && source.value === path;
			});
			if (stale.length === 0) return;
			pathVersions.set(path, (pathVersions.get(path) ?? 0) + 1);
			for (const key of stale) notify(key);
		},
		requestItem(item, edge = Number.POSITIVE_INFINITY) {
			if (disposed) return;
			const key = managedAssetKey(item);
			if (!key || failedModels.has(key)) return;
			const source = keySource(key);
			if (!source) return;
			const entry = ensureEntry(key);
			entry.lastUsedAt = now();
			if (edge > entry.want) entry.want = edge;
			if (entry.texture) return refine(key, entry);
			if (entry.loading || entry.retryTimer) return;
			if (entry.error && now() < entry.retryAt) return;
			if (queue.some((queued) => queued.key === key)) return;
			const start = starter(item, key, source);
			if (!start) return;
			entry.error = false;
			starters.set(key, start);
			start(entry);
		},
		getTexture(key) {
			const entry = entries.get(key);
			if (!entry?.texture) return null;
			entry.lastUsedAt = now();
			return entry.texture;
		},
		getNaturalSize(key) {
			const entry = entries.get(key);
			if (!entry?.texture) return null;
			if (entry.natural === undefined && entry.source) probeNaturalSize(key, entry, entry.source);
			return entry.natural ?? null;
		},
		hasError(key) {
			return entries.get(key)?.error ?? false;
		},
		acquire(key) {
			const entry = ensureEntry(key);
			entry.refs += 1;
			entry.lastUsedAt = now();
		},
		release(key) {
			const entry = entries.get(key);
			if (!entry) return;
			entry.refs -= 1;
			if (entry.refs > 0) return;
			entry.lastUsedAt = now();
			clearRetry(entry);
			if (entry.loading) return;
			if (!entry.texture) evict(key, entry);
			else trim();
		},
		async withTextures(items, use, loadOptions) {
			const keys = new Set<string>();
			if (!disposed) {
				for (const item of items) {
					const key = managedAssetKey(item);
					if (key) keys.add(key);
				}
			}
			const textures = new Map<string, Texture>();
			if (keys.size === 0) return use(textures);

			for (const key of keys) manager.acquire(key);
			try {
				for (const item of items) manager.requestItem(item, loadOptions?.edge?.(item));
				const settled = () =>
					[...keys].every((key) => {
						const entry = entries.get(key);
						return Boolean(entry?.error) || Boolean(entry?.texture && !refinable(entry));
					});
				if (!settled()) {
					const timeoutMs = loadOptions?.timeoutMs ?? 15_000;
					await new Promise<void>((resolve) => {
						const timer = setTimeout(finish, timeoutMs);
						const unsubscribe = manager.subscribe(() => {
							if (settled()) finish();
						});
						function finish() {
							clearTimeout(timer);
							unsubscribe();
							resolve();
						}
					});
				}
				for (const key of keys) {
					const texture = entries.get(key)?.texture;
					if (texture) textures.set(key, texture);
				}
				return await use(textures);
			} finally {
				for (const key of keys) manager.release(key);
			}
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		destroy() {
			disposed = true;
			queue.length = 0;
			listeners.clear();
			pathVersions.clear();
			starters.clear();
			failedModels.clear();
			for (const [key, entry] of entries) evict(key, entry);
			entries.clear();
			for (const release of [...retiring]) release();
		},
	};

	return manager;
}
