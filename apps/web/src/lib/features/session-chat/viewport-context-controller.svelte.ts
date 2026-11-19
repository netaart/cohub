import {
	type ViewportAppContext,
	type ViewportBoardContext,
	type ViewportContext,
	type ViewportFileContext,
	type ViewportMediaContext,
	type ViewportMediaMark,
	type ViewportPortContext,
	type ViewportSelectedNode,
	type ViewportVisibleLines,
	type ViewportVisibleRect,
	viewportContextId,
} from "@cohub/protocol";
import {
	type MediaMarkRect,
	type MediaRef,
	mediaRefId,
} from "#lib/media/media-ask.svelte.ts";

export type FileViewportObservation = {
	path: string;
	visibleLines?: ViewportVisibleLines | null;
};

export type BoardViewportObservation = {
	path: string;
	visibleRect?: ViewportVisibleRect | null;
	selectedNodes?: ViewportSelectedNode[] | null;
};

type MarkedMedia = ViewportMediaContext & { marks: ViewportMediaMark[] };

type MediaDraft = { media: MarkedMedia[]; lastN: number };

const roundFraction = (value: number) =>
	Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;

export type PortViewportObservation = {
	port: string;
	url?: string | null;
};

export type ActiveViewportSource =
	| { kind: "file"; path: string }
	| { kind: "board"; path: string; boardId?: string | null }
	| { kind: "port"; port: string; url?: string | null }
	| ({ kind: "app"; appId: string } & Omit<
			ViewportAppContext,
			"kind" | "appId"
	  >)
	| null;

function sameVisibleLines(
	a: ViewportVisibleLines | undefined,
	b: ViewportVisibleLines | undefined,
) {
	if (!a && !b) return true;
	if (!a || !b) return false;
	return a.start === b.start && a.end === b.end;
}

function sameVisibleRect(
	a: ViewportVisibleRect | undefined,
	b: ViewportVisibleRect | undefined,
) {
	if (!a && !b) return true;
	if (!a || !b) return false;
	return (
		a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
	);
}

function sameSelectedNodes(
	a: ViewportSelectedNode[] | undefined,
	b: ViewportSelectedNode[] | undefined,
) {
	if (!a && !b) return true;
	if (!a || !b || a.length !== b.length) return false;
	return a.every(
		(node, index) =>
			node.id === b[index]?.id &&
			node.type === b[index]?.type &&
			node.title === b[index]?.title,
	);
}

function buildFileContext(
	path: string,
	visibleLines?: ViewportVisibleLines | null,
): ViewportFileContext {
	return {
		kind: "file",
		path,
		...(visibleLines
			? {
					visibleLines: {
						start: visibleLines.start,
						end: visibleLines.end,
					},
				}
			: {}),
	};
}

function buildBoardContext(
	source: { path: string; boardId?: string | null },
	observation?: BoardViewportObservation | null,
): ViewportBoardContext {
	const selectedNodes = observation?.selectedNodes?.filter(Boolean) ?? [];
	return {
		kind: "board",
		path: source.path,
		...(source.boardId ? { boardId: source.boardId } : {}),
		...(observation?.visibleRect
			? {
					visibleRect: {
						x: observation.visibleRect.x,
						y: observation.visibleRect.y,
						width: observation.visibleRect.width,
						height: observation.visibleRect.height,
					},
				}
			: {}),
		...(selectedNodes.length > 0 ? { selectedNodes } : {}),
	};
}

function buildPortContext(
	port: string,
	url?: string | null,
): ViewportPortContext {
	const trimmed = url?.trim();
	return {
		kind: "port",
		port,
		...(trimmed ? { url: trimmed } : {}),
	};
}

function buildWorkContext(
	source: Extract<ActiveViewportSource, { kind: "app" }>,
): ViewportAppContext {
	return {
		kind: "app",
		appId: source.appId,
		key: source.key,
		label: source.label,
		content: source.content,
	};
}

