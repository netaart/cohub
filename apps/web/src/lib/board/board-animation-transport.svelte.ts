import type {
	BoardPlaybackCommand,
	BoardPlaybackSnapshot,
} from "@cohub/protocol";
import { untrack } from "svelte";
import { followBoardPlayback } from "$lib/board/board-playback-clock.svelte";
import type { BoardEditor } from "$lib/board/editor.svelte";

type Command = BoardPlaybackCommand extends infer C
	? C extends BoardPlaybackCommand
		? Omit<C, "commandId">
		: never
	: never;

/**
 * Which animation is shown, where its time is, and the play controls, shared by the editor's dock
 * and the viewer's playback bar. While shared playback runs the editor has no playhead; when it
 * stops, `hold` parks the playhead where it ended so edits keep landing on the animation.
 */
export function createBoardAnimationTransport(input: {
	editor: BoardEditor;
	playback: () => BoardPlaybackSnapshot | null;
	send: (command: BoardPlaybackCommand) => unknown;
	hold: boolean;
}) {
	const { editor } = input;
	let chosen = $state<string | null>(null);
	let starting = $state.raw<{
		stale: BoardPlaybackSnapshot | null;
		from: number;
	} | null>(null);

	const ids = $derived(Object.keys(editor.animations));
	const animationId = $derived.by(() => {
		const playback = input.playback();
		return (
			editor.playhead?.animationId ??
			(playback && editor.animations[playback.animationId]
				? playback.animationId
				: null) ??
			(chosen && editor.animations[chosen] ? chosen : null) ??
			ids[0] ??
			null
		);
	});
	const animation = $derived(
		animationId ? editor.animations[animationId] : undefined,
	);
	const live = $derived.by(() => {
		const playback = input.playback();
		return (
			playback?.status === "playing" &&
			playback.animationId === animationId &&
			!editor.playhead
		);
	});
	const clock = followBoardPlayback(() => ({
		playback: live ? input.playback() : null,
		document: editor.document,
	}));
	const pending = $derived(
		starting !== null && starting.stale === input.playback(),
	);
	const current = $derived(
		live && !pending && clock.snapshot === input.playback(),
	);
	const playing = $derived(pending || (live && (!current || clock.advancing)));
	const time = $derived.by(() => {
		const playback = input.playback();
		if (pending && starting) return starting.from;
		if (live) return current ? clock.time : (playback?.position ?? 0);
		return (
			editor.playhead?.time ??
			(playback?.animationId === animationId ? playback.position : 0)
		);
	});
	const nextMarker = $derived(
		animation?.markers.find((marker) => marker.pause && marker.at > time + 1) ??
			null,
	);

	$effect(() => {
		if (!input.hold || !live || !current || clock.advancing) return;
		const id = animationId;
		const at = clock.time;
		if (id) untrack(() => editor.setPlayhead({ animationId: id, time: at }));
	});

	function send(command: Command) {
		void input.send({
			...command,
			commandId: crypto.randomUUID(),
		} as BoardPlaybackCommand);
	}

	function play() {
		const id = animationId;
		if (!id || !animation) return;
		const from = time >= animation.duration ? 0 : time;
		const request = { stale: input.playback(), from };
		starting = request;
		setTimeout(() => {
			if (starting === request) starting = null;
		}, 4000);
		chosen = id;
		editor.setPlayhead(null);
		send({ type: "play", animationId: id, position: from });
	}

	function pause() {
		if (!animationId) return;
		const at = time;
		send({ type: "pause" });
		editor.setPlayhead({ animationId, time: at });
	}

	return {
		get ids() {
			return ids;
		},
		get animationId() {
			return animationId;
		},
		get animation() {
			return animation;
		},
		get playing() {
			return playing;
		},
		get time() {
			return time;
		},
		get nextMarker() {
			return nextMarker;
		},
		play,
		pause,
		toggle() {
			if (playing) pause();
			else play();
		},
		seek(at: number) {
			if (!animationId) return;
			const value = Math.max(0, at);
			if (playing) send({ type: "seek", position: value });
			else editor.setPlayhead({ animationId, time: value });
		},
		next() {
			if (!animationId || !nextMarker) return;
			if (playing) send({ type: "next" });
			else editor.setPlayhead({ animationId, time: nextMarker.at });
		},
		choose(id: string) {
			chosen = id;
			if (playing) send({ type: "stop" });
			editor.setPlayhead({ animationId: id, time: 0 });
		},
		hold() {
			if (animationId && !editor.playhead)
				editor.setPlayhead({ animationId, time });
		},
	};
}

export type BoardAnimationTransport = ReturnType<
	typeof createBoardAnimationTransport
>;
