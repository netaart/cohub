import { redirect } from "@sveltejs/kit";
import { resolvePreferredLocale } from "#lib/i18n/locale.ts";
import { androidApp, androidIntentUrl } from "#lib/server/android-app.ts";
import { PUBLIC_COHUB_ENV } from "$app/env/public";
import type { PageServerLoad } from "./$types";

/** Fallback when the browser keeps the App Link; no client JS keeps the code out of logs. */
export const csr = false;

const android = androidApp(PUBLIC_COHUB_ENV);

export const load: PageServerLoad = ({ url, request, setHeaders }) => {
	if (!url.searchParams.has("state")) redirect(302, "/");

	setHeaders({ "cache-control": "no-store", "referrer-policy": "no-referrer" });

	const languages = (request.headers.get("accept-language") ?? "")
		.split(",")
		.map((language) => language.split(";")[0]?.trim() ?? "")
		.filter(Boolean);
	const onAndroid = /\bAndroid\b/.test(request.headers.get("user-agent") ?? "");

	return {
		appHref:
			android && onAndroid
				? androidIntentUrl(url, android.packageName)
				: `${url.pathname}${url.search}`,
		locale: resolvePreferredLocale("system", languages),
	};
};
