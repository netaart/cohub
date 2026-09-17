import { error } from "@sveltejs/kit";
import { loadPublicAppDetail } from "$lib/server/public-api";
import { setPublicPageCache } from "$lib/server/public-cache";
import type { PageServerLoad } from "./$types";

/** Read `?cohub_v=` as a version number; ignore anything malformed. */
function readRequestedVersion(searchParams: URLSearchParams): number | null {
	const raw = searchParams.get("cohub_v");
	if (!raw || !/^\d{1,9}$/.test(raw)) return null;
	const version = Number(raw);
	return version >= 1 ? version : null;
}

export const load: PageServerLoad = async ({
	params,
	fetch,
	url,
	setHeaders,
}) => {
	const path = {
		username: params.username,
		spaceSlug: params.spaceSlug,
		appSlug: params.appSlug,
		pathname: url.pathname,
	};
	const requestedVersion = readRequestedVersion(url.searchParams);
	const result = await loadPublicAppDetail(path, fetch, {
		version: requestedVersion,
	});

	if (result.ok) {
		// This loader fetches the API anonymously, so the rendered document can only
		// ever reflect anonymous-visible data — app visibility alone governs caching.
		setPublicPageCache(setHeaders, {
			private: (result.detail.app.visibility ?? "public") === "space",
		});
		const app = result.detail.app;
		return {
			mode: "ready" as const,
			app,
			/** @deprecated Use app. Kept for Work-era public page consumers. */
			work: app,
			space: result.detail.space,
			owner: result.detail.owner,
			publisher: result.detail.publisher,
			content: result.detail.content,
			publicUrl: result.detail.publicUrl,
			totalViews: result.detail.totalViews ?? null,
			version: result.detail.version ?? null,
			requestedVersion,
			pathname: url.pathname,
			origin: url.origin,
		};
	}

	// Only a definitive miss should 404 the document.
	// Auth failures, API outages, and shape issues fall back to client load so
	// already-published Works keep working (same as pre-SSR behavior).
	if (result.status === 404) {
		error(404, "App not found");
	}

	setPublicPageCache(setHeaders, { private: true });
	return {
		mode: "client" as const,
		pathname: url.pathname,
		origin: url.origin,
		username: params.username,
		spaceSlug: params.spaceSlug,
		appSlug: params.appSlug,
		requestedVersion,
	};
};
