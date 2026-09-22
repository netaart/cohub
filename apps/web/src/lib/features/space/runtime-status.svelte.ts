import { HttpError, type RuntimeStatus } from "@neta-art/cohub";
import { getCacheUserKey } from "$lib/cache/keys";
import { subscribeSpaceChannel } from "$lib/features/session-chat/space-channel";
import { sdk } from "$lib/sdk";
import { createLocalListCache } from "$lib/stores/create-local-list-cache";
import {
	createRuntimeStatusFreshness,
	type RuntimeStatusFreshness,
	runtimeStatusBackoffMs,
	shouldRequestRuntimeStatus,
} from "./runtime-status-policy";

const cache = createLocalListCache<RuntimeStatus>({
	storagePrefix: "cohub:runtime",
	cacheVersion: 1,
	updatedEventName: "cohub:runtime-cache-updated",
	ttlMs: 60_000,
	normalize: (items) =>
		items
			.filter((item) => item.kind === "local" || item.kind === "cloud")
			.slice(0, 1),
});
const keyFor = (spaceId: string) => `${getCacheUserKey()}:${spaceId}`;
const statuses = $state<Record<string, RuntimeStatus>>({});
const verified = $state<Record<string, boolean>>({});
export const runtimeStatusVerified = (spaceId: string) =>
	verified[keyFor(spaceId)] === true;
const fetchedAt = $state<Record<string, number>>({});
const pending = new Map<string, Promise<RuntimeStatus | null>>();
const freshness = new Map<string, RuntimeStatusFreshness>();

export const cachedRuntimeStatus = (spaceId: string) => {
	const key = keyFor(spaceId);
	const current = statuses[key];
	if (current && verified[key]) return current;
	const snapshot = current ?? cache.getCached(spaceId)?.[0];
	// Unverified snapshots retain labels/models, never claim either connection is online.
	return snapshot
		? {
				...snapshot,
				online: false,
				workspace: {
					online: false,
					observedAt: snapshot.workspace?.observedAt ?? null,
				},
			}
		: null;
};

/** Epoch ms of the last successful status fetch for a Space, if any. */
export const cachedRuntimeStatusFetchedAt = (spaceId: string) =>
	fetchedAt[keyFor(spaceId)] ?? cache.getCachedMeta(spaceId)?.updatedAt ?? null;

function freshnessFor(spaceId: string) {
	let current = freshness.get(spaceId);
	if (!current) {
		current = createRuntimeStatusFreshness();
		freshness.set(spaceId, current);
	}
	return current;
}

/**
 * Fetch the runtime status for a Space, coalescing concurrent callers and
 * honouring the freshness/backoff policy. `force` bypasses both, for explicit
 * user actions that must observe the server immediately.
 */
export function refreshRuntimeStatus(
	spaceId: string,
	options: { force?: boolean } = {},
) {
	const key = keyFor(spaceId);
	const inFlight = pending.get(key);
	if (inFlight) return inFlight;

	const state = freshnessFor(key);
	if (
		!shouldRequestRuntimeStatus(state, {
			now: Date.now(),
			force: options.force,
		})
	)
		return Promise.resolve(cachedRuntimeStatus(spaceId));

	const request = sdk
		.space(spaceId)
		.getRuntime()
		.then((status) => {
			if (keyFor(spaceId) !== key) return null;
			const previous = statuses[key] ?? cache.getCached(spaceId)?.[0];
			verified[key] = true;
			statuses[key] = {
				...status,
				capabilities: status.capabilities ?? previous?.capabilities ?? null,
			};
			cache.setCached(spaceId, [statuses[key]]);
			fetchedAt[key] = Date.now();
			state.lastSuccessAt = Date.now();
			state.retryAt = 0;
			return status as RuntimeStatus | null;
		})
		.catch((error) => {
			// Retain useful labels, but fail closed after an unverified connection.
			verified[key] = false;
			if (
				error instanceof HttpError &&
				[401, 403, 404].includes(error.status)
			) {
				delete statuses[key];
				delete fetchedAt[key];
				if (keyFor(spaceId) === key) cache.clearCached(spaceId);
			}
			state.retryAt =
				Date.now() +
				runtimeStatusBackoffMs(
					error instanceof HttpError ? error.status : null,
				);
			throw error;
		})
		.finally(() => {
			if (pending.get(key) === request) pending.delete(key);
		});
	pending.set(key, request);
	return request;
}

/** Shared realtime room; refresh only on lifecycle changes, not every heartbeat. */
export function watchRuntimeStatus(spaceId: string) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const unsubscribe = subscribeSpaceChannel(spaceId, (event) => {
		if (event.type !== "space.runtime.changed") return;
		clearTimeout(timer);
		timer = setTimeout(() => {
			void (async () => {
				await pending.get(keyFor(spaceId))?.catch(() => undefined);
				await refreshRuntimeStatus(spaceId, { force: true });
			})().catch(() => undefined);
		}, 150);
	});
	return () => {
		clearTimeout(timer);
		unsubscribe();
	};
}
