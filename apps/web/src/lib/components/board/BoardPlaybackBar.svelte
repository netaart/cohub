<script lang="ts">
import type {
	BoardPlaybackCommand,
	BoardPlaybackSnapshot,
} from "@cohub/protocol";
import type { BoardStage } from "@neta-art/cohub/board/stage";
import {
	ListOrdered,
	LocateFixed,
	Pause,
	Play,
	SkipForward,
	Volume2,
	VolumeX,
	X,
} from "lucide-svelte";
import { onDestroy, untrack } from "svelte";
import { formatBoardTime } from "$lib/board/animation-timeline";
import { createBoardAnimationTransport } from "$lib/board/board-animation-transport.svelte";
import { boardAnimationReach } from "$lib/board/board-media-playback";
import type { BoardEditor } from "$lib/board/editor.svelte";
import BoardMenu, {
	type BoardMenuItem,
} from "$lib/components/board/BoardMenu.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const IDLE_MS = 2500;
const SEEK_STEP_MS = 5000;

const {
	editor,
	playback,
	media,
	sound,
	onPlayback,
	onClose,
}: {
	editor: BoardEditor;
	playback: BoardPlaybackSnapshot | null;
	media: BoardStage["media"] | null;
	sound: { blocked: boolean; muted: boolean };
	onPlayback: (command: BoardPlaybackCommand) => unknown;
	onClose: () => void;
} = $props();

const locale = $derived(getLocale());
const transport = createBoardAnimationTransport({
	editor: untrack(() => editor),
	playback: () => playback,
	send: (command) => onPlayback(command),
	hold: false,
});
const animation = $derived(transport.animation);
const duration = $derived(Math.max(1, animation?.duration ?? 1));
const chapters = $derived(
	animation?.markers.filter((marker) => marker.label) ?? [],
);
const reach = $derived(
	boardAnimationReach(editor.document, transport.animationId),
);
const silent = $derived(sound.blocked || sound.muted);
const soundLabel = $derived(
	sound.blocked
		? m.board_sound_enable({}, { locale })
		: sound.muted
			? m.board_sound_unmute({}, { locale })
			: m.board_sound_mute({}, { locale }),
);
const detached = $derived(reach.camera && editor.cameraPolicy === "free");

let listAnchor = $state<HTMLButtonElement | null>(null);
let listOpen = $state(false);
const items = $derived<BoardMenuItem[]>([
	...transport.ids.map((id) => ({
		id: `animation-${id}`,
		label: editor.animations[id]?.name || id,
		checked: id === transport.animationId,
		run: () => transport.choose(id),
	})),
	...(chapters.length && transport.ids.length > 1
		? [{ id: "separator", separator: true as const }]
		: []),
	...chapters.map((marker, index) => ({
		id: `chapter-${index}`,
		label: marker.label ?? formatBoardTime(marker.at),
		run: () => transport.seek(marker.at),
	})),
]);

let bar = $state<HTMLDivElement | null>(null);
let idle = $state(false);
let hovered = $state(false);
let focused = $state(false);
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const shown = $derived(
	!idle ||
		hovered ||
		focused ||
		listOpen ||
		!transport.playing ||
		sound.blocked,
);

function wake() {
	idle = false;
	if (idleTimer) clearTimeout(idleTimer);
	idleTimer = setTimeout(() => {
		idleTimer = null;
		idle = true;
	}, IDLE_MS);
}

$effect(() => {
	if (!transport.playing) return;
	untrack(wake);
	const away = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = null;
		idle = true;
	};
	const page = document.documentElement;
	window.addEventListener("pointermove", wake, { passive: true });
	window.addEventListener("pointerdown", wake, { passive: true });
	page.addEventListener("pointerleave", away);
	return () => {
		window.removeEventListener("pointermove", wake);
		window.removeEventListener("pointerdown", wake);
		page.removeEventListener("pointerleave", away);
	};
});

onDestroy(() => {
	if (idleTimer) clearTimeout(idleTimer);
});

function toggle() {
	media?.unlock();
	transport.toggle();
}

function seekBy(delta: number) {
	transport.seek(Math.min(duration, Math.max(0, transport.time + delta)));
}

function toggleSound() {
	if (!media) return;
	if (sound.blocked) {
		media.setMuted(false);
		media.unlock();
	} else media.setMuted(!sound.muted);
}

export function key(event: KeyboardEvent): boolean {
	if (event.metaKey || event.ctrlKey || event.altKey) return false;
	const run =
		event.key === " " || event.key === "k"
			? toggle
			: event.key === "ArrowLeft"
				? () => seekBy(-SEEK_STEP_MS)
				: event.key === "ArrowRight"
					? () => seekBy(SEEK_STEP_MS)
					: event.key.toLowerCase() === "m" && reach.sound
						? toggleSound
						: null;
	if (!run || !animation) return false;
	event.preventDefault();
	if (!event.repeat || event.key.startsWith("Arrow")) run();
	wake();
	return true;
}

