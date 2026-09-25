/**
 * Shared MIME helpers for space file read/write and CDN delivery classification.
 * Kept separate from space-fs.ts so CDN helpers can use them without cycles.
 */
import { basename, extname } from "node:path";
import { BOARD_EXTENSION, BOARD_MIME_TYPE } from "@cohub/protocol";

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

const mimeByExt: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".csv": "text/csv",
  [BOARD_EXTENSION]: BOARD_MIME_TYPE,
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/tsx",
  ".jsx": "text/jsx",
  ".svelte": "text/x-svelte",
  ".css": "text/css",
  ".scss": "text/x-scss",
  ".html": "text/html",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".ini": "text/plain",
  ".env": "text/plain",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".py": "text/x-python",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java-source",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".cpp": "text/x-c++src",
  ".hpp": "text/x-c++hdr",
  ".sql": "application/sql",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".opus": "audio/ogg",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
  ".pdf": "application/pdf",
  ".exe": "application/x-msdownload",
  ".dmg": "application/x-apple-diskimage",
  ".deb": "application/vnd.debian.binary-package",
  ".rpm": "application/x-rpm",
};

export function getMimeType(path: string) {
  const lower = basename(path).toLowerCase();
  if (lower === "dockerfile") return "text/x-dockerfile";
  if (lower === "makefile") return "text/x-makefile";

  const extMimeType = mimeByExt[extname(lower)];
  if (extMimeType) return extMimeType;

  if (lower.startsWith(".")) return "text/plain";
  return null;
}
