import {
	type BoardAssetKeySource,
	type BoardAssetMedia,
	type BoardAssetRef,
	type BoardAssetUrlOptions,
	type BoardSceneItem,
	boardAssetKey,
	boardAssetKeySource,
	boardAssetRefKey,
	boardModelFormat,
} from "../model/index.js";
import type { ModelFormat } from "@cohub/protocol/fs";
import {
	imageVariantUrl,
	MEDIA_VARIANT_MAX,
	MEDIA_VARIANT_SIZES,
	type MediaVariantSize,
	probeMediaInfo,
	variantSource,
} from "../../media.js";
import { Texture } from "pixi.js";
import { defaultBoardDeviceBudget } from "./device.js";
import { scheduleBoardIdle } from "./idle.js";
import {
	type LruBudget,
	type LruEntry,
	planLruTrim,
} from "./lru.js";
import {
	type BoardImageTexturePool,
	boardImageTexturePool,
	loadBoardImageTexture,
	loadFittedImageTexture,
	readTextureTone,
	shrinkBoardTexture,
	unloadBoardImageTexture,
} from "./texture-pool.js";
import {
	loadVideoThumbnailTexture,
	videoTextureNaturalSize,
} from "../render/index.js";

type BoardUrlMedia = "image" | "video";

function variantUrl(source: string, edge: number, cover: boolean): string | null {
	if (!(edge <= MEDIA_VARIANT_MAX)) return null;
	const url = imageVariantUrl(source, edge as MediaVariantSize, cover ? "cover" : "contain");
	return url && url !== source ? url : null;
}

const SMALLEST_VARIANT = MEDIA_VARIANT_SIZES[0];

function boundEdge({ width, height }: Size, cover: boolean): number {
	return cover ? Math.min(width, height) : Math.max(width, height);
}

function sharpEdge(texture: Texture, edge: number, resized: boolean, cover: boolean): number {
	return resized && boundEdge(texture, cover) >= edge ? edge : Number.POSITIVE_INFINITY;
}

type Size = { width: number; height: number };

type Entry = {
	media: BoardAssetMedia;
	cover: boolean;
	source: string | null;
	url: string | null;
	texture: Texture | null;
	/** Bound of the loaded texture; Infinity once it cannot sharpen further. */
	edge: number;
	want: number;
	/** World center of the latest request. */
	center: { x: number; y: number } | null;
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
	invalidateItemAssets: () => void;
	requestItem: (item: BoardSceneItem, edge?: number) => void;
	/** World point used to prioritize queued loads. */
	focus: (point: { x: number; y: number } | null) => void;
	getTexture: (key: string) => Texture | null;
	getNaturalSize: (key: string) => Size | null;
	getTone: (key: string) => number | null;
	hasError: (key: string) => boolean;
	acquire: (key: string) => void;
	release: (key: string) => void;
	prefetch?: (requests: readonly BoardAssetPrefetch[]) => void;
	withTextures: <T>(
		items: BoardSceneItem[],
		use: (textures: Map<string, Texture>) => T | Promise<T>,
		options?: { timeoutMs?: number; edge?: (item: BoardSceneItem) => number },
	) => Promise<T>;
	subscribe: (listener: (key: string, change: BoardAssetChange) => void) => () => void;
	stats: () => { textures: number; cooling: number; bytes: number; loading?: number; prefetching?: number };
	destroy: () => void;
};

export type BoardAssetPrefetch = { item: BoardSceneItem; edge: number };

export type BoardAssetChange = "texture" | "tone";

const MAX_RETRY_DELAY = 30_000;
const PREFETCH_CONCURRENCY = 2;
const PREFETCH_POOL_SHARE = 0.5;
const SHRINK_EDGE = 256;
const SHRINK_CONCURRENCY = 4;
const TRIM_DELAY = 400;
const TRIM_MAX_DELAY = 2_000;
const TONE_LIMIT = 8192;

function footprintOf(texture: Texture | null): number {
	if (!texture) return 0;
	const width = texture.width || 0;
	const height = texture.height || 0;
	return width * height * 4;
}

export type BoardAssetManagerOptions = {
	/** Resolve a Space file path to a URL a texture can load from; null when unavailable. */
	resolveFileUrl: (path: string, options?: BoardAssetUrlOptions) => Promise<string | null>;
	/** undefined keeps the built-in rule, null shows none; cached until `invalidateItemAssets`. */
	itemAsset?: (item: BoardSceneItem) => BoardAssetRef | null | undefined;
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
	/** An unshared copy of an image texture at `edge`; null keeps evicting outright. */
	shrinkTexture?: (texture: Texture, edge: number) => Promise<Texture | null>;
	readTone?: ((texture: Texture) => Promise<number | null>) | null;
	now?: () => number;
};

