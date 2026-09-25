import {
	type MediaInfo,
	type MediaType,
	type MediaVariantSize,
	mediaVariantSize,
	probeMediaInfo,
} from "@neta-art/cohub/media";
import { MemoryLru } from "$lib/cache/memory-lru";

const MAX_CONCURRENT_PROBES = 4;
/** An empty probe (no meta, or a failed request) may be transient; retry it after this. */
const EMPTY_RETRY_MS = 60_000;
/** Probes are tiny and URLs immutable; this bounds memory for huge sessions. */
const cache = new MemoryLru<string, { info: MediaInfo; expiresAt: number }>(
	2_000,
);
const pending = new Map<string, Promise<MediaInfo>>();
const waiting: (() => void)[] = [];
let active = 0;

/** Run with at most `MAX_CONCURRENT_PROBES` in flight; a freed slot passes straight to the next waiter. */
async function withSlot<T>(run: () => Promise<T>): Promise<T> {
	if (active < MAX_CONCURRENT_PROBES) active += 1;
	else await new Promise<void>((resolve) => waiting.push(resolve));
	try {
		return await run();
	} finally {
		const next = waiting.shift();
		if (next) next();
		else active -= 1;
	}
}

export function cachedMediaInfo(url: string): MediaInfo | undefined {
	const entry = cache.get(url);
	if (!entry || entry.expiresAt > Date.now()) return entry?.info;
	cache.delete(url);
	return undefined;
}

/** Probe a URL once (empty results retry after `EMPTY_RETRY_MS`), a few at a time. */
export function loadMediaInfo(
	url: string,
	type: MediaType,
): Promise<MediaInfo> {
	const hit = cachedMediaInfo(url);
	if (hit) return Promise.resolve(hit);
	let request = pending.get(url);
	if (!request) {
		request = withSlot(() => probeMediaInfo(url, { type }))
			.then((info) => {
				const empty = Object.keys(info).length === 0;
				cache.set(url, {
					info,
					expiresAt: empty
						? Date.now() + EMPTY_RETRY_MS
						: Number.POSITIVE_INFINITY,
				});
				return info;
			})
			.finally(() => pending.delete(url));
		pending.set(url, request);
	}
	return request;
}

/** Variant size for `cssPixels` on this screen. */
export function screenVariantSize(cssPixels: number): MediaVariantSize {
	const ratio =
		typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
	return mediaVariantSize(cssPixels * Math.min(ratio, 3));
}
