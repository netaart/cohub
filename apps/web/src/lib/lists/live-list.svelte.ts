import { SvelteMap } from "svelte/reactivity";
import { getCacheUserKeyAsync } from "$lib/cache/keys";
import {
	appendPage,
	type Compare,
	type LiveFit,
	mergeFirstPage,
	placeItem,
	sameData,
	shareItems,
} from "$lib/lists/live-list-core";
import { syncStatus } from "$lib/sync/sync-status.svelte";

export type { LiveFit } from "$lib/lists/live-list-core";

export type LivePage<T, E> = {
	items: T[];
	hasMore: boolean;
	cursor: string | null;
	extra: E;
};

export type LiveView<T, E> = {
	readonly items: T[];
	readonly extra: E;
	readonly loading: boolean;
	readonly loadingMore: boolean;
	readonly error: string | null;
};

export type LiveChange<F, T> = {
	id: string;
	fit(filter: F): LiveFit;
	merge(existing: T): T;
	create?(filter: F): T | null;
	settled?: boolean;
};

export type LiveListSource<F, T, E> = {
	name: string;
	pageSize: number;
	memoLimit: number;
	key(filter: F): string;
	id(item: T): string;
	compare(filter: F): Compare<T>;
	emptyExtra(): E;
	mergeExtra(current: E, incoming: E): E;
	fetch(filter: F, cursor: string | null): Promise<LivePage<T, E>>;
	read(filter: F): Promise<LivePage<T, E> | null>;
	write(filter: F, snapshot: LivePage<T, E>): Promise<void>;
	covered?(filter: F): boolean;
	onRows?(
		items: T[],
		origin: { authoritative: boolean; startedAt?: number },
	): void;
};

type Entry<F, T, E> = {
	filter: F;
	items: T[];
	extra: E;
	hasMore: boolean;
	cursor: string | null;
	syncedEpoch: number;
	syncedCovered: boolean;
	stale: boolean;
	paged: boolean;
	loadingMore: boolean;
	error: string | null;
};

type Flight<F, T, E> = {
	promise: Promise<void>;
	epoch: number;
	replay: ((entry: Entry<F, T, E>) => Entry<F, T, E>)[];
};

const STALE_SYNC_DELAY_MS = 400;
const PERSIST_DELAY_MS = 1_000;

export class LiveList<F, T, E> {
	readonly #source: LiveListSource<F, T, E>;
	readonly #emptyView: LiveView<T, E>;
	#entries = new SvelteMap<string, Entry<F, T, E>>();
	#inflight = new Map<string, Flight<F, T, E>>();
	#hydrating = new Map<string, Promise<void>>();
	#watchers = new Map<string, { filter: F; count: number }>();
	#staleTimers = new Map<string, ReturnType<typeof setTimeout>>();
	#persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
	#userKey: string | null = null;
	#generation = 0;
	#stopGap: (() => void) | null = null;

