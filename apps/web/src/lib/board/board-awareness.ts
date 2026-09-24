import type {
	BoardAwarenessGesture,
	BoardAwarenessNodePreview,
	BoardAwarenessStateUpdate,
	BoardAwarenessUpdate,
	BoardAwarenessViewport,
} from "@cohub/protocol/realtime";
import {
	BOARD_AWARENESS_MAX_VIEWPORT_ZOOM,
	BOARD_AWARENESS_MIN_VIEWPORT_ZOOM,
	BOARD_AWARENESS_WORLD_COORDINATE_LIMIT,
	BOARD_AWARENESS_WORLD_EXTENT_LIMIT,
} from "@cohub/protocol/realtime";
import type { BoardAwarenessUpdatedEvent } from "@neta-art/cohub";
import type { BoardFrame, BoardItem } from "@neta-art/cohub/board";
import { selectionBounds } from "@neta-art/cohub/board";
import type { BoardEditor, BoardInteraction } from "$lib/board/editor.svelte";

const SEND_INTERVAL_MS = 40;
const VIEWPORT_SEND_INTERVAL_MS = 100;
const VIEWPORT_POSITION_THRESHOLD_PX = 2;
const VIEWPORT_ZOOM_THRESHOLD = 0.005;
const HEARTBEAT_MS = 2_000;
const CURSOR_VISIBLE_MS = 5_000;
const PEER_TTL_MS = 10_000;
const ENDED_GESTURE_TTL_MS = 12_000;
const MAX_PREVIEW_NODES = 64;

// Sequence ordering belongs to the websocket connection, which can outlive a
// BoardPanel. Keep one allocator for the page so a remounted controller never
// restarts below the final updates from its predecessor.
let localAwarenessSequence = 0;

function nextLocalAwarenessSequence(): number {
	localAwarenessSequence += 1;
	return localAwarenessSequence;
}

export type RemoteBoardGesture =
	| Exclude<BoardAwarenessGesture, { kind: "draw" }>
	| {
			kind: "draw";
			id: string;
			nodeId: string;
			color: string;
			size: number;
			from: 0;
			points: Array<{ x: number; y: number; p: number }>;
	  };

export type BoardAwarenessCursor = {
	x: number;
	y: number;
	pointerType: "mouse" | "pen" | "touch";
};

export type RemoteBoardAwarenessPeer = {
	connectionId: string;
	actorId: string;
	actorName: string;
	seq: number;
	state: BoardAwarenessStateUpdate | null;
	gesture: RemoteBoardGesture | null;
	gestureEndedAt: number | null;
	lastCursor: BoardAwarenessCursor | null;
	cursorClearedAt: number | null;
	cursorMovedAt: number;
	viewportMovedAt: number;
	lastSeenAt: number;
};

type LocalStateInput = {
	client: { formFactor: "desktop" | "mobile" };
	tool: string;
	selection: string[];
	bounds: {
		x: number;
		y: number;
		width: number;
		height: number;
	} | null;
	editingId: string | null;
};

type LocalState = Omit<LocalStateInput, "bounds"> & {
	bounds: BoardFrame | null;
};

type CursorInput = BoardAwarenessCursor;

type ViewportInput = BoardAwarenessViewport;

type ControllerOptions = {
	send: (seq: number, update: BoardAwarenessUpdate) => Promise<void>;
	onChange: () => void;
	now?: () => number;
};

function frameFromBounds(
	bounds: { x: number; y: number; width: number; height: number } | null,
): BoardFrame | null {
	return bounds ? { ...bounds, rotation: 0 } : null;
}

export function boardAwarenessViewportFromCamera(
	camera: { x: number; y: number; zoom: number },
	surface: { width: number; height: number },
): BoardAwarenessViewport | null {
	if (
		!Number.isFinite(camera.x) ||
		!Number.isFinite(camera.y) ||
		!Number.isFinite(camera.zoom) ||
		camera.zoom < BOARD_AWARENESS_MIN_VIEWPORT_ZOOM ||
		camera.zoom > BOARD_AWARENESS_MAX_VIEWPORT_ZOOM ||
		!Number.isFinite(surface.width) ||
		!Number.isFinite(surface.height) ||
		surface.width <= 0 ||
		surface.height <= 0
	)
		return null;
	const viewport = {
		x: -camera.x / camera.zoom,
		y: -camera.y / camera.zoom,
		width: surface.width / camera.zoom,
		height: surface.height / camera.zoom,
		zoom: camera.zoom,
	};
	if (
		Math.abs(viewport.x) > BOARD_AWARENESS_WORLD_COORDINATE_LIMIT ||
		Math.abs(viewport.y) > BOARD_AWARENESS_WORLD_COORDINATE_LIMIT ||
		viewport.width > BOARD_AWARENESS_WORLD_EXTENT_LIMIT ||
		viewport.height > BOARD_AWARENESS_WORLD_EXTENT_LIMIT
	)
		return null;
	return viewport;
}

