import type {
	BoardAwarenessGesture,
	BoardAwarenessPoint,
	BoardAwarenessStateUpdate,
	BoardAwarenessUpdate,
	BoardReaction,
} from "@cohub/protocol/realtime";
import type { BoardEditor, BoardEditorChannel } from "../editor/index.js";
import { memo } from "../editor/state.js";
import {
	type BoardDrawPoint,
	type BoardFrame,
	type BoardItem,
	type BoardSceneItem,
	itemBounds,
	sceneItemToItem,
	unionRects,
} from "../model/index.js";
import {
	activityExpiresAt,
	activitySettlesAt,
	automationActivity,
	type BoardAutomationActivity,
	type BoardPresenceChange,
	mergeAutomationActivity,
} from "./activity.js";
import {
	boardAwarenessGesture,
	boardAwarenessViewport,
	MAX_PREVIEW_NODES,
	sameAwarenessState,
	sameFrame,
	viewportChanged,
} from "./gesture.js";

const SEND_INTERVAL_MS = 40;
const VIEWPORT_SEND_INTERVAL_MS = 100;
const HEARTBEAT_MS = 2_000;
const CURSOR_VISIBLE_MS = 5_000;
const PEER_TTL_MS = 10_000;
const ENDED_GESTURE_TTL_MS = 12_000;
const REACTION_INTERVAL_MS = 150;
const TOUCH_HOLD_MS = 1_500;
const TOUCH_FADE_MS = 250;
const LABEL_MS = 2_500;
const EDGE_INSET = 14;
const DRAW_CHUNK = 64;

export type BoardPresencePayload = {
	connectionId: string;
	actorId: string;
	actorName: string;
	seq: number;
	update: BoardAwarenessUpdate;
};

export type BoardPresenceChannel = {
	readonly connectionId?: string | null;
	updateAwareness(update: BoardAwarenessUpdate): Promise<void>;
	subscribe(handlers: {
		awareness?: (event: { payload: BoardPresencePayload }) => void;
		changed?: (event: { payload: BoardPresenceChange }) => void;
		resync?: () => void;
	}): () => void;
};

export type BoardPresenceGesture =
	| Exclude<BoardAwarenessGesture, { kind: "draw" }>
	| { kind: "draw"; id: string; itemId: string; color: string; size: number; from: 0; points: BoardDrawPoint[] };

export type BoardPresenceCursorInput = { x: number; y: number; pointerType: "mouse" | "pen" | "touch" };

export type BoardPresencePeer = {
	readonly connectionId: string;
	readonly actorId: string;
	readonly actorName: string;
	readonly state: BoardAwarenessStateUpdate | null;
	readonly gesture: BoardPresenceGesture | null;
};

export type BoardPresenceAction =
	| "drawing"
	| "connecting"
	| "creating"
	| "moving"
	| "resizing"
	| "rotating"
	| "adjusting"
	| "editing"
	| "viewing";

export type BoardPresenceCursor = {
	connectionId: string;
	actorId: string;
	actorName: string;
	x: number;
	y: number;
	pointerType: "mouse" | "pen" | "touch" | null;
	mobile: boolean;
	released: boolean;
	fading: boolean;
	offscreen: boolean;
	labelled: boolean;
	action: BoardPresenceAction | null;
};

export type BoardPresenceActivity = BoardAutomationActivity & {
	status: "active" | "settled";
	focus: BoardFrame;
	x: number;
	y: number;
};

export type BoardPresenceStroke = { id: string; points: BoardDrawPoint[]; color: string; size: number };

export type BoardReactionEvent = { reaction: BoardReaction; at: BoardAwarenessPoint; actorId: string | null };

export type BoardPresenceOptions = {
	editor: BoardEditor;
	channel: BoardPresenceChannel;
	publish?: "all" | "reactions" | "none";
	formFactor?: "desktop" | "mobile";
	cursorInterval?: number;
	now?: () => number;
};

