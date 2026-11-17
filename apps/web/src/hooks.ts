import type { Reroute } from "@sveltejs/kit/hooks";
import { parseSpaceAddressPath } from "#lib/stores/space-address.ts";
import { browser } from "$app/env";

/**
 * Friendly Space paths (`/:username/:slug/...`) render the `/spaces/:id/...` routes
 * in the browser. The server serves them from the catch-all shell route instead.
 */
export const reroute: Reroute = async ({ url }) => {
	if (!browser) return;
	const parsed = parseSpaceAddressPath(url.pathname);
	if (!parsed) return;
	try {
		const { resolveSpaceAddress } = await import(
			"#lib/space-address-resolver.ts"
		);
		const spaceId = await resolveSpaceAddress(parsed.address);
		return spaceId ? `/spaces/${spaceId}${parsed.rest}` : undefined;
	} catch {
		return;
	}
};
