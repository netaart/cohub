import { isModelHidden, type ModelCatalogItem } from "#lib/model-catalog.ts";
import { sdk } from "#lib/sdk.ts";

class ModelsCatalogStore {
	items = $state<ModelCatalogItem[] | null>(null);
	visibleItems = $state<ModelCatalogItem[] | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	private loadPromise: Promise<ModelCatalogItem[]> | null = null;

	async load(options: { force?: boolean } = {}) {
		if (this.items && !options.force) return this.items;
		if (this.loadPromise && !options.force) return this.loadPromise;

		this.loading = true;
		this.error = null;
		this.loadPromise = sdk.models
			.list()
			.then((catalog) => {
				const items: ModelCatalogItem[] = [];
				for (const entries of Object.values(catalog)) {
					for (const entry of entries) items.push(entry);
				}
				this.items = items;
				this.visibleItems = items.filter((item) => !isModelHidden(item));
				return items;
			})
			.catch((error) => {
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
