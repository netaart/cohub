import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

/**
 * OAuth return path for native shells. The Android App Link claims this URL
 * first and exchanges the code where the PKCE verifier lives; this route only
 * serves a browser that followed the link manually.
 *
 * `ssr` keeps the authorization code out of client modules, storage and logs.
 */
export const ssr = true;

export const load: PageLoad = () => {
	redirect(302, "/");
};
