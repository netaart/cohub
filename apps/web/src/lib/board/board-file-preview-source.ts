/**
 * Reads workspace files to build file-card preview snapshots.
 *
 * This is the one place that turns a path into display facts, and it is
 * deliberately conservative about doing so, because a board can hold thousands
 * of file cards:
 *
 * - requests are deduplicated per file and capped by an in-flight limit;
 * - oversized files are skipped outright rather than downloaded and truncated;
 * - non-text files never trigger a read at all — their card needs no content;
 * - results are memoised per file version, so panning over the same cards is free.
 *
 * The produced snapshot is a cache of the file, never a replacement for it: the
 * workspace file stays authoritative and nothing here ever writes back to it.
 *
 * Every cache in here is keyed by space *and* path. A path is only meaningful
 * within its space, and identical paths across spaces are common ("README.md");
 * keying by path alone would serve one space's excerpt and cover for another's
 * card — and because enrichment commits the snapshot, that content would then be
 * written into the other space's board.
 */

import type { SpaceFsChange } from "@cohub/protocol/fs";
import {
	availabilityFromError,
	type BoardFileSnapshotFacts,
	buildFileSnapshot,
	FILE_EXCERPT_MAX_BYTES,
	type FileAvailability,
	filePreviewMemoKey,
	filePreviewScope,
} from "@neta-art/cohub/board";
import { sdk } from "$lib/sdk";
import {
	isTextFileResponse,
	tryResolveTextFileResponse,
} from "$lib/space-file-text";

/** Concurrent file reads. Kept low so previews never crowd out user actions. */
const MAX_CONCURRENT = 4;
/** Memoised results, keyed by space, path and mtime. */
const MEMO_LIMIT = 512;
const CHANGE_VERDICT_LIMIT = 4096;

type PreviewRequest = {
	path: string;
	mimeType?: string | null;
	size?: number;
	mtimeMs?: number;
};

/**
 * A preview read's outcome.
 *
 * `complete` distinguishes facts that describe the file *as it is now* from facts
 * that are merely all we could establish. Callers must not merge an incomplete
 * result over a cached one — but they must not replace with it either, or a
 * transient failure would blank a usable card. Only a complete result may replace,
 * which is what lets a removed cover or excerpt actually disappear.
 */
export type FilePreviewResult = {
	facts: BoardFileSnapshotFacts;
	complete: boolean;
};

/**
 * Metadata carried by a filesystem change event.
 *
 * Reusing it avoids a stat request per invalidated card, and is the only way a
 * non-text file (whose content is never read) learns its new size and mtime.
 */
export type FileChangeMeta = {
	size?: number;
	mtimeMs?: number;
	removed?: boolean;
};

/**
 * Availability of a referenced file, tracked separately from the snapshot.
 *
 * This is deliberately *not* stored on the node. Whether a file can be read right
 * now is transient and client-local — it depends on permissions, network and
 * timing — whereas the snapshot is a content cache that syncs to every client.
 * Writing availability into the document would let one client's outage become
 * everyone's, and would be indistinguishable from the file genuinely being gone.
 */
const availability = new Map<string, FileAvailability>();

export type { FileAvailability };

/** Availability last observed for a file; `ok` until a read says otherwise. */
export function fileAvailability(
	spaceId: string,
	path: string,
): FileAvailability {
	return availability.get(filePreviewScope(spaceId, path)) ?? "ok";
}

function setAvailability(
	spaceId: string,
	path: string,
	state: FileAvailability,
) {
	const key = filePreviewScope(spaceId, path);
	const previous = availability.get(key) ?? "ok";
	if (previous === state) return;
	if (state === "ok") availability.delete(key);
	else availability.set(key, state);
	notify();
}

const memo = new Map<string, BoardFileSnapshotFacts>();
const inFlight = new Map<string, Promise<FilePreviewResult>>();
/**
 * Paths whose cached previews were invalidated since a board last refreshed.
 *
 * Boards consult this rather than re-reading every card on every change event:
 * only cards whose file actually changed *and* which are currently on screen do
 * any work.
 */
