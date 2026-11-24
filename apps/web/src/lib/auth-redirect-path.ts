import { isUuidOrShortUuid } from "@cohub/protocol/identifiers";

function isAuthEndpointPath(url: URL) {
	if (url.pathname === "/app-auth") {
		const origin = url.searchParams.get("origin") ?? "";
		const target = URL.canParse(origin) ? new URL(origin) : null;
		const local =
			target?.protocol === "http:" &&
			["localhost", "127.0.0.1"].includes(target.hostname);
		// The broker revalidates the binding before issuing credentials.
		return (
			!isUuidOrShortUuid(url.searchParams.get("app")) ||
			!target ||
			(target.protocol !== "https:" && !local) ||
			target.origin !== origin
		);
	}
	return (
		url.pathname === "/callback" ||
		url.pathname.startsWith("/callback/") ||
		url.pathname.startsWith("/app-auth/")
	);
}

export function sanitizeRedirectPath(path?: string | null): string {
	const trimmed = path?.trim();
	if (!trimmed || trimmed.startsWith("//") || /[\\\r\n\t]/.test(trimmed))
		return "/";
	if (typeof window === "undefined" && !trimmed.startsWith("/")) return "/";
	const origin =
		typeof window === "undefined"
			? "http://local.invalid"
			: window.location.origin;
	try {
		const url = new URL(trimmed, origin);
		if (
			url.origin !== origin ||
			url.pathname.startsWith("//") ||
			isAuthEndpointPath(url)
		)
			return "/";
		return url.pathname + url.search + url.hash;
	} catch {
		return "/";
	}
}
