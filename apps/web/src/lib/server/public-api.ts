import type {
	AppResolveResponse,
	PublicUserPageResponse,
} from "@neta-art/cohub";
import { PUBLIC_API_ORIGIN } from "$env/static/public";
import type { PublicAppPath } from "$lib/app-pwa";

function apiUrl(path: string) {
	const base = (PUBLIC_API_ORIGIN ?? "").replace(/\/$/, "");
	return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
	return response.json().catch(() => null);
}

function asAppDetail(value: unknown): AppResolveResponse | null {
	if (!isRecord(value)) return null;
	if (!isRecord(value.app) || typeof value.app.id !== "string") return null;
	if (!isRecord(value.space) || typeof value.space.id !== "string") return null;
	if (!isRecord(value.owner) || typeof value.owner.userUuid !== "string")
		return null;
	return value as AppResolveResponse;
}

function asPublicUserPage(value: unknown): PublicUserPageResponse | null {
	if (!isRecord(value)) return null;
	if (!isRecord(value.profile) || typeof value.profile.userUuid !== "string")
		return null;
	if (!Array.isArray(value.spaces) || !Array.isArray(value.apps)) return null;
	return value as PublicUserPageResponse;
}

export type PublicApiFailure = {
	ok: false;
	status: number;
	/** True when the app likely exists but the anonymous SSR fetch cannot see it. */
	needsClientAuth?: boolean;
};

/**
 * Public app detail for SSR / manifest.
 * Web Workers do not talk to Postgres — this always goes through the API.
 */
export async function loadPublicAppDetail(
	path: PublicAppPath | null,
	fetcher: typeof fetch,
	options: { version?: number | null } = {},
): Promise<{ ok: true; detail: AppResolveResponse } | PublicApiFailure> {
	if (!path) return { ok: false, status: 0 };
	const query = options.version != null ? `?cohub_v=${options.version}` : "";
	const url = apiUrl(
		`/api/apps/by-slug/${encodeURIComponent(path.username)}/${encodeURIComponent(path.spaceSlug)}/${encodeURIComponent(path.appSlug)}${query}`,
	);
	const response = await fetcher(url).catch(() => null);
	if (!response) return { ok: false, status: 502 };
	if (response.status === 404) return { ok: false, status: 404 };
	// Space-visibility works require auth; anonymous SSR cannot complete them.
	if (response.status === 401 || response.status === 403) {
		return { ok: false, status: response.status, needsClientAuth: true };
	}
	if (!response.ok)
		return {
			ok: false,
			status: response.status >= 500 ? 502 : response.status,
		};
	const detail = asAppDetail(await readJson(response));
	if (!detail) return { ok: false, status: 502 };
	return { ok: true, detail };
}

/**
 * Page URL for an API `redirectTo` (retired username / Space slug): the canonical
 * pathname with the page's own query string. Null when there is nothing to follow.
 */
export function publicSlugRedirectLocation(
	redirectTo: unknown,
	url: URL,
): string | null {
	if (typeof redirectTo !== "string") return null;
	const pathname = new URL(redirectTo, url.origin).pathname;
	return pathname === url.pathname ? null : `${pathname}${url.search}`;
}

/** `redirectTo` for a `/:username/:spaceSlug` Space page; null on a miss or any failure. */
export async function loadPublicSpaceRedirect(
	username: string,
	spaceSlug: string,
	fetcher: typeof fetch,
): Promise<unknown> {
	const response = await fetcher(
		apiUrl(
			`/api/spaces/by-slug/${encodeURIComponent(username)}/${encodeURIComponent(spaceSlug)}`,
		),
	).catch(() => null);
	if (!response?.ok) return null;
	const body = await readJson(response);
	return isRecord(body) ? body.redirectTo : null;
}

/** Public profile page payload for SSR. */
export async function loadPublicUserPage(
	username: string,
	fetcher: typeof fetch,
): Promise<{ ok: true; page: PublicUserPageResponse } | PublicApiFailure> {
	const url = apiUrl(`/api/users/by-username/${encodeURIComponent(username)}`);
	const response = await fetcher(url).catch(() => null);
	if (!response) return { ok: false, status: 502 };
	if (!response.ok) {
		return {
			ok: false,
			status:
				response.status === 404
					? 404
					: response.status >= 500
						? 502
						: response.status,
		};
	}
	const page = asPublicUserPage(await readJson(response));
	if (!page) return { ok: false, status: 502 };
	return { ok: true, page };
}
