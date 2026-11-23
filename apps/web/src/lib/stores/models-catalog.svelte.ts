import { isModelHidden, type ModelCatalogItem } from "#lib/model-catalog.ts";
import { sdk } from "#lib/sdk.ts";

/** Listings carry per-user offers that operators can change at any time; refresh them in the background. */
const STALE_MS = 5 * 60 * 1000;

class ModelsCatalogStore {
	items = $state<ModelCatalogItem[] | null>(null);
	visibleItems = $state<ModelCatalogItem[] | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	private loadPromise: Promise<ModelCatalogItem[]> | null = null;
	private loadedAt = 0;

	async load(options: { force?: boolean } = {}) {
		if (this.items && !options.force) {
			// A stale catalog answers at once and refreshes silently.
			if (!this.loadPromise && Date.now() - this.loadedAt >= STALE_MS)
				void this.fetch().catch(() => undefined);
			return this.items;
		}
		if (this.loadPromise && !options.force) return this.loadPromise;
		return this.fetch();
	}

	private fetch() {
		this.loading = !this.items;
		this.error = null;
		this.loadPromise = sdk.models
			.list()
			.then((catalog) => {
				const items: ModelCatalogItem[] = [];
				for (const entries of Object.values(catalog)) {
					for (const entry of entries) items.push(entry);
				}
				this.items = items;
				this.loadedAt = Date.now();
				this.visibleItems = items.filter((item) => !isModelHidden(item));
				return items;
			})
			.catch((error) => {
				if (this.items) throw error;
				this.error =
					error instanceof Error
						? error.message
						: "Failed to load models catalog";
				throw error;
			})
			.finally(() => {
				this.loading = false;
				this.loadPromise = null;
			});

		return this.loadPromise;
	}
}

export const modelsCatalogStore = new ModelsCatalogStore();
