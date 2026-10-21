import {
	idbGetMany,
	idbWriteMany,
	type SpaceFileUrlCacheRecord,
} from "$lib/cache/db";
import {
	canUseUserScopedCache,
	getCacheUserKey,
	spaceFileUrlKey,
} from "$lib/cache/keys";
import { sdk } from "$lib/sdk";
import { createSpaceFileBatchReader } from "./space-file-batch";
import {
	createSpaceFileUrlResolver,
	type SpaceFileUrlRecord,
} from "./space-file-url-resolver";

const STORE = "space_file_urls";

export const spaceFileReads = createSpaceFileBatchReader({
	readMany: (spaceId, paths) => sdk.space(spaceId).files.readMany(paths),
	readOne: (spaceId, path) => sdk.space(spaceId).files.read(path),
});

export const spaceFileUrls = createSpaceFileUrlResolver({
	scope: getCacheUserKey,
	remote: {
		read: spaceFileReads.read,
		invalidate: spaceFileReads.invalidate,
		resolveUrl: (spaceId, path) =>
			sdk.space(spaceId).files.resolveUrl(path, { purpose: "preview" }),
	},
	store: {
		async read(scope, spaceId, paths) {
			const found = new Map<string, SpaceFileUrlRecord>();
			if (!canUseUserScopedCache(scope)) return found;
			const records = await idbGetMany<SpaceFileUrlCacheRecord>(
				STORE,
				paths.map((path) => spaceFileUrlKey(scope, spaceId, path)),
			);
			for (const record of records.values())
				found.set(record.path, {
					url: record.url,
					verifiedAt: record.verifiedAt,
				});
			return found;
		},
		async write(scope, spaceId, { put, remove }) {
			if (!canUseUserScopedCache(scope)) return;
			await idbWriteMany<SpaceFileUrlCacheRecord>(STORE, {
				put: [...put].map(([path, record]) => ({
					key: spaceFileUrlKey(scope, spaceId, path),
					userKey: scope,
					spaceId,
					path,
					...record,
					lastAccessedAt: record.verifiedAt,
				})),
				delete: remove.map((path) => spaceFileUrlKey(scope, spaceId, path)),
			});
		},
	},
});
