/**
 * Pure eviction policy for the board texture LRU cache.
 *
 * Textures whose cards have scrolled off-screen are not freed immediately:
 * they enter a "cooling" pool (reference count zero but still on the GPU) so a
 * quick pan back is instant instead of re-fetching. The pool is bounded by
 * both entry count and approximate GPU bytes; when a budget is exceeded the least
 * recently used entries are evicted first. Keeping this decision pure makes the
 * release-vs-churn trade-off trivial to test.
 */

export type LruEntry = {
	key: string;
	/** Timestamp (ms) the entry was last used; smaller = older = evict first. */
	lastUsedAt: number;
	/** Approximate GPU footprint in bytes. */
	bytes: number;
};

export type LruBudget = {
	maxCount: number;
	maxBytes: number;
};

/** Default cooling-pool ceiling: 64 images or ~128 MB of GPU memory. */
export const DEFAULT_LRU_BUDGET: LruBudget = {
	maxCount: 64,
	maxBytes: 128 * 1024 * 1024,
};

/**
 * Given the unreferenced (cooling) entries and a budget, return the keys to
 * evict — oldest first — so the remaining pool fits within both limits. Returns
 * an empty array when the pool already fits.
 */
export function selectLruEvictions(
	entries: LruEntry[],
	budget: LruBudget,
): string[] {
	if (entries.length === 0) return [];
	let count = entries.length;
	let bytes = 0;
	for (const entry of entries) bytes += entry.bytes;
	if (count <= budget.maxCount && bytes <= budget.maxBytes) return [];

	const sorted = [...entries].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
	const evict: string[] = [];
	for (const entry of sorted) {
		if (count <= budget.maxCount && bytes <= budget.maxBytes) break;
		evict.push(entry.key);
		count -= 1;
		bytes -= entry.bytes;
	}
	return evict;
}
