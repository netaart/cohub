import { PUBLIC_COHUB_ENV, PUBLIC_FILES_ORIGIN } from "$env/static/public";

function publicFilesOrigin() {
	return (PUBLIC_FILES_ORIGIN ?? "").trim().replace(/\/+$/, "");
}

function publicFilesEnvPrefix() {
	const env = PUBLIC_COHUB_ENV?.trim().toLowerCase();
	return !env || env === "prod" ? "" : `${env}/`;
}

/**
 * Absolute CDN URL for a file in a Space's public files area, mirroring the
 * server's `buildPublicFileUrl` (`{origin}/{env}p/{spaceId}/{path}`). Returns
 * null when the origin is not configured for this build.
 */
export function buildPublicFileUrl(
	spaceId: string,
	path: string,
): string | null {
	const origin = publicFilesOrigin();
	const normalized = path.replace(/^\/+|\/+$/g, "");
	if (!origin || !normalized) return null;
	const objectKey = `${publicFilesEnvPrefix()}p/${spaceId}/${normalized}`;
	return `${origin}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
}