function viewportChanged(
	current: BoardAwarenessViewport | null,
	next: BoardAwarenessViewport | null,
): boolean {
	if (!current || !next) return current !== next;
	const currentCenter = {
		x: current.x + current.width / 2,
		y: current.y + current.height / 2,
	};
	const nextCenter = {
		x: next.x + next.width / 2,
		y: next.y + next.height / 2,
	};
	const positionDelta =
		Math.hypot(nextCenter.x - currentCenter.x, nextCenter.y - currentCenter.y) *
		next.zoom;
	const zoomDelta =
		Math.abs(next.zoom - current.zoom) / Math.max(current.zoom, next.zoom);
	const widthDelta = Math.abs(
		next.width * next.zoom - current.width * current.zoom,
	);
	const heightDelta = Math.abs(
		next.height * next.zoom - current.height * current.zoom,
	);
	return (
		positionDelta >= VIEWPORT_POSITION_THRESHOLD_PX ||
		zoomDelta >= VIEWPORT_ZOOM_THRESHOLD ||
		widthDelta >= VIEWPORT_POSITION_THRESHOLD_PX ||
		heightDelta >= VIEWPORT_POSITION_THRESHOLD_PX
	);
}

function previewForItem(item: BoardItem): BoardAwarenessNodePreview {
	return {
		nodeId: item.id,
		frame: { ...item.frame },
		...(item.type === "arrow"
			? {
					arrow: {
						start: { ...item.start },
						end: { ...item.end },
						bend: item.bend,
					},
				}
			: {}),
	};
}

function interactionNodeIds(interaction: BoardInteraction): string[] {
	switch (interaction.type) {
		case "translating":
		case "resizing":
		case "rotating":
			return [...interaction.origin.keys()];
		case "draggingArrowHandle":
			return [interaction.arrowId];
		case "drawing":
		case "creatingArrow":
		case "creatingBox":
			return [interaction.id];
		// Connection gestures create no node, so they contribute no node ids; their
		// liveness is carried by the gesture itself.
		case "creatingConnection":
		case "draggingConnectionEnd":
			return [];
		default:
			return [];
	}
}

function gestureFromEditor(editor: BoardEditor): BoardAwarenessGesture | null {
	const interaction = editor.interaction;
	if (interaction.type === "drawing") {
		return {
			kind: "draw",
			id: interaction.id,
			nodeId: interaction.id,
			color: interaction.color,
			size: interaction.size,
			from: 0,
			points: interaction.points.slice(0, 64),
		};
	}
	if (interaction.type === "creatingArrow") {
		return {
			kind: "arrow",
			id: interaction.id,
			nodeId: interaction.id,
			start: interaction.start,
			current: interaction.current,
			color: interaction.color,
			size: interaction.size,
		};
	}
	if (interaction.type === "creatingBox") {
		return {
			kind: "box",
			id: interaction.id,
			nodeId: interaction.id,
			shape: interaction.kind,
			start: interaction.start,
			current: interaction.current,
			color: interaction.color,
			geo: interaction.geo,
		};
	}
	if (
		interaction.type === "translating" ||
		interaction.type === "resizing" ||
		interaction.type === "rotating" ||
		interaction.type === "draggingArrowHandle"
	) {
		const ids = interactionNodeIds(interaction);
		const allFrames: BoardFrame[] = [];
		const nodes: BoardAwarenessNodePreview[] = [];
		for (const id of ids) {
			const item = editor.itemById(id);
			if (!item) continue;
			allFrames.push(item.frame);
			if (nodes.length < MAX_PREVIEW_NODES) nodes.push(previewForItem(item));
		}
		const mode =
			interaction.type === "translating"
				? "translate"
				: interaction.type === "resizing"
					? "resize"
					: interaction.type === "rotating"
						? "rotate"
						: "arrow";
		return {
			kind: "transform",
			id:
				interaction.type === "draggingArrowHandle"
					? `gesture_${interaction.arrowId}`
					: `gesture_${ids.length}_${ids.slice(0, 3).join("_").slice(0, 100)}`,
			mode,
			nodes,
			bounds: frameFromBounds(selectionBounds(allFrames)),
		};
	}
	return null;
}

