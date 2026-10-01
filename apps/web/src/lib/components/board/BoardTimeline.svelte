<script lang="ts">
import type { BoardPlaybackCommand, BoardPlaybackSnapshot } from "@cohub/protocol";
import { Circle, Diamond, Pause, Play, Plus, X } from "lucide-svelte";
import { onDestroy } from "svelte";
import type { BoardEditor } from "$lib/board/editor.svelte";
import { playbackTimeAt } from "$lib/board/runtime/board-player";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	editor,
	playback,
	readonly = false,
	onPlayback,
	onClose,
}: {
	editor: BoardEditor;
	playback: BoardPlaybackSnapshot | null;
	readonly?: boolean;
	onPlayback: (command: BoardPlaybackCommand) => unknown;
	onClose: () => void;
} = $props();

const locale = $derived(getLocale());

const animationIds = $derived(Object.keys(editor.animations));
let chosen = $state<string | null>(null);
const animationId = $derived(
	editor.playhead?.animationId ?? (playback && editor.animations[playback.animationId] ? playback.animationId : null) ?? (chosen && editor.animations[chosen] ? chosen : null) ?? animationIds[0] ?? null,
);
const animation = $derived(animationId ? editor.animations[animationId] : undefined);
const playing = $derived(playback?.status === "playing" && playback.animationId === animationId);

let clock = $state(0);
let frame = 0;
function tick() {
	frame = 0;
	if (!playing || !playback) return;
	clock = playbackTimeAt(playback, editor.document, Date.now()) ?? 0;
	frame = requestAnimationFrame(tick);
}
$effect(() => {
	if (playing && !frame) frame = requestAnimationFrame(tick);
});
onDestroy(() => cancelAnimationFrame(frame));

const time = $derived(playing ? clock : (editor.playhead?.time ?? (playback?.animationId === animationId ? playback.position : 0)));
const keyframe = $derived(editor.keyframeState("position"));

type CommandInput = BoardPlaybackCommand extends infer C ? (C extends BoardPlaybackCommand ? Omit<C, "commandId"> : never) : never;

function command(value: CommandInput) {
	void onPlayback({ ...value, commandId: crypto.randomUUID() } as BoardPlaybackCommand);
}

function seek(value: number) {
	if (!animationId) return;
	if (playing) command({ type: "seek", position: value });
	else editor.setPlayhead({ animationId, time: value });
}

function togglePlay() {
	if (!animationId) return;
	if (playing) {
		command({ type: "pause" });
		editor.setPlayhead({ animationId, time: clock });
		return;
	}
	const from = animation && time >= animation.duration ? 0 : time;
	editor.setPlayhead(null);
	command({ type: "play", animationId, position: from });
}

function choose(id: string) {
	chosen = id;
	if (playing) command({ type: "stop" });
	editor.setPlayhead({ animationId: id, time: 0 });
}

function create() {
	chosen = editor.createAnimation(m.board_animation_default_name({}, { locale }));
}

function format(ms: number) {
	const seconds = ms / 1000;
	return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}
</script>

