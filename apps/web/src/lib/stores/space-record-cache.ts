import type { SpaceRecord } from "@neta-art/cohub";
import { canUseUserScopedCache, getCacheUserKeyAsync } from "$lib/cache/keys";
import { spaceRecordRepo } from "$lib/cache/repositories/space-record-repo";

async function resolveCacheUserKey() {
	const userKey = await getCacheUserKeyAsync();
	return canUseUserScopedCache(userKey) ? userKey : null;
}

function hasOwn<T extends object>(value: T, key: PropertyKey) {
	return Object.hasOwn(value, key);
}

function isCacheableSpaceRecord(space: Partial<SpaceRecord> & { id: string }) {
	return (
		typeof space.userUuid === "string" &&
		space.userUuid.length > 0 &&
		hasOwn(space, "createdAt") &&
		hasOwn(space, "updatedAt")
	);
}

function mergeSpaceRecord(
	current: SpaceRecord,
	next: Partial<SpaceRecord>,
): SpaceRecord {
	const merged = {
		...current,
		...next,
		slug: hasOwn(next, "slug") ? (next.slug ?? null) : current.slug,
		description: hasOwn(next, "description")
			? (next.description ?? null)
			: current.description,
		// Lists send a slimmer profile; fields they omit keep their cached value.
		publicProfile: hasOwn(next, "publicProfile")
			? next.publicProfile && {
					...current.publicProfile,
					...next.publicProfile,
				}
			: current.publicProfile,
		ownerProfile: hasOwn(next, "ownerProfile")
			? next.ownerProfile
			: current.ownerProfile,
		lastActivityAt: hasOwn(next, "lastActivityAt")
			? (next.lastActivityAt ?? null)
			: current.lastActivityAt,
		channels: hasOwn(next, "channels") ? next.channels : current.channels,
		access: hasOwn(next, "access") ? next.access : current.access,
		accessLevel: hasOwn(next, "accessLevel")
			? next.accessLevel
			: current.accessLevel,
	};

	if (hasOwn(next, "access") && !hasOwn(next, "accessLevel")) {
		delete merged.accessLevel;
	}

	return merged;
}

export async function getCachedSpaceRecord(spaceId: string) {
	if (!(await resolveCacheUserKey())) return null;
	return spaceRecordRepo.getCached(spaceId);
}

export async function cacheSpaceRecord(space: SpaceRecord) {
	if (!(await resolveCacheUserKey())) return null;
	const cached = await spaceRecordRepo.getCached(space.id).catch(() => null);
	if (!cached?.space && !isCacheableSpaceRecord(space)) return null;
	const merged = cached?.space ? mergeSpaceRecord(cached.space, space) : space;
	return await spaceRecordRepo.set(space.id, merged);
}

export async function patchCachedSpaceRecord(
	space: Partial<SpaceRecord> & { id: string },
) {
	if (!(await resolveCacheUserKey())) return null;
	const cached = await spaceRecordRepo.getCached(space.id).catch(() => null);
	if (!cached?.space) return null;
	const merged = mergeSpaceRecord(cached.space, space);
	return await spaceRecordRepo.set(space.id, merged);
}

export function cacheSpaceRecordSoon(space: SpaceRecord | null | undefined) {
	if (!space?.id) return;
	void cacheSpaceRecord(space).catch(() => undefined);
}

export function patchCachedSpaceRecordSoon(
	space: (Partial<SpaceRecord> & { id: string }) | null | undefined,
) {
	if (!space?.id) return;
	void patchCachedSpaceRecord(space).catch(() => undefined);
}

export function cacheSpaceRecordsSoon(
	spaces: SpaceRecord[] | null | undefined,
) {
	if (!spaces?.length) return;
	for (const space of spaces) cacheSpaceRecordSoon(space);
}
