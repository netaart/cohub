import {
	isUuid,
	type ResourceAppTarget,
	readResourceAppTarget,
	writeResourceAppTarget,
} from "@cohub/protocol";
import { toSpaceIdPath } from "$lib/stores/space-address";

const RESOURCE_SEGMENTS = {
	tasks: "task",
	checkpoints: "checkpoint",
	cronjobs: "cronjob",
	apps: "app",
} as const;

export { resourceAppRef } from "@cohub/protocol";

export function resourceFromUrl(
	url: URL,
): { spaceId: string; target: ResourceAppTarget } | null {
	const match =
		/^\/spaces\/([^/]+)\/(tasks|checkpoints|cronjobs|apps)\/([^/]+)\/?$/.exec(
			toSpaceIdPath(url.pathname),
		);
	if (!match || !isUuid(match[1])) return null;
	const params = new URLSearchParams({
		resource: `${RESOURCE_SEGMENTS[match[2] as keyof typeof RESOURCE_SEGMENTS]}:${match[3]}`,
	});
	const base = url.searchParams.get("base");
	if (base) params.set("resourceBase", base);
	const target = readResourceAppTarget(params);
	return target ? { spaceId: match[1], target } : null;
}

export function resourceWorkspaceUrl(
	pathname: string,
	search: string | URLSearchParams,
	target: ResourceAppTarget,
) {
	const params = new URLSearchParams(search);
	params.delete("window");
	params.delete("appHash");
	params.delete("preview");
	params.delete("base");
	params.delete("native");
	writeResourceAppTarget(params, target);
	return `${pathname}?${params}`;
}