function sameFrame(a: BoardFrame, b: BoardFrame): boolean {
	return (
		Math.abs(a.x - b.x) < 0.01 &&
		Math.abs(a.y - b.y) < 0.01 &&
		Math.abs(a.width - b.width) < 0.01 &&
		Math.abs(a.height - b.height) < 0.01 &&
		Math.abs(a.rotation - b.rotation) < 0.01
	);
}

function previewMatchesItem(
	preview: BoardAwarenessNodePreview,
	item: BoardItem | undefined,
): boolean {
	if (!item || !sameFrame(preview.frame, item.frame)) return false;
	if (!preview.arrow) return true;
	if (item.type !== "arrow") return false;
	return (
		item.bend === preview.arrow.bend &&
		JSON.stringify(item.start) === JSON.stringify(preview.arrow.start) &&
		JSON.stringify(item.end) === JSON.stringify(preview.arrow.end)
	);
}

const COLLABORATION_COLOR_FALLBACKS = [
	0xe8450e, 0x2563eb, 0x16a34a, 0xe11d48, 0xd97706, 0x7c3aed,
] as const;

export function collaborationColorIndex(actorId: string): number {
	let hash = 0;
	for (let index = 0; index < actorId.length; index += 1) {
		hash = (hash * 31 + actorId.charCodeAt(index)) | 0;
	}
	return Math.abs(hash) % COLLABORATION_COLOR_FALLBACKS.length;
}

export function collaborationColorToken(actorId: string): string {
	return `--board-collaboration-${collaborationColorIndex(actorId) + 1}`;
}

export function collaborationColor(actorId: string): number {
	return (
		COLLABORATION_COLOR_FALLBACKS[collaborationColorIndex(actorId)] ??
		COLLABORATION_COLOR_FALLBACKS[0]
	);
}

