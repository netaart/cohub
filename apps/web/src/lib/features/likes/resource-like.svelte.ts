import type { LikeResourceType } from "@neta-art/cohub";
import { ensureAuth, hasLocalSessionHint } from "$lib/auth";
import { getCurrentRedirectPath } from "$lib/auth-redirect";
import {
	onViewerLikeChanged,
	readViewerLike,
	writeViewerLike,
} from "$lib/cache/repositories/viewer-likes-repo";
import { haptic } from "$lib/haptics";
import { sdk } from "$lib/sdk";
import { authStore } from "$lib/stores/auth.svelte";

const FAILED_HINT_MS = 3_000;

export class ResourceLike {
	liked = $state(false);
	failed = $state(false);
	toggled = $state<{ liked: boolean } | null>(null);
	#total = $state(0);
	/** The liked state `#total` already includes. */
	#counted = $state(false);
	readonly count = $derived(
		Math.max(0, this.#total + Number(this.liked) - Number(this.#counted)),
	);
	#confirmed = false;
	#loaded: Promise<void> = Promise.resolve();
	#syncing = false;
	#failedTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		readonly resourceType: LikeResourceType,
		readonly resourceId: string,
		total: number,
	) {
		this.#total = total;
	}

	setTotal(total: number) {
		this.#total = total;
		this.#counted = this.#confirmed;
	}

	load() {
		this.#loaded = this.#load();
		return this.#loaded;
	}

	async #load() {
		if (!hasLocalSessionHint()) return;
		await authStore.ensureLoaded();
		if (!authStore.isAuthenticated) return;
		const cached = await readViewerLike(this.resourceType, this.resourceId);
		if (cached !== null) this.#adopt(cached);
		try {
			const liked = await sdk.user.likes.isLiked(
				this.resourceType,
				this.resourceId,
			);
			this.#adopt(liked);
			void writeViewerLike(this.resourceType, this.resourceId, liked);
		} catch {}
	}

	watch() {
		return onViewerLikeChanged(this.resourceType, this.resourceId, () => {
			void readViewerLike(this.resourceType, this.resourceId).then((liked) => {
				if (liked === null || this.#syncing) return;
				this.liked = this.#confirmed = liked;
			});
		});
	}

	async toggle() {
		await this.#loaded;
		if (!authStore.isAuthenticated) {
			await authStore.ensureLoaded();
			if (!authStore.isAuthenticated) {
				await ensureAuth({ redirectPath: getCurrentRedirectPath() });
				return;
			}
		}
		this.liked = !this.liked;
		this.toggled = { liked: this.liked };
		this.#setFailed(false);
		haptic("tick");
		await this.#sync();
	}

	dispose() {
		clearTimeout(this.#failedTimer);
	}

	#adopt(liked: boolean) {
		this.liked = this.#confirmed = this.#counted = liked;
	}

	async #sync() {
		if (this.#syncing) return;
		this.#syncing = true;
		try {
			while (this.liked !== this.#confirmed) {
				const target = this.liked;
				const liked = await sdk.user.likes.set(
					this.resourceType,
					this.resourceId,
					target,
				);
				this.#confirmed = liked;
				if (liked !== target) this.liked = liked;
				void writeViewerLike(this.resourceType, this.resourceId, liked);
			}
		} catch {
			this.liked = this.#confirmed;
			this.#setFailed(true);
			haptic("reject");
		} finally {
			this.#syncing = false;
		}
	}

	#setFailed(failed: boolean) {
		clearTimeout(this.#failedTimer);
		this.failed = failed;
		if (failed)
			this.#failedTimer = setTimeout(() => {
				this.failed = false;
			}, FAILED_HINT_MS);
	}
}