const stalePaths = new Map<string, FileChangeMeta>();

export type FilePreviewInvalidation = {
	spaceId: string;
	path: string;
	meta: FileChangeMeta;
};

const listeners = new Set<(event: FilePreviewInvalidation | null) => void>();
let version = 0;
let active = 0;
const waiting: Array<() => void> = [];

function notify(event: FilePreviewInvalidation | null = null) {
	version += 1;
	for (const listener of listeners) listener(event);
}

function memoKey(spaceId: string, request: PreviewRequest): string {
	return filePreviewMemoKey(spaceId, request.path, request.mtimeMs);
}

function remember(key: string, result: FilePreviewResult) {
	// Only a complete result is worth caching; an incomplete one would pin a
	// transient failure until the next change event.
	if (!result.complete) return;
	if (memo.size >= MEMO_LIMIT) {
		// Cheap FIFO eviction: preview reads are idempotent, so a miss only costs
		// one more request.
		const oldest = memo.keys().next().value;
		if (oldest !== undefined) memo.delete(oldest);
	}
	memo.set(key, result.facts);
}

async function acquireSlot(): Promise<void> {
	if (active < MAX_CONCURRENT) {
		active += 1;
		return;
	}
	await new Promise<void>((resolve) => waiting.push(resolve));
	active += 1;
}

function releaseSlot() {
	active -= 1;
	waiting.shift()?.();
}

/**
 * Whether reading this file could add anything to its card.
 *
 * Only text yields an excerpt or a frontmatter cover, and only within a size
 * bound — a large minified bundle would cost a full transfer to produce a line
 * of noise. Everything else renders from metadata alone.
 */
function shouldRead(request: PreviewRequest): boolean {
	if (request.size !== undefined && request.size > FILE_EXCERPT_MAX_BYTES)
		return false;
	// Unknown mime: attempt the read, the response's own kind decides.
	if (request.mimeType === undefined || request.mimeType === null) return true;
	return isTextFileResponse({ kind: "binary", mimeType: request.mimeType });
}

async function readSnapshot(
	spaceId: string,
	request: PreviewRequest,
): Promise<FilePreviewResult> {
	const base = buildFileSnapshot({
		path: request.path,
		mimeType: request.mimeType ?? undefined,
		size: request.size,
		mtimeMs: request.mtimeMs,
	});
	// A file whose content cannot contribute to its card is fully described by its
	// metadata, so this is a complete result and no request is made. Its metadata
	// comes from the change event (see invalidateFilePreviews), which is why it does
	// not go stale.
	if (!shouldRead(request)) return { facts: base, complete: true };

	await acquireSlot();
	try {
		const file = await sdk.space(spaceId).files.read(request.path);
		setAvailability(spaceId, request.path, "ok");
		// Still being prepared: metadata-only is right for now, but incomplete, so
		// the next pass retries rather than caching this.
		if (!("content" in file)) return { facts: base, complete: false };
		if (file.size > FILE_EXCERPT_MAX_BYTES) {
			return {
				facts: buildFileSnapshot({
					path: request.path,
					mimeType: file.mimeType,
					size: file.size,
					mtimeMs: file.mtimeMs,
				}),
				complete: true,
			};
		}
		const { file: resolved } = await tryResolveTextFileResponse(file);
		return {
			facts: buildFileSnapshot({
				path: request.path,
				content: isTextFileResponse(resolved) ? resolved.content : null,
				mimeType: resolved.mimeType,
				size: resolved.size,
				mtimeMs: resolved.mtimeMs,
			}),
			complete: true,
		};
	} catch (error) {
		// A failed read must not blank the card: the cached facts still render, and
		// only a definitive 404/410 is treated as the file being gone. Incomplete, so
		// the caller keeps whatever it already had.
		setAvailability(spaceId, request.path, availabilityFromError(error));
		return { facts: base, complete: false };
	} finally {
		releaseSlot();
	}
}

