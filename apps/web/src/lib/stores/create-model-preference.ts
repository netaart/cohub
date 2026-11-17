import {
	canUseUserScopedCache,
	encodeKeyPart,
	getCacheUserKeyAsync,
} from "#lib/cache/keys.ts";

const STORAGE_PREFIX = "cohub:composer-create-model:v1";

type CreateModelPreferenceRecord = {
	id: string;
	updatedAt: number;
};

export type CreateModelPreference = {
	userKey: string;
	modelId: string | null;
};

function storageKey(userKey: string) {
	return `${STORAGE_PREFIX}:${encodeKeyPart(userKey)}`;
}

function getStorage(userKey: string): Storage | null {
	if (typeof window === "undefined" || !canUseUserScopedCache(userKey))
		return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

export async function readCreateModelPreference(): Promise<CreateModelPreference> {
	const userKey = await getCacheUserKeyAsync();
	const storage = getStorage(userKey);
	if (!storage) return { userKey, modelId: null };
	try {
		const parsed = JSON.parse(
			storage.getItem(storageKey(userKey)) ?? "null",
		) as Partial<CreateModelPreferenceRecord> | null;
		return {
			userKey,
			modelId:
				typeof parsed?.id === "string" && parsed.id.trim()
					? parsed.id.trim()
					: null,
		};
	} catch {
		return { userKey, modelId: null };
	}
}

export async function saveCreateModelPreference(
	id: string,
	expectedUserKey?: string,
) {
	const normalized = id.trim();
	if (!normalized) return;
	const userKey = await getCacheUserKeyAsync();
	if (expectedUserKey && userKey !== expectedUserKey) return;
	const storage = getStorage(userKey);
	if (!storage) return;
	try {
		storage.setItem(
			storageKey(userKey),
			JSON.stringify({
				id: normalized,
				updatedAt: Date.now(),
			} satisfies CreateModelPreferenceRecord),
		);
	} catch {
		// Runtime state remains authoritative when storage is unavailable.
	}
}
