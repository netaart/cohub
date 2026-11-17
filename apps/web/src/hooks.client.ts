import { HttpError } from "@neta-art/cohub";
import type { HandleClientError } from "@sveltejs/kit/hooks";
import { shouldReloadForFailedDynamicImport } from "#lib/asset-import-recovery.ts";
import { installCohubDebuggerConsoleExports } from "#lib/debugger.ts";

installCohubDebuggerConsoleExports();

// SvelteKit replaces unknown thrown errors with a generic "Internal Error";
// keep the real SDK HttpError message so error boundaries can classify it.
export const handleError: HandleClientError = ({ kind, error }) => {
	if (kind !== "unknown") return;
	console.error(error);
	if (error instanceof HttpError) return { message: error.message };
};

const FAILED_DYNAMIC_IMPORT_STORAGE_KEY = "cohub:failed-dynamic-import";

function reloadForFailedDynamicImport(error: unknown): boolean {
	let previousSignature: string | null = null;
	try {
		previousSignature = sessionStorage.getItem(
			FAILED_DYNAMIC_IMPORT_STORAGE_KEY,
		);
	} catch {
		// Private browsing or storage policies must not prevent recovery.
	}

	const signature = shouldReloadForFailedDynamicImport(
		error,
		previousSignature,
	);
	if (!signature) return false;

	try {
		sessionStorage.setItem(FAILED_DYNAMIC_IMPORT_STORAGE_KEY, signature);
	} catch {
		// Reloading remains useful when session storage is unavailable.
	}
	window.location.reload();
	return true;
}

// A deployment can remove a chunk that an already-open page needs only when a
// route is visited. Reload once into the current asset manifest instead of
// leaving the user at SvelteKit's generic error boundary.
window.addEventListener("vite:preloadError", (event) => {
	if (reloadForFailedDynamicImport(event.payload)) event.preventDefault();
});

window.addEventListener("error", (event) => {
	if (reloadForFailedDynamicImport(event.error)) event.preventDefault();
});

window.addEventListener("unhandledrejection", (event) => {
	if (reloadForFailedDynamicImport(event.reason)) event.preventDefault();
});
