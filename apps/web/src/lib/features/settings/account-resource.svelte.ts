import { handleUnauthorizedError } from "$lib/auth-redirect";
import {
	canUseUserScopedCache,
	getCacheUserKey,
	getCacheUserKeyAsync,
} from "$lib/cache/keys";
import {
	readAccountSnapshot,
	writeAccountSnapshot,
} from "$lib/features/settings/account-snapshots";

const FRESH_MS = 30_000;

export class AccountResource<T> {
	readonly #name: string;
	readonly #fetch: () => Promise<T>;
	readonly #stored = new Map<string, T | null>();
	#owner = $state<string | null>(null);
	#data = $state.raw<T | null>(null);
	#error = $state.raw<unknown>(null);
	#refreshing = $state(false);
	#fetchedAt = 0;
	#generation = 0;
	#inflight: Promise<void> | null = null;

	constructor(name: string, fetch: () => Promise<T>) {
		this.#name = name;
		this.#fetch = fetch;
	}

	get data(): T | null {
		const owner = getCacheUserKey();
		return owner === this.#owner ? this.#data : this.#peek(owner);
	}

	get error(): unknown {
		return getCacheUserKey() === this.#owner ? this.#error : null;
	}

	errorMessage(fallback: string): string {
		const error = this.error;
		if (error === null) return "";
		return error instanceof Error && error.message ? error.message : fallback;
	}

	get loading() {
		return this.data === null && this.error === null;
	}

	get refreshing() {
		return getCacheUserKey() === this.#owner && this.#refreshing;
	}

	async load({ force = false } = {}): Promise<void> {
		const owner = await getCacheUserKeyAsync();
		this.#adopt(owner);
		if (!force && this.#inflight) return this.#inflight;
		if (!force && Date.now() - this.#fetchedAt < FRESH_MS) return;
		const generation = ++this.#generation;
		this.#refreshing = true;
		const request = this.#fetch()
			.then(
				(data) => {
					if (generation !== this.#generation) return;
					this.#error = null;
					this.#commit(owner, data);
				},
				async (error: unknown) => {
					if (generation !== this.#generation) return;
					if (await handleUnauthorizedError(error)) return;
					this.#error = error;
					console.warn(`[account] Failed to load ${this.#name}`, error);
				},
			)
			.finally(() => {
				if (generation !== this.#generation) return;
				this.#refreshing = false;
				this.#inflight = null;
			});
		this.#inflight = request;
		return request;
	}

	update(recipe: (data: T) => T) {
		const owner = getCacheUserKey();
		if (owner !== this.#owner || this.#data === null) return;
		this.#settle();
		this.#commit(owner, recipe(this.#data));
	}

	#peek(owner: string): T | null {
		if (!canUseUserScopedCache(owner)) return null;
		if (!this.#stored.has(owner))
			this.#stored.set(owner, readAccountSnapshot<T>(owner, this.#name));
		return this.#stored.get(owner) ?? null;
	}

	#adopt(owner: string) {
		if (owner === this.#owner) return;
		this.#settle();
		this.#fetchedAt = 0;
		this.#owner = owner;
		this.#data = this.#peek(owner);
		this.#error = null;
	}

	#settle() {
		this.#generation += 1;
		this.#inflight = null;
		this.#refreshing = false;
	}

	#commit(owner: string, data: T) {
		this.#data = data;
		this.#fetchedAt = Date.now();
		this.#stored.set(owner, data);
		if (canUseUserScopedCache(owner))
			writeAccountSnapshot(owner, this.#name, data);
	}
}
