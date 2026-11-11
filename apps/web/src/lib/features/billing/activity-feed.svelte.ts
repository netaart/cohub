import { getCacheUserKey } from "$lib/cache/keys";
import { AccountResource } from "$lib/features/settings/account-resource.svelte";

export type FeedPage<T> = { items: T[]; nextCursor: string | null };

export class ActivityFeed<T extends { id: string }> {
	readonly #first: AccountResource<FeedPage<T>>;
	readonly #fetch: (cursor: string | null) => Promise<FeedPage<T>>;
	#loaded = $state.raw<{ owner: string; items: T[]; cursor: string | null }>({
		owner: "",
		items: [],
		cursor: null,
	});
	#more: Promise<void> | null = null;
	loadingMore = $state(false);
	moreFailed = $state(false);

	constructor(
		name: string,
		fetch: (cursor: string | null) => Promise<FeedPage<T>>,
	) {
		this.#fetch = fetch;
		this.#first = new AccountResource(name, () => fetch(null));
	}

	get #older(): T[] {
		return this.#loaded.owner === getCacheUserKey() ? this.#loaded.items : [];
	}

	readonly items = $derived.by(() => {
		const first = this.#first.data?.items ?? [];
		const older = this.#older;
		if (!older.length) return first;
		const seen = new Set<string>();
		const items: T[] = [];
		for (const item of [...first, ...older]) {
			if (seen.has(item.id)) continue;
			seen.add(item.id);
			items.push(item);
		}
		return items;
	});

	get #nextCursor() {
		return this.#older.length
			? this.#loaded.cursor
			: (this.#first.data?.nextCursor ?? null);
	}

	get hasMore() {
		return this.#nextCursor != null;
	}

	get loading() {
		return this.#first.loading;
	}

	get error() {
		return this.#first.error;
	}

	load() {
		return this.#first.load();
	}

	refresh() {
		const first = this.#first.data;
		const older = this.#older;
		if (first && older.length)
			this.#loaded = { ...this.#loaded, items: [...first.items, ...older] };
		return this.#first.load({ force: true });
	}

	loadMore() {
		if (this.#more || !this.hasMore) return this.#more;
		const owner = getCacheUserKey();
		const cursor = this.#nextCursor;
		this.loadingMore = true;
		this.moreFailed = false;
		this.#more = this.#fetch(cursor)
			.then((page) => {
				if (owner !== getCacheUserKey()) return;
				this.#loaded = {
					owner,
					items: [...this.#older, ...page.items],
					cursor: page.nextCursor,
				};
			})
			.catch(() => {
				this.moreFailed = true;
			})
			.finally(() => {
				this.loadingMore = false;
				this.#more = null;
			});
		return this.#more;
	}
}
