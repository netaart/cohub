import {
	measureTurnRailMarkers,
	type TurnRailMarkerAnchor,
} from "./turn-rail-markers";

export type SessionScrollAnchorKind =
	| "user"
	| "assistant"
	| "process"
	| "compact";

export type SessionScrollAnchorTarget = {
	itemKey: string;
	turnSequence: number;
	kind: SessionScrollAnchorKind;
};

export type SessionScrollAnchor = SessionScrollAnchorTarget & {
	offset: number;
	updatedAt: number;
};

export function isSessionScrollAnchorKind(
	value: unknown,
): value is SessionScrollAnchorKind {
	return (
		value === "user" ||
		value === "assistant" ||
		value === "process" ||
		value === "compact"
	);
}

export function isSessionScrollAnchor(
	value: unknown,
): value is SessionScrollAnchor {
	if (!value || typeof value !== "object") return false;
	const anchor = value as Partial<SessionScrollAnchor>;
	return Boolean(
		typeof anchor.itemKey === "string" &&
			anchor.itemKey.trim() &&
			Number.isInteger(anchor.turnSequence) &&
			(anchor.turnSequence ?? 0) > 0 &&
			isSessionScrollAnchorKind(anchor.kind) &&
			typeof anchor.offset === "number" &&
			Number.isFinite(anchor.offset) &&
			typeof anchor.updatedAt === "number" &&
			Number.isFinite(anchor.updatedAt),
	);
}

export function isSessionScrollAnchorTurnLoaded(
	anchor: SessionScrollAnchor,
	turns: Array<{ sequence: number }>,
) {
	return turns.some((turn) => turn.sequence === anchor.turnSequence);
}

export function resolveSessionScrollAnchorTargetIndex(
	anchor: SessionScrollAnchor,
	targets: SessionScrollAnchorTarget[],
) {
	const exactIndex = targets.findIndex(
		(target) => target.itemKey === anchor.itemKey,
	);
	if (exactIndex >= 0) return exactIndex;
	return targets.findIndex(
		(target) =>
			target.turnSequence === anchor.turnSequence &&
			target.kind === anchor.kind,
	);
}

export function resolveSessionScrollRestore(input: {
	anchorTop: number;
	anchorOffset: number;
	scrollHeight: number;
	clientHeight: number;
}) {
	const desiredScrollTop = Math.max(0, input.anchorTop + input.anchorOffset);
	const maxScrollTop = Math.max(0, input.scrollHeight - input.clientHeight);
	return {
		scrollTop: Math.min(desiredScrollTop, maxScrollTop),
		reached: desiredScrollTop <= maxScrollTop + 1,
	};
}

const AUTO_FOLLOW_THRESHOLD_PX = 60;

export function shouldFollowSessionTail(input: {
	shouldAutoFollow: boolean;
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
	streamingRegionVisible: boolean;
	threshold?: number;
}) {
	if (input.shouldAutoFollow || input.streamingRegionVisible) return true;
	const distanceFromBottom = Math.max(
		0,
		input.scrollHeight - input.scrollTop - input.clientHeight,
	);
	return distanceFromBottom <= (input.threshold ?? AUTO_FOLLOW_THRESHOLD_PX);
}

function areNumberRecordsEqual(
	current: Record<number, number>,
	next: Record<number, number>,
) {
	if (current === next) return true;
	const currentKeys = Object.keys(current);
	const nextKeys = Object.keys(next);
	if (currentKeys.length !== nextKeys.length) return false;
	for (const key of currentKeys) {
		const numKey = Number(key);
		if (current[numKey] !== next[numKey]) return false;
	}
	return true;
}

const SESSION_SCROLL_ANCHOR_PERSIST_DEBOUNCE_MS = 500;
const MAX_SESSION_SCROLL_ANCHORS = 200;
const TURN_MARKER_CONTENT_MEASURE_MS = 500;

