import {
	type AppMarketplaceCatalog,
	AppMarketplaceCatalogSchema,
	type AppMarketplaceEntry,
	COHUB_APP_MARKETPLACE_URL,
	emptySpaceInstalledApps,
	SPACE_INSTALLED_APPS_PATH,
	type SpaceInstalledApps,
	SpaceInstalledAppsSchema,
} from "@cohub/protocol";
import { HttpError, type SpaceFsFileResponse } from "@neta-art/cohub";
import { sdk } from "$lib/sdk";

const MAX_CATALOG_BYTES = 5 * 1024 * 1024;

export type InstalledAppsFile = {
	document: SpaceInstalledApps;
	revision: { mtimeMs: number; size: number } | null;
};

const INSTALLED_CACHE_TTL_MS = 15 * 60 * 1_000;
const INSTALLED_CACHE_MAX_ENTRIES = 12;
type InstalledCacheEntry = { value: InstalledAppsFile; expiresAt: number };
const installedCache = new Map<string, InstalledCacheEntry>();
const installedRequests = new Map<string, Promise<InstalledAppsFile>>();

function getInstalledCache(spaceId: string) {
	const entry = installedCache.get(spaceId);
	if (!entry) return null;
	if (entry.expiresAt <= Date.now()) {
		installedCache.delete(spaceId);
		return null;
	}
	// Map insertion order provides a small, predictable LRU.
	installedCache.delete(spaceId);
	installedCache.set(spaceId, entry);
	return entry.value;
}

function setInstalledCache(spaceId: string, value: InstalledAppsFile) {
	installedCache.delete(spaceId);
	installedCache.set(spaceId, {
		value,
		expiresAt: Date.now() + INSTALLED_CACHE_TTL_MS,
	});
	while (installedCache.size > INSTALLED_CACHE_MAX_ENTRIES) {
		const oldest = installedCache.keys().next().value;
		if (!oldest) break;
		installedCache.delete(oldest);
	}
}

function decodeFile(file: SpaceFsFileResponse) {
	if (file.encoding !== "base64") return file.content;
	const bytes = Uint8Array.from(atob(file.content), (character) =>
		character.charCodeAt(0),
	);
	return new TextDecoder().decode(bytes);
}

export function readInstalledApps(
	spaceId: string,
	options: { refresh?: boolean } = {},
): Promise<InstalledAppsFile> {
	const pending = installedRequests.get(spaceId);
	if (pending) return pending;
	if (!options.refresh) {
		const cached = getInstalledCache(spaceId);
		if (cached) return Promise.resolve(cached);
	}
	const request = (async () => {
		try {
			const file = await sdk
				.space(spaceId)
				.files.read(SPACE_INSTALLED_APPS_PATH);
			if (!("content" in file)) {
				throw new Error("The installed Apps file is still being prepared.");
			}
			const document = SpaceInstalledAppsSchema.parse(
				JSON.parse(decodeFile(file)),
			);
			return { document, revision: { mtimeMs: file.mtimeMs, size: file.size } };
		} catch (error) {
			if (error instanceof HttpError && error.status === 404) {
				return { document: emptySpaceInstalledApps(), revision: null };
			}
			throw error;
		}
	})();
	installedRequests.set(spaceId, request);
	void request
		.then((result) => {
			if (installedRequests.get(spaceId) === request)
				setInstalledCache(spaceId, result);
		})
		.catch(() => {
			// The caller receives the original rejection; this maintenance chain only updates cache state.
		})
		.finally(() => {
			if (installedRequests.get(spaceId) === request)
				installedRequests.delete(spaceId);
		});
	return request;
}

export function cacheInstalledApps(spaceId: string, value: InstalledAppsFile) {
	setInstalledCache(spaceId, value);
}

export function invalidateInstalledApps(spaceId: string) {
	installedCache.delete(spaceId);
	// A read already in flight may predate the change; never cache its result.
	installedRequests.delete(spaceId);
}

export async function writeInstalledApps(
	spaceId: string,
	document: SpaceInstalledApps,
	revision: InstalledAppsFile["revision"],
): Promise<InstalledAppsFile["revision"]> {
	const validated = SpaceInstalledAppsSchema.parse(document);
	const result = await sdk.space(spaceId).files.write({
		path: SPACE_INSTALLED_APPS_PATH,
		content: `${JSON.stringify(validated, null, 2)}\n`,
		encoding: "utf-8",
		...(revision ? { expected: revision } : {}),
		mutationId: crypto.randomUUID(),
	});
	return { mtimeMs: result.mtimeMs, size: result.size };
}

let catalog: AppMarketplaceCatalog | null = null;
let catalogRequest: Promise<AppMarketplaceCatalog> | null = null;

export function loadAppMarketplace(options: { refresh?: boolean } = {}) {
	if (!options.refresh && catalog) return Promise.resolve(catalog);
	if (!options.refresh && catalogRequest) return catalogRequest;
	catalogRequest = fetch(COHUB_APP_MARKETPLACE_URL, {
		headers: { Accept: "application/json" },
	})
		.then(async (response) => {
			if (!response.ok) {
				throw new Error(`Marketplace returned ${response.status}.`);
			}
			const declaredSize = Number(response.headers.get("content-length") ?? 0);
			if (declaredSize > MAX_CATALOG_BYTES) {
				throw new Error("Marketplace catalog is too large.");
			}
			const text = await response.text();
			if (new Blob([text]).size > MAX_CATALOG_BYTES) {
				throw new Error("Marketplace catalog is too large.");
			}
			return AppMarketplaceCatalogSchema.parse(JSON.parse(text));
		})
		.then((nextCatalog) => {
			catalog = nextCatalog;
			return nextCatalog;
		})
		.finally(() => {
			catalogRequest = null;
		});
	return catalogRequest;
}

function normalizedSearchText(app: AppMarketplaceEntry) {
	return [
		app.id,
		app.name,
		app.description,
		app.publisher,
		...(app.keywords ?? []),
	]
		.filter(Boolean)
		.join(" ")
		.toLocaleLowerCase();
}

export function searchMarketplace(
	apps: AppMarketplaceEntry[],
	query: string,
): AppMarketplaceEntry[] {
	const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	if (!terms.length) return apps;
	return apps
		.map((app, index) => {
			const name = app.name.toLocaleLowerCase();
			const id = app.id.toLocaleLowerCase();
			const haystack = normalizedSearchText(app);
			if (!terms.every((term) => haystack.includes(term))) return null;
			const queryValue = terms.join(" ");
			const score =
				id === queryValue
					? 0
					: name === queryValue
						? 1
						: name.startsWith(queryValue)
							? 2
							: name.includes(queryValue)
								? 3
								: 4;
			return { app, index, score };
		})
		.filter((match): match is NonNullable<typeof match> => Boolean(match))
		.sort((left, right) => left.score - right.score || left.index - right.index)
		.map((match) => match.app);
}