export function contains(target: EventTarget | null): boolean {
	return target instanceof Node && Boolean(bar?.contains(target));
}
</script>

{#if animation}
	<div
		bind:this={bar}
		class="playback toolbar-surface"
		class:playback--asleep={!shown}
		role="toolbar"
		tabindex="-1"
		aria-label={m.board_play_animation({}, { locale })}
		onpointerenter={() => { hovered = true; }}
		onpointerleave={() => { hovered = false; }}
		onfocusin={(event) => { focused = (event.target as Element).matches(":focus-visible"); }}
		onfocusout={(event) => { focused = bar?.contains(event.relatedTarget as Node | null) ?? false; }}
	>
		<button
			type="button"
			class="tool-key"
			title={transport.playing ? m.board_pause({}, { locale }) : m.board_play({}, { locale })}
			aria-label={transport.playing ? m.board_pause({}, { locale }) : m.board_play({}, { locale })}
			onclick={toggle}
		>
			{#if transport.playing}<Pause class="h-3.5 w-3.5" fill="currentColor" />{:else}<Play class="h-3.5 w-3.5" fill="currentColor" />{/if}
		</button>
		{#if items.length > 1}
			<button
				bind:this={listAnchor}
				type="button"
				class="tool-key name"
				aria-haspopup="menu"
				aria-expanded={listOpen}
				onclick={() => { listOpen = !listOpen; }}
			>
				<ListOrdered class="h-3.5 w-3.5 shrink-0" />
				<span>{animation.name || transport.animationId}</span>
			</button>
		{/if}
		<input
			class="scrub"
			type="range"
			min="0"
			max={duration}
			step="10"
			value={transport.time}
			aria-label={m.board_playhead({}, { locale })}
			aria-valuetext={formatBoardTime(transport.time)}
			oninput={(event) => transport.seek(Number(event.currentTarget.value))}
		/>
		<span class="time">{formatBoardTime(transport.time)}</span>
		{#if transport.nextMarker}
			<button type="button" class="tool-key" title={m.board_next_marker({}, { locale })} aria-label={m.board_next_marker({}, { locale })} onclick={transport.next}>
				<SkipForward class="h-3.5 w-3.5" />
			</button>
		{/if}
		{#if reach.sound && media}
			<button
				type="button"
				class="tool-key"
				class:sound-off={sound.blocked}
				title={soundLabel}
				aria-label={soundLabel}
				aria-pressed={sound.muted && !sound.blocked}
				onclick={toggleSound}
			>
				{#if silent}<VolumeX class="h-3.5 w-3.5" />{:else}<Volume2 class="h-3.5 w-3.5" />{/if}
				{#if sound.blocked}<span>{soundLabel}</span>{/if}
			</button>
		{/if}
		{#if detached}
			<button type="button" class="tool-key" title={m.board_camera_return({}, { locale })} aria-label={m.board_camera_return({}, { locale })} onclick={() => editor.setCameraPolicy("follow")}>
				<LocateFixed class="h-3.5 w-3.5" />
			</button>
		{/if}
		<button type="button" class="tool-key" title={m.board_close({}, { locale })} aria-label={m.board_close({}, { locale })} onclick={onClose}>
			<X class="h-3.5 w-3.5" />
		</button>
	</div>
	{#if listOpen && listAnchor}
		<BoardMenu anchor={listAnchor} {items} label={m.board_animation_select({}, { locale })} onClose={() => { listOpen = false; }} />
	{/if}
{/if}

<style>
	.playback {
		position: absolute;
		bottom: 14px;
		left: 50%;
		z-index: 26;
		width: min(560px, calc(100% - 28px));
		translate: -50% 0;
		transition:
			opacity 200ms ease,
			translate 200ms var(--ease-out);
	}
	.playback--asleep {
		opacity: 0;
		translate: -50% 6px;
		pointer-events: none;
	}
	.name {
		max-width: 160px;
		padding: 0 8px;
		font-size: 12px;
	}
	.name span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.scrub {
		flex: 1;
		min-width: 60px;
		accent-color: var(--brand);
	}
	.time {
		flex: none;
		min-width: 44px;
		color: var(--text-tertiary);
		font-family: var(--font-mono);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	.sound-off {
		padding: 0 10px 0 8px;
		border-color: var(--brand-border);
		background: var(--brand-bg);
		color: var(--brand-muted-fg);
		font-size: 12px;
		font-weight: 500;
		white-space: nowrap;
	}
	@media (pointer: coarse) {
		.playback {
			--tool-key-size: 38px;
			bottom: calc(12px + env(safe-area-inset-bottom, 0px));
			width: calc(100% - 16px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.playback {
			transition: none;
		}
	}
</style>
