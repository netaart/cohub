import { error } from "@sveltejs/kit";
import { loadPublicAppDetail } from "$lib/server/public-api";
import { setPublicPageCache } from "$lib/server/public-cache";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({
	params,
	fetch,
	url,
	setHeaders,
}) => {
	const result = await loadPublicAppDetail(
		{
			username: params.username,
			spaceSlug: params.spaceSlug,
			appSlug: params.appSlug,
			pathname: url.pathname,
		},
		fetch,
	);

	if (result.ok) {
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
			content: result.detail.content,
			publicUrl: result.detail.publicUrl,
			totalViews: result.detail.totalViews ?? null,
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
	};
};
