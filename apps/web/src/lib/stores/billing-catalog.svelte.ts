import type { BillingCatalog } from "@neta-art/cohub";
import { sdk } from "$lib/sdk";
import { authStore } from "$lib/stores/auth.svelte";

class BillingCatalogStore {
	catalog = $state<BillingCatalog | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	private loadPromise: Promise<BillingCatalog> | null = null;
	private loadedAt = 0;
	private scope: string | null = null;
	private readonly staleMs = 5 * 60 * 1000;
	private requestVersion = 0;
	private deadlineTimer: ReturnType<typeof setTimeout> | null = null;

	private currentScope() {
		return authStore.isAuthenticated ? (authStore.userUuid ?? "auth") : "anon";
	}

	async load(
		options: { force?: boolean; silent?: boolean } = {},
	): Promise<BillingCatalog> {
		const scope = this.currentScope();
		const fresh =
			this.catalog &&
			this.scope === scope &&
			Date.now() - this.loadedAt < this.staleMs;
		if (fresh && !options.force) return this.catalog as BillingCatalog;
		if (this.loadPromise && this.scope === scope && !options.force)
			return this.loadPromise;

		const version = ++this.requestVersion;
		if (this.scope !== scope) this.catalog = null;
		this.scope = scope;
		if (!options.silent) this.loading = true;
		this.error = null;
		this.loadPromise = sdk.billing
			.getCatalog()
			.then(({ catalog }) => {
				if (version !== this.requestVersion || scope !== this.currentScope())
					return catalog;
				this.catalog = catalog;
				this.scope = scope;
				this.loadedAt = Date.now();
				this.scheduleDeadline(catalog);
				return catalog;
			})
			.catch((error) => {
				if (version !== this.requestVersion || scope !== this.currentScope())
					throw error;
				this.error =
					error instanceof Error
						? error.message
						: "Failed to load billing options";
				throw error;
			})
			.finally(() => {
				if (version !== this.requestVersion) return;
				this.loading = false;
				this.loadPromise = null;
			});

		return this.loadPromise;
	}

	private scheduleDeadline(catalog: BillingCatalog) {
		if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
		const deadlines = catalog.currentSubscriptions.flatMap((subscription) => {
			return [
				subscription.currentPeriodEnd,
				subscription.renewalRecovery?.effectiveEndsAt,
			]
				.filter(
					(value): value is string =>
						Boolean(value) && Date.parse(value as string) > Date.now(),
				)
				.map((value) => Date.parse(value));
		});
		if (!deadlines.length || typeof window === "undefined") return;
		this.deadlineTimer = setTimeout(
			() => {
				this.loadedAt = 0;
				window.dispatchEvent(new Event("cohub:billing-refresh"));
				void this.refresh().catch(() => undefined);
			},
			Math.min(2_147_483_647, Math.max(0, Math.min(...deadlines) - Date.now())),
		);
	}

	refresh(): Promise<BillingCatalog> {
		return this.load({ force: true, silent: true });
	}

	clear() {
		this.requestVersion++;
		if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
		this.deadlineTimer = null;
		this.loadPromise = null;
		this.catalog = null;
		this.error = null;
		this.loadedAt = 0;
		this.scope = null;
	}
}

export const billingCatalogStore = new BillingCatalogStore();