export function createBoardAwarenessController(options: ControllerOptions) {
	const now = options.now ?? Date.now;
	const peers = new Map<string, RemoteBoardAwarenessPeer>();
	let seq = 0;
	let localCursor: CursorInput | null = null;
	let localViewport: ViewportInput | null = null;
	let localState: LocalState = {
		client: { formFactor: "desktop" },
		tool: "select",
		selection: [],
		bounds: null,
		editingId: null,
	};
	let pendingGesture: BoardAwarenessGesture | null = null;
	let activeGesture: BoardAwarenessGesture | null = null;
	let sentDrawPoints = 0;
	let stateTimer: ReturnType<typeof setTimeout> | null = null;
	let gestureTimer: ReturnType<typeof setTimeout> | null = null;
	let lastStateSentAt = 0;
	let lastGestureSentAt = 0;
	let sendTail: Promise<void> = Promise.resolve();
	let destroyed = false;

	function emit(update: BoardAwarenessUpdate) {
		if (destroyed) return;
		seq = nextLocalAwarenessSequence();
		const currentSeq = seq;
		sendTail = sendTail
			.then(() => options.send(currentSeq, update))
			.catch((error) =>
				console.warn("[BoardAwareness] failed to publish update", error),
			);
	}

	function currentState(): BoardAwarenessStateUpdate {
		return {
			type: "state",
			client: localState.client,
			cursor: localCursor,
			viewport: localViewport,
			tool: localState.tool,
			selection: {
				ids: localState.selection.slice(0, MAX_PREVIEW_NODES),
				count: localState.selection.length,
				bounds: localState.bounds,
			},
			editingId: localState.editingId,
		};
	}

	function flushState() {
		if (stateTimer) clearTimeout(stateTimer);
		stateTimer = null;
		lastStateSentAt = now();
		emit(currentState());
	}

	function scheduleState(
		immediate = false,
		minimumInterval = SEND_INTERVAL_MS,
	) {
		if (stateTimer) return;
		const delay = immediate
			? 0
			: Math.max(0, minimumInterval - (now() - lastStateSentAt));
		stateTimer = setTimeout(flushState, delay);
	}

	function emitGesture(gesture: BoardAwarenessGesture) {
		if (gesture.kind !== "draw") {
			emit({ type: "gesture", gesture });
			return;
		}
		const points = pendingGesture?.kind === "draw" ? pendingGesture.points : [];
		if (gesture.id !== activeGesture?.id || sentDrawPoints > points.length) {
			sentDrawPoints = 0;
		}
		for (let from = sentDrawPoints; from < points.length; from += 64) {
			const chunk = points.slice(from, from + 64);
			if (chunk.length === 0) continue;
			emit({
				type: "gesture",
				gesture: { ...gesture, from, points: chunk },
			});
			sentDrawPoints = from + chunk.length;
		}
	}

	function flushGesture() {
		if (gestureTimer) clearTimeout(gestureTimer);
		gestureTimer = null;
		lastGestureSentAt = now();
		if (pendingGesture) emitGesture(pendingGesture);
	}

	function scheduleGesture(immediate = false) {
		if (gestureTimer) return;
		const delay = immediate
			? 0
			: Math.max(0, SEND_INTERVAL_MS - (now() - lastGestureSentAt));
		gestureTimer = setTimeout(flushGesture, delay);
	}

	function updateLocalState(next: LocalStateInput) {
		const previousKey = JSON.stringify(localState);
		localState = {
			...next,
			bounds: next.bounds ? { ...next.bounds, rotation: 0 } : null,
		};
		if (JSON.stringify(localState) !== previousKey) scheduleState(true);
	}

	function setCursor(cursor: CursorInput | null) {
		localCursor = cursor;
		scheduleState(cursor === null);
	}

	function setViewport(viewport: ViewportInput | null) {
		if (!viewportChanged(localViewport, viewport)) return;
		localViewport = viewport;
		scheduleState(viewport === null, VIEWPORT_SEND_INTERVAL_MS);
	}

	function syncGesture(editor: BoardEditor) {
		const next = gestureFromEditor(editor);
		if (!next) {
			if (!activeGesture) return;
			flushGesture();
			const nodeIds = interactionNodeIds(editor.interaction);
			emit({
				type: "gesture.end",
				gestureId: activeGesture.id,
				resultingNodeIds:
					activeGesture.kind === "transform"
						? activeGesture.nodes.map((node) => node.nodeId)
						: "nodeId" in activeGesture
							? [activeGesture.nodeId]
							: nodeIds,
			});
			activeGesture = null;
			pendingGesture = null;
			sentDrawPoints = 0;
			return;
		}
		if (activeGesture?.id !== next.id) {
			if (activeGesture) {
				emit({ type: "gesture.cancel", gestureId: activeGesture.id });
			}
			activeGesture = next;
			sentDrawPoints = 0;
		}
		pendingGesture = next;
		// Preserve the complete raw stroke locally; only each wire chunk is capped.
		if (next.kind === "draw" && editor.interaction.type === "drawing") {
			pendingGesture = { ...next, points: editor.interaction.points };
		}
		scheduleGesture(sentDrawPoints === 0);
	}

	function receive(event: BoardAwarenessUpdatedEvent) {
		const payload = event.payload;
		const existing = peers.get(payload.connectionId);
		if (existing && payload.seq <= existing.seq) return;
		const peer: RemoteBoardAwarenessPeer = existing ?? {
			connectionId: payload.connectionId,
			actorId: payload.actorId,
			actorName: payload.actorName,
			seq: -1,
			state: null,
			gesture: null,
			gestureEndedAt: null,
			lastCursor: null,
			cursorClearedAt: null,
			cursorMovedAt: now(),
			viewportMovedAt: now(),
			lastSeenAt: now(),
		};
		peer.actorId = payload.actorId;
		peer.actorName = payload.actorName;
		peer.seq = payload.seq;
		peer.lastSeenAt = now();

		const update = payload.update;
		if (update.type === "state") {
			const previousCursor = peer.state?.cursor ?? peer.lastCursor;
			if (
				viewportChanged(peer.state?.viewport ?? null, update.viewport ?? null)
			) {
				peer.viewportMovedAt = now();
			}
			if (update.cursor) {
				if (
					!previousCursor ||
					previousCursor.x !== update.cursor.x ||
					previousCursor.y !== update.cursor.y
				) {
					peer.cursorMovedAt = now();
				}
				peer.lastCursor = update.cursor;
				peer.cursorClearedAt = null;
			} else if (peer.state?.cursor) {
				peer.cursorClearedAt = now();
			}
			peer.state = update;
		} else if (update.type === "gesture") {
			const gesture = update.gesture;
			if (gesture.kind === "draw") {
				const current = peer.gesture;
				if (
					gesture.from === 0 ||
					current?.kind !== "draw" ||
					current.id !== gesture.id
				) {
					peer.gesture = { ...gesture, from: 0, points: [...gesture.points] };
				} else if (gesture.from === current.points.length) {
					peer.gesture = {
						...current,
						points: [...current.points, ...gesture.points],
					};
				}
			} else {
				peer.gesture = gesture;
			}
			peer.gestureEndedAt = null;
		} else if (update.type === "gesture.end") {
			if (peer.gesture?.id === update.gestureId) peer.gestureEndedAt = now();
		} else if (peer.gesture?.id === update.gestureId) {
			peer.gesture = null;
			peer.gestureEndedAt = null;
		}
		peers.set(peer.connectionId, peer);
		options.onChange();
	}

	function reconcile(items: BoardItem[]) {
		const waiting = [...peers.values()].some(
			(peer) => peer.gesture && peer.gestureEndedAt != null,
		);
		if (!waiting) return;
		const itemsById = new Map(items.map((item) => [item.id, item]));
		let changed = false;
		for (const peer of peers.values()) {
			if (!peer.gesture || peer.gestureEndedAt == null) continue;
			const gesture = peer.gesture;
			// A connection gesture is settled by the relation appearing, which the
			// item list cannot show, so it is retired on its end signal alone rather
			// than being held open waiting for a node that will never arrive.
			const applied =
				gesture.kind === "transform"
					? gesture.nodes.every((preview) =>
							previewMatchesItem(preview, itemsById.get(preview.nodeId)),
						)
					: gesture.kind === "connection"
						? true
						: itemsById.has(gesture.nodeId);
			if (!applied) continue;
			peer.gesture = null;
			peer.gestureEndedAt = null;
			changed = true;
		}
		if (changed) options.onChange();
	}

	function prune() {
		const timestamp = now();
		let changed = false;
		for (const [connectionId, peer] of peers) {
			const gestureExpired =
				peer.gestureEndedAt != null &&
				timestamp - peer.gestureEndedAt > ENDED_GESTURE_TTL_MS;
			if (gestureExpired) {
				peer.gesture = null;
				peer.gestureEndedAt = null;
				changed = true;
			}
			if (timestamp - peer.lastSeenAt > PEER_TTL_MS) {
				peers.delete(connectionId);
				changed = true;
			}
		}
		if (changed || peers.size > 0) options.onChange();
	}

	const heartbeat =
		typeof window === "undefined"
			? null
			: setInterval(() => {
					if (!destroyed) flushState();
				}, HEARTBEAT_MS);
	const cleanup =
		typeof window === "undefined" ? null : setInterval(prune, 1_000);

	function destroy(): Promise<void> {
		if (destroyed) return sendTail;
		localCursor = null;
		localViewport = null;
		localState = {
			...localState,
			selection: [],
			bounds: null,
			editingId: null,
		};
		flushState();
		if (activeGesture) {
			emit({ type: "gesture.cancel", gestureId: activeGesture.id });
		}
		destroyed = true;
		if (stateTimer) clearTimeout(stateTimer);
		if (gestureTimer) clearTimeout(gestureTimer);
		if (heartbeat) clearInterval(heartbeat);
		if (cleanup) clearInterval(cleanup);
		peers.clear();
		options.onChange();
		return sendTail;
	}

	return {
		get peers() {
			return [...peers.values()];
		},
		get cursorVisibleMs() {
			return CURSOR_VISIBLE_MS;
		},
		updateLocalState,
		setCursor,
		setViewport,
		syncGesture,
		receive,
		reconcile,
		destroy,
	};
}

export type BoardAwarenessController = ReturnType<
	typeof createBoardAwarenessController
>;