export function createSessionScrollController() {
	let listEl = $state<HTMLDivElement | null>(null);
	let composerHeight = $state(0);
	let chatChromeHeight = $state(0);
	let shouldAutoFollow = $state(true);
	let turnMarkerPositions = $state<Record<number, number>>({});
	let turnMarkerHeights = $state<Record<number, number>>({});
	let turnAnchorGeometry: TurnRailMarkerAnchor[] = [];
	let turnGeometrySessionId: string | null = null;
	let turnMarkerMeasureVersion = $state(0);
	let turnMarkerMeasureFrame: number | null = null;
	let turnMarkerMeasureTimer: ReturnType<typeof setTimeout> | null = null;
	let timelineScrollTop = $state(0);
	let timelineScrollHeight = $state(0);
	let timelineClientHeight = $state(0);
	let scrollAnchorBySession = $state.raw(
		new Map<string, SessionScrollAnchor>(),
	);
	let pendingRestoreSessionId = $state<string | null>(null);
	let activeAnchorRestore = $state<
		(SessionScrollAnchor & { sessionId: string }) | null
	>(null);
	let pendingTimelineMarkdownRenders = $state(0);
	let persistSessionScrollAnchorsTimer: ReturnType<typeof setTimeout> | null =
		null;
	let vimScrollFrame: number | null = null;
	let vimScrollVelocity = 0;
	let vimScrollStopTimer: ReturnType<typeof setTimeout> | null = null;
	let vimPendingGTimer: ReturnType<typeof setTimeout> | null = null;

	function loadSessionScrollAnchors(storageKey: string) {
		// A pending trailing write may hold the freshest anchor for the space we
		// are leaving; flush it so the reload below cannot drop it.
		flushPendingSessionScrollAnchorsPersist(storageKey);
		scrollAnchorBySession = new Map();
		try {
			const raw = localStorage.getItem(storageKey);
			if (!raw) return;
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				return;
			scrollAnchorBySession = trimSessionScrollAnchors(
				new Map(
					Object.entries(parsed).filter(
						(entry): entry is [string, SessionScrollAnchor] =>
							isSessionScrollAnchor(entry[1]),
					),
				),
			);
		} catch {
			// ignore corrupt local scroll cache
		}
	}

	function persistSessionScrollAnchorsNow(storageKey: string) {
		if (persistSessionScrollAnchorsTimer) {
			clearTimeout(persistSessionScrollAnchorsTimer);
			persistSessionScrollAnchorsTimer = null;
		}
		try {
			localStorage.setItem(
				storageKey,
				JSON.stringify(Object.fromEntries(scrollAnchorBySession.entries())),
			);
		} catch {
			// ignore storage failures
		}
	}

	/** Persist only after scrolling settles — no writes during the gesture. */
	function scheduleSessionScrollAnchorsPersist(storageKey: string) {
		if (persistSessionScrollAnchorsTimer) {
			clearTimeout(persistSessionScrollAnchorsTimer);
		}
		persistSessionScrollAnchorsTimer = setTimeout(() => {
			persistSessionScrollAnchorsTimer = null;
			persistSessionScrollAnchorsNow(storageKey);
		}, SESSION_SCROLL_ANCHOR_PERSIST_DEBOUNCE_MS);
	}

	function flushPendingSessionScrollAnchorsPersist(storageKey: string) {
		if (!persistSessionScrollAnchorsTimer) return;
		clearTimeout(persistSessionScrollAnchorsTimer);
		persistSessionScrollAnchorsTimer = null;
		persistSessionScrollAnchorsNow(storageKey);
	}

	/** Bound growth: stale positions are not worth unbounded storage writes. */
	function trimSessionScrollAnchors(map: Map<string, SessionScrollAnchor>) {
		if (map.size <= MAX_SESSION_SCROLL_ANCHORS) return map;
		const entries = [...map.entries()].sort(
			(a, b) => a[1].updatedAt - b[1].updatedAt,
		);
		const excess = map.size - MAX_SESSION_SCROLL_ANCHORS;
		for (let i = 0; i < excess; i += 1) map.delete(entries[i][0]);
		return map;
	}

	function setSessionScrollAnchor(
		storageKey: string,
		sessionId: string,
		anchor: SessionScrollAnchor,
	) {
		const next = new Map(scrollAnchorBySession);
		next.set(sessionId, anchor);
		trimSessionScrollAnchors(next);
		// Reassign so `$state.raw` consumers observe the write.
		scrollAnchorBySession = next;
		scheduleSessionScrollAnchorsPersist(storageKey);
	}

	function getSessionScrollAnchor(sessionId: string) {
		return scrollAnchorBySession.get(sessionId);
	}

	function clearSessionScrollAnchor(storageKey: string, sessionId: string) {
		if (!scrollAnchorBySession.has(sessionId)) return;
		const next = new Map(scrollAnchorBySession);
		next.delete(sessionId);
		scrollAnchorBySession = next;
		scheduleSessionScrollAnchorsPersist(storageKey);
	}

	function getMessageElementAbsoluteTop(node: HTMLElement) {
		if (!listEl) return 0;
		const containerRect = listEl.getBoundingClientRect();
		const nodeRect = node.getBoundingClientRect();
		return listEl.scrollTop + (nodeRect.top - containerRect.top);
	}

	function updateTimelineScrollMetrics() {
		if (!listEl) {
			if (timelineScrollTop !== 0) timelineScrollTop = 0;
			if (timelineScrollHeight !== 0) timelineScrollHeight = 0;
			if (timelineClientHeight !== 0) timelineClientHeight = 0;
			return;
		}
		const nextTop = listEl.scrollTop;
		const nextHeight = listEl.scrollHeight;
		const nextClient = listEl.clientHeight;
		if (timelineScrollTop !== nextTop) timelineScrollTop = nextTop;
		if (timelineScrollHeight !== nextHeight) timelineScrollHeight = nextHeight;
		if (timelineClientHeight !== nextClient) timelineClientHeight = nextClient;
	}

	function getTimelineBottomScrollTop() {
		if (!listEl) return 0;
		return Math.max(0, listEl.scrollHeight - listEl.clientHeight);
	}

	function updateAutoFollow(threshold = AUTO_FOLLOW_THRESHOLD_PX) {
		if (!listEl) return;
		const distanceFromBottom =
			listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight;
		const next = distanceFromBottom <= threshold;
		if (shouldAutoFollow !== next) shouldAutoFollow = next;
	}

	function shouldPinToBottom(options?: { immediate?: boolean }) {
		return Boolean(listEl && (options?.immediate || shouldAutoFollow));
	}

	function clearTurnMarkers() {
		const hadMarkers =
			Object.keys(turnMarkerPositions).length > 0 ||
			Object.keys(turnMarkerHeights).length > 0;
		const hadGeometry =
			turnAnchorGeometry.length > 0 || turnGeometrySessionId !== null;
		if (Object.keys(turnMarkerPositions).length > 0) turnMarkerPositions = {};
		if (Object.keys(turnMarkerHeights).length > 0) turnMarkerHeights = {};
		turnAnchorGeometry = [];
		turnGeometrySessionId = null;
		// Only signal when the cache actually transitions — a no-op clear on an
		// already-empty cache must stay reactively silent or repeated timeline
		// effect runs (listEl / hasTimelineItems invalidation) ping-pong the
		// version effect until Svelte's depth guard throws.
		if (hadMarkers || hadGeometry) {
			turnMarkerMeasureVersion += 1;
		}
	}

	function measureTurnMarkerPositions() {
		if (!listEl) {
			clearTurnMarkers();
			updateTimelineScrollMetrics();
			return;
		}
		updateTimelineScrollMetrics();
		const scrollContainer = listEl;
		const anchors = Array.from(
			scrollContainer.querySelectorAll<HTMLElement>(
				'[data-turn-anchor="user"]',
			),
		)
			.map((anchor) => ({
				sequence: Number(anchor.dataset.turnSequence),
				absoluteTop: getMessageElementAbsoluteTop(anchor),
				offsetHeight: anchor.offsetHeight,
			}))
			.filter((anchor) => Number.isFinite(anchor.sequence));
		// Cache document-space geometry so scroll frames can binary-search the
		// current turn without touching the DOM; it only changes with content.
		turnGeometrySessionId = scrollContainer.dataset.sessionId ?? null;
		turnAnchorGeometry = anchors;
		// Signal "cache refreshed" even when the derived marker values happen to
		// stay identical (e.g. a uniform shift above the first anchor).
		turnMarkerMeasureVersion += 1;
		const { positions, heights } = measureTurnRailMarkers({
			scrollHeight: scrollContainer.scrollHeight,
			clientHeight: scrollContainer.clientHeight,
			anchors,
		});
		if (!areNumberRecordsEqual(turnMarkerPositions, positions)) {
			turnMarkerPositions = positions;
		}
		if (!areNumberRecordsEqual(turnMarkerHeights, heights)) {
			turnMarkerHeights = heights;
		}
	}

	/** Measure on the next frame; coalesces bursts of layout triggers. */
	function scheduleTurnMarkerMeasure() {
		// Do NOT cancel the throttle timer here: direct schedules (chrome resize,
		// session switch) must not reset the content-growth throttle window, or
		// every markdown render after a chrome change fires an unthrottled measure.
		if (turnMarkerMeasureFrame != null) return;
		turnMarkerMeasureFrame = requestAnimationFrame(() => {
			turnMarkerMeasureFrame = null;
			measureTurnMarkerPositions();
		});
	}

	/**
	 * Content grows continuously while streaming. The leading edge keeps
	 * discrete changes instant; the trailing edge caps steady-state work to
	 * one measurement pass per window.
	 */
	function scheduleTurnMarkerMeasureThrottled() {
		if (turnMarkerMeasureTimer || turnMarkerMeasureFrame != null) return;
		scheduleTurnMarkerMeasure();
		turnMarkerMeasureTimer = setTimeout(() => {
			turnMarkerMeasureTimer = null;
			scheduleTurnMarkerMeasure();
		}, TURN_MARKER_CONTENT_MEASURE_MS);
	}

	function cancelTurnMarkerMeasure() {
		if (turnMarkerMeasureFrame != null) {
			cancelAnimationFrame(turnMarkerMeasureFrame);
			turnMarkerMeasureFrame = null;
		}
		if (turnMarkerMeasureTimer) {
			clearTimeout(turnMarkerMeasureTimer);
			turnMarkerMeasureTimer = null;
		}
	}

	/**
	 * Cached user-turn geometry, ascending by document position. Empty when
	 * the cache belongs to another session — measurement paths refresh it and
	 * bump the version; readers never measure so effects stay write-free.
	 */
	function getTurnAnchorGeometry(sessionId: string) {
		return turnGeometrySessionId === sessionId ? turnAnchorGeometry : [];
	}

	function stopVimScroll() {
		vimScrollVelocity = 0;
		if (vimScrollStopTimer) {
			clearTimeout(vimScrollStopTimer);
			vimScrollStopTimer = null;
		}
		if (vimScrollFrame != null) {
			cancelAnimationFrame(vimScrollFrame);
			vimScrollFrame = null;
		}
	}

	function runVimScrollFrame() {
		if (!listEl || vimScrollVelocity === 0) {
			stopVimScroll();
			return;
		}
		listEl.scrollTop = Math.min(
			Math.max(0, listEl.scrollHeight - listEl.clientHeight),
			Math.max(0, listEl.scrollTop + vimScrollVelocity),
		);
		vimScrollFrame = requestAnimationFrame(runVimScrollFrame);
	}

	function scrollTimelineByLines(
		direction: 1 | -1,
		beginUserScroll: () => void,
	) {
		if (!listEl) return;
		beginUserScroll();
		vimScrollVelocity = direction * 10;
		if (vimScrollFrame == null) {
			vimScrollFrame = requestAnimationFrame(runVimScrollFrame);
		}
		if (vimScrollStopTimer) clearTimeout(vimScrollStopTimer);
		vimScrollStopTimer = setTimeout(stopVimScroll, 110);
	}

	function clearPendingVimG() {
		if (!vimPendingGTimer) return;
		clearTimeout(vimPendingGTimer);
		vimPendingGTimer = null;
	}

	function armPendingVimG(timeoutMs = 550) {
		vimPendingGTimer = setTimeout(() => {
			vimPendingGTimer = null;
		}, timeoutMs);
	}

	function scrollTimelineToTop(
		beginUserScroll: () => void,
		setProgrammaticScrollTop: (scrollTop: number) => void,
		onScrolled?: () => void,
	) {
		if (!listEl) return;
		beginUserScroll();
		shouldAutoFollow = false;
		setProgrammaticScrollTop(0);
		requestAnimationFrame(() => onScrolled?.());
	}

	function scrollTimelineToBottom(scrollToBottomNow: () => void) {
		if (!listEl) return;
		shouldAutoFollow = true;
		stopVimScroll();
		scrollToBottomNow();
	}

	function resetSessionScrollUi() {
		clearTurnMarkers();
		cancelTurnMarkerMeasure();
		if (timelineScrollTop !== 0) timelineScrollTop = 0;
		if (timelineScrollHeight !== 0) timelineScrollHeight = 0;
		if (timelineClientHeight !== 0) timelineClientHeight = 0;
		pendingRestoreSessionId = null;
		activeAnchorRestore = null;
		pendingTimelineMarkdownRenders = 0;
		shouldAutoFollow = true;
	}

	return {
		get listEl() {
			return listEl;
		},
		set listEl(value: HTMLDivElement | null) {
			listEl = value;
		},
		get composerHeight() {
			return composerHeight;
		},
		set composerHeight(value: number) {
			composerHeight = value;
		},
		get chatChromeHeight() {
			return chatChromeHeight;
		},
		set chatChromeHeight(value: number) {
			chatChromeHeight = value;
		},
		get shouldAutoFollow() {
			return shouldAutoFollow;
		},
		set shouldAutoFollow(value: boolean) {
			shouldAutoFollow = value;
		},
		get turnMarkerPositions() {
			return turnMarkerPositions;
		},
		set turnMarkerPositions(value: Record<number, number>) {
			if (!areNumberRecordsEqual(turnMarkerPositions, value)) {
				turnMarkerPositions = value;
			}
		},
		get turnMarkerHeights() {
			return turnMarkerHeights;
		},
		set turnMarkerHeights(value: Record<number, number>) {
			if (!areNumberRecordsEqual(turnMarkerHeights, value)) {
				turnMarkerHeights = value;
			}
		},
		get turnMarkerMeasureVersion() {
			return turnMarkerMeasureVersion;
		},
		clearTurnMarkers,
		get timelineScrollTop() {
			return timelineScrollTop;
		},
		set timelineScrollTop(value: number) {
			timelineScrollTop = value;
		},
		get timelineScrollHeight() {
			return timelineScrollHeight;
		},
		set timelineScrollHeight(value: number) {
			timelineScrollHeight = value;
		},
		get timelineClientHeight() {
			return timelineClientHeight;
		},
		set timelineClientHeight(value: number) {
			timelineClientHeight = value;
		},
		get scrollAnchorBySession() {
			return scrollAnchorBySession;
		},
		set scrollAnchorBySession(value: Map<string, SessionScrollAnchor>) {
			scrollAnchorBySession = value;
		},
		get pendingRestoreSessionId() {
			return pendingRestoreSessionId;
		},
		set pendingRestoreSessionId(value: string | null) {
			pendingRestoreSessionId = value;
		},
		get activeAnchorRestore() {
			return activeAnchorRestore;
		},
		set activeAnchorRestore(value:
			| (SessionScrollAnchor & { sessionId: string })
			| null,) {
			activeAnchorRestore = value;
		},
		get pendingTimelineMarkdownRenders() {
			return pendingTimelineMarkdownRenders;
		},
		set pendingTimelineMarkdownRenders(value: number) {
			pendingTimelineMarkdownRenders = value;
		},
		get vimPendingGActive() {
			return Boolean(vimPendingGTimer);
		},
		loadSessionScrollAnchors,
		persistSessionScrollAnchorsNow,
		setSessionScrollAnchor,
		getSessionScrollAnchor,
		clearSessionScrollAnchor,
		getMessageElementAbsoluteTop,
		updateTimelineScrollMetrics,
		getTimelineBottomScrollTop,
		updateAutoFollow,
		shouldPinToBottom,
		scheduleTurnMarkerMeasure,
		scheduleTurnMarkerMeasureThrottled,
		cancelTurnMarkerMeasure,
		getTurnAnchorGeometry,
		stopVimScroll,
		scrollTimelineByLines,
		clearPendingVimG,
		armPendingVimG,
		scrollTimelineToTop,
		scrollTimelineToBottom,
		resetSessionScrollUi,
	};
}
