import type { PublicGenerationDeclaration } from "@cohub/protocol/generation";
import {
	canUseUserScopedCache,
	getCacheUserKey,
	getCacheUserKeyAsync,
} from "#lib/cache/keys.ts";
import { sdk } from "#lib/sdk.ts";
import { authStore } from "#lib/stores/auth.svelte.ts";
import { isValidCachedGenerationModel } from "#lib/stores/generation-models-validation.ts";

const STORAGE_PREFIX = "cohub:generation-models:v1";
export const GENERATION_MODELS_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

type PersistedGenerationModels = {
	models: PublicGenerationDeclaration[];
	updatedAt: number;
};

let memory: PublicGenerationDeclaration[] | null = null;
let memoryUserKey: string | null = null;
let memoryUpdatedAt = 0;
let activeLoad: {
	userKey: string;
	promise: Promise<PublicGenerationDeclaration[]>;
} | null = null;

function storageKey(userKey: string) {
	return `${STORAGE_PREFIX}:${encodeURIComponent(userKey)}`;
}

function resetMemoryForUser(userKey: string) {
	if (memoryUserKey === userKey) return;
	memory = null;
	memoryUserKey = userKey;
	memoryUpdatedAt = 0;
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

function readPersisted(userKey: string): PersistedGenerationModels | null {
	const storage = getStorage(userKey);
	if (!storage) return null;
	try {
		const parsed = JSON.parse(storage.getItem(storageKey(userKey)) ?? "null");
		const rawModels = Array.isArray(parsed) ? parsed : parsed?.models;
		if (!Array.isArray(rawModels)) return null;
		const models = rawModels.filter(
			(item): item is PublicGenerationDeclaration =>
				isValidCachedGenerationModel(item),
		);
		if (models.length === 0 && Array.isArray(parsed)) return null;
		return {
			models,
			updatedAt:
				!Array.isArray(parsed) &&
				typeof parsed.updatedAt === "number" &&
				Number.isFinite(parsed.updatedAt)
					? parsed.updatedAt
					: 0,
		};
	} catch {
		return null;
	}
}

function hydrateMemory(userKey: string) {
	resetMemoryForUser(userKey);
	if (memory) return;
	const persisted = readPersisted(userKey);
	if (!persisted) return;
	memory = persisted.models;
	memoryUpdatedAt = persisted.updatedAt;
}

export function getCachedGenerationModels(): PublicGenerationDeclaration[] {
	if (!authStore.loaded) return [];
	const userKey = getCacheUserKey();
	hydrateMemory(userKey);
	return memory ?? [];
}

export async function loadGenerationModels(options?: {
	refresh?: boolean;
	maxAgeMs?: number;
}): Promise<PublicGenerationDeclaration[]> {
	const userKey = await getCacheUserKeyAsync();
	hydrateMemory(userKey);
	const maxAgeMs = options?.maxAgeMs ?? Number.POSITIVE_INFINITY;
	const fresh = Date.now() - memoryUpdatedAt <= maxAgeMs;
	if (!options?.refresh && memory && fresh) return memory;
	if (activeLoad?.userKey === userKey) return activeLoad.promise;

	const promise = sdk.models
		.listMultimodal()
		.then((response) => {
			if (getCacheUserKey() !== userKey) return response.models;
			const updatedAt = Date.now();
			memoryUserKey = userKey;
			memory = response.models;
			memoryUpdatedAt = updatedAt;
			const storage = getStorage(userKey);
			if (storage) {
				try {
					storage.setItem(
						storageKey(userKey),
						JSON.stringify({
							models: response.models,
							updatedAt,
						} satisfies PersistedGenerationModels),
					);
				} catch {}
			}
			return response.models;
		})
		.finally(() => {
			if (activeLoad?.promise === promise) activeLoad = null;
		});
	activeLoad = { userKey, promise };
	return promise;
}
