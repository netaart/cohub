import {
	isReservedPublicIdentifier,
	parseSpaceSlug,
	parseUsername,
} from "@cohub/protocol/public-identifiers";
import type { SpaceRecord } from "@neta-art/cohub";
import { SvelteMap, SvelteSet } from "svelte/reactivity";

/**
 * Friendly Space addresses (`/:username/:slug/...`) and their Space ids.
 *
 * Invariant: one address maps to at most one Space. Addresses seen in a server
 * response this session are `confirmed`; addresses seeded from the local cache
 * only route navigations and never drive links or URL canonicalization.
 */
export type SpaceAddress = { username: string; slug: string };

type Entry = SpaceAddress & { confirmed: boolean };

type SpaceAddressInput = Partial<Pick<SpaceRecord, "slug" | "ownerProfile">> & {
	id: string;
};

/** Third path segments that belong to public routes under `/:username/:slug`. */
const PUBLIC_SPACE_SUBROUTES = new Set(["w", "join"]);

const bySpace = new SvelteMap<string, Entry>();
const byAddress = new SvelteMap<string, string>();
/** Old addresses the server resolved this session, by redirect. */
const aliases = new SvelteMap<string, string>();
/** Addresses routed from the local cache that the server has not confirmed yet. */
const pending = new SvelteSet<string>();

export const addressKey = (address: SpaceAddress) =>
	`${address.username}/${address.slug}`;

/** The friendly address at the start of an app path, with the remainder. */
export function parseSpaceAddressPath(
	pathname: string,
): { address: SpaceAddress; rest: string } | null {
	const [, rawUsername, rawSlug, sub, ...tail] = pathname.split("/");
	if (!rawUsername || !rawSlug) return null;
	if (sub !== undefined && PUBLIC_SPACE_SUBROUTES.has(sub)) return null;
	let username: string | null;
	let slug: string | null;
	try {
		username = parseUsername(decodeURIComponent(rawUsername));
		slug = parseSpaceSlug(decodeURIComponent(rawSlug));
	} catch {
		return null;
	}
	if (!username || !slug) return null;
	if (isReservedPublicIdentifier("username", username)) return null;
	const rest = sub === undefined ? "" : `/${[sub, ...tail].join("/")}`;
	return { address: { username, slug }, rest };
}

export function spaceAddressPath(address: SpaceAddress): string {
	return `/${encodeURIComponent(address.username)}/${encodeURIComponent(address.slug)}`;
}

/** Confirmed address of a Space, for links and the address bar. */
export function spaceAddressOf(spaceId: string): SpaceAddress | null {
	const entry = bySpace.get(spaceId);
	return entry?.confirmed ? entry : null;
}

/** Space routed by an address: current holder first, then a resolved old address. */
export function spaceIdAt(
	address: SpaceAddress,
): { spaceId: string; confirmed: boolean } | null {
	const key = addressKey(address);
	const holder = byAddress.get(key);
	if (holder) {
		return {
			spaceId: holder,
			confirmed: Boolean(bySpace.get(holder)?.confirmed),
		};
	}
	const alias = aliases.get(key);
	return alias ? { spaceId: alias, confirmed: true } : null;
}

/** `/spaces/:id/...` form of an app path whose friendly prefix is known. */
export function toSpaceIdPath(pathname: string): string {
	if (pathname.startsWith("/spaces/")) return pathname;
	const parsed = parseSpaceAddressPath(pathname);
	const holder = parsed && spaceIdAt(parsed.address);
	return holder ? `/spaces/${holder.spaceId}${parsed.rest}` : pathname;
}

function evictAddress(key: string) {
	const holder = byAddress.get(key);
	if (holder) bySpace.delete(holder);
	byAddress.delete(key);
}

function setEntry(spaceId: string, entry: Entry) {
	const current = bySpace.get(spaceId);
	if (current) byAddress.delete(addressKey(current));
	const key = addressKey(entry);
	const holder = byAddress.get(key);
	if (holder && holder !== spaceId) bySpace.delete(holder);
	aliases.delete(key);
	bySpace.set(spaceId, entry);
	byAddress.set(key, spaceId);
}

