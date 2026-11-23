import type { BillingQuota } from "@neta-art/cohub";
import { canUseUserScopedCache, getCacheUserKey } from "#lib/cache/keys.ts";
import { onBillingChange } from "#lib/features/billing/refresh.ts";
import { sdk } from "#lib/sdk.ts";
import { authStore } from "#lib/stores/auth.svelte.ts";

const STORAGE_PREFIX = "cohub:billing-quotas:v1";
const STALE_MS = 60 * 1000;

/**
 * Quota balances (e.g. daily seconds) for composer and picker hints. Cached per user for the first paint,
 * refreshed silently; the server decides what a request actually draws.
 */
class BillingQuotasStore {
	quotas = $state<BillingQuota[]>([]);
	private userKey: string | null = null;
	private loadedAt = 0;
	private loading: Promise<void> | null = null;
	private listening = false;

	private storage(userKey: string): Storage | null {
		if (typeof window === "undefined" || !canUseUserScopedCache(userKey))
			return null;
		try {
			return window.localStorage;
		} catch {
			return null;
		}
	}

	private hydrate(userKey: string) {
		if (this.userKey === userKey) return;
		this.userKey = userKey;
		this.loadedAt = 0;
		this.quotas = [];
		try {
			const raw = this.storage(userKey)?.getItem(
				`${STORAGE_PREFIX}:${encodeURIComponent(userKey)}`,
			);
			const parsed = raw ? JSON.parse(raw) : null;
			if (Array.isArray(parsed)) this.quotas = parsed;
		} catch {}
	}

	/** Balance for a token, or null when the user has no such quota. */
	balance(tokenType: string | null | undefined): number | null {
		if (!tokenType) return null;
		return (
			this.quotas.find((quota) => quota.tokenType === tokenType)?.balance ??
			null
		);
	}

	refresh(options: { force?: boolean } = {}) {
		if (!authStore.loaded || !authStore.isAuthenticated) return;
		const userKey = getCacheUserKey();
		this.hydrate(userKey);
		if (!this.listening && typeof window !== "undefined") {
			this.listening = true;
			onBillingChange(() => this.refresh({ force: true }));
		}
		if (this.loading) return;
		if (!options.force && Date.now() - this.loadedAt < STALE_MS) return;
		this.loading = sdk.billing
			.getQuotas()
			.then(({ quotas }) => {
				if (getCacheUserKey() !== userKey) return;
				this.quotas = quotas;
				this.loadedAt = Date.now();
				try {
					this.storage(userKey)?.setItem(
						`${STORAGE_PREFIX}:${encodeURIComponent(userKey)}`,
						JSON.stringify(quotas),
					);
				} catch {}
			})
			.catch(() => {})
			.finally(() => {
				this.loading = null;
			});
	}
}

export const billingQuotasStore = new BillingQuotasStore();
