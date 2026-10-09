<script lang="ts">
import type {
	BoardPlaybackCommand,
	BoardPlaybackSnapshot,
	BoardTrack,
} from "@cohub/protocol";
import { playbackTimeAt } from "@neta-art/cohub/board";
import {
	Circle,
	Crosshair,
	Diamond,
	FastForward,
	Layers,
	Pause,
	Play,
	Plus,
	X,
} from "lucide-svelte";
import { onDestroy } from "svelte";
import {
	BOARD_EASE_PRESETS,
	type BoardTrackRow,
	boardTrackRows,
} from "$lib/board/animation-tracks";
import type { BoardEditor } from "$lib/board/editor.svelte";
import BoardAnimationTracks from "$lib/components/board/BoardAnimationTracks.svelte";
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
	editor.playhead?.animationId ??
		(playback && editor.animations[playback.animationId]
			? playback.animationId
			: null) ??
		(chosen && editor.animations[chosen] ? chosen : null) ??
		animationIds[0] ??
		null,
);
const animation = $derived(
	animationId ? editor.animations[animationId] : undefined,
);
const playing = $derived(
	playback?.status === "playing" && playback.animationId === animationId,
);

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

const time = $derived(
	playing
		? clock
		: (editor.playhead?.time ??
				(playback?.animationId === animationId ? playback.position : 0)),
);
const nextMarker = $derived(
	animation?.markers.find((marker) => marker.pause && marker.at > time + 1) ??
		null,
);
const keyframe = $derived(editor.keyframeState("position"));

const trackRows = $derived<BoardTrackRow[]>(
	animation ? boardTrackRows(editor.document.items, animation.tracks) : [],
);
const hasCameraMotion = $derived(
	trackRows.some((row) => row.kind === "camera"),
);

let tracksOpen = $state(false);
let selectedKey = $state<string | null>(null);

$effect(() => {
	if (!tracksOpen) selectedKey = null;
});
$effect(() => {
	animationId;
	selectedKey = null;
});

const selectedKeyframe = $derived.by(() => {
	if (!selectedKey) return null;
	const separator = selectedKey.lastIndexOf(":");
	const trackId = selectedKey.slice(0, separator);
	const at = Number(selectedKey.slice(separator + 1));
	const track: BoardTrack | undefined = animation?.tracks[trackId];
	const entry = track?.keyframes.find((candidate) => candidate.at === at);
	return track && entry ? { trackId, at, entry } : null;
});

const selectedEase = $derived(
	selectedKeyframe?.entry.ease && selectedKeyframe.entry.ease.length > 0
		? selectedKeyframe.entry.ease
		: "linear",
);

const EASE_LABELS = $derived<Record<string, string>>({
	linear: m.board_ease_linear({}, { locale }),
	ease: m.board_ease_ease({}, { locale }),
	"ease-in": m.board_ease_in({}, { locale }),
	"ease-out": m.board_ease_out({}, { locale }),
	"ease-in-out": m.board_ease_in_out({}, { locale }),
});

type CommandInput = BoardPlaybackCommand extends infer C
	? C extends BoardPlaybackCommand
		? Omit<C, "commandId">
		: never
	: never;

