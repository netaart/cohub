import type { BoardPlaybackCommand, BoardPlaybackSnapshot } from "@cohub/protocol";
import type { BoardEditor } from "../editor/index.js";
import { createBoardEntityId } from "../model/items/id.js";
import { playbackClockAt } from "./playback-clock.js";

type Command = BoardPlaybackCommand extends infer C ? C extends BoardPlaybackCommand ? Omit<C, "commandId"> : never : never;
type Animation = NonNullable<BoardEditor["animations"][string]>;

export type BoardTransportSnapshot = Readonly<{
	ids: readonly string[];
	animationId: string | null;
	animation: Animation | undefined;
	playing: boolean;
	starting: boolean;
	time: number;
	nextMarker: Animation["markers"][number] | null;
}>;

export type BoardTransportSend = (command: BoardPlaybackCommand) => BoardPlaybackSnapshot | null | void | Promise<BoardPlaybackSnapshot | null | void>;

export function createBoardTransport(options: {
	editor: Pick<BoardEditor, "document" | "playhead" | "setPlayhead" | "subscribe" | "gestureActive" | "editingId">;
	playback?: BoardPlaybackSnapshot | null;
	send: BoardTransportSend;
	onError?: (error: unknown, command: BoardPlaybackCommand) => void;
	holdOnEnd?: boolean;
}) {
	const { editor } = options;
	const listeners = new Set<() => void>();
	let playback = options.playback ?? null;
	let chosen: string | null = null;
	let pending: {
		command: Extract<BoardPlaybackCommand, { type: "play" }>;
		playhead: BoardEditor["playhead"];
		acceptedPlaybackId?: string;
		waiting: boolean;
	} | null = null;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let frame: number | null = null;
	let disposed = false;
	let animations: BoardEditor["animations"] | undefined;
	let ids: readonly string[] = [];
	let snapshot: BoardTransportSnapshot;

	function cancelFrame() {
		if (frame !== null) cancelAnimationFrame(frame);
		frame = null;
	}

	function clearPending() {
		pending = null;
		clearTimeout(timeout);
		timeout = undefined;
	}

	const editing = () => editor.gestureActive || editor.editingId !== null;

	function acceptPlay() {
		if (!pending?.acceptedPlaybackId) return;
		if (playback?.playbackId !== pending.acceptedPlaybackId || playback.status === "stopped") {
			clearPending();
			return;
		}
		if (pending.playhead && editing()) return;
		const { playhead } = pending;
		clearPending();
		if (editor.playhead === playhead) editor.setPlayhead(null);
	}

	function refresh() {
		if (disposed) return;
		const { document, playhead } = editor;
		if (pending && pending.playhead !== playhead) clearPending();
		if (animations !== document.animations) {
			animations = document.animations;
			ids = Object.keys(animations);
		}
		const remote = playback && animations[playback.animationId] ? playback : null;
		const starting = pending?.waiting ? pending.command : null;
		const animationId = starting?.animationId ?? playhead?.animationId ?? remote?.animationId ?? (chosen && animations[chosen] ? chosen : ids[0]) ?? null;
		const animation = animationId ? animations[animationId] : undefined;
		const live = !playhead && !starting && remote?.status === "playing";
		const clock = live ? playbackClockAt(remote, document, Date.now()) : null;
		const time = starting?.position ?? playhead?.time ?? (live ? clock?.time ?? 0 : remote?.position ?? 0);
		const playing = clock?.advancing ?? false;
		const nextMarker = animation?.markers.find((marker) => marker.pause && marker.at > time + 1) ?? null;
		if (!clock?.advancing || !listeners.size) cancelFrame();
		else if (frame === null && typeof requestAnimationFrame === "function") {
			frame = requestAnimationFrame(() => {
				frame = null;
				refresh();
			});
		}
		const changed = snapshot?.ids !== ids || snapshot.animationId !== animationId || snapshot.animation !== animation || snapshot.playing !== playing || snapshot.starting !== Boolean(starting) || snapshot.time !== time || snapshot.nextMarker !== nextMarker;
		if (changed) snapshot = { ids, animationId, animation, playing, starting: Boolean(starting), time, nextMarker };
		if (clock && !clock.advancing && options.holdOnEnd && animationId && listeners.size && !editing()) {
			const settled = snapshot;
			queueMicrotask(() => {
				if (!disposed && listeners.size && snapshot === settled && !editor.playhead && !editing()) editor.setPlayhead({ animationId, time });
			});
		}
		if (changed) for (const listener of listeners) listener();
	}

	async function dispatch(command: BoardPlaybackCommand) {
		let result: Awaited<ReturnType<BoardTransportSend>>;
		try {
			result = await options.send(command);
		} catch (error) {
			if (disposed) return;
			if (pending?.command.commandId === command.commandId) {
				clearPending();
				refresh();
			}
			options.onError?.(error, command);
			return;
		}
		if (pending?.command.commandId !== command.commandId || result?.commandId !== command.commandId) return;
		pending.acceptedPlaybackId = result.playbackId;
		if (playback?.playbackId === result.playbackId) {
			acceptPlay();
			refresh();
		}
	}

	function send(command: Command) {
		if (!disposed) void dispatch({ ...command, commandId: createBoardEntityId() });
	}

	function play() {
		refresh();
		const { animation, animationId, time } = snapshot;
		if (!animation || !animationId || disposed || pending?.waiting) return;
		const playhead = editor.playhead;
		const position = time >= animation.duration ? 0 : time;
		const command = { type: "play" as const, commandId: createBoardEntityId(), animationId, position };
		clearPending();
		const request = { command, playhead, waiting: true };
		pending = request;
		timeout = setTimeout(() => {
			request.waiting = false;
			refresh();
		}, 4_000);
		chosen = animationId;
		refresh();
		void dispatch(command);
	}

	function pause() {
		refresh();
		if (!snapshot.animationId || disposed || pending?.waiting) return;
		send({ type: "pause" });
	}

	const stop = editor.subscribe(["document", "playback"], refresh);
	const stopEditing = editor.subscribe(["interaction", "editing"], () => {
		if (editing() || (!pending && !options.holdOnEnd)) return;
		// The editor can announce idle just before committing the gesture or text draft.
		queueMicrotask(() => {
			if (disposed) return;
			acceptPlay();
			refresh();
		});
	});
	refresh();
	return {
		getSnapshot: () => snapshot,
		subscribe(listener: () => void) {
			if (disposed) return () => {};
			listeners.add(listener);
			refresh();
			return () => {
				listeners.delete(listener);
				if (!listeners.size) cancelFrame();
			};
		},
		setPlayback(next: BoardPlaybackSnapshot | null) {
			if (disposed || playback === next) return;
			if (pending && next?.commandId === pending.command.commandId) pending.acceptedPlaybackId = next.playbackId;
			playback = next;
			acceptPlay();
			refresh();
		},
		play,
		pause,
		toggle() {
			refresh();
			if (snapshot.playing) pause();
			else play();
		},
		seek(at: number) {
			refresh();
			if (disposed || pending?.waiting || !snapshot.animationId || !Number.isFinite(at)) return;
			const position = Math.max(0, at);
			if (snapshot.playing) send({ type: "seek", position });
			else editor.setPlayhead({ animationId: snapshot.animationId, time: position });
		},
		next() {
			refresh();
			const { animationId, nextMarker, playing } = snapshot;
			if (disposed || pending?.waiting || !animationId || !nextMarker) return;
			if (playing) send({ type: "next" });
			else editor.setPlayhead({ animationId, time: nextMarker.at });
		},
		choose(id: string) {
			refresh();
			if (disposed || pending?.waiting || !animations?.[id]) return;
			const wasPlaying = snapshot.playing;
			clearPending();
			chosen = id;
			editor.setPlayhead({ animationId: id, time: 0 });
			refresh();
			if (wasPlaying) send({ type: "stop" });
		},
		hold() {
			refresh();
			const { animationId, time } = snapshot;
			if (!disposed && !pending?.waiting && animationId && !editor.playhead && !editing()) {
				const playhead = { animationId, time };
				if (pending?.playhead === null && pending.command.animationId === animationId) pending.playhead = playhead;
				editor.setPlayhead(playhead);
			}
		},
		destroy() {
			disposed = true;
			stop();
			stopEditing();
			cancelFrame();
			clearPending();
			listeners.clear();
		},
	};
}

export type BoardTransport = ReturnType<typeof createBoardTransport>;
