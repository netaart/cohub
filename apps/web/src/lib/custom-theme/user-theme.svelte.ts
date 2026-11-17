import { HOME_SPACE_SLUG } from "@cohub/protocol/public-identifiers";
import { HttpError, type SpaceRecord } from "@neta-art/cohub";
import { getThemeCss } from "#lib/custom-theme/theme-css.svelte.ts";
import { sdk } from "#lib/sdk.ts";

const ENABLED_STORAGE_KEY = "cohub:custom-theme-enabled";

function homeSpaceKey(userUuid: string) {
	return `cohub:home-space-id:${userUuid}`;
}

function readStorage(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStorage(key: string, value: string | null) {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {}
}

const customThemesAllowed =
	typeof location === "undefined" ||
	new URLSearchParams(location.search).get("theme") !== "safe";

class UserTheme {
	enabled = $state(
		typeof localStorage === "undefined" ||
			readStorage(ENABLED_STORAGE_KEY) !== "0",
	);
	spaceId = $state<string | null>(null);

	#userUuid: string | null = null;
	#request = 0;

	setHomeSpace(space: Pick<SpaceRecord, "id" | "userUuid" | "slug">) {
		if (space.userUuid !== this.#userUuid || space.slug !== HOME_SPACE_SLUG)
			return;
		this.#request += 1;
		writeStorage(homeSpaceKey(space.userUuid), space.id);
		this.spaceId = space.id;
	}

	get css(): string | null {
		if (!customThemesAllowed || !this.enabled || !this.spaceId) return null;
		return getThemeCss(this.spaceId);
	}

	setEnabled(enabled: boolean) {
		this.enabled = enabled;
		writeStorage(ENABLED_STORAGE_KEY, enabled ? null : "0");
	}

	resolve(userUuid: string | null) {
		if (userUuid === this.#userUuid) return;
		this.#userUuid = userUuid;
		this.spaceId = userUuid ? readStorage(homeSpaceKey(userUuid)) : null;
		if (userUuid) void this.#confirm(userUuid);
	}

	async #confirm(userUuid: string) {
		const request = ++this.#request;
		let spaceId: string | null;
		try {
			spaceId = (await sdk.spaces.getOwnedBySlug(HOME_SPACE_SLUG)).id;
		} catch (error) {
			if (!(error instanceof HttpError && error.status === 404)) return;
			spaceId = null;
		}
		if (userUuid !== this.#userUuid || request !== this.#request) return;
		writeStorage(homeSpaceKey(userUuid), spaceId);
		this.spaceId = spaceId;
	}
}

export const userTheme = new UserTheme();

export function spaceThemeCss(spaceId: string): string | null {
	if (!customThemesAllowed) return null;
	if (spaceId === userTheme.spaceId && !userTheme.enabled) return null;
	return getThemeCss(spaceId);
}