type Peer = {
	connectionId: string;
	actorId: string;
	actorName: string;
	seq: number;
	state: BoardAwarenessStateUpdate | null;
	gesture: BoardPresenceGesture | null;
	gestureEndedAt: number | null;
	lastCursor: BoardPresenceCursorInput | null;
	cursorClearedAt: number | null;
	cursorMovedAt: number;
	viewportMovedAt: number;
	lastSeenAt: number;
};

const EDITOR_CHANNELS: readonly BoardEditorChannel[] = ["document", "scene", "selection", "camera", "tool", "interaction", "editing"];

function action(peer: Peer): BoardPresenceAction | null {
	const gesture = peer.gesture;
	if (gesture?.kind === "draw") return "drawing";
	if (gesture?.kind === "arrow") return gesture.startItemId ? "connecting" : "creating";
	if (gesture?.kind === "box") return "creating";
	if (gesture?.kind === "transform")
		return gesture.mode === "translate" ? "moving" : gesture.mode === "resize" ? "resizing" : gesture.mode === "rotate" ? "rotating" : "adjusting";
	return peer.state?.editingId ? "editing" : null;
}

export function createBoardPresence(options: BoardPresenceOptions) {
	const { editor, channel } = options;
	const now = options.now ?? Date.now;
	const publish = options.publish ?? "all";
	const sharesState = publish === "all";
	const formFactor = options.formFactor ?? "desktop";
	const cursorInterval = options.cursorInterval ?? SEND_INTERVAL_MS;
	const peers = new Map<string, Peer>();
	const listeners = new Set<() => void>();
	const reactionListeners = new Set<(event: BoardReactionEvent) => void>();
	let activityLog: BoardAutomationActivity[] = [];
	let version = 0;
	let destroyed = false;

	let active = true;
	let visible = globalThis.document?.visibilityState !== "hidden";
	let cursor: BoardPresenceCursorInput | null = null;
	let sent: BoardAwarenessStateUpdate | null = null;
	let stateTimer: ReturnType<typeof setTimeout> | null = null;
	let lastStateAt = 0;
	let gesture: BoardAwarenessGesture | null = null;
	let pendingGesture: BoardAwarenessGesture | null = null;
	let sentDrawPoints = 0;
	let gestureTimer: ReturnType<typeof setTimeout> | null = null;
	let lastGestureAt = 0;
	let lastReactionAt = 0;
	let sendTail: Promise<void> = Promise.resolve();
	let deadline = Number.POSITIVE_INFINITY;
	let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
	let shownAt = now();
	let syncQueued = false;
	let shownView: readonly unknown[] = [];

	function send(update: BoardAwarenessUpdate) {
		if (destroyed) return;
		sendTail = sendTail.then(() => channel.updateAwareness(update)).catch(() => undefined);
	}

	function changed() {
		version += 1;
		shownAt = now();
		schedule();
		for (const listener of [...listeners]) listener();
	}

	function surface(camera = editor.camera, rect = editor.visibleRect) {
		return rect ? { width: rect.width * camera.zoom, height: rect.height * camera.zoom } : null;
	}

	function localState(): BoardAwarenessStateUpdate {
		const selection = editor.selection;
		const bounds = editor.bounds;
		const size = surface();
		return {
			type: "state",
			client: { formFactor, scripts: active && visible && editor.hasScripts },
			cursor: active ? cursor : null,
			viewport: size ? boardAwarenessViewport(editor.camera, size) : null,
			tool: editor.tool,
			selection: {
				ids: selection.slice(0, MAX_PREVIEW_NODES),
				count: selection.length,
				bounds: bounds ? { ...bounds, rotation: 0 } : null,
			},
			editingId: editor.editingId,
		};
	}

	function flushState() {
		if (stateTimer) clearTimeout(stateTimer);
		stateTimer = null;
		if (!sharesState) return;
		lastStateAt = now();
		sent = localState();
		send(sent);
	}

	function scheduleState(immediate: boolean, interval = cursorInterval) {
		if (!sharesState || stateTimer) return;
		stateTimer = setTimeout(flushState, immediate ? 0 : Math.max(0, interval - (now() - lastStateAt)));
	}

	function syncState() {
		const next = localState();
		if (sameAwarenessState(sent, next)) return;
		const onlyView =
			sent !== null &&
			sameAwarenessState(sent, { ...next, viewport: sent.viewport }) &&
			viewportChanged(sent.viewport ?? null, next.viewport ?? null);
		scheduleState(!onlyView, onlyView ? VIEWPORT_SEND_INTERVAL_MS : cursorInterval);
	}

	function sendGesture(next: BoardAwarenessGesture) {
		if (next.kind !== "draw") {
			send({ type: "gesture", gesture: next });
			return;
		}
		const points = next.points;
		if (sentDrawPoints > points.length) sentDrawPoints = 0;
		for (let from = sentDrawPoints; from < points.length; from += DRAW_CHUNK) {
			const chunk = points.slice(from, from + DRAW_CHUNK);
			send({ type: "gesture", gesture: { ...next, from, points: chunk } });
			sentDrawPoints = from + chunk.length;
		}
	}

	function flushGesture() {
		if (gestureTimer) clearTimeout(gestureTimer);
		gestureTimer = null;
		lastGestureAt = now();
		if (pendingGesture) sendGesture(pendingGesture);
	}

	function syncGesture() {
		if (!sharesState) return;
		const next = boardAwarenessGesture(editor);
		if (!next) {
			if (!gesture) return;
			flushGesture();
			send({
				type: "gesture.end",
				gestureId: gesture.id,
				resultingItemIds: gesture.kind === "transform" ? gesture.items.map((item) => item.itemId) : [gesture.itemId],
			});
			gesture = pendingGesture = null;
			sentDrawPoints = 0;
			return;
		}
		if (gesture?.id !== next.id) {
			if (gesture) send({ type: "gesture.cancel", gestureId: gesture.id });
			gesture = next;
			sentDrawPoints = 0;
		}
		const interaction = editor.interaction;
		pendingGesture = next.kind === "draw" && interaction.type === "drawing" ? { ...next, points: interaction.points } : next;
		if (gestureTimer) return;
		const delay = sentDrawPoints === 0 ? 0 : Math.max(0, SEND_INTERVAL_MS - (now() - lastGestureAt));
		gestureTimer = setTimeout(flushGesture, delay);
	}

	function reconcile() {
		let settled = false;
		for (const peer of peers.values()) {
			const ended = peer.gesture;
			if (!ended || peer.gestureEndedAt === null) continue;
			const applied =
				ended.kind === "transform"
					? ended.items.every((preview) => {
							const item = editor.itemById(preview.itemId);
							return item !== null && sameFrame(preview.frame, item.frame);
						})
					: editor.itemById(ended.itemId) !== null;
			if (!applied) continue;
			peer.gesture = null;
			peer.gestureEndedAt = null;
			settled = true;
		}
		return settled;
	}

	function shows(): boolean {
		if (activityLog.length > 0) return true;
		for (const peer of peers.values()) if (peer.state?.cursor || peer.lastCursor || peer.state?.viewport) return true;
		return false;
	}

	function sync() {
		syncQueued = false;
		if (destroyed) return;
		syncState();
		syncGesture();
		let notify = reconcile() || activityLog.length > 0;
		const view = [editor.camera, editor.visibleRect];
		if (view.some((part, index) => part !== shownView[index])) {
			shownView = view;
			notify ||= shows();
		}
		if (notify) changed();
	}

	function queueSync() {
		if (syncQueued) return;
		syncQueued = true;
		queueMicrotask(sync);
	}

	function receive({ connectionId, actorId, actorName, seq, update }: BoardPresencePayload) {
		if (destroyed) return;
		const existing = peers.get(connectionId);
		if (existing && seq <= existing.seq) return;
		const at = now();
		let dirty = !existing || existing.actorId !== actorId || existing.actorName !== actorName || at - existing.lastSeenAt > CURSOR_VISIBLE_MS;
		const peer: Peer = existing ?? {
			connectionId,
			actorId,
			actorName,
			seq,
			state: null,
			gesture: null,
			gestureEndedAt: null,
			lastCursor: null,
			cursorClearedAt: null,
			cursorMovedAt: at,
			viewportMovedAt: at,
			lastSeenAt: at,
		};
		peer.actorId = actorId;
		peer.actorName = actorName;
		peer.seq = seq;
		peer.lastSeenAt = at;
		peers.set(connectionId, peer);
		switch (update.type) {
			case "reaction":
				for (const listener of [...reactionListeners]) listener({ reaction: update.reaction, at: update.at, actorId });
				break;
			case "state": {
				dirty ||= !sameAwarenessState(peer.state, update);
				const previous = peer.state?.cursor ?? peer.lastCursor;
				if (viewportChanged(peer.state?.viewport ?? null, update.viewport ?? null)) peer.viewportMovedAt = at;
				if (update.cursor) {
					if (!previous || previous.x !== update.cursor.x || previous.y !== update.cursor.y) peer.cursorMovedAt = at;
					peer.lastCursor = update.cursor;
					peer.cursorClearedAt = null;
				} else if (peer.state?.cursor) peer.cursorClearedAt = at;
				peer.state = update;
				break;
			}
			case "gesture": {
				const next = update.gesture;
				const current = peer.gesture;
				if (next.kind !== "draw") peer.gesture = next;
				else if (next.from === 0 || current?.kind !== "draw" || current.id !== next.id)
					peer.gesture = { ...next, from: 0, points: [...next.points] };
				else if (next.from === current.points.length) peer.gesture = { ...current, points: [...current.points, ...next.points] };
				peer.gestureEndedAt = null;
				dirty = true;
				break;
			}
			case "gesture.end":
				if (peer.gesture?.id === update.gestureId) {
					peer.gestureEndedAt = at;
					dirty = reconcile() || dirty;
				}
				break;
			case "gesture.cancel":
				if (peer.gesture?.id === update.gestureId) {
					peer.gesture = null;
					peer.gestureEndedAt = null;
					dirty = true;
				}
				break;
		}
		if (dirty) changed();
		else if (!deadlineTimer) schedule();
	}

	function noteChange(change: BoardPresenceChange) {
		const activity = automationActivity(change, now());
		if (!activity) return;
		activityLog = mergeAutomationActivity(activityLog, activity);
		changed();
	}

	function nextDeadline(at: number): number {
		let next = Number.POSITIVE_INFINITY;
		const after = (time: number) => {
			if (time > at && time < next) next = time;
		};
		for (const peer of peers.values()) {
			after(peer.lastSeenAt + PEER_TTL_MS);
			after(peer.lastSeenAt + CURSOR_VISIBLE_MS);
			after(peer.cursorMovedAt + LABEL_MS);
			after(peer.viewportMovedAt + LABEL_MS);
			if (peer.cursorClearedAt !== null) {
				after(peer.cursorClearedAt + TOUCH_HOLD_MS);
				after(peer.cursorClearedAt + TOUCH_HOLD_MS + TOUCH_FADE_MS);
			}
			if (peer.gestureEndedAt !== null) after(peer.gestureEndedAt + ENDED_GESTURE_TTL_MS);
		}
		for (const activity of activityLog) {
			after(activitySettlesAt(activity));
			after(activityExpiresAt(activity));
		}
		return next;
	}

	function schedule() {
		if (destroyed) return;
		const next = nextDeadline(now());
		if (next === deadline && deadlineTimer) return;
		if (deadlineTimer) clearTimeout(deadlineTimer);
		deadline = next;
		deadlineTimer = Number.isFinite(next) ? setTimeout(expire, Math.max(0, next - now()) + 1) : null;
	}

	function expire() {
		deadlineTimer = null;
		deadline = Number.POSITIVE_INFINITY;
		const at = now();
		if (nextDeadline(shownAt) > at) return schedule();
		for (const [id, peer] of peers) {
			if (at - peer.lastSeenAt > PEER_TTL_MS) peers.delete(id);
			else if (peer.gestureEndedAt !== null && at - peer.gestureEndedAt > ENDED_GESTURE_TTL_MS) {
				peer.gesture = null;
				peer.gestureEndedAt = null;
			}
		}
		activityLog = activityLog.filter((activity) => activityExpiresAt(activity) > at);
		changed();
	}

	const peerList = memo(() => [version] as const, (_version): readonly BoardPresencePeer[] => [...peers.values()]);

	const cursors = memo(
		() => [version, editor.camera, editor.visibleRect] as const,
		(_version, camera, rect): readonly BoardPresenceCursor[] => {
			const at = now();
			const size = surface(camera, rect);
			if (!size) return [];
			const { x: cx, y: cy, zoom } = camera;
			const out: BoardPresenceCursor[] = [];
			for (const peer of peers.values()) {
				if (at - peer.lastSeenAt > CURSOR_VISIBLE_MS) continue;
				const mobile = peer.state?.client?.formFactor === "mobile";
				const live = peer.state?.cursor ?? null;
				let point: { x: number; y: number } | null = live ?? peer.lastCursor;
				let released = !live && point !== null;
				const heldFor = released && peer.cursorClearedAt !== null ? at - peer.cursorClearedAt : 0;
				if (heldFor > TOUCH_HOLD_MS + TOUCH_FADE_MS) {
					point = null;
					released = false;
				}
				const viewport = mobile ? peer.state?.viewport : null;
				const viewing = !point && Boolean(viewport);
				if (!point && viewport) point = { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 };
				if (!point) continue;
				const sx = point.x * zoom + cx;
				const sy = point.y * zoom + cy;
				const offscreen = sx < 0 || sy < 0 || sx > size.width || sy > size.height;
				if (offscreen && !mobile) continue;
				const doing = viewing ? "viewing" : action(peer);
				const movedAt = viewing ? peer.viewportMovedAt : peer.cursorMovedAt;
				out.push({
					connectionId: peer.connectionId,
					actorId: peer.actorId,
					actorName: peer.actorName,
					x: offscreen ? Math.min(Math.max(sx, EDGE_INSET), size.width - EDGE_INSET) : sx,
					y: offscreen ? Math.min(Math.max(sy, EDGE_INSET), size.height - EDGE_INSET) : sy,
					pointerType: viewing ? null : (live ?? peer.lastCursor)?.pointerType ?? null,
					mobile,
					released,
					fading: heldFor > TOUCH_HOLD_MS,
					offscreen,
					labelled: (!viewing && doing !== null) || at - movedAt < LABEL_MS,
					action: doing,
				});
			}
			return out;
		},
	);

	const activities = memo(
		() => [version, editor.camera, editor.visibleRect, editor.scene] as const,
		(_version, camera, rect, scene): readonly BoardPresenceActivity[] => {
			const at = now();
			const size = surface(camera, rect);
			if (!size) return [];
			const { x: cx, y: cy, zoom } = camera;
			return activityLog.flatMap((activity) => {
				const rects = activity.itemIds.flatMap((id) => {
					const item = scene.get(id);
					return item ? [itemBounds(item.frame)] : [];
				});
				const bounds = unionRects(rects);
				if (!bounds) return [];
				return [
					{
						...activity,
						status: at < activitySettlesAt(activity) ? ("active" as const) : ("settled" as const),
						focus: { ...bounds, rotation: 0 },
						x: Math.min(Math.max(bounds.x * zoom + cx, EDGE_INSET), Math.max(size.width - EDGE_INSET, EDGE_INSET)),
						y: Math.min(Math.max(bounds.y * zoom + cy, EDGE_INSET), Math.max(size.height - EDGE_INSET, EDGE_INSET)),
					},
				];
			});
		},
	);

	const previews = memo(
		() => [version, editor.scene] as const,
		(_version, scene): ReadonlyMap<string, BoardItem> => {
			const out = new Map<string, BoardItem>();
			for (const peer of [...peers.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)) {
				if (peer.gesture?.kind !== "transform") continue;
				for (const preview of peer.gesture.items) {
					const item = scene.get(preview.itemId);
					if (item) out.set(preview.itemId, sceneItemToItem({ ...item, frame: preview.frame } as BoardSceneItem, scene.layout));
				}
			}
			return out;
		},
	);

	const strokes = memo(
		() => [version] as const,
		(_version): readonly BoardPresenceStroke[] =>
			[...peers.values()].flatMap(({ gesture }) =>
				gesture?.kind === "draw" ? [{ id: gesture.itemId, points: gesture.points, color: gesture.color, size: gesture.size }] : [],
			),
	);

	function clearCursor() {
		if (!cursor) return;
		cursor = null;
		scheduleState(true);
	}

	function onVisibility() {
		visible = globalThis.document?.visibilityState !== "hidden";
		if (!visible) cursor = null;
		syncState();
	}

	const stopEditor = editor.subscribe(EDITOR_CHANNELS, queueSync);
	let stopChannel = () => {};
	try {
		stopChannel = channel.subscribe({
			awareness: (event) => receive(event.payload),
			changed: (event) => noteChange(event.payload),
			resync: () => {
				sent = null;
				flushState();
			},
		});
	} catch {}
	const heartbeat = sharesState && typeof globalThis.window !== "undefined" ? setInterval(() => !destroyed && flushState(), HEARTBEAT_MS) : null;
	globalThis.document?.addEventListener("visibilitychange", onVisibility);
	globalThis.window?.addEventListener("blur", clearCursor);
	queueSync();

	return {
		get version() {
			return version;
		},
		get peers() {
			return peerList();
		},
		get cursors() {
			return cursors();
		},
		get activities() {
			return activities();
		},
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		previews,
		strokes,
		setCursor(next: BoardPresenceCursorInput | null) {
			if (destroyed || (next === null && cursor === null)) return;
			cursor = next;
			scheduleState(next === null);
		},
		setActive(next: boolean) {
			if (active === next) return;
			active = next;
			if (!next) cursor = null;
			syncState();
		},
		react(reaction: BoardReaction, at: BoardAwarenessPoint) {
			const time = now();
			if (destroyed || publish === "none" || time - lastReactionAt < REACTION_INTERVAL_MS) return;
			lastReactionAt = time;
			send({ type: "reaction", reaction, at });
			for (const listener of [...reactionListeners]) listener({ reaction, at, actorId: null });
		},
		onReaction(listener: (event: BoardReactionEvent) => void): () => void {
			reactionListeners.add(listener);
			return () => reactionListeners.delete(listener);
		},
		leadsScripts(): boolean {
			if (!active || !visible) return false;
			if (channel.connectionId === undefined) return true;
			const self = channel.connectionId;
			if (!self || !sharesState) return false;
			for (const peer of peers.values()) if (peer.state?.client?.scripts && peer.connectionId < self) return false;
			return true;
		},
		destroy(): Promise<void> {
			if (destroyed) return sendTail;
			if (sharesState) {
				cursor = null;
				send({ ...localState(), cursor: null, viewport: null, selection: { ids: [], count: 0, bounds: null }, editingId: null });
				if (gesture) send({ type: "gesture.cancel", gestureId: gesture.id });
			}
			destroyed = true;
			for (const timer of [stateTimer, gestureTimer, deadlineTimer]) if (timer) clearTimeout(timer);
			if (heartbeat) clearInterval(heartbeat);
			stopEditor();
			globalThis.document?.removeEventListener("visibilitychange", onVisibility);
			globalThis.window?.removeEventListener("blur", clearCursor);
			peers.clear();
			activityLog = [];
			version += 1;
			for (const listener of [...listeners]) listener();
			listeners.clear();
			reactionListeners.clear();
			return sendTail.finally(stopChannel);
		},
	};
}

export type BoardPresence = ReturnType<typeof createBoardPresence>;
