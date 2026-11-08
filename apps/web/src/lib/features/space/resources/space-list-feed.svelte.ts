import { getCacheUserKey } from "$lib/cache/keys";
import { MemoryLru } from "$lib/cache/memory-lru";
import {
	readSpaceResourceList,
	writeSpaceResourceList,
} from "$lib/cache/repositories/space-resource-lists-repo";

const snapshots = new MemoryLru<string, unknown[]>(48);

/** Memory, then IndexedDB, then a silent refresh. Only server data is cached. */
export abstract class SpaceListFeed<T> {
	readonly spaceId: string;
	readonly #kind: string;
	readonly #key: string;
	#started = false;
	#disposed = false;
	#version = 0;

	items = $state.raw<T[]>([]);
	ready = $state(false);
	refreshing = $state(false);
	failed = $state(false);

	constructor(spaceId: string, kind: string) {
		this.spaceId = spaceId;
		this.#kind = kind;
		this.#key = `${getCacheUserKey()}:${spaceId}:${kind}`;
		const snapshot = snapshots.get(this.#key) as T[] | undefined;
		if (snapshot) {
			this.items = snapshot;
			this.ready = true;
		}
	}

	protected abstract fetchItems(): Promise<T[]>;

	protected beginFetch() {}

	protected reconcile(items: T[]) {
		return items;
	}

	get started() {
		return this.#started;
	}

	start() {
		if (this.#started || this.#disposed) return;
		this.#started = true;
		void this.#restoreThenRefresh();
	}

	dispose() {
		this.#disposed = true;
		this.#version += 1;
	}

	async refresh() {
		if (this.#disposed || !this.#started) return;
		const version = ++this.#version;
		this.refreshing = true;
		this.beginFetch();
		try {
			const items = await this.fetchItems();
			if (version !== this.#version) return;
			this.commit(this.reconcile(items));
			this.failed = false;
		} catch (error) {
			if (version !== this.#version) return;
			this.failed = true;
			console.warn(`[space-list] failed to refresh ${this.#kind}`, error);
		} finally {
			if (version === this.#version) {
				this.refreshing = false;
				this.ready = true;
			}
		}
	}

	protected commit(items: T[]) {
		if (this.#disposed) return;
		this.items = items;
		this.ready = true;
		snapshots.set(this.#key, items);
		void writeSpaceResourceList(this.spaceId, this.#kind, items);
	}

	async #restoreThenRefresh() {
		if (!this.ready) {
			const version = this.#version;
			const cached = await readSpaceResourceList<T>(this.spaceId, this.#kind);
			if (version === this.#version && !this.ready && cached) {
				this.items = cached;
				this.ready = true;
				snapshots.set(this.#key, cached);
			}
		}
		await this.refresh();
	}
}
