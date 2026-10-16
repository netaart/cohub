import {
	type BoardSceneItem,
	boardImageKeySource,
	boardModelTarget,
	featuredTaskArtifact,
	imageAssetKey,
	isBoardModelItem,
	parseBoardMediaSource,
	taskArtifactModelFormat,
} from "../model/index.js";
import type { ModelFormat } from "@cohub/protocol/fs";
import { mediaPreviewCandidates } from "../../media.js";
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

const TASK_TEXTURE_SIZE = 1536;

function taskPreviewKey(item: BoardSceneItem & { type: "task" }) {
	const artifact = featuredTaskArtifact(item.props.snapshot.artifacts);
	if (!artifact || artifact.type === "text") return null;
	const [still] = mediaPreviewCandidates(artifact, { size: TASK_TEXTURE_SIZE });
	if (still) return `url:${still}`;
	if (artifact.type === "video") return `video-url:${encodeURIComponent(artifact.url)}`;
	const model = taskArtifactModelFormat(artifact);
	return model ? `model-url:${encodeURIComponent(artifact.url)}` : null;
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
	if (item.type === "task") return taskPreviewKey(item);
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

type Entry = {
	url: string | null;
	texture: Texture | null;
	refs: number;
	loading: boolean;
	error: boolean;
	attempts: number;
	retryAt: number;
	retryTimer: ReturnType<typeof setTimeout> | null;
	lastUsedAt: number;
};

type Load = (entry: Entry) => Promise<Texture | null>;

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
	requestItem: (item: BoardSceneItem) => void;
	getTexture: (key: string) => Texture | null;
	getNaturalSize: (key: string) => { width: number; height: number } | null;
	hasError: (key: string) => boolean;
	acquire: (key: string) => void;
	release: (key: string) => void;
	withTextures: <T>(
		items: BoardSceneItem[],
		use: (textures: Map<string, Texture>) => T | Promise<T>,
		options?: { timeoutMs?: number },
	) => Promise<T>;
	subscribe: (listener: () => void) => () => void;
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
	resolveFileUrl: (path: string) => Promise<string | null>;
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
	const concurrency = Math.max(1, options.concurrency ?? 4);
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
	const resolveFileUrl = options.resolveFileUrl;

	const entries = new Map<string, Entry>();
	const pathVersions = new Map<string, number>();
	const loaders = new Map<string, Load>();
	const failedModels = new Set<string>();
	const inflight = new Set<string>();
	const queue: Array<{ key: string; load: Load }> = [];
	const listeners = new Set<() => void>();
	let active = 0;
	const activeByMedia: Record<BoardAssetMedia, number> = {
		image: 0,
		video: 0,
		model: 0,
	};
	let disposed = false;

	function notify() {
		for (const listener of listeners) listener();
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
				url: null,
				texture: null,
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
			const load = loaders.get(key);
			if (!load) return;
			entry.error = false;
			if (!queue.some((task) => task.key === key)) {
				queue.push({ key, load });
				pump();
			}
		}, delay);
	}

	function evict(key: string, entry: Entry) {
		clearRetry(entry);
		loaders.delete(key);
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

	function settle(
		key: string,
		entry: Entry,
		texture: Texture | null,
		error?: unknown,
	) {
		entry.loading = false;
		inflight.delete(key);
		active -= 1;
		const media = keySource(key)?.media;
		if (media) activeByMedia[media] -= 1;
		if (entries.get(key) !== entry) {
			if (texture) releaseTexture(key, entry.url ?? "", texture);
			if (!disposed) pump();
			return;
		}
		if (texture) {
			entry.error = false;
			entry.attempts = 0;
			entry.texture = texture;
			entry.lastUsedAt = now();
			if (entry.refs <= 0) trim();
			else notify();
		} else {
			entry.error = true;
			entry.attempts += 1;
			entry.retryAt =
				now() + Math.min(1000 * 2 ** entry.attempts, MAX_RETRY_DELAY);
			console.warn(`[board] failed to load preview for ${key}`, error);
			if (media === "model") failedModels.add(key);
			if (entry.refs <= 0) evict(key, entry);
			else {
				if (media !== "model") scheduleRetry(key, entry);
				notify();
			}
		}
		if (!disposed) pump();
	}

	function pump() {
		while (!disposed && active < concurrency && queue.length > 0) {
			const taskIndex = queue.findIndex(({ key }) => {
				const media = keySource(key)?.media;
				return !media || activeByMedia[media] < limits[media];
			});
			if (taskIndex < 0) return;
			const [task] = queue.splice(taskIndex, 1);
			if (!task) continue;
			const entry = entries.get(task.key);
			const source = keySource(task.key);
			if (!entry || !source || entry.texture || entry.loading) continue;
			entry.loading = true;
			inflight.add(task.key);
			active += 1;
			activeByMedia[source.media] += 1;
			task.load(entry).then(
				(texture) => settle(task.key, entry, texture),
				(error) => settle(task.key, entry, null, error),
			);
		}
	}

	function urlLoader(source: BoardAssetSource & { media: BoardUrlMedia }): Load {
		const getUrl =
			source.kind === "url"
				? () => Promise.resolve(source.value)
				: () => resolveFileUrl(source.value);
		return async (entry) => {
			const url = await getUrl();
			if (!url || disposed) return null;
			entry.url = url;
			const pending = pendingUnloads.get(`${source.media}:${url}`);
			if (pending) await pending;
			if (disposed) return null;
			return loadTexture(url, source.media);
		};
	}

	function modelPreviewable(item: BoardSceneItem) {
		const previews = options.modelPreviews;
		if (!previews) return false;
		const size = item.type === "file" ? item.props.snapshot?.size : undefined;
		return size === undefined || size <= (previews.maxBytes ?? Number.POSITIVE_INFINITY);
	}

	function modelLoader(item: BoardSceneItem, key: string): Load | null {
		const previews = options.modelPreviews;
		if (!previews) return null;
		const target = boardModelTarget(item);
		if (!target) return null;
		const request = {
			key,
			src: target.src,
			format: target.format,
			...(target.size === undefined ? {} : { size: target.size }),
		};
		return async () => Texture.from(await previews.load(request));
	}

	const manager: BoardAssetManager = {
		assetKey: managedAssetKey,
		invalidatePath(path) {
			if (disposed) return;
			const cached = [...entries.keys()].some((key) => {
				const source = keySource(key);
				return source?.kind === "file" && source.value === path;
			});
			if (!cached) return;
			pathVersions.set(path, (pathVersions.get(path) ?? 0) + 1);
			notify();
		},
		requestItem(item) {
			if (disposed) return;
			const key = managedAssetKey(item);
			if (!key || failedModels.has(key)) return;
			const source = keySource(key);
			if (!source) return;
			const entry = ensureEntry(key);
			entry.lastUsedAt = now();
			if (entry.texture || entry.loading) return;
			if (entry.error && now() < entry.retryAt) return;
			entry.error = false;
			clearRetry(entry);
			if (queue.some((queued) => queued.key === key)) return;
			const load =
				source.media === "model"
					? modelLoader(item, key)
					: urlLoader({ ...source, media: source.media });
			if (!load) return;
			loaders.set(key, load);
			queue.push({ key, load });
			pump();
		},
		getTexture(key) {
			const entry = entries.get(key);
			if (!entry?.texture) return null;
			entry.lastUsedAt = now();
			return entry.texture;
		},
		getNaturalSize(key) {
			const texture = manager.getTexture(key);
			if (!texture) return null;
			return (
				videoTextureNaturalSize(texture) ?? {
					width: texture.width,
					height: texture.height,
				}
			);
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
				for (const item of items) manager.requestItem(item);
				const settled = () =>
					[...keys].every((key) => {
						const entry = entries.get(key);
						return Boolean(entry?.texture) || Boolean(entry?.error);
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
			loaders.clear();
			failedModels.clear();
			for (const [key, entry] of entries) evict(key, entry);
			entries.clear();
		},
	};

	return manager;
}
