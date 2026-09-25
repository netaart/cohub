/** File handlers. Extensions are stored lowercase and dot-prefixed (`.board`). */

/** `<meta name="cohub:file-handlers" content=".board .md">` in the App page head. */
export const APP_FILE_HANDLERS_META_NAME = "cohub:file-handlers";

export const MAX_APP_FILE_HANDLERS = 32;

const EXTENSION_RE = /^\.[a-z0-9][a-z0-9_-]{0,31}$/;

/** Normalizes `board`, `.Board`, or ` .board ` to `.board`; null when invalid. */
export function normalizeFileExtension(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim().toLowerCase();
	const extension = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
	return EXTENSION_RE.test(extension) ? extension : null;
}

/** Parses a list or a comma / space separated string; drops invalid entries. */
export function parseAppFileHandlers(value: unknown): string[] {
	const raw = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.split(/[\s,]+/)
			: [];
	const extensions = new Set<string>();
	for (const entry of raw) {
		const extension = normalizeFileExtension(entry);
		if (extension) extensions.add(extension);
		if (extensions.size >= MAX_APP_FILE_HANDLERS) break;
	}
	return [...extensions];
}

/** The extension of a path's last segment; dotfiles such as `.env` have none. */
export function fileExtensionOf(path: string): string | null {
	const name = path.replace(/\/+$/, "").split("/").pop() ?? "";
	const dot = name.lastIndexOf(".");
	return dot > 0 ? normalizeFileExtension(name.slice(dot)) : null;
}

/** Whether an App's declared handlers cover the file at `path`. */
export function appHandlesFile(
	fileHandlers: readonly string[] | null | undefined,
	path: string,
): boolean {
	const extension = fileExtensionOf(path);
	return Boolean(extension && fileHandlers?.includes(extension));
}
