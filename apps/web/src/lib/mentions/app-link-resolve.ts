import { appDisplayTitle } from "#lib/app-page-meta.ts";
import { sdk } from "#lib/sdk.ts";
import { getCohubAppLinkKey, type ParsedCohubAppLink } from "./app.ts";

const LINK_RESOLVE_LIMIT = 20;

export async function resolveCohubAppLinkMentionLabels(
	links: ParsedCohubAppLink[],
	options?: { signal?: AbortSignal; limit?: number },
) {
	const unique = [
		...new Map(links.map((link) => [getCohubAppLinkKey(link), link])).values(),
	].slice(0, options?.limit ?? LINK_RESOLVE_LIMIT);
	const resolved = new Map<string, string>();

	await Promise.all(
		unique.map(async (link) => {
			try {
				const { app } = await sdk.apps.getBySlug(
					link.username,
					link.spaceSlug,
					link.appSlug,
					{ signal: options?.signal },
				);
				if (options?.signal?.aborted)
					throw new DOMException("Resolve aborted", "AbortError");
				resolved.set(
					getCohubAppLinkKey(link),
					appDisplayTitle(app.meta, app.slug),
				);
			} catch (error) {
				if ((error as { name?: string })?.name === "AbortError") throw error;
				// Missing or inaccessible Works stay as ordinary pasted links.
			}
		}),
	);
	return resolved;
}
