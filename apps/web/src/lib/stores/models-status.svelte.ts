import type { ModelStatusResponse } from "@cohub/protocol/model/status";
import { sdk } from "#lib/sdk.ts";

class ModelsStatusStore {
	status = $state<ModelStatusResponse | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	private loadPromise: Promise<ModelStatusResponse> | null = null;
	/** Wall-clock time of the last successful load, to drive background refresh. */
	private loadedAt = 0;
	private readonly refreshIntervalMs = 60_000;

	async load(options: { force?: boolean } = {}) {
		if (this.status && !options.force) {
			// Silently refresh in the background when stale; return cached immediately
			// so the UI never blocks on status (local-first, non-disruptive).
			if (Date.now() - this.loadedAt > this.refreshIntervalMs) {
				void this.refresh();
			}
			return this.status;
		}
		if (this.loadPromise && !options.force) return this.loadPromise;

		this.loading = true;
		this.error = null;
		this.loadPromise = sdk.models
			.status()
			.then((response) => {
				this.status = response;
				this.loadedAt = Date.now();
				return response;
			})
			.catch((error) => {
				this.error =
					error instanceof Error
						? error.message
						: "Failed to load model status";
				throw error;
			})
			.finally(() => {
				this.loading = false;
				this.loadPromise = null;
			});

		return this.loadPromise;
	}

	/** Background refresh without flipping loading state — avoids UI thrash. */
	private async refresh() {
		try {
			const response = await sdk.models.status();
			this.status = response;
			this.loadedAt = Date.now();
		} catch {
			// keep stale data on background refresh failure
		}
	}

	getEntry(modelId: string) {
		return this.status?.models[modelId] ?? null;
	}
}

export const modelsStatusStore = new ModelsStatusStore();
