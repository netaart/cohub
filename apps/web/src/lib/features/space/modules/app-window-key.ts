import { isUuid } from "@cohub/protocol/identifiers";

/** `<appId>` or `<appId>:<path>`; a UUID has no `:`, so the key splits unambiguously. */
export function appWindowKey(appId: string, path?: string | null): string {
	return path ? `${appId}:${path}` : appId;
}

export function parseAppWindowKey(
	key: string,
): { appId: string; path: string | null } | null {
	const separator = key.indexOf(":");
	const appId = separator < 0 ? key : key.slice(0, separator);
	if (!isUuid(appId)) return null;
	if (separator < 0) return { appId, path: null };
	const path = key.slice(separator + 1);
	// Workspace-relative paths only; a link cannot point a window outside it.
	const relative =
		path && !path.startsWith("/") && !path.split("/").includes("..");
	return relative ? { appId, path } : null;
}
