import type {
	SpaceMember,
	SpaceUsageResponse,
	SpaceWalletSummary,
} from "@neta-art/cohub";
import { sdk } from "$lib/sdk";

type SpaceProfileCacheEntry<T> = {
	value: T;
	updatedAt: number;
};

type SpaceProfileCacheOptions<T> = {
	key: string;
	ttlMs: number;
	fetcher: () => Promise<T>;
};

const SPACE_PROFILE_STORAGE_VERSION = 1;
const SPACE_PROFILE_CACHE_PREFIX = "cohub:space-profile";
const SPACE_PROFILE_CACHE_TTL_MS = 60 * 60 * 1000;
const memory = new Map<string, SpaceProfileCacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

function storageKey(key: string) {
	return `${SPACE_PROFILE_CACHE_PREFIX}:${SPACE_PROFILE_STORAGE_VERSION}:${key}`;
}

function readLocalEntry<T>(key: string): SpaceProfileCacheEntry<T> | null {
	if (typeof localStorage === "undefined") return null;
	try {
		const parsed = JSON.parse(
			localStorage.getItem(storageKey(key)) ?? "null",
		) as Partial<SpaceProfileCacheEntry<T>> | null;
		if (!parsed || typeof parsed.updatedAt !== "number") return null;
		return { value: parsed.value as T, updatedAt: parsed.updatedAt };
	} catch {
		return null;
	}
}

function writeEntry<T>(key: string, value: T) {
	const entry: SpaceProfileCacheEntry<T> = { value, updatedAt: Date.now() };
	memory.set(key, entry);
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(storageKey(key), JSON.stringify(entry));
	} catch {
		// Best-effort cache.
	}
}

function deleteEntry(key: string) {
	memory.delete(key);
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.removeItem(storageKey(key));
	} catch {
		// Best-effort cache.
	}
}

function readEntry<T>(key: string): SpaceProfileCacheEntry<T> | null {
	const cached = memory.get(key) as SpaceProfileCacheEntry<T> | undefined;
	if (cached) return cached;
	const local = readLocalEntry<T>(key);
	if (local) memory.set(key, local);
	return local;
}

function isFresh(entry: SpaceProfileCacheEntry<unknown>, ttlMs: number) {
	return Date.now() - entry.updatedAt < ttlMs;
}

async function fetchWithCache<T>({
	key,
	ttlMs,
	fetcher,
}: SpaceProfileCacheOptions<T>) {
	const cached = readEntry<T>(key);
	if (cached && isFresh(cached, ttlMs)) return cached.value;
	const existing = inFlight.get(key) as Promise<T> | undefined;
	if (existing) return existing;
	const request = fetcher()
		.then((value) => {
			writeEntry(key, value);
			return value;
		})
		.catch((error) => {
			if (cached) return cached.value;
			throw error;
		})
		.finally(() => {
			inFlight.delete(key);
		});
	inFlight.set(key, request);
	return request;
}

const membersKey = (spaceId: string) => `${spaceId}:members`;
const usageKey = (spaceId: string, days: number) => `${spaceId}:usage:${days}`;
const walletKey = (spaceId: string) => `${spaceId}:wallet`;
export function getCachedSpaceMembers(spaceId: string) {
	return readEntry<SpaceMember[]>(membersKey(spaceId))?.value ?? null;
}

export function fetchSpaceMembersWithCache(spaceId: string) {
	return fetchWithCache({
		key: membersKey(spaceId),
		ttlMs: SPACE_PROFILE_CACHE_TTL_MS,
		fetcher: async () => (await sdk.space(spaceId).members.list()).items,
	});
}

export function invalidateCachedSpaceMembers(spaceId: string) {
	deleteEntry(membersKey(spaceId));
}

export function getCachedSpaceUsage(spaceId: string, days: number) {
	return readEntry<SpaceUsageResponse>(usageKey(spaceId, days))?.value ?? null;
}

export function fetchSpaceUsageWithCache(spaceId: string, days: number) {
	return fetchWithCache({
		key: usageKey(spaceId, days),
		ttlMs: SPACE_PROFILE_CACHE_TTL_MS,
		fetcher: () => sdk.space(spaceId).usage.get(days),
	});
}

export function getCachedSpaceWallet(spaceId: string) {
	return readEntry<SpaceWalletSummary>(walletKey(spaceId))?.value ?? null;
}

/** Always fetches: usage charges move the balance without a wallet event. */
export function fetchSpaceWalletWithCache(spaceId: string) {
	return fetchWithCache({
		key: walletKey(spaceId),
		ttlMs: 0,
		fetcher: () => sdk.space(spaceId).wallet.get(),
	});
}