	constructor(source: LiveListSource<F, T, E>) {
		this.#source = source;
		this.#emptyView = Object.freeze({
			items: Object.freeze([]) as unknown as T[],
			extra: source.emptyExtra(),
			loading: true,
			loadingMore: false,
			error: null,
		});
	}

	start() {
		this.#stopGap ??= syncStatus.onGap(() => this.#catchUp());
	}

	stop() {
		this.#stopGap?.();
		this.#stopGap = null;
	}

	reset() {
		this.#generation += 1;
		this.#entries.clear();
		this.#inflight.clear();
		this.#hydrating.clear();
		for (const timer of this.#staleTimers.values()) clearTimeout(timer);
		for (const timer of this.#persistTimers.values()) clearTimeout(timer);
		this.#staleTimers.clear();
		this.#persistTimers.clear();
	}

	view(filter: F): LiveView<T, E> {
		const entry = this.#entries.get(this.#source.key(filter));
		if (!entry) return this.#emptyView;
		return {
			items: entry.items,
			extra: entry.extra,
			loading:
				entry.items.length === 0 && entry.syncedEpoch === 0 && !entry.error,
			loadingMore: entry.loadingMore,
			error: entry.items.length === 0 ? entry.error : null,
		};
	}

	find(id: string): T | undefined {
		return this.findBy((row) => this.#source.id(row) === id);
	}

	findBy(predicate: (item: T) => boolean): T | undefined {
		for (const entry of this.#entries.values()) {
			const item = entry.items.find(predicate);
			if (item) return item;
		}
		return undefined;
	}

	watch(filter: F): () => void {
		const key = this.#source.key(filter);
		const watcher = this.#watchers.get(key);
		if (watcher) watcher.count += 1;
		else this.#watchers.set(key, { filter, count: 1 });
		void this.open(filter, { visible: true });
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const current = this.#watchers.get(key);
			if (!current) return;
			current.count -= 1;
			if (current.count > 0) return;
			this.#watchers.delete(key);
			this.#cancelStaleSync(key);
		};
	}

	async ready(filter: F) {
		await this.#ensureUser();
		await this.#hydrate(filter);
	}

	async open(filter: F, options: { visible?: boolean } = {}) {
		await this.#ensureUser();
		await this.#hydrate(filter);
		const key = this.#source.key(filter);
		const entry = this.#entries.get(key);
		if (entry && this.#isLive(entry)) return;
		if (entry && !options.visible && entry.syncedEpoch === syncStatus.epoch)
			return;
		await this.sync(filter, {
			track:
				Boolean(options.visible && entry?.items.length) &&
				syncStatus.recovering,
		});
	}

	isLive(filter: F) {
		const entry = this.#entries.get(this.#source.key(filter));
		return Boolean(entry && this.#isLive(entry));
	}

	sync(filter: F, options: { track?: boolean } = {}): Promise<void> {
		const key = this.#source.key(filter);
		const pending = this.#inflight.get(key);
		if (pending) {
			const settled =
				pending.epoch === syncStatus.epoch
					? pending.promise
					: pending.promise.then(() => this.sync(filter));
			return options.track ? syncStatus.track(settled) : settled;
		}
		const generation = this.#generation;
		const epoch = syncStatus.epoch;
		const covered = this.#source.covered?.(filter) ?? true;
		const startedAt = Date.now();
		this.#cancelStaleSync(key);
		const flight: Flight<F, T, E> = {
			promise: Promise.resolve(),
			epoch,
			replay: [],
		};
		flight.promise = this.#source
			.fetch(filter, null)
			.then((page) => {
				if (generation !== this.#generation) return;
				const current = this.#entries.get(key) ?? this.#blank(filter);
				const items = shareItems(
					current.items,
					mergeFirstPage(current.items, page.items, {
						id: this.#source.id,
						paged: current.paged,
					}),
					this.#source.id,
				);
				const merged = this.#source.mergeExtra(current.extra, page.extra);
				const extra = sameData(current.extra, merged) ? current.extra : merged;
				let next: Entry<F, T, E> = {
					...current,
					items,
					extra,
					hasMore: current.paged ? current.hasMore : page.hasMore,
					cursor: current.paged ? current.cursor : page.cursor,
					syncedEpoch: epoch,
					syncedCovered: covered,
					stale: false,
					error: null,
				};
				for (const change of flight.replay) next = change(next);
				// The first sync also persists live changes applied to a cached snapshot.
				const changed =
					current.syncedEpoch === 0 ||
					next.items !== current.items ||
					next.extra !== current.extra ||
					next.hasMore !== current.hasMore;
				this.#set(key, next, { persist: changed, fresh: true });
				this.#source.onRows?.(page.items, { authoritative: true, startedAt });
			})
			.catch((error: unknown) => {
				if (generation !== this.#generation) return;
				console.warn(`[${this.#source.name}] sync failed`, error);
				const current = this.#entries.get(key) ?? this.#blank(filter);
				this.#set(key, {
					...current,
					error: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				if (this.#inflight.get(key) === flight) this.#inflight.delete(key);
			});
		this.#inflight.set(key, flight);
		return options.track ? syncStatus.track(flight.promise) : flight.promise;
	}

	async loadMore(filter: F) {
		const key = this.#source.key(filter);
		const entry = this.#entries.get(key);
		if (!entry || entry.loadingMore || !entry.hasMore || !entry.cursor) return;
		const generation = this.#generation;
		const startedAt = Date.now();
		this.#set(key, { ...entry, loadingMore: true });
		try {
			const page = await this.#source.fetch(filter, entry.cursor);
			const current = this.#entries.get(key);
			if (generation !== this.#generation || !current) return;
			this.#set(key, {
				...current,
				items: appendPage(current.items, page.items, this.#source.id),
				extra: this.#source.mergeExtra(current.extra, page.extra),
				hasMore: page.hasMore,
				cursor: page.cursor,
				paged: true,
				loadingMore: false,
			});
			this.#source.onRows?.(page.items, { authoritative: true, startedAt });
		} catch (error) {
			console.warn(`[${this.#source.name}] load more failed`, error);
			const current = this.#entries.get(key);
			if (generation === this.#generation && current)
				this.#set(key, { ...current, loadingMore: false });
		}
	}

	apply(change: LiveChange<F, T>) {
		const apply = (entry: Entry<F, T, E>) => this.#applyChange(entry, change);
		this.#forEachEntry(apply);
	}

	remove(id: string) {
		this.apply({ id, fit: () => "out", merge: (item) => item });
	}

	invalidate(predicate: (filter: F) => boolean = () => true) {
		this.#forEachEntry((entry) =>
			predicate(entry.filter) ? { ...entry, stale: true } : entry,
		);
	}

	#forEachEntry(change: (entry: Entry<F, T, E>) => Entry<F, T, E>) {
		for (const [key, entry] of [...this.#entries]) {
			const next = change(entry);
			if (next !== entry) this.#set(key, next, { persist: true });
			this.#inflight.get(key)?.replay.push(change);
		}
	}

	#applyChange(
		entry: Entry<F, T, E>,
		change: LiveChange<F, T>,
	): Entry<F, T, E> {
		const { id } = this.#source;
		const compare = this.#source.compare(entry.filter);
		const index = entry.items.findIndex((item) => id(item) === change.id);
		const fit = change.fit(entry.filter);
		if (index >= 0) {
			if (fit === "out")
				return {
					...entry,
					items: entry.items.filter((_, i) => i !== index),
				};
			const merged = change.merge(entry.items[index] as T);
			return {
				...entry,
				items: placeItem(entry.items, merged, {
					id,
					compare,
					hasMore: entry.hasMore,
				}),
			};
		}
		if (fit === "out" || fit === "keep") return entry;
		const created =
			fit === "in" ? (change.create?.(entry.filter) ?? null) : null;
		if (!created) return entry.stale ? entry : { ...entry, stale: true };
		return {
			...entry,
			items: placeItem(entry.items, created, {
				id,
				compare,
				hasMore: entry.hasMore,
			}),
			stale: entry.stale || !change.settled,
		};
	}

	#isLive(entry: Entry<F, T, E>) {
		return (
			entry.syncedEpoch === syncStatus.epoch &&
			entry.syncedCovered &&
			!entry.stale &&
			(this.#source.covered?.(entry.filter) ?? true)
		);
	}

	#blank(filter: F): Entry<F, T, E> {
		return {
			filter,
			items: [],
			extra: this.#source.emptyExtra(),
			hasMore: false,
			cursor: null,
			syncedEpoch: 0,
			syncedCovered: false,
			stale: false,
			paged: false,
			loadingMore: false,
			error: null,
		};
	}

	async #ensureUser() {
		const userKey = await getCacheUserKeyAsync();
		if (userKey === this.#userKey) return;
		const switched = this.#userKey !== null;
		this.#userKey = userKey;
		if (!switched) return;
		this.reset();
		for (const { filter } of this.#watchers.values())
			void this.open(filter, { visible: true });
	}

	#hydrate(filter: F): Promise<void> {
		const key = this.#source.key(filter);
		if (this.#entries.has(key)) return Promise.resolve();
		const pending = this.#hydrating.get(key);
		if (pending) return pending;
		const run = this.#readSnapshot(filter).finally(() => {
			if (this.#hydrating.get(key) === run) this.#hydrating.delete(key);
		});
		this.#hydrating.set(key, run);
		return run;
	}

	async #readSnapshot(filter: F) {
		const key = this.#source.key(filter);
		const generation = this.#generation;
		const cached = await this.#source.read(filter).catch(() => null);
		if (generation !== this.#generation || this.#entries.has(key)) return;
		const entry = this.#blank(filter);
		this.#set(
			key,
			cached
				? {
						...entry,
						items: cached.items,
						extra: cached.extra,
						hasMore: cached.hasMore,
					}
				: entry,
		);
		if (cached) this.#source.onRows?.(cached.items, { authoritative: false });
		this.#evict();
	}

	#set(
		key: string,
		entry: Entry<F, T, E>,
		options: { persist?: boolean; fresh?: boolean } = {},
	) {
		const wasStale = !options.fresh && this.#entries.get(key)?.stale;
		this.#entries.set(key, entry);
		if (options.persist && entry.syncedEpoch > 0) this.#schedulePersist(key);
		if (entry.stale && !wasStale && this.#watchers.has(key))
			this.#scheduleStaleSync(key);
	}

	#evict() {
		let excess = this.#entries.size - this.#source.memoLimit;
		if (excess <= 0) return;
		for (const key of [...this.#entries.keys()]) {
			if (excess <= 0) return;
			if (this.#watchers.has(key) || this.#inflight.has(key)) continue;
			this.#entries.delete(key);
			excess -= 1;
		}
	}

	#catchUp() {
		for (const [key, { filter }] of this.#watchers) {
			const entry = this.#entries.get(key);
			void this.sync(filter, { track: Boolean(entry?.items.length) });
		}
	}

	#scheduleStaleSync(key: string) {
		if (this.#staleTimers.has(key)) return;
		this.#staleTimers.set(
			key,
			setTimeout(() => {
				this.#staleTimers.delete(key);
				const watcher = this.#watchers.get(key);
				if (watcher) void this.sync(watcher.filter);
			}, STALE_SYNC_DELAY_MS),
		);
	}

	#cancelStaleSync(key: string) {
		const timer = this.#staleTimers.get(key);
		if (timer) clearTimeout(timer);
		this.#staleTimers.delete(key);
	}

	#schedulePersist(key: string) {
		if (this.#persistTimers.has(key)) return;
		const generation = this.#generation;
		this.#persistTimers.set(
			key,
			setTimeout(() => {
				this.#persistTimers.delete(key);
				const entry = this.#entries.get(key);
				if (generation !== this.#generation || !entry) return;
				const { pageSize } = this.#source;
				void this.#source
					.write(entry.filter, {
						items: entry.items.slice(0, pageSize),
						hasMore: entry.hasMore || entry.items.length > pageSize,
						cursor: null,
						extra: entry.extra,
					})
					.catch((error: unknown) => {
						console.warn(`[${this.#source.name}] persist failed`, error);
					});
			}, PERSIST_DELAY_MS),
		);
	}
}
