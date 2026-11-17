import {
	type AppPageDetail,
	buildAppPwaMeta as buildSharedAppPwaMeta,
} from "#lib/app-page-meta.ts";

export type AppPwaDetail = AppPageDetail;

const PUBLIC_APP_SEGMENT = "w";

export type PublicAppPath = {
	username: string;
	spaceSlug: string;
	appSlug: string;
	pathname: string;
};

export function parsePublicAppPath(pathname: string): PublicAppPath | null {
	const segments = pathname.split("/").filter(Boolean);
	if (segments.length !== 4 || segments[2] !== PUBLIC_APP_SEGMENT) return null;
	const [username, spaceSlug, , appSlug] = segments;
	if (!username || !spaceSlug || !appSlug) return null;
	return { username, spaceSlug, appSlug, pathname: `/${segments.join("/")}` };
}

export function resolvePublicAppStartUrl(requestUrl: URL) {
	const rawStartUrl = requestUrl.searchParams.get("start_url");
	if (!rawStartUrl) return { startUrl: "/", path: null };

	let parsed: URL;
	try {
		parsed = new URL(rawStartUrl, requestUrl.origin);
	} catch {
		return { startUrl: "/", path: null };
	}
	if (parsed.origin !== requestUrl.origin) return { startUrl: "/", path: null };

	const path = parsePublicAppPath(parsed.pathname);
	if (!path) return { startUrl: "/", path: null };

	return { startUrl: path.pathname, path };
}

export function buildAppPwaMeta(detail: AppPwaDetail | null) {
	return buildSharedAppPwaMeta(detail);
}
