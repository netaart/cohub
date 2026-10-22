import {
	isCohubAppHostname,
	isHostnameWithin,
	parseCohubAppHostTemplate,
} from "@cohub/protocol";
import { proxyPortApp } from "./port-app-proxy.ts";
import {
	detailFailureResponse,
	isDocumentRequest,
	loadStandaloneAppDetail,
	methodNotAllowed,
	serveStandaloneApp,
	serveWebContent,
	type WaitUntil,
} from "./standalone-app.ts";

export function parseSiteHostSuffixes(value: string | null | undefined) {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim().toLowerCase().replace(/^\.+/, ""))
		.filter(Boolean);
}

/**
 * Serves a request addressed to a published App's own origin — a managed
 * standalone host or a bound custom domain — or null for the Cohub site.
 *
 * Such an origin resolves to exactly one App, so every path on that host
 * belongs to it — including prerendered paths that the SvelteKit adapter would
 * otherwise answer from static assets. `entry.worker.ts` calls this before the
 * adapter runs, which is what makes those paths reach the App.
 *
 * Custom domains are on once site host suffixes are configured: any host
 * outside them is a custom domain candidate and never reaches SvelteKit, so a
 * third-party hostname can never render the Cohub site, sign-in or broker.
 *
 * Deployment values are read from `.env`, so they are parsed here rather than
 * trusted: a value that only differs in case or padding would otherwise match
 * one entry point and not the other.
 *
 * Kept free of `$lib`/`$env` aliases so Wrangler can bundle it for the entry,
 * and kept standalone so it stays unit tested (`entry.worker.ts` is build glue).
 */
export function serveStandaloneHostRequest(input: {
	request: Request;
	url: URL;
	template: string | null;
	siteHostSuffixes?: string | null;
	cohubEnv?: string | null;
	apiOrigin: string;
	fetcher: typeof fetch;
	waitUntil: WaitUntil;
}): Promise<Response> | null {
	const hostname = input.url.hostname;
	const template = parseCohubAppHostTemplate(input.template);
	if (template && isCohubAppHostname(hostname, template)) {
		return serveStandaloneApp(input);
	}
	const siteZones = parseSiteHostSuffixes(input.siteHostSuffixes);
	if (siteZones.length === 0) return null;
	if (siteZones.some((zone) => isHostnameWithin(hostname, zone))) return null;
	return serveCustomDomain({
		...input,
		portPolicy: {
			prefix: input.cohubEnv === "prod" ? "s" : "d",
			// The first zone carries Cloudflare for SaaS. Proxying only within it
			// keeps the subrequest same-zone, which preserves the visitor IP.
			zones: siteZones.slice(0, 1),
		},
	});
}

async function serveCustomDomain(input: {
	request: Request;
	url: URL;
	apiOrigin: string;
	fetcher: typeof fetch;
	waitUntil: WaitUntil;
	portPolicy: { prefix: string; zones: readonly string[] };
}): Promise<Response> {
	const result = await loadStandaloneAppDetail({
		apiOrigin: input.apiOrigin,
		origin: input.url.origin,
		fetcher: input.fetcher,
		waitUntil: input.waitUntil,
		recordView: isDocumentRequest(input.request, input.url),
		portPolicy: input.portPolicy,
		cacheMisses: true,
	});
	if (result.status !== "ok") return detailFailureResponse(result);
	const content = result.detail.content;
	if (content?.kind === "port") {
		return proxyPortApp({
			request: input.request,
			url: input.url,
			upstream: content.url,
			fetcher: input.fetcher,
		});
	}
	if (content?.kind !== "web")
		return detailFailureResponse({ status: "not_found" });
	if (input.request.method !== "GET" && input.request.method !== "HEAD") {
		return methodNotAllowed();
	}
	return serveWebContent({ ...input, content });
}
