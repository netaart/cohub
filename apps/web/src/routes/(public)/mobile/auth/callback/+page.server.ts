import { redirect } from "@sveltejs/kit";
import { resolvePreferredLocale } from "$lib/i18n/locale";
import type { PageServerLoad } from "./$types";

/** Fallback when the browser keeps the App Link; no client JS keeps the code out of logs. */
export const csr = false;

export const load: PageServerLoad = ({ url, request, setHeaders }) => {
	if (!url.searchParams.has("state")) redirect(302, "/");

	setHeaders({ "cache-control": "no-store", "referrer-policy": "no-referrer" });

	const languages = (request.headers.get("accept-language") ?? "")
		.split(",")
		.map((language) => language.split(";")[0]?.trim() ?? "")
		.filter(Boolean);

	return {
		appHref: `${url.pathname}${url.search}`,
		locale: resolvePreferredLocale("system", languages),
	};
};
