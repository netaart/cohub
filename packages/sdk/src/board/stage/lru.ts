/**
 * Pure eviction policy for the board texture LRU cache.
 *
 * Textures whose cards have scrolled off-screen are not freed immediately:
 * they enter a "cooling" pool (reference count zero but still on the GPU) so a
 * quick pan back is instant instead of re-fetching. The pool is bounded by
 * both entry count and approximate GPU bytes; when a budget is exceeded the least
 * recently used entries shrink or leave first. Keeping this decision pure makes
 * the release-vs-churn trade-off trivial to test.
 */

export type LruEntry = {
	key: string;
	/** Timestamp (ms) the entry was last used; smaller = older = evict first. */
	lastUsedAt: number;
	/** Approximate GPU footprint in bytes. */
	bytes: number;
	shrunkBytes?: number;
};

export type LruBudget = {
	maxCount: number;
	maxBytes: number;
};

/**
 * Default cooling-pool ceiling: 2048 images or ~192 MB of GPU memory. Bytes
 * bind first for full-size textures; shrunk copies let many more stay warm.
 */
export const DEFAULT_LRU_BUDGET: LruBudget = {
	maxCount: 2048,
	maxBytes: 192 * 1024 * 1024,
};
export const COMPACT_LRU_BUDGET: LruBudget = {
	maxCount: 1024,
	maxBytes: 96 * 1024 * 1024,
};

export type LruTrim = { shrink: string[]; evict: string[] };

export function planLruTrim(entries: LruEntry[], budget: LruBudget): LruTrim {
	let bytes = 0;
	for (const entry of entries) bytes += entry.bytes;
	const over = entries.length - budget.maxCount;
	if (over <= 0 && bytes <= budget.maxBytes) return { shrink: [], evict: [] };

	const sorted = [...entries].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
	const evict = sorted.slice(0, Math.max(0, over));
	const kept = sorted.slice(evict.length);
	for (const entry of evict) bytes -= entry.bytes;
	const shrink = new Set<LruEntry>();
	for (const entry of kept) {
		if (bytes <= budget.maxBytes) break;
		if (entry.shrunkBytes === undefined || entry.shrunkBytes >= entry.bytes) continue;
		shrink.add(entry);
		bytes -= entry.bytes - entry.shrunkBytes;
	}
	for (const entry of kept) {
		if (bytes <= budget.maxBytes) break;
		bytes -= shrink.delete(entry) ? (entry.shrunkBytes as number) : entry.bytes;
		evict.push(entry);
	}
	return { shrink: [...shrink].map(({ key }) => key), evict: evict.map(({ key }) => key) };
}

export function selectLruEvictions(entries: LruEntry[], budget: LruBudget): string[] {
	return planLruTrim(entries.map(({ key, lastUsedAt, bytes }) => ({ key, lastUsedAt, bytes })), budget).evict;
}
