import { redirect } from "@sveltejs/kit";
import { buildSpaceRootRoute } from "$lib/space-routes";
import { resourceFromUrl, resourceWorkspaceUrl } from "./resource-app-route";

export function redirectResourcePage(url: URL) {
	if (url.searchParams.get("native") === "1") return;
	const resource = resourceFromUrl(url);
	if (!resource) return;
	redirect(
		307,
		resourceWorkspaceUrl(
			buildSpaceRootRoute(resource.spaceId),
			url.searchParams,
			resource.target,
		),
	);
}
