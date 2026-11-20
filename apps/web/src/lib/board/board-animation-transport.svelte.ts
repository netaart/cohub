import type { BoardPlaybackSnapshot } from "@cohub/protocol";
import { createBoardTransport } from "@neta-art/cohub/board/player";
import { untrack } from "svelte";

type Options = Parameters<typeof createBoardTransport>[0];

export function createBoardAnimationTransport({ editor, playback, ...options }: Omit<Options, "playback"> & {
	playback: () => BoardPlaybackSnapshot | null;
}) {
	const transport = untrack(() => createBoardTransport({
		...options,
		editor: {
			get document() { return editor.document; },
			get playhead() { return editor.playhead; },
			get gestureActive() { return editor.gestureActive; },
			get editingId() { return editor.editingId; },
			setPlayhead: editor.setPlayhead,
			subscribe: (channels, refresh) => editor.subscribe(channels, () => untrack(refresh)),
		},
		playback: playback(),
		onError: (error) => console.warn("[board] Playback command failed", error),
	}));
	let snapshot = $state.raw(transport.getSnapshot());
	const { ids, animationId, animation, playing, starting, time, nextMarker } = $derived(snapshot);

	$effect(() => {
		const next = playback();
		untrack(() => transport.setPlayback(next));
	});
	$effect(() => {
		const sync = () => { snapshot = transport.getSnapshot(); };
		const stop = untrack(() => transport.subscribe(sync));
		sync();
		return () => {
			stop();
			transport.destroy();
		};
	});
	return {
		...transport,
		get ids() { return ids; },
		get animationId() { return animationId; },
		get animation() { return animation; },
		get playing() { return playing; },
		get starting() { return starting; },
		get time() { return time; },
		get nextMarker() { return nextMarker; },
	};
}