function command(value: CommandInput) {
	void onPlayback({
		...value,
		commandId: crypto.randomUUID(),
	} as BoardPlaybackCommand);
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

function nextMarkerCommand() {
	if (!animationId || !nextMarker) return;
	if (playing) command({ type: "next" });
	else editor.setPlayhead({ animationId, time: nextMarker.at });
}

function choose(id: string) {
	chosen = id;
	if (playing) command({ type: "stop" });
	editor.setPlayhead({ animationId: id, time: 0 });
}

function create() {
	chosen = editor.createAnimation(
		m.board_animation_default_name({}, { locale }),
	);
}

function selectKeyframe(row: BoardTrackRow, at: number) {
	if (!animationId) return;
	selectedKey = `${row.id}:${at}`;
	editor.setPlayhead({ animationId, time: at });
}

function removeKeyframe(row: BoardTrackRow, at: number) {
	editor.removeKeyframe(row.id, at);
	selectedKey = null;
}

function toggleKeyframe() {
	if (!animationId) return;
	editor.setPlayhead({ animationId, time });
	editor.toggleKeyframe("position");
}

function setEase(value: string) {
	if (!selectedKeyframe) return;
	editor.setKeyframeEase(selectedKeyframe.trackId, selectedKeyframe.at, value);
}

function toggleCameraPolicy() {
	editor.setCameraPolicy(editor.cameraPolicy === "follow" ? "free" : "follow");
}

function format(ms: number) {
	const seconds = ms / 1000;
	return seconds < 60
		? `${seconds.toFixed(1)}s`
		: `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
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

	{#if animation}
		<button type="button" class="timeline-btn" title={m.board_next_marker({}, { locale })} aria-label={m.board_next_marker({}, { locale })} disabled={!nextMarker} onclick={nextMarkerCommand}>
			<FastForward class="h-3.5 w-3.5" />
		</button>
	{/if}
	{#if hasCameraMotion}
		<button
			type="button"
			class="timeline-btn"
			class:timeline-btn--on={editor.cameraPolicy === "follow"}
			title={editor.cameraPolicy === "follow" ? m.board_camera_follow({}, { locale }) : m.board_camera_free({}, { locale })}
			aria-label={editor.cameraPolicy === "follow" ? m.board_camera_follow({}, { locale }) : m.board_camera_free({}, { locale })}
			aria-pressed={editor.cameraPolicy === "follow"}
			onclick={toggleCameraPolicy}
		>
			<Crosshair class="h-3.5 w-3.5" />
		</button>
	{/if}
	{#if animation && trackRows.length > 0}
		<button
			type="button"
			class="timeline-btn"
			class:timeline-btn--on={tracksOpen}
			title={m.board_tracks({}, { locale })}
			aria-label={m.board_tracks({}, { locale })}
			aria-expanded={tracksOpen}
			onclick={() => { tracksOpen = !tracksOpen; }}
		>
			<Layers class="h-3.5 w-3.5" />
		</button>
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
			onclick={toggleKeyframe}
		>
			<Diamond class="h-3.5 w-3.5" fill={keyframe === "keyframe" ? "currentColor" : "none"} />
		</button>
	{/if}

	<button type="button" class="timeline-btn" title={m.board_timeline_close({}, { locale })} aria-label={m.board_timeline_close({}, { locale })} onclick={onClose}>
		<X class="h-3.5 w-3.5" />
	</button>
</div>

{#if animation && tracksOpen}
	<div class="board-tracks-panel" role="region" aria-label={m.board_tracks({}, { locale })}>
		<BoardAnimationTracks
			rows={trackRows}
			duration={animation.duration}
			time={time}
			{readonly}
			{selectedKey}
			onSelectKeyframe={selectKeyframe}
			onRemoveKeyframe={removeKeyframe}
		/>
		{#if !readonly && selectedKeyframe}
			<div class="tracks-edit">
				<label class="tracks-edit-label" for="board-keyframe-ease">{m.board_ease({}, { locale })}</label>
				<select
					id="board-keyframe-ease"
					class="tracks-edit-select"
					value={selectedEase}
					onchange={(event) => setEase(event.currentTarget.value)}
				>
					{#each BOARD_EASE_PRESETS as preset (preset)}
						<option value={preset}>{EASE_LABELS[preset] ?? preset}</option>
					{/each}
				</select>
				<span class="tracks-edit-time">
					{(selectedKeyframe.at / 1000).toFixed(2)}s
				</span>
			</div>
		{/if}
	</div>
{/if}

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
	.timeline-btn--on { color: var(--brand-muted-fg); background: var(--brand-bg); }
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

	.board-tracks-panel {
		position: absolute;
		left: 50%;
		bottom: calc(64px + 38px);
		z-index: 26;
		display: flex;
		flex-direction: column;
		gap: 6px;
		width: min(640px, calc(100% - 24px));
		transform: translateX(-50%);
		border-radius: 10px;
		border: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);
		padding: 6px 8px;
		box-shadow: 0 8px 20px color-mix(in srgb, var(--overlay-scrim-strong) 14%, transparent);
		backdrop-filter: blur(12px);
	}

	.tracks-edit {
		display: flex;
		align-items: center;
		gap: 8px;
		border-top: 1px solid var(--border-subtle);
		padding-top: 6px;
	}
	.tracks-edit-label {
		color: var(--text-tertiary);
		font-size: 11px;
	}
	.tracks-edit-select {
		flex: 1;
		border-radius: 6px;
		background: var(--bg-secondary);
		padding: 3px 6px;
		color: var(--text-primary);
		font-size: 11px;
	}
	.tracks-edit-time {
		color: var(--text-tertiary);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}

	@media (pointer: coarse) {
		.timeline-btn { width: 36px; height: 36px; }
		.board-tracks-panel { bottom: calc(64px + 46px); }
	}
</style>
