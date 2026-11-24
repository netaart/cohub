import {
	type BoardAssetKeySource,
	type BoardAssetMedia,
	type BoardAssetRef,
	type BoardAssetSource,
	type BoardSceneItem,
	boardAssetKey,
	boardAssetKeySource,
	boardAssetRefKey,
	boardMediaNaturalSize,
	boardModelCover,
	boardModelFormat,
	isBoardModelObject,
} from "../model/index.js";
import { mediaHost } from "@cohub/protocol/core";
import type { BoardModelView } from "@cohub/protocol/board-model";
import type { ModelFormat } from "@cohub/protocol/fs";
import {
	fitsVideoFrames,
	imageVariantUrl,
	loadMediaInfo,
	loadMediaSize,
	MEDIA_VARIANT_MAX,
	MEDIA_VARIANT_SIZES,
	type MediaVariantSize,
	mediaVariantSize,
	variantSource,
	videoFrameUrl,
} from "../../media.js";
import { Texture } from "pixi.js";
import type { ModelStill } from "../render/model3d/index.js";
import { defaultBoardDeviceBudget, readBoardDeviceSignals } from "./device.js";
import { createBoardModelPreviews } from "./model-previews.js";
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
	type BoardTextureTone,
	readTextureTone,
	shrinkBoardTexture,
	unloadBoardImageTexture,
} from "./texture-pool.js";
import {
	loadVideoThumbnailTexture,
	videoTextureNaturalSize,
} from "../render/index.js";

type BoardUrlMedia = "image" | "video";

const SMALLEST_VARIANT = MEDIA_VARIANT_SIZES[0];

function variantUrl(source: string, edge: number, cover: boolean): string | null {
	if (!(edge <= MEDIA_VARIANT_MAX)) return null;
	const url = imageVariantUrl(source, edge as MediaVariantSize, cover ? "cover" : "contain");
	return url && url !== source ? url : null;
}

const frameAspects = new Map<string, number>();
const FRAME_ASPECT_LIMIT = 2048;
const FRAME_SLACK = 1.25;

function learnAspect(source: string, { width, height }: Size) {
	if (!width || !height || frameAspects.has(source)) return;
	frameAspects.set(source, width / height);
	if (frameAspects.size > FRAME_ASPECT_LIMIT) frameAspects.delete(frameAspects.keys().next().value as string);
}

const FRAME_FACTS_WAIT_MS = 300;

async function factSize(source: string): Promise<Size | undefined> {
	const timeout = new Promise<null>((resolve) => setTimeout(resolve, FRAME_FACTS_WAIT_MS, null));
	const info = await Promise.race([loadMediaInfo(source, "video"), timeout]);
	return info?.width && info.height ? { width: info.width, height: info.height } : undefined;
}

function frameUrl(source: string, edge: number, natural: Size | null | undefined): string | null {
	return videoFrameUrl(source, mediaVariantSize(edge), { natural, aspect: natural ? null : frameAspects.get(source) });
}

function textureMedia(media: BoardAssetMedia, url: string): BoardAssetMedia {
	return media === "video" && url && variantSource(url)?.type === "video" ? "image" : media;
}

function slotOf(media: BoardUrlMedia, source: string, frameless = false): BoardAssetMedia {
	return media === "video" && !frameless && videoFrameUrl(source, SMALLEST_VARIANT) ? "image" : media;
}

const FRAMELESS = new Error("Video frame failed");
const NO_PREVIEW = new Error("No preview without decoding the video");

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
	path: string | null;
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
	frameless: boolean;
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
	view?: BoardModelView;
	animation?: string;
};

export type BoardModelPreviews = {
	load: (request: BoardModelPreviewRequest) => Promise<ModelStill>;
	maxBytes?: number;
};

