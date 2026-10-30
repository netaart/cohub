import {
	applyUserPreferencesPatch,
	type NotificationPreferences,
	parseUserPreferences,
	type UserPreferencesPatch,
} from "@neta-art/cohub";
import { sdk } from "$lib/sdk";
import { authStore } from "$lib/stores/auth.svelte";

const cacheKey = (userUuid: string) => `cohub:user-preferences:${userUuid}`;

function readCache(userUuid: string): NotificationPreferences | null {
	try {
		const raw = localStorage.getItem(cacheKey(userUuid));
		return raw ? parseUserPreferences(JSON.parse(raw)).notifications : null;
	} catch {
		return null;
	}
}

function writeCache(userUuid: string, notifications: NotificationPreferences) {
	try {
		localStorage.setItem(cacheKey(userUuid), JSON.stringify({ notifications }));
	} catch {
		// The server stays authoritative; the cache only speeds up first paint.
	}
}

/**
 * Server-owned; the local cache only ever holds values the server returned.
 * `#revision` advances on every local edit and every remote change signal, so
 * a response that started before either is never applied.
 */
class NotificationPreferencesStore {
	value = $state<NotificationPreferences>(
		parseUserPreferences(null).notifications,
	);
	loaded = $state(false);
	#userUuid: string | null = null;
	#request: { revision: number; promise: Promise<void> } | null = null;
	#listening = false;
	#revision = 0;

	/** Shows cached values immediately and refreshes them from the server. */
	sync(): Promise<void> {
		const userUuid = authStore.userUuid;
		if (!userUuid) return Promise.resolve();
		if (userUuid !== this.#userUuid) this.#switchUser(userUuid);
		if (this.#request?.revision !== this.#revision) {
			const request = {
				revision: this.#revision,
				promise: this.#fetch(userUuid, this.#revision).finally(() => {
					if (this.#request === request) this.#request = null;
				}),
			};
			this.#request = request;
		}
		return this.#request.promise;
	}

	async update(patch: UserPreferencesPatch) {
		const userUuid = authStore.userUuid;
		if (!userUuid) throw new Error("Sign in to change notification settings");
		if (userUuid !== this.#userUuid) this.#switchUser(userUuid);
		const previous = this.value;
		const revision = ++this.#revision;
		this.value = applyUserPreferencesPatch(
			{ notifications: previous },
			patch,
		).notifications;
		try {
			const { preferences } = await sdk.user.updatePreferences(patch);
			if (revision === this.#revision && userUuid === this.#userUuid)
				this.#accept(userUuid, preferences.notifications);
		} catch (error) {
			if (revision === this.#revision && userUuid === this.#userUuid)
				this.value = previous;
			throw error;
		}
	}

	#switchUser(userUuid: string) {
		this.#userUuid = userUuid;
		this.#revision++;
		const cached = readCache(userUuid);
		this.value = cached ?? parseUserPreferences(null).notifications;
		this.loaded = cached !== null;
		if (this.#listening) return;
		this.#listening = true;
		sdk.onUserEvent((event) => {
			if (event.type === "user.preferences.updated") this.#refresh();
		});
		// Change signals are not replayed, so catch up after every reconnect.
		let dropped = false;
		sdk.onConnection(({ state }) => {
			if (state === "closed" || state === "error") dropped = true;
			else if (state === "open" && dropped) {
				dropped = false;
				this.#refresh();
			}
		});
	}

	#refresh() {
		if (!this.#userUuid) return;
		this.#revision++;
		void this.sync().catch((error) =>
			console.warn("[notifications] Failed to refresh preferences:", error),
		);
	}

	async #fetch(userUuid: string, revision: number) {
		const { preferences } = await sdk.user.getPreferences();
		if (userUuid === this.#userUuid && revision === this.#revision)
			this.#accept(userUuid, preferences.notifications);
	}

	#accept(userUuid: string, notifications: NotificationPreferences) {
		this.value = notifications;
		this.loaded = true;
		writeCache(userUuid, notifications);
	}
}

export const notificationPreferences = new NotificationPreferencesStore();