/**
 * Build the preview snapshot for one file. Concurrent callers for the same
 * space+path+mtime share a single read.
 */
export function loadFilePreview(
	spaceId: string,
	request: PreviewRequest,
): Promise<FilePreviewResult> {
	// Metadata from the change event that invalidated this file, so a card learns a
	// new size, mtime or removal even when its content is never read. Consumed here
	// rather than cleared by the caller: the mark and the metadata on it are one
	// thing, and clearing it separately would drop the metadata before this read.
	const scopeKey = filePreviewScope(spaceId, request.path);
	const pendingMeta = stalePaths.get(scopeKey);
	stalePaths.delete(scopeKey);
	const effective: PreviewRequest = pendingMeta
		? {
				...request,
				size: pendingMeta.size ?? request.size,
				mtimeMs: pendingMeta.mtimeMs ?? request.mtimeMs,
			}
		: request;

	const key = memoKey(spaceId, effective);
	const cached = memo.get(key);
	if (cached) return Promise.resolve({ facts: cached, complete: true });
	const pending = inFlight.get(key);
	if (pending) return pending;

	const promise = readSnapshot(spaceId, effective)
		.then((result) => {
			remember(key, result);
			return result;
		})
		.finally(() => {
			inFlight.delete(key);
		});
	inFlight.set(key, promise);
	return promise;
}

function setRecent<V>(map: Map<string, V>, key: string, value: V) {
	map.delete(key);
	map.set(key, value);
	if (map.size <= CHANGE_VERDICT_LIMIT) return;
	const oldest = map.keys().next().value;
	if (oldest !== undefined) map.delete(oldest);
}

/**
 * Drop memoised previews after a filesystem change event.
 *
 * Each change's own metadata is carried through, so a card refreshes its size
 * and mtime without a stat request — and for a file whose content is never read
 * (a PDF, an archive), it is the only way those ever update.
 */
export function invalidateFilePreviews(
	spaceId: string,
	changes: readonly SpaceFsChange[],
) {
	const events: FilePreviewInvalidation[] = [];
	for (const change of changes) {
		if (change.path) {
			const meta = {
				size: change.size,
				mtimeMs: change.mtimeMs,
				removed: change.kind === "delete",
			};
			events.push({ spaceId, path: change.path, meta });
		}
		if (change.oldPath)
			events.push({ spaceId, path: change.oldPath, meta: { removed: true } });
	}
	if (events.length === 0) return;

	const scopes = new Set(
		events.map((event) => filePreviewScope(spaceId, event.path)),
	);
	for (const key of memo.keys()) {
		if (scopes.has(key.slice(0, key.lastIndexOf("@")))) memo.delete(key);
	}
	for (const { path, meta } of events) {
		const key = filePreviewScope(spaceId, path);
		// A removal is authoritative: record it rather than waiting for a read to
		// 404. Any other change proves the file is there, so clear a stale verdict.
		if (meta.removed) setRecent(availability, key, "missing");
		else availability.delete(key);
		// Mark the file stale even when nothing was memoised: a board that has not
		// read it yet still needs to know its snapshot is out of date.
		setRecent(stalePaths, key, meta);
	}
	for (const event of events) notify(event);
}

/** Monotonic counter for reactive consumers; bumped on every invalidation. */
export function filePreviewVersion() {
	return version;
}

/** Subscribe to invalidations. Returns an unsubscribe function. */
export function subscribeFilePreviews(
	listener: (event: FilePreviewInvalidation | null) => void,
) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Whether a file's cached preview is known to be stale. */
export function isFilePreviewStale(spaceId: string, path: string) {
	return stalePaths.has(filePreviewScope(spaceId, path));
}

/** Test seam: clear all memoised state. */
export function resetFilePreviewCache() {
	memo.clear();
	inFlight.clear();
	stalePaths.clear();
	availability.clear();
}
