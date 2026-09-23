import { isCohubAppHostname, parseCohubAppHostTemplate } from "@cohub/protocol";
import { serveStandaloneApp } from "./standalone-app.ts";

/**
 * Serves a request addressed to a published App's standalone origin, or null
 * when the host is not a managed standalone origin.
 *
 * A standalone origin resolves to exactly one App, so every path on that host
 * belongs to it — including prerendered paths that the SvelteKit adapter would
 * otherwise answer from static assets. `entry.worker.ts` calls this before the
 * adapter runs, which is what makes those paths reach the App.
 *
 * The template is deployment configuration read from `.env`, so it is parsed
 * here rather than trusted: a value that only differs in case or padding would
 * otherwise match one entry point and not the other.
 *
 * Kept free of `$lib`/`$env` aliases so Wrangler can bundle it for the entry,
 * and kept standalone so it stays unit tested (`entry.worker.ts` is build glue).
 */
export function serveStandaloneHostRequest(input: {
	request: Request;
	url: URL;
	template: string | null;
	apiOrigin: string;
	fetcher: typeof fetch;
}): Promise<Response> | null {
	const template = parseCohubAppHostTemplate(input.template);
	if (!template || !isCohubAppHostname(input.url.hostname, template))
		return null;
	return serveStandaloneApp({
		request: input.request,
		url: input.url,
		apiOrigin: input.apiOrigin,
		fetcher: input.fetcher,
	});
}