/**
 * Record a Space address from a server record. Fields a partial record omits keep
 * their known value; an explicit null slug or owner username removes the address.
 */
export function rememberSpaceAddress(
	space: SpaceAddressInput,
	options: { confirmed?: boolean } = {},
) {
	const confirmed = options.confirmed ?? true;
	const current = bySpace.get(space.id);
	if (!confirmed && current?.confirmed) return;
	const slug = Object.hasOwn(space, "slug") ? space.slug : current?.slug;
	const username = Object.hasOwn(space, "ownerProfile")
		? space.ownerProfile?.username
		: current?.username;
	// Names assigned before they were reserved stay on `/spaces/:id`: the platform route wins.
	if (
		!slug ||
		!username ||
		isReservedPublicIdentifier("username", username) ||
		isReservedPublicIdentifier("spaceSlug", slug)
	) {
		if (current && (confirmed || !current.confirmed)) {
			byAddress.delete(addressKey(current));
			bySpace.delete(space.id);
		}
		return;
	}
	if (
		current?.slug === slug &&
		current.username === username &&
		current.confirmed === confirmed
	)
		return;
	if (!confirmed) {
		const holder = byAddress.get(addressKey({ username, slug }));
		if (holder && bySpace.get(holder)?.confirmed) return;
	}
	setEntry(space.id, { username, slug, confirmed });
}

/** The server resolved `requested` to a Space that now lives at `current`. */
export function rememberResolvedAddress(
	requested: SpaceAddress,
	spaceId: string,
	current: SpaceAddress,
) {
	const requestedKey = addressKey(requested);
	pending.delete(requestedKey);
	setEntry(spaceId, { ...current, confirmed: true });
	if (requestedKey !== addressKey(current)) {
		evictAddress(requestedKey);
		aliases.set(requestedKey, spaceId);
	}
}

/** Drop a cache-seeded address the server says no longer exists. */
export function forgetUnconfirmedAddress(address: SpaceAddress) {
	const key = addressKey(address);
	const holder = byAddress.get(key);
	if (holder && !bySpace.get(holder)?.confirmed) evictAddress(key);
}

export function markAddressPending(address: SpaceAddress) {
	pending.add(addressKey(address));
}

export function settleAddress(address: SpaceAddress) {
	pending.delete(addressKey(address));
}

/** A username change moves every Space the user owns. */
export function renameSpaceOwner(previous: string, next: string) {
	if (previous === next) return;
	for (const [spaceId, entry] of [...bySpace]) {
		if (entry.username === previous) {
			setEntry(spaceId, { ...entry, username: next });
		}
	}
}

export function clearSpaceAddresses() {
	bySpace.clear();
	byAddress.clear();
	aliases.clear();
	pending.clear();
}

/**
 * Where the address bar should point for `spaceId` at `url`: navigate when the
 * friendly address in the URL now belongs to another Space, replace the URL when
 * the Space has a different confirmed address, otherwise null.
 */
export function canonicalSpaceLocation(
	url: Pick<URL, "pathname" | "search" | "hash">,
	spaceId: string,
): { navigate: string } | { replace: string } | null {
	const idPrefix = `/spaces/${spaceId}`;
	let rest: string;
	if (url.pathname === idPrefix || url.pathname.startsWith(`${idPrefix}/`)) {
		rest = url.pathname.slice(idPrefix.length);
	} else {
		const parsed = parseSpaceAddressPath(url.pathname);
		if (!parsed) return null;
		const key = addressKey(parsed.address);
		if (pending.has(key)) return null;
		rest = parsed.rest;
		const holder = byAddress.get(key);
		if (holder && holder !== spaceId && bySpace.get(holder)?.confirmed) {
			return { navigate: `/spaces/${holder}${rest}${url.search}${url.hash}` };
		}
	}
	const address = spaceAddressOf(spaceId);
	if (!address) return null;
	const pathname = `${spaceAddressPath(address)}${rest}`;
	return pathname === url.pathname
		? null
		: { replace: `${pathname}${url.search}${url.hash}` };
}
