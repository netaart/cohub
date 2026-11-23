export const APP_BROWSER_SESSION_PATH = "/.well-known/cohub/app-session";
export const APP_BROWSER_SESSION_SECONDS = 14 * 24 * 60 * 60;

export function appReturnPath(value: string, origin: string): string | null {
	if (!value || value.length > 2048 || /[\\\r\n]/.test(value)) return null;
	try {
		const url = new URL(value, origin);
		if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password ||
			url.pathname.startsWith("//") || url.pathname.startsWith(APP_BROWSER_SESSION_PATH)) return null;
		return url.pathname + url.search + url.hash;
	} catch {
		return null;
	}
}

/** An unprivileged cache hint. Only the HttpOnly session cookie authorizes a refresh. */
export const APP_BROWSER_SESSION_HINT = "__Host-cohub-app-active";