export function createBoardAssetManager(
	options: BoardAssetManagerOptions,
): BoardAssetManager {
	const concurrency = Math.max(1, options.concurrency ?? defaultBoardDeviceBudget().concurrency);
	const limits: Record<BoardAssetMedia, number> = {
		image: concurrency,
		video: Math.max(1, Math.min(options.videoConcurrency ?? 2, concurrency)),
		model: 1,
	};
	const budget = options.lruBudget ?? defaultBoardDeviceBudget().lru;
	const prefetchLimit = Math.min(PREFETCH_CONCURRENCY, concurrency - 1);
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
	const shrinkTexture = options.shrinkTexture ?? (useSharedImagePool ? shrinkBoardTexture : null);
	const readTone = options.readTone === undefined ? (typeof createImageBitmap === "function" ? readTextureTone : null) : options.readTone;
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
	function releaseTexture(media: BoardAssetMedia, url: string, texture: Texture | null) {
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
	function retire(media: BoardAssetMedia, url: string, texture: Texture) {
		const release = () => {
			if (retiring.delete(release)) releaseTexture(media, url, texture);
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
	const listeners = new Set<(key: string, change: BoardAssetChange) => void>();
	let active = 0;
	const activeByMedia: Record<BoardAssetMedia, number> = {
		image: 0,
		video: 0,
		model: 0,
	};
	let disposed = false;
	let focus: { x: number; y: number } | null = null;
	let trimTimer: ReturnType<typeof setTimeout> | null = null;
	let trimSince = 0;
	let shrinking = 0;
	let warm = new Set<string>();
	let warming = 0;
	const unwarmable = new Set<string>();

	function isWarm(key: string): boolean {
		return warm.has(key) && (entries.get(key)?.refs ?? 0) <= 0;
	}

	function notify(key: string, change: BoardAssetChange = "texture") {
		for (const listener of listeners) listener(key, change);
	}

	const tones = new Map<string, number>();
	const toneQueue = new Set<string>();
	let cancelTone: (() => void) | null = null;

	function queueTone(key: string) {
		if (!readTone || tones.has(key)) return;
		toneQueue.add(key);
		cancelTone ??= scheduleBoardIdle(readNextTone, 0);
	}

	async function readNextTone() {
		const [key] = toneQueue;
		if (key === undefined) {
			cancelTone = null;
			return;
		}
		toneQueue.delete(key);
		const texture = entries.get(key)?.texture;
		const tone = texture && readTone ? await readTone(texture).catch(() => null) : null;
		if (disposed) return;
		if (tone !== null) {
			if (tones.size >= TONE_LIMIT) tones.delete(tones.keys().next().value as string);
			tones.set(key, tone);
			notify(key, "tone");
		}
		cancelTone = toneQueue.size > 0 ? scheduleBoardIdle(readNextTone, 0) : null;
	}

	const keys = new WeakMap<BoardSceneItem, { epoch: number; key: string | null }>();
	let keyEpoch = 0;
	function managedAssetKey(item: BoardSceneItem): string | null {
		const cached = keys.get(item);
		if (cached?.epoch === keyEpoch) return cached.key;
		const key = resolveAssetKey(item);
		keys.set(item, { epoch: keyEpoch, key });
		return key;
	}

	function resolveAssetKey(item: BoardSceneItem): string | null {
		const asset = options.itemAsset?.(item);
		const key = asset === undefined ? boardAssetKey(item) : asset && boardAssetRefKey(asset);
		if (!key) return null;
		const source = boardAssetKeySource(key);
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
			const source = boardAssetKeySource(key);
			entry = {
				media: source?.media ?? "image",
				cover: source?.fit === "cover",
				source: null,
				url: null,
				texture: null,
				edge: 0,
				want: 0,
				center: null,
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
			releaseTexture(entry.media, entry.url ?? "", entry.texture);
		entries.delete(key);
	}

	function scheduleTrim() {
		const at = now();
		if (trimTimer === null) trimSince = at;
		else if (at - trimSince >= TRIM_MAX_DELAY) return;
		else clearTimeout(trimTimer);
		trimTimer = setTimeout(() => {
			trimTimer = null;
			if (!disposed) trim();
		}, TRIM_DELAY);
	}

	function shrunkFootprint({ media, texture }: Entry): number | undefined {
		if (!shrinkTexture || media !== "image" || !texture) return undefined;
		const scale = SHRINK_EDGE / Math.max(texture.width, texture.height);
		return scale < 1 ? Math.round(texture.width * scale) * Math.round(texture.height * scale) * 4 : undefined;
	}

	function trim() {
		const cooling: LruEntry[] = [];
		for (const [key, entry] of entries) {
			if (entry.refs <= 0 && entry.texture && !entry.loading)
				cooling.push({
					key,
					lastUsedAt: entry.lastUsedAt,
					bytes: footprintOf(entry.texture),
					shrunkBytes: shrunkFootprint(entry),
				});
		}
		const plan = planLruTrim(cooling, budget);
		for (const key of plan.evict) {
			const entry = entries.get(key);
			if (entry) evict(key, entry);
		}
		for (const key of plan.shrink.slice(0, Math.max(0, SHRINK_CONCURRENCY - shrinking))) {
			const entry = entries.get(key);
			if (entry) shrink(key, entry);
		}
	}

	function shrink(key: string, entry: Entry) {
		const { texture, url } = entry;
		if (!shrinkTexture || !texture) return;
		entry.loading = true;
		shrinking += 1;
		void shrinkTexture(texture, SHRINK_EDGE)
			.catch(() => null)
			.then((small) => {
				shrinking -= 1;
				entry.loading = false;
				const current = entries.get(key) === entry;
				if (small && current && entry.refs <= 0) {
					entry.texture = small;
					entry.url = "";
					entry.edge = SHRINK_EDGE;
					releaseTexture(entry.media, url ?? "", texture);
				} else {
					if (small) releaseTexture(entry.media, "", small);
					if (current && entry.refs > 0) refine(key, entry);
					else if (current) evict(key, entry);
				}
				if (!disposed) trim();
			});
	}

	function adopt(key: string, entry: Entry, loaded: Loaded | null, error?: unknown) {
		entry.loading = false;
		if (entries.get(key) !== entry) {
			if (loaded) releaseTexture(entry.media, loaded.url, loaded.texture);
			return;
		}
		if (warm.delete(key) && !loaded && !entry.texture && entry.refs <= 0) unwarmable.add(key);
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
			if (entry.refs <= 0) scheduleTrim();
			else notify(key);
			if (replaced) retire(entry.media, replacedUrl, replaced);
			queueTone(key);
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

	function refinable(key: string, entry: Entry) {
		return entry.media === "image" && (entry.refs > 0 || warm.has(key)) && entry.texture !== null && entry.source !== null && entry.want > entry.edge;
	}

	function refine(key: string, entry: Entry) {
		if (refinable(key, entry) && !entry.loading && entry.source)
			enqueue(key, "image", textureLoad("image", entry.source));
	}

	function enqueue(key: string, media: BoardAssetMedia, load: Load) {
		if (queue.some((task) => task.key === key)) return;
		queue.push({ key, media, load });
		pump();
	}

	function nextTask(): number {
		let best = -1;
		let bestWarm = true;
		let nearest = Number.POSITIVE_INFINITY;
		for (let index = 0; index < queue.length; index += 1) {
			const task = queue[index] as Task;
			if (activeByMedia[task.media] >= limits[task.media]) continue;
			const prefetching = isWarm(task.key);
			if (prefetching && (!bestWarm || warming >= prefetchLimit)) continue;
			const center = entries.get(task.key)?.center;
			const distance = focus && center ? (center.x - focus.x) ** 2 + (center.y - focus.y) ** 2 : 0;
			if (best < 0 || (bestWarm && !prefetching) || distance < nearest) {
				nearest = distance;
				best = index;
				bestWarm = prefetching;
				if (!focus && !prefetching) return index;
			}
		}
		return best;
	}

	function pump() {
		while (!disposed && active < concurrency && queue.length > 0) {
			const taskIndex = nextTask();
			if (taskIndex < 0) return;
			const [task] = queue.splice(taskIndex, 1);
			if (!task) continue;
			const entry = entries.get(task.key);
			if (!entry || entry.loading || (entry.texture && !refinable(task.key, entry))) continue;
			const prefetching = isWarm(task.key);
			entry.loading = true;
			active += 1;
			activeByMedia[task.media] += 1;
			if (prefetching) warming += 1;
			const done = (loaded: Loaded | null, error?: unknown) => {
				active -= 1;
				activeByMedia[task.media] -= 1;
				if (prefetching) warming -= 1;
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
			const { cover, want: edge } = entry;
			const variant = media === "image" ? variantUrl(source, Math.max(edge, SMALLEST_VARIANT), cover) : null;
			const url = variant ?? source;
			const pending = pendingUnloads.get(`${media}:${url}`);
			if (pending) await pending;
			if (disposed) return null;
			if (media === "image" && !variant && useSharedImagePool && Number.isFinite(edge)) {
				const fitted = await loadFittedImageTexture(url, edge, cover).catch(() => null);
				if (fitted) return { texture: fitted, url: "", edge: sharpEdge(fitted, edge, true, cover) };
			}
			const texture = await loadTexture(url, media);
			if (!texture) return null;
			const bound = boundEdge(texture, cover);
			if (media === "image" && shrinkTexture && edge < bound / 2) {
				const longEdge = Math.round((edge * Math.max(texture.width, texture.height)) / bound);
				const small = await shrinkTexture(texture, longEdge).catch(() => null);
				if (small) {
					releaseTexture(media, url, texture);
					return { texture: small, url: "", edge };
				}
			}
			return { texture, url, edge: sharpEdge(texture, edge, Boolean(variant), cover) };
		};
	}
	function resolveFile(key: string, media: BoardUrlMedia, path: string): Start {
		return (entry) => {
			const fresh = entry.attempts > 0;
			entry.loading = true;
			resolveFileUrl(path, fresh ? { fresh } : undefined).then(
				(url) => {
					if (disposed || entries.get(key) !== entry) return;
					if (entry.refs <= 0 && !warm.has(key)) return evict(key, entry);
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

	function starter(item: BoardSceneItem, key: string, source: BoardAssetKeySource): Start | null {
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
				const source = boardAssetKeySource(key);
				return source?.kind === "file" && source.value === path;
			});
			if (stale.length === 0) return;
			pathVersions.set(path, (pathVersions.get(path) ?? 0) + 1);
			keyEpoch += 1;
			for (const key of stale) notify(key);
		},
		invalidateItemAssets() {
			if (options.itemAsset) keyEpoch += 1;
		},
		requestItem(item, edge = Number.POSITIVE_INFINITY) {
			if (disposed) return;
			const key = managedAssetKey(item);
			if (!key || failedModels.has(key)) return;
			const source = boardAssetKeySource(key);
			if (!source) return;
			const entry = ensureEntry(key);
			entry.lastUsedAt = now();
			entry.center = { x: item.frame.x + item.frame.width / 2, y: item.frame.y + item.frame.height / 2 };
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
		getTone(key) {
			return tones.get(key) ?? null;
		},
		focus(point) {
			focus = point;
		},
		acquire(key) {
			unwarmable.delete(key);
			const entry = ensureEntry(key);
			if (entry.refs <= 0) entry.want = 0;
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
			else scheduleTrim();
		},
		prefetch(requests) {
			if (disposed) return;
			const next = new Set<string>();
			let room = budget.maxBytes * PREFETCH_POOL_SHARE;
			for (const entry of entries.values()) if (entry.refs <= 0) room -= footprintOf(entry.texture);
			for (const { item, edge } of requests) {
				const key = managedAssetKey(item);
				if (!key || !Number.isFinite(edge) || unwarmable.has(key) || boardAssetKeySource(key)?.media !== "image") continue;
				const entry = entries.get(key);
				const sharp = entry?.texture && entry.edge >= edge;
				if (entry && (entry.refs > 0 || sharp || entry.error || (entry.loading && !warm.has(key)))) continue;
				room -= edge * edge * 4;
				if (room < 0) break;
				next.add(key);
			}
			for (const key of warm) {
				if (next.has(key)) continue;
				const entry = entries.get(key);
				if (!entry || entry.refs > 0 || entry.loading) continue;
				const index = queue.findIndex((task) => task.key === key);
				if (index >= 0) queue.splice(index, 1);
				if (!entry.texture) evict(key, entry);
			}
			const fresh = new Set([...next].filter((key) => !warm.has(key)));
			warm = next;
			for (const { item, edge } of requests) {
				const key = managedAssetKey(item);
				if (!key || !next.has(key)) continue;
				const entry = ensureEntry(key);
				entry.want = edge;
				entry.center = { x: item.frame.x + item.frame.width / 2, y: item.frame.y + item.frame.height / 2 };
				if (!fresh.delete(key)) continue;
				if (entry.texture) {
					refine(key, entry);
					continue;
				}
				const start = starter(item, key, boardAssetKeySource(key) as BoardAssetKeySource);
				if (!start) {
					warm.delete(key);
					evict(key, entry);
					continue;
				}
				starters.set(key, start);
				start(entry);
			}
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
						return Boolean(entry?.error) || Boolean(entry?.texture && !refinable(key, entry));
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
		stats() {
			let textures = 0;
			let cooling = 0;
			let bytes = 0;
			for (const entry of entries.values()) {
				if (!entry.texture) continue;
				textures += 1;
				if (entry.refs <= 0) cooling += 1;
				bytes += footprintOf(entry.texture);
			}
			let loading = active - warming;
			let prefetching = warming;
			for (const task of queue) {
				if (!entries.has(task.key)) continue;
				if (isWarm(task.key)) prefetching += 1;
				else loading += 1;
			}
			return { textures, cooling, bytes, loading, prefetching };
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		destroy() {
			disposed = true;
			if (trimTimer !== null) clearTimeout(trimTimer);
			trimTimer = null;
			cancelTone?.();
			toneQueue.clear();
			tones.clear();
			queue.length = 0;
			warm.clear();
			unwarmable.clear();
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
