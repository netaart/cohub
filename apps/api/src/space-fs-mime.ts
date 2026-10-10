/**
 * Shared MIME helpers for space file read/write and CDN delivery classification.
 * Kept separate from space-fs.ts so CDN helpers can use them without cycles.
 */

/** Strip parameters (`text/plain; charset=utf-8` → `text/plain`) and lowercase. */
export function normalizeMime(mimeType: string | null | undefined): string | null {
	if (!mimeType) return null;
	const base = mimeType.split(";")[0]?.trim().toLowerCase();
	return base || null;
}

export function isTextMime(mimeType: string | null | undefined) {
	const mime = normalizeMime(mimeType);
	if (!mime) return false;
	return (
		mime.startsWith("text/") ||
		mime === "application/json" ||
		mime === "application/csv" ||
		mime === "application/xml" ||
		mime === "application/yaml" ||
		mime === "application/toml" ||
		mime === "application/sql" ||
		mime === "application/x-ndjson"
	);
}

/**
 * Resolve the MIME used for text/binary classification on reads.
 *
 * Filename-based text types win over generic content sniffs such as
 * `application/octet-stream` (common for empty/dotfiles like `.npmrc` from
 * sandbox `http.DetectContentType`). Real media types from content sniffing
 * are still trusted.
 */
export function resolveReadMimeType(
	byName: string | null | undefined,
	provided: string | null | undefined,
): string | null {
	const nameMime = normalizeMime(byName);
	const providedMime = normalizeMime(provided);

	if (isTextMime(nameMime)) return nameMime;

	if (
		providedMime &&
		(isTextMime(providedMime) ||
			providedMime.startsWith("image/") ||
			providedMime.startsWith("video/") ||
			providedMime.startsWith("audio/") ||
			providedMime === "application/pdf")
	) {
		return providedMime;
	}

	return nameMime ?? providedMime;
}
