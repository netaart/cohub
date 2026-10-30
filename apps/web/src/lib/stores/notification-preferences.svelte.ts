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

/** Server-owned; the local cache only ever holds values the server returned. */
class NotificationPreferencesStore {
	value = $state<NotificationPreferences>(
		parseUserPreferences(null).notifications,
	);
	loaded = $state(false);
	#userUuid: string | null = null;
	#request: Promise<void> | null = null;
	#stopEvents: (() => void) | null = null;
	#revision = 0;

	/** Shows cached values immediately and refreshes them from the server. */
	sync(): Promise<void> {
		const userUuid = authStore.userUuid;
		if (!userUuid) return Promise.resolve();
		if (userUuid !== this.#userUuid) this.#switchUser(userUuid);
		this.#request ??= this.#fetch(userUuid).finally(() => {
			this.#request = null;
		});
		return this.#request;
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
		this.#request = null;
		const cached = readCache(userUuid);
		this.value = cached ?? parseUserPreferences(null).notifications;
		this.loaded = cached !== null;
		this.#stopEvents ??= sdk.onUserEvent((event) => {
			if (event.type !== "user.preferences.updated" || !this.#userUuid) return;
			this.#accept(
				this.#userUuid,
				parseUserPreferences(event.payload.preferences).notifications,
			);
		});
	}

	async #fetch(userUuid: string) {
		const revision = this.#revision;
		const { preferences } = await sdk.user.getPreferences();
		// A local edit made while this read was in flight is newer.
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
