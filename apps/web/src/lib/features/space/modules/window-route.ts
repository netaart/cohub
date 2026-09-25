import { buildSpaceRootRoute } from "$lib/space-routes";
import { parseAppWindowKey } from "./app-window-key";

export type WindowKind = "file" | "board" | "port" | "app";

export type WindowRef = {
	kind: WindowKind;
	key: string;
};

/** Canonical deep-link key; the legacy `preview` spelling stays readable. */
export const WINDOW_QUERY_KEY = "window";
const LEGACY_WINDOW_QUERY_KEY = "preview";

/** An App id, or an App id bound to a workspace file. */
export function isValidAppKey(key: string): boolean {
	return parseAppWindowKey(key) !== null;
}

/** Accept only integer ports in 1..65535. Reject host-injection forms. */
export function isValidPortKey(key: string): boolean {
	if (!/^\d{1,5}$/.test(key)) return false;
	const n = Number(key);
	return Number.isInteger(n) && n >= 1 && n <= 65535;
}

export function encodeWindowParam(ref: WindowRef): string {
	return `${ref.kind}:${ref.key}`;
}

export function parseWindowParam(
	value: string | null | undefined,
): WindowRef | null {
	if (!value) return null;
	const separator = value.indexOf(":");
	if (separator <= 0) return null;
	// `work:` deep links predate the rename; they still open app windows.
	const kind =
		value.slice(0, separator) === "work" ? "app" : value.slice(0, separator);
	const key = value.slice(separator + 1);
	if (!key) return null;
	if (kind !== "file" && kind !== "board" && kind !== "port" && kind !== "app")
		return null;
	if (kind === "port" && !isValidPortKey(key)) return null;
	if (kind === "app" && !isValidAppKey(key)) return null;
	return { kind, key };
}

function windowSearchParams(
	search: string | URLSearchParams | null | undefined,
): URLSearchParams | null {
	if (!search) return null;
	return typeof search === "string"
		? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
		: search;
}

export function readWindowFromSearch(
	search: string | URLSearchParams | null | undefined,
): WindowRef | null {
	const params = windowSearchParams(search);
	return parseWindowParam(
		params?.get(WINDOW_QUERY_KEY) ?? params?.get(LEGACY_WINDOW_QUERY_KEY),
	);
}

/**
 * Resolve shallow navigation state without letting an older state entry mask an
 * explicit window in the browser URL.
 */
export function resolveRouteWindow(
	search: string | URLSearchParams | null | undefined,
	shallowValue: string | null | undefined,
): WindowRef | null {
	const params = windowSearchParams(search);
	if (params?.has(WINDOW_QUERY_KEY))
		return parseWindowParam(params.get(WINDOW_QUERY_KEY));
	if (params?.has(LEGACY_WINDOW_QUERY_KEY))
		return parseWindowParam(params.get(LEGACY_WINDOW_QUERY_KEY));
	return parseWindowParam(shallowValue);
}

export function withWindowParam(
	pathname: string,
	search: string | URLSearchParams | null | undefined,
	ref: WindowRef | null,
): string {
	const params =
		typeof search === "string"
			? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
			: new URLSearchParams(search ?? undefined);
	if (ref) params.set(WINDOW_QUERY_KEY, encodeWindowParam(ref));
	else {
		params.delete(WINDOW_QUERY_KEY);
		params.delete(LEGACY_WINDOW_QUERY_KEY);
	}
	const query = params.toString();
	return query ? `${pathname}?${query}` : pathname;
}

/**
 * Preserve the current `?window=` when switching Main routes inside a space.
 * Chat/session navigation should only change the main panel, not collapse Files.
 */
export function withCurrentWindow(
	pathname: string,
	currentSearch?: string | URLSearchParams | null,
): string {
	if (typeof window === "undefined" && currentSearch == null) return pathname;
	const search =
		currentSearch ??
		(typeof window !== "undefined" ? window.location.search : null);
	const ref = readWindowFromSearch(search);
	if (!ref) return pathname;
	return withWindowParam(pathname, null, ref);
}

/**
 * Sidebar-driven Main navigation. Desktop keeps the open window pane;
 * mobile drops it so the full-screen overlay does not cover the target.
 */
export function withSidebarMainWindow(
	pathname: string,
	options: {
		isMobile: boolean;
		currentSearch?: string | URLSearchParams | null;
	},
): string {
	if (options.isMobile) return pathname;
	return withCurrentWindow(pathname, options.currentSearch);
}

/** Deterministic ingress for legacy `/spaces/:id/files/...` routes. */
export function buildFileIngressMainRoute(
	spaceId: string,
	path: string,
): string {
	const cleaned = path
		.split("/")
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		})
		.filter(Boolean)
		.join("/");
	return withWindowParam(buildSpaceRootRoute(spaceId), null, {
		kind: "file",
		key: cleaned,
	});
}
