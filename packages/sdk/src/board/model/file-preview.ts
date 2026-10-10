/**
 * File-card preview helpers used by the renderer and by client-local state.
 *
 * Snapshot *extraction* lives in `file-snapshot.ts`. This module keeps the
 * presentation facts every renderer needs (kind, type label, size,
 * availability) plus the cache-key helpers the web client uses to scope
 * per-space file state.
 */

export {
	FILE_EXCERPT_MAX_BYTES,
	FILE_EXCERPT_MAX_CHARS,
	buildCodeExcerpt,
	buildFileExcerpt,
	buildFileSnapshot,
	fileBaseName,
	fileCategory,
	fileStem,
	readCoverFromFrontmatter,
	readFrontmatterScalars,
	readTitleFromFrontmatter,
	resolveCoverRef,
	resolveFileTitle,
	resolveSpacePath,
	shouldFetchFileExcerpt,
	splitFrontmatter,
	type BoardFileSnapshotFacts,
	type BuildSnapshotInput,
	type FileCategory,
	type ResolvedCover,
} from "./file-snapshot.js";

import type { BoardFileSnapshotFacts, FileCategory } from "./file-snapshot.js";

export type FilePreviewKind = "cover" | "text" | "blank";

/**
 * Which tier a card renders at. Derived rather than stored: presentation follows
 * from the facts present, so there is no second piece of state to fall out of
 * sync with them.
 */
export function filePreviewKind(
	snapshot: BoardFileSnapshotFacts | undefined,
): FilePreviewKind {
	if (!snapshot) return "blank";
	if (snapshot.coverPath || snapshot.coverUrl) return "cover";
	if (snapshot.excerpt) return "text";
	return "blank";
}

/** Short uppercase type label for a file card (`MD`, `JSON`, `FILE`). */
export function fileTypeLabel(path: string): string {
	const name = path.split("/").filter(Boolean).pop() ?? path;
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return (name.replace(/^\./, "") || "file").toUpperCase();
	return name.slice(dot + 1).toUpperCase();
}

/** Human-readable byte size. Kept as a public helper for custom card renderers. */
export function formatFileSize(bytes: number | undefined): string {
	if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "";
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** `MD · 12 KB` — empty when neither fact is available. */
export function fileMetaLine(
	path: string,
	size: number | undefined,
): string {
	const type = fileTypeLabel(path);
	const formatted = formatFileSize(size);
	if (type && formatted) return `${type} · ${formatted}`;
	return formatted || type;
}

/** Map a file category onto an existing palette token. */
export function fileCategoryAccent(
	category: FileCategory,
	palette: {
		text: number;
		rare: number;
		epic: number;
		legendary: number;
		muted: number;
	},
): number {
	switch (category) {
		case "doc":
			return palette.text;
		case "code":
			return palette.rare;
		case "data":
			return palette.epic;
		case "media":
			return palette.legendary;
		default:
			return palette.muted;
	}
}

/** Whether a snapshot's cached facts still describe the file on disk. */
export function isFileSnapshotFresh(
	snapshot: BoardFileSnapshotFacts | undefined,
	file: { mtimeMs?: number; size?: number },
): boolean {
	if (!snapshot) return false;
	if (snapshot.mtimeMs === undefined || file.mtimeMs === undefined)
		return false;
	if (snapshot.mtimeMs !== file.mtimeMs) return false;
	if (
		snapshot.size !== undefined &&
		file.size !== undefined &&
		snapshot.size !== file.size
	)
		return false;
	return true;
}

export type FileAvailability = "ok" | "missing" | "unavailable";

/**
 * Classify a failed read.
 *
 * Only a 404 (or 410 Gone) is treated as the file being absent. Everything else
 * — offline, 5xx, timeout, 401/403 — is `unavailable`.
 */
export function availabilityFromError(error: unknown): FileAvailability {
	const status =
		typeof error === "object" && error !== null
			? (error as { status?: unknown }).status
			: undefined;
	if (typeof status !== "number") return "unavailable";
	if (status === 404 || status === 410) return "missing";
	return "unavailable";
}

/**
 * Cache key for a file within a space.
 *
 * A path only means anything relative to its space, and identical paths across
 * spaces are the norm ("README.md"), so every preview cache is keyed by both.
 */
export function filePreviewScope(spaceId: string, path: string): string {
	return `${spaceId}\u0000${path}`;
}

/**
 * Cache key for one *version* of a file. The mtime is part of the key so a
 * changed file misses the cache instead of serving a stale excerpt or cover.
 */
export function filePreviewMemoKey(
	spaceId: string,
	path: string,
	mtimeMs?: number,
): string {
	return `${filePreviewScope(spaceId, path)}@${mtimeMs ?? 0}`;
}

/**
 * Fold a freshly read snapshot into the cached one.
 *
 * `complete` decides whether the incoming facts supersede the cached ones or
 * are merged over them. A complete read's omissions are authoritative.
 */
export function mergeFileSnapshot(
	cached: BoardFileSnapshotFacts | undefined,
	incoming: BoardFileSnapshotFacts,
	complete: boolean,
): BoardFileSnapshotFacts {
	return complete ? incoming : { ...cached, ...incoming };
}