function isSameActiveSource(
	prev: ActiveViewportSource,
	next: ActiveViewportSource,
) {
	if (prev === next) return true;
	if (!prev || !next || prev.kind !== next.kind) return false;
	if (prev.kind === "port" && next.kind === "port") {
		return prev.port === next.port && (prev.url ?? null) === (next.url ?? null);
	}
	if (prev.kind === "app" && next.kind === "app") {
		return (
			prev.appId === next.appId &&
			prev.key === next.key &&
			prev.label === next.label &&
			prev.content === next.content
		);
	}
	if (
		prev.kind !== "port" &&
		next.kind !== "port" &&
		prev.kind !== "app" &&
		next.kind !== "app"
	) {
		return prev.path === next.path;
	}
	return false;
}

/** Stable id for dismiss / auto-attach; matches `viewportContextId` for live contexts. */
export function activeViewportSourceId(
	source: ActiveViewportSource,
): string | null {
	if (!source) return null;
	if (source.kind === "port") return `port:${source.port}`;
	if (source.kind === "app") return `app:${source.appId}:${source.key}`;
	return `${source.kind}:${source.path}`;
}

/**
 * Dismiss sticks until the active source actually changes to another one.
 * Closing the preview (→ null) keeps dismiss so reopening the same source stays quiet.
 * Switching A → B drops A's dismiss so returning later can auto-attach again.
 */
export function nextDismissedIdsAfterSourceChange(
	dismissedIds: readonly string[],
	prevId: string | null,
	nextId: string | null,
): readonly string[] {
	if (!prevId || !nextId || prevId === nextId) return dismissedIds;
	if (!dismissedIds.includes(prevId)) return dismissedIds;
	return dismissedIds.filter((id) => id !== prevId);
}