export type BoardAssetManager = {
	assetKey: (item: BoardSceneItem) => string | null;
	invalidatePath: (path: string) => void;
	invalidateItemAssets: (ids?: Iterable<string>) => void;
	requestItem: (item: BoardSceneItem, edge?: number) => void;
	/** World point used to prioritize queued loads. */
	focus: (point: { x: number; y: number } | null) => void;
	getTexture: (key: string) => Texture | null;
	getNaturalSize: (key: string) => Size | null;
	getTone: (key: string) => number | null;
	isCutout: (key: string) => boolean;
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
	subscribeModelStills: (listener: (key: string, still: ModelStill) => void) => () => void;
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

function objectCoverKey(item: BoardSceneItem): string | null {
	const cover = boardModelCover(item);
	return cover && boardAssetRefKey({ src: cover });
}

function footprintOf(texture: Texture | null): number {
	if (!texture) return 0;
	const width = texture.width || 0;
	const height = texture.height || 0;
	return width * height * 4;
}

export type BoardAssetManagerOptions = {
	/** Resolve a Space file path to a URL a texture can load from; null when unavailable. */
	resolveFile: BoardAssetSource["resolveFile"];
	subscribe?: BoardAssetSource["subscribe"];
	/** undefined keeps the built-in rule, null shows none; cached until `invalidateItemAssets`. */
	itemAsset?: (item: BoardSceneItem) => BoardAssetRef | null | undefined;
	concurrency?: number;
	videoConcurrency?: number;
	loadVideoPreviews?: boolean;
	modelPreviews?: BoardModelPreviews | false;
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
	readTone?: ((texture: Texture) => Promise<BoardTextureTone | null>) | null;
	now?: () => number;
};

export function createBoardAssetManager(
	options: BoardAssetManagerOptions,
): BoardAssetManager {
	const device = defaultBoardDeviceBudget();
	const { saveData } = readBoardDeviceSignals();
	const loadVideoPreviews = options.loadVideoPreviews ?? !saveData;
	const modelPreviews = options.modelPreviews ?? (!saveData && typeof createImageBitmap === "function" ? createBoardModelPreviews(options) : false);
	const concurrency = Math.max(1, options.concurrency ?? device.concurrency);
	const limits: Record<BoardAssetMedia, number> = {
		image: concurrency,
		video: Math.max(1, Math.min(options.videoConcurrency ?? 2, concurrency)),
		model: 1,
	};
	const budget = options.lruBudget ?? device.lru;
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
	function releaseTexture(asset: BoardAssetMedia, url: string, texture: Texture | null) {
		const media = textureMedia(asset, url);
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

	const entries = new Map<string, Entry>();
	const keysByPath = new Map<string, Set<string>>();
	const pathVersions = new Map<string, number>();
	const starters = new Map<string, Start>();
	const unavailable = new Set<string>();
	const queue: Task[] = [];
	const listeners = new Set<(key: string, change: BoardAssetChange) => void>();
	const stillListeners = new Set<(key: string, still: ModelStill) => void>();
	let active = 0;
	const activeByMedia: Record<BoardAssetMedia, number> = {
		image: 0,
		video: 0,
		model: 0,
	};
	let disposed = false;
	let stopSource: (() => void) | null = null;
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

	const tones = new Map<string, BoardTextureTone>();
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

	type KeyRecord = { epoch: number; itemEpoch: number; base: string | null; path: string | null; version: number; key: string | null; natural: Size | null };
	const keys = new WeakMap<BoardSceneItem, KeyRecord>();
	const itemEpochs = new Map<string, number>();
	let keyEpoch = 0;
	function managedAssetKey(item: BoardSceneItem): string | null {
		const itemEpoch = itemEpochs.get(item.id) ?? 0;
		let record = keys.get(item);
		if (record?.epoch !== keyEpoch || record.itemEpoch !== itemEpoch) {
			const { key: base, natural } = resolveAsset(item);
			const source = base ? boardAssetKeySource(base) : null;
			const path = source?.kind === "file" ? source.value : null;
			record = { epoch: keyEpoch, itemEpoch, base, path, version: 0, key: base, natural };
			keys.set(item, record);
		}
		if (record.path !== null) {
			const version = pathVersions.get(record.path) ?? 0;
			if (version !== record.version) {
				record.version = version;
				record.key = `local:${version}:${record.base}`;
			}
		}
		return record.key;
	}

	function resolveAsset(item: BoardSceneItem): { key: string | null; natural: Size | null } {
		const asset = options.itemAsset?.(item);
		const natural = (asset === undefined ? boardMediaNaturalSize(item) : asset?.natural) ?? null;
		const key = asset !== undefined ? asset && boardAssetRefKey(asset) : isBoardModelObject(item) ? objectCoverKey(item) : boardAssetKey(item);
		const source = key ? boardAssetKeySource(key) : null;
		if (source?.media === "video" && source.kind === "url" && !loadVideoPreviews && slotOf("video", source.value) === "video")
			return { key: null, natural };
		if (source?.media === "model" && !modelPreviewable(item)) return { key: null, natural };
		return { key, natural };
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
			const path = source?.kind === "file" ? source.value : null;
			entry = {
				media: source?.media ?? "image",
				cover: source?.fit === "cover",
				path,
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
				frameless: false,
				retryAt: 0,
				retryTimer: null,
				lastUsedAt: now(),
			};
			entries.set(key, entry);
			if (path !== null) {
				const keyed = keysByPath.get(path);
				if (keyed) keyed.add(key);
				else keysByPath.set(path, new Set([key]));
			}
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
		if (entry.path === null) return;
		const keyed = keysByPath.get(entry.path);
		keyed?.delete(key);
		if (keyed?.size === 0) keysByPath.delete(entry.path);
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

	function shrunkFootprint({ media, texture, url }: Entry): number | undefined {
		if (!shrinkTexture || textureMedia(media, url ?? "") !== "image" || !texture) return undefined;
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
			const decoded = videoTextureNaturalSize(texture);
			if (decoded) entry.natural = decoded;
			else if (loaded.edge === Number.POSITIVE_INFINITY && !variantSource(loaded.url))
				entry.natural = { width: texture.width, height: texture.height };
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
		if (error === FRAMELESS && entry.source && entry.refs > 0)
			return enqueue(key, "video", textureLoad("video", entry.source));
		const final = entry.media === "model" || error === NO_PREVIEW;
		entry.error = true;
		entry.attempts += 1;
		entry.retryAt = now() + Math.min(1000 * 2 ** entry.attempts, MAX_RETRY_DELAY);
		if (error !== NO_PREVIEW) console.warn(`[board] failed to load preview for ${key}`, error);
		if (final) unavailable.add(key);
		if (entry.refs <= 0) evict(key, entry);
		else {
			if (!final) scheduleRetry(key, entry);
			notify(key);
		}
	}

	function refinable(key: string, entry: Entry) {
		if (entry.media === "model" || !(entry.refs > 0 || warm.has(key)) || !entry.texture || !entry.source || entry.want <= entry.edge) return false;
		return entry.media === "image" || frameUrl(entry.source, entry.want, entry.natural) !== entry.url;
	}

	function refine(key: string, entry: Entry) {
		if (entry.loading || !entry.source || entry.media === "model") return;
		if (refinable(key, entry)) enqueue(key, slotOf(entry.media, entry.source, entry.frameless), textureLoad(entry.media, entry.source));
		else if (entry.media === "video" && entry.natural === undefined && entry.texture && boundEdge(entry.texture, false) < entry.want && !fitsVideoFrames(entry.source))
			probeNaturalSize(key, entry, entry.source);
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

	async function loadSized(entry: Entry, url: string, media: BoardUrlMedia, resized: boolean, slack = 2): Promise<Loaded | null> {
		const { cover, want: edge } = entry;
		const pending = pendingUnloads.get(`${media}:${url}`);
		if (pending) await pending;
		if (disposed) return null;
		const texture = await loadTexture(url, media);
		if (!texture) return null;
		const bound = boundEdge(texture, cover);
		if (media === "image" && shrinkTexture && edge < bound / slack) {
			const longEdge = Math.round((edge * Math.max(texture.width, texture.height)) / bound);
			const small = await shrinkTexture(texture, longEdge).catch(() => null);
			if (small) {
				releaseTexture(media, url, texture);
				return { texture: small, url: "", edge };
			}
		}
		return { texture, url, edge: sharpEdge(texture, edge, resized, cover) };
	}

	function textureLoad(media: BoardUrlMedia, source: string): Load {
		return async (entry) => {
			entry.source = source;
			const { cover, want: edge } = entry;
			if (media === "video") {
				if (entry.natural === undefined && !entry.frameless && mediaHost(source)?.metaHeaders) entry.natural = await factSize(source);
				const frame = entry.frameless ? null : frameUrl(source, edge, entry.natural);
				if (frame) {
					const loaded = await loadSized(entry, frame, "image", true, FRAME_SLACK).catch(() => null);
					if (loaded) {
						learnAspect(source, loaded.texture);
						if (!entry.natural && !fitsVideoFrames(source) && loaded.edge === Number.POSITIVE_INFINITY)
							loaded.edge = boundEdge(loaded.texture, false);
					}
					if (loaded || entry.texture) return loaded;
					entry.frameless = true;
					throw FRAMELESS;
				}
				if (!loadVideoPreviews) throw NO_PREVIEW;
				return loadSized(entry, source, "video", false);
			}
			const variant = variantUrl(source, Math.max(edge, SMALLEST_VARIANT), cover);
			if (!variant && useSharedImagePool && Number.isFinite(edge)) {
				const fitted = await loadFittedImageTexture(source, edge, cover).catch(() => null);
				if (fitted) return { texture: fitted, url: "", edge: sharpEdge(fitted, edge, true, cover) };
			}
			return loadSized(entry, variant ?? source, "image", Boolean(variant));
		};
	}
	function startFile(key: string, media: BoardUrlMedia, path: string): Start {
		return (entry) => {
			const fresh = entry.attempts > 0;
			entry.loading = true;
			options.resolveFile(path, fresh ? { fresh } : undefined).then(
				(file) => {
					if (disposed || entries.get(key) !== entry) return;
					if (entry.refs <= 0 && !warm.has(key)) return evict(key, entry);
					if (!file) return adopt(key, entry, null, new Error(`Unavailable file: ${path}`));
					const { url, media: facts } = file;
					if (facts && !entry.natural) entry.natural = { width: facts.width, height: facts.height };
					entry.loading = false;
					enqueue(key, slotOf(media, url, entry.frameless), textureLoad(media, url));
				},
				(error: unknown) => {
					if (!disposed) adopt(key, entry, null, error);
				},
			);
		};
	}

	function probeNaturalSize(key: string, entry: Entry, source: string) {
		entry.natural = null;
		void loadMediaSize(source, entry.media === "video" ? "video" : "image").then((size) => {
			if (disposed || entries.get(key) !== entry || !size) return;
			entry.natural = size;
			refine(key, entry);
			notify(key);
		});
	}

	function modelPreviewable(item: BoardSceneItem) {
		if (!modelPreviews) return false;
		const size = item.type === "file" ? item.props.snapshot?.size : undefined;
		return size === undefined || size <= (modelPreviews.maxBytes ?? Number.POSITIVE_INFINITY);
	}

	function modelLoader(item: BoardSceneItem, key: string): Load | null {
		if (!modelPreviews || item.type !== "file") return null;
		const { src, snapshot, model } = item.props;
		const format = boardModelFormat(src, snapshot?.mimeType);
		if (!format) return null;
		const request = { key, src, format, size: snapshot?.size, view: model?.view, animation: model?.animation };
		return async () => {
			const still = await modelPreviews.load(request);
			for (const listener of stillListeners) listener(key, still);
			return { texture: Texture.from(still.image), url: "", edge: Number.POSITIVE_INFINITY };
		};
	}

	function starter(item: BoardSceneItem, key: string, source: BoardAssetKeySource): Start | null {
		if (source.media === "model") {
			const load = modelLoader(item, key);
			return load ? () => enqueue(key, "model", load) : null;
		}
		const media = source.media;
		if (source.kind === "file") return startFile(key, media, source.value);
		const load = textureLoad(media, source.value);
		return (entry) => enqueue(key, slotOf(media, source.value, entry.frameless), load);
	}

	const manager: BoardAssetManager = {
		assetKey: managedAssetKey,
		invalidatePath(path) {
			const stale = keysByPath.get(path);
			if (disposed || !stale) return;
			pathVersions.set(path, (pathVersions.get(path) ?? 0) + 1);
			for (const key of [...stale]) notify(key);
		},
		invalidateItemAssets(ids) {
			if (!options.itemAsset) return;
			if (!ids) {
				keyEpoch += 1;
				itemEpochs.clear();
				return;
			}
			for (const id of ids) itemEpochs.set(id, (itemEpochs.get(id) ?? 0) + 1);
		},
		requestItem(item, edge = Number.POSITIVE_INFINITY) {
			if (disposed) return;
			const key = managedAssetKey(item);
			if (!key || unavailable.has(key)) return;
			const source = boardAssetKeySource(key);
			if (!source) return;
			const entry = ensureEntry(key);
			entry.lastUsedAt = now();
			if (!entry.natural) entry.natural = keys.get(item)?.natural ?? entry.natural;
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
			return tones.get(key)?.color ?? null;
		},
		isCutout(key) {
			return tones.get(key)?.cutout ?? false;
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
		prefetch(input) {
			if (disposed) return;
			const merged = new Map<string, BoardAssetPrefetch>();
			for (const request of input) {
				const key = managedAssetKey(request.item);
				if (!key || !Number.isFinite(request.edge)) continue;
				const known = merged.get(key);
				if (!known || known.edge < request.edge) merged.set(key, known ? { item: known.item, edge: request.edge } : request);
			}
			const requests = [...merged.values()];
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
		subscribeModelStills(listener) {
			stillListeners.add(listener);
			return () => {
				stillListeners.delete(listener);
			};
		},
		destroy() {
			disposed = true;
			stopSource?.();
			if (trimTimer !== null) clearTimeout(trimTimer);
			trimTimer = null;
			cancelTone?.();
			toneQueue.clear();
			tones.clear();
			queue.length = 0;
			warm.clear();
			unwarmable.clear();
			listeners.clear();
			stillListeners.clear();
			pathVersions.clear();
			itemEpochs.clear();
			starters.clear();
			unavailable.clear();
			for (const [key, entry] of entries) evict(key, entry);
			entries.clear();
			for (const release of [...retiring]) release();
		},
	};

	stopSource = options.subscribe?.((path) => manager.invalidatePath(path)) ?? null;
	return manager;
}
