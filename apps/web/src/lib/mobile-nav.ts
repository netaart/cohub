export type AppArea = "chats" | "spaces" | "account";

export const APP_AREAS: readonly AppArea[] = ["chats", "spaces", "account"];

export function isSpaceCreatePath(pathname: string): boolean {
	return pathname === "/spaces/new" || pathname.startsWith("/spaces/new/");
}

export function isSessionsPath(pathname: string): boolean {
	return pathname === "/sessions" || pathname.startsWith("/sessions/");
}

export function isAccountPath(pathname: string): boolean {
	return pathname === "/settings" || pathname.startsWith("/settings/");
}

const SPACE_SURFACE_PATH =
	/^\/spaces\/[^/]+\/(files|checkpoints|cronjobs|apps|tasks)(\/|$)/;
const SESSION_DETAIL_PATH = /^\/spaces\/[^/]+\/sessions\/[^/]+(\/|$)/;

export function resolveAppArea(pathname: string): AppArea {
	if (isSessionsPath(pathname)) return "chats";
	if (isAccountPath(pathname)) return "account";
	return "spaces";
}

export function appAreaHref(area: AppArea): string {
	switch (area) {
		case "chats":
			return "/sessions";
		case "spaces":
			return "/spaces";
		case "account":
			return "/settings/general";
	}
}

export function shouldHideMobileTabBar(pathname: string): boolean {
	return (
		isSpaceCreatePath(pathname) ||
		SESSION_DETAIL_PATH.test(pathname) ||
		SPACE_SURFACE_PATH.test(pathname)
	);
}