export function createViewportContextController() {
	let activeSource = $state.raw<ActiveViewportSource>(null);
	let fileObservation = $state.raw<FileViewportObservation | null>(null);
	let boardObservation = $state.raw<BoardViewportObservation | null>(null);
	let dismissedIds = $state.raw<string[]>([]);
	/**
	 * null = live derivation
	 * array (possibly empty) = frozen send-cycle UI state
	 */
	let snapshot = $state.raw<ViewportContext[] | null>(null);
	let pendingBoardObservation: BoardViewportObservation | null = null;
	let boardFlushFrame = 0;
	/** Shown by the viewer itself, so it joins only at send. */
	let viewingMedia: ViewportMediaContext | null = null;
	let markedMedia = $state.raw<MarkedMedia[]>([]);
	let lastMarkN = 0;
	let mediaScope: string | null = null;
	const parkedMedia = new Map<string, MediaDraft>();
	let sendingMarks: Set<ViewportMediaMark> | null = null;

	const activeContext = $derived.by<ViewportContext | null>(() => {
		const source = activeSource;
		if (!source) return null;
		if (source.kind === "file") {
			const visibleLines =
				fileObservation?.path === source.path
					? fileObservation.visibleLines
					: null;
			return buildFileContext(source.path, visibleLines);
		}
		if (source.kind === "board") {
			const observation =
				boardObservation?.path === source.path ? boardObservation : null;
			return buildBoardContext(source, observation);
		}
		if (source.kind === "app") return buildWorkContext(source);
		return buildPortContext(source.port, source.url);
	});

	function liveContexts({ sending }: { sending: boolean }): ViewportContext[] {
		const result: ViewportContext[] = [];
		const context = activeContext;
		if (context && !dismissedIds.includes(viewportContextId(context)))
			result.push(context);
		result.push(...markedMedia);
		const viewing = viewingMedia;
		if (
			sending &&
			viewing &&
			!markedMedia.some(
				(media) => viewportContextId(media) === viewportContextId(viewing),
			)
		)
			result.push(viewing);
		return result;
	}

	const contexts = $derived.by<ViewportContext[]>(
		() => snapshot ?? liveContexts({ sending: false }),
	);

	function cancelPendingBoardFlush() {
		if (boardFlushFrame && typeof cancelAnimationFrame === "function") {
			cancelAnimationFrame(boardFlushFrame);
		}
		boardFlushFrame = 0;
		pendingBoardObservation = null;
	}

	function applyBoardObservation(next: BoardViewportObservation) {
		const prev = boardObservation;
		if (
			prev?.path === next.path &&
			sameVisibleRect(
				prev.visibleRect ?? undefined,
				next.visibleRect ?? undefined,
			) &&
			sameSelectedNodes(
				prev.selectedNodes ?? undefined,
				next.selectedNodes ?? undefined,
			)
		) {
			return;
		}
		boardObservation = next;
	}

	function setActiveSource(next: ActiveViewportSource) {
		if (isSameActiveSource(activeSource, next)) return;
		const prevId = activeViewportSourceId(activeSource);
		const nextId = activeViewportSourceId(next);
		const pruned = nextDismissedIdsAfterSourceChange(
			dismissedIds,
			prevId,
			nextId,
		);
		if (pruned !== dismissedIds) dismissedIds = [...pruned];
		activeSource = next;
		if (!next) {
			fileObservation = null;
			boardObservation = null;
			cancelPendingBoardFlush();
			return;
		}
		if (next.kind === "file") {
			if (fileObservation?.path !== next.path) fileObservation = null;
			boardObservation = null;
			cancelPendingBoardFlush();
			return;
		}
		if (next.kind === "board") {
			if (boardObservation?.path !== next.path) {
				boardObservation = null;
				cancelPendingBoardFlush();
			}
			fileObservation = null;
			return;
		}
		fileObservation = null;
		boardObservation = null;
		cancelPendingBoardFlush();
	}

	function setFileVisibleLines(
		path: string,
		visibleLines: ViewportVisibleLines | null,
	) {
		if (!path) return;

		// Destroy/unmount reports null — only clear the matching observation so a
		// stale editor cannot wipe the newly active file's visible range.
		if (visibleLines == null) {
			if (fileObservation?.path !== path) return;
			fileObservation = null;
			return;
		}

		// Ignore late updates from a previous editor after the active file changed.
		if (activeSource?.kind === "file" && activeSource.path !== path) {
			return;
		}

		const next: FileViewportObservation = {
			path,
			visibleLines: {
				start: visibleLines.start,
				end: visibleLines.end,
			},
		};
		const prev = fileObservation;
		if (
			prev?.path === next.path &&
			sameVisibleLines(
				prev.visibleLines ?? undefined,
				next.visibleLines ?? undefined,
			)
		) {
			return;
		}
		fileObservation = next;
	}

	function setBoardViewState(
		path: string,
		state: {
			visibleRect?: ViewportVisibleRect | null;
			selectedNodes?: ViewportSelectedNode[] | null;
		},
	) {
		if (!path) return;
		if (activeSource?.kind === "board" && activeSource.path !== path) {
			return;
		}

		pendingBoardObservation = {
			path,
			visibleRect: state.visibleRect ?? undefined,
			selectedNodes: state.selectedNodes ?? undefined,
		};

		// Coalesce pan/zoom bursts to one state write per frame.
		if (boardFlushFrame) return;
		if (typeof requestAnimationFrame !== "function") {
			const pending = pendingBoardObservation;
			pendingBoardObservation = null;
			if (pending) applyBoardObservation(pending);
			return;
		}
		boardFlushFrame = requestAnimationFrame(() => {
			boardFlushFrame = 0;
			const pending = pendingBoardObservation;
			pendingBoardObservation = null;
			if (pending) applyBoardObservation(pending);
		});
	}

	function dismiss(id: string) {
		if (markedMedia.some((media) => viewportContextId(media) === id)) {
			markedMedia = markedMedia.filter(
				(media) => viewportContextId(media) !== id,
			);
			return;
		}
		if (dismissedIds.includes(id)) return;
		dismissedIds = [...dismissedIds, id];
	}

	function setMediaScope(key: string | null, { carry = false } = {}) {
		if (key === mediaScope) return;
		const previous = mediaScope;
		mediaScope = key;
		if (carry) return;
		if (previous && lastMarkN > 0)
			parkedMedia.set(previous, { media: markedMedia, lastN: lastMarkN });
		const parked = key ? parkedMedia.get(key) : undefined;
		if (key) parkedMedia.delete(key);
		markedMedia = parked?.media ?? [];
		lastMarkN = parked?.lastN ?? 0;
	}

	function viewMedia(ref: MediaRef | null) {
		viewingMedia = ref ? { kind: "media", ...ref } : null;
	}

	function mediaMarks(ref: MediaRef): readonly ViewportMediaMark[] {
		const id = mediaRefId(ref);
		return (
			markedMedia.find((media) => viewportContextId(media) === id)?.marks ?? []
		);
	}

	function addMediaMark(ref: MediaRef, rect: MediaMarkRect, floor = 0) {
		const id = mediaRefId(ref);
		lastMarkN = Math.max(lastMarkN, floor) + 1;
		const n = lastMarkN;
		const mark: ViewportMediaMark = {
			n,
			x: roundFraction(rect.x),
			y: roundFraction(rect.y),
			width: roundFraction(rect.width),
			height: roundFraction(rect.height),
		};
		const existing = markedMedia.find(
			(media) => viewportContextId(media) === id,
		);
		markedMedia = existing
			? markedMedia.map((media) =>
					media === existing
						? { ...media, marks: [...media.marks, mark] }
						: media,
				)
			: [...markedMedia, { kind: "media", ...ref, marks: [mark] }];
		return n;
	}

	function removeMediaMark(ref: MediaRef, n: number) {
		const id = mediaRefId(ref);
		markedMedia = markedMedia.flatMap((media) => {
			if (viewportContextId(media) !== id) return [media];
			const marks = media.marks.filter((mark) => mark.n !== n);
			return marks.length > 0 ? [{ ...media, marks }] : [];
		});
	}

	function takeSendSnapshot(): ViewportContext[] {
		// Flush any coalesced board observation before capturing.
		if (pendingBoardObservation) {
			const pending = pendingBoardObservation;
			cancelPendingBoardFlush();
			applyBoardObservation(pending);
		}
		// Capture before freezing UI so we don't read the empty send-cycle list.
		const next = snapshot ?? liveContexts({ sending: true });
		sendingMarks = new Set(markedMedia.flatMap((media) => media.marks));
		// Freeze an empty composer list for the in-flight send so chips clear
		// with the draft, while returning the captured contexts for the message.
		snapshot = [];
		return next;
	}

	function restoreAfterFailedSend() {
		// Return to live derivation; keep dismissed ids.
		snapshot = null;
		sendingMarks = null;
	}

	function markSendSucceeded() {
		// Unfreeze composer chips; dismissed sources stay dismissed until source changes.
		snapshot = null;
		const sent = sendingMarks;
		sendingMarks = null;
		if (!sent?.size) return;
		markedMedia = markedMedia.flatMap((media) => {
			const marks = media.marks.filter((mark) => !sent.has(mark));
			return marks.length > 0 ? [{ ...media, marks }] : [];
		});
		if (markedMedia.length === 0) lastMarkN = 0;
	}

	function dispose() {
		cancelPendingBoardFlush();
	}

	return {
		get contexts() {
			return contexts;
		},
		get activeContext() {
			return activeContext;
		},
		get hasMediaMarks() {
			return markedMedia.length > 0;
		},
		setActiveSource,
		setFileVisibleLines,
		setBoardViewState,
		setMediaScope,
		viewMedia,
		mediaMarks,
		addMediaMark,
		removeMediaMark,
		dismiss,
		takeSendSnapshot,
		restoreAfterFailedSend,
		markSendSucceeded,
		dispose,
	};
}

export type ViewportContextController = ReturnType<
	typeof createViewportContextController
>;
