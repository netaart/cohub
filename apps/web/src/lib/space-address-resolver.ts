import { HttpError } from "@neta-art/cohub";
import { canUseUserScopedCache, getCacheUserKeyAsync } from "$lib/cache/keys";
import { spaceRecordRepo } from "$lib/cache/repositories/space-record-repo";
import { sdk } from "$lib/sdk";
import {
	addressKey,
	clearSpaceAddresses,
	forgetUnconfirmedAddress,
	markAddressPending,
	parseSpaceAddressPath,
	rememberResolvedAddress,
	rememberSpaceAddress,
	type SpaceAddress,
	settleAddress,
	spaceIdAt,
} from "$lib/stores/space-address";
import { cacheSpaceRecordSoon } from "$lib/stores/space-record-cache";

let seededFor: string | null = null;
let seeding: Promise<void> = Promise.resolve();
const verifying = new Map<string, Promise<string | null>>();

function seedFromCache(): Promise<void> {
	return getCacheUserKeyAsync().then((userKey) => {
		if (!canUseUserScopedCache(userKey)) return;
		if (seededFor === userKey) return seeding;
		if (seededFor !== null) clearSpaceAddresses();
		seededFor = userKey;
		seeding = spaceRecordRepo
			.listCached()
			.then((spaces) => {
				for (const space of spaces)
					rememberSpaceAddress(space, { confirmed: false });
			})
			.catch(() => undefined);
		return seeding;
	});
}

/** Resolve an address with the server and record the result as confirmed. */
export function confirmSpaceAddress(
	address: SpaceAddress,
): Promise<string | null> {
	const key = addressKey(address);
	const inflight = verifying.get(key);
	if (inflight) return inflight;
	const request = sdk.spaces
		.getBySlug(address.username, address.slug)
		.then((space) => {
			cacheSpaceRecordSoon(space);
			const current = space.redirectTo
				? parseSpaceAddressPath(
						new URL(space.redirectTo, "http://cohub.local").pathname,
					)?.address
				: address;
			rememberResolvedAddress(address, space.id, current ?? address);
			return space.id;
		})
		.catch((error) => {
			if (error instanceof HttpError && error.status === 404)
				forgetUnconfirmedAddress(address);
			settleAddress(address);
			return null;
		})
		.finally(() => verifying.delete(key));
	verifying.set(key, request);
	return request;
}

/**
 * Space id for a friendly address: memory, then the local cache (verified with the
 * server in the background), then the server. Null when nothing resolves.
 */
export async function resolveSpaceAddress(
	address: SpaceAddress,
): Promise<string | null> {
	let hit = spaceIdAt(address);
	if (!hit) {
		await seedFromCache();
		hit = spaceIdAt(address);
	}
	if (!hit) return confirmSpaceAddress(address);
	if (!hit.confirmed) {
		markAddressPending(address);
		void confirmSpaceAddress(address);
	}
	return hit.spaceId;
}