<div class="board-timeline" role="toolbar" aria-label={m.board_timeline({}, { locale })}>
	<button type="button" class="timeline-btn" title={playing ? m.board_pause({}, { locale }) : m.board_play({}, { locale })} aria-label={playing ? m.board_pause({}, { locale }) : m.board_play({}, { locale })} disabled={!animation} onclick={togglePlay}>
		{#if playing}<Pause class="h-3.5 w-3.5" />{:else}<Play class="h-3.5 w-3.5" />{/if}
	</button>

	<select class="timeline-select" aria-label={m.board_animation_select({}, { locale })} value={animationId ?? ""} onchange={(event) => choose(event.currentTarget.value)}>
		{#each animationIds as id (id)}
			<option value={id}>{editor.animations[id]?.name || id}</option>
		{/each}
	</select>
	{#if !readonly}
		<button type="button" class="timeline-btn" title={m.board_animation_new({}, { locale })} aria-label={m.board_animation_new({}, { locale })} onclick={create}>
			<Plus class="h-3.5 w-3.5" />
		</button>
	{/if}

	{#if animation}
		<div class="timeline-track">
			<input
				type="range"
				min="0"
				max={animation.duration}
				step="10"
				value={time}
				aria-label={m.board_playhead({}, { locale })}
				oninput={(event) => seek(Number(event.currentTarget.value))}
			/>
			{#each animation.markers as marker (marker.at)}
				<span class="timeline-marker" class:timeline-marker--pause={marker.pause} style:left="{(marker.at / animation.duration) * 100}%" title={marker.label ?? format(marker.at)}></span>
			{/each}
		</div>
		<span class="timeline-time">{format(time)} / {format(animation.duration)}</span>
	{/if}

	{#if !readonly && animation}
		<button
			type="button"
			class="timeline-btn"
			class:timeline-btn--record={editor.recording}
			title={m.board_record({}, { locale })}
			aria-label={m.board_record({}, { locale })}
			aria-pressed={editor.recording}
			disabled={!editor.playhead}
			onclick={() => editor.setRecording(!editor.recording)}
		>
			<Circle class="h-3.5 w-3.5" fill={editor.recording ? "currentColor" : "none"} />
		</button>
		<button
			type="button"
			class="timeline-btn"
			class:timeline-btn--active={keyframe !== "none"}
			title={m.board_keyframe_toggle({}, { locale })}
			aria-label={m.board_keyframe_toggle({}, { locale })}
			aria-pressed={keyframe === "keyframe"}
			disabled={!editor.playhead || editor.selectedItems.length === 0}
			onclick={() => editor.toggleKeyframe("position")}
		>
			<Diamond class="h-3.5 w-3.5" fill={keyframe === "keyframe" ? "currentColor" : "none"} />
		</button>
	{/if}

	<button type="button" class="timeline-btn" title={m.board_timeline_close({}, { locale })} aria-label={m.board_timeline_close({}, { locale })} onclick={onClose}>
		<X class="h-3.5 w-3.5" />
	</button>
</div>

<style>
	.board-timeline {
		position: absolute;
		left: 50%;
		bottom: 64px;
		z-index: 26;
		display: flex;
		align-items: center;
		gap: 4px;
		width: min(640px, calc(100% - 24px));
		transform: translateX(-50%);
		border-radius: 10px;
		border: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);
		padding: 4px 6px;
		box-shadow: 0 8px 20px color-mix(in srgb, var(--overlay-scrim-strong) 14%, transparent);
		backdrop-filter: blur(12px);
	}

	.timeline-btn {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border-radius: 6px;
		color: var(--text-secondary);
		transition: background-color 100ms ease, color 100ms ease;
	}
	.timeline-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
	.timeline-btn:disabled { opacity: 0.4; }
	.timeline-btn--active { color: var(--brand-muted-fg); }
	.timeline-btn--record { color: var(--error-500); }

	.timeline-select {
		max-width: 132px;
		min-width: 0;
		border-radius: 6px;
		background: transparent;
		padding: 2px 4px;
		color: var(--text-primary);
		font-size: 12px;
	}

	.timeline-track {
		position: relative;
		display: flex;
		flex: 1;
		min-width: 80px;
		align-items: center;
	}
	.timeline-track input { width: 100%; accent-color: var(--brand); }

	.timeline-marker {
		position: absolute;
		top: -2px;
		width: 2px;
		height: 6px;
		transform: translateX(-1px);
		border-radius: 1px;
		background: var(--text-tertiary);
		pointer-events: none;
	}
	.timeline-marker--pause { background: var(--brand); }

	.timeline-time {
		flex-shrink: 0;
		color: var(--text-tertiary);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}

	@media (pointer: coarse) {
		.timeline-btn { width: 36px; height: 36px; }
	}
</style>
