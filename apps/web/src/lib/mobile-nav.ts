export type MobileNavTab = "chats" | "spaces" | "account";

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

export function resolveMobileNavTab(pathname: string): MobileNavTab {
	if (isSessionsPath(pathname)) return "chats";
	if (isAccountPath(pathname)) return "account";
	return "spaces";
}

export function shouldHideMobileTabBar(pathname: string): boolean {
	return (
		isSpaceCreatePath(pathname) ||
		SESSION_DETAIL_PATH.test(pathname) ||
		SPACE_SURFACE_PATH.test(pathname)
	);
}
