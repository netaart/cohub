<script lang="ts">
import { ChevronLeft, ChevronRight, X } from "lucide-svelte";
import { onMount } from "svelte";
import type { BoardAssetSource } from "$lib/board/board-asset-source";
import { playableBoardMediaList } from "$lib/board/board-media-playback";
import type { BoardEditor } from "$lib/board/editor.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	editor,
	assetSource,
	playingId,
	active = true,
	surface,
	onClose,
}: {
	editor: BoardEditor;
	assetSource: BoardAssetSource;
	playingId: string | null;
	active?: boolean;
	surface: { width: number; height: number };
	onClose: () => void;
} = $props();

const locale = $derived(getLocale());

let mediaEl: HTMLMediaElement | null = $state(null);
let activeMediaId = $state<string | null>(null);
let activeItemId: string | null = null;
let src = $state<string | null>(null);
let loading = $state(false);
let error = $state<string | null>(null);

const item = $derived(playingId ? editor.itemById(playingId) : null);
const playlist = $derived(playableBoardMediaList(item, assetSource));
const media = $derived(
	playlist.find((entry) => entry.id === activeMediaId) ?? playlist[0] ?? null,
);
const activeIndex = $derived(
	media ? playlist.findIndex((entry) => entry.id === media.id) : -1,
);
const layout = $derived.by(() => {
	if (!item || !media) return null;
	const camera = editor.camera;
	const zoom = camera.zoom;
	const nodeWidth = item.frame.width * zoom;
	const nodeHeight = item.frame.height * zoom;
	const width = Math.max(nodeWidth, media.kind === "audio" ? 240 : 1);
	const height =
		media.kind === "audio" ? Math.max(100, nodeHeight) : nodeHeight;
	const centerX = (item.frame.x + item.frame.width / 2) * zoom + camera.x;
	const centerY = (item.frame.y + item.frame.height / 2) * zoom + camera.y;
	return {
		left: centerX - width / 2,
		top: centerY - height / 2,
		width,
		height,
		rotation: item.frame.rotation || 0,
	};
});

$effect(() => {
	if (playingId === activeItemId) return;
	activeItemId = playingId;
	activeMediaId = null;
});

$effect(() => {
	const target = media;
	const id = playingId;
	if (!target || !id) {
		src = null;
		loading = false;
		error = null;
		return;
	}
	let cancelled = false;
	src = null;
	loading = true;
	error = null;
	void target
		.resolveUrl()
		.then((url) => {
			if (cancelled) return;
			if (!url) {
				error = m.board_media_not_ready({}, { locale });
				return;
			}
			src = url;
		})
		.catch(() => {
			if (!cancelled) error = m.board_media_load_failed({}, { locale });
		})
		.finally(() => {
			if (!cancelled) loading = false;
		});
	return () => {
		cancelled = true;
	};
});

$effect(() => {
	const element = mediaEl;
	const currentLayout = layout;
	const currentMedia = media;
	if (!element) return;
	if (!active) {
		element.pause();
		return;
	}
	if (
		currentMedia?.kind === "video" &&
		currentLayout &&
		(currentLayout.left + currentLayout.width < 0 ||
			currentLayout.top + currentLayout.height < 0 ||
			currentLayout.left > surface.width ||
			currentLayout.top > surface.height)
	)
		element.pause();
});

$effect(() => {
	const element = mediaEl;
	const url = src;
	if (!element || !url || !active) return;
	queueMicrotask(() => {
		element.focus({ preventScroll: true });
		void element.play().catch(() => {
		});
	});
	return () => {
		element.pause();
		element.removeAttribute("src");
		element.load();
	};
});

$effect(() => {
	const element = mediaEl;
	const time = item?.type === "video" || item?.type === "audio" ? item.props.time : undefined;
	if (!element || time === undefined || !Number.isFinite(time) || Math.abs(element.currentTime - time / 1000) < 0.05) return;
	if (element.readyState >= 1) element.currentTime = Math.max(0, time / 1000);
});
onMount(() => {
	const pauseWhenHidden = () => {
		if (document.hidden) mediaEl?.pause();
	};
	document.addEventListener("visibilitychange", pauseWhenHidden);
	return () =>
		document.removeEventListener("visibilitychange", pauseWhenHidden);
});

function selectMedia(index: number) {
	const target = playlist[index];
	if (target) activeMediaId = target.id;
}

function handleEnded() {
	if (activeIndex >= 0 && activeIndex < playlist.length - 1) {
		selectMedia(activeIndex + 1);
		return;
	}
	onClose();
}

function handleMediaError() {
	if (!src) return;
	media?.invalidateUrl();
	src = null;
	loading = false;
	error = m.board_media_load_failed({}, { locale });
}

function stopPropagation(event: Event) {
	event.stopPropagation();
}
</script>

{#if item && media && layout}
	<div
		class:board-audio-player={media.kind === "audio"}
		class:board-video-player={media.kind === "video"}
		class="board-media-player"
		role="dialog"
		tabindex="-1"
		aria-label={media.title}
		style:left="{layout.left}px"
		style:width="{layout.width}px"
		style:height="{layout.height}px"
		style:transform="rotate({layout.rotation}deg)"
		onpointerdown={stopPropagation}
		onwheel={stopPropagation}
		data-drawer-swipe-ignore
	>
		<div class="board-media-toolbar">
			<div class="board-media-title" title={media.title}>{media.title}</div>
			{#if playlist.length > 1}
				<span class="board-media-position">{activeIndex + 1} / {playlist.length}</span>
				<button
					type="button"
					class="board-media-action"
					title={m.board_prev_output({}, { locale })}
					aria-label={m.board_prev_output({}, { locale })}
					disabled={activeIndex <= 0}
					onclick={() => selectMedia(activeIndex - 1)}
				>
					<ChevronLeft size={14} strokeWidth={2} />
				</button>
				<button
					type="button"
					class="board-media-action"
					title={m.board_next_output({}, { locale })}
					aria-label={m.board_next_output({}, { locale })}
					disabled={activeIndex >= playlist.length - 1}
					onclick={() => selectMedia(activeIndex + 1)}
				>
					<ChevronRight size={14} strokeWidth={2} />
				</button>
			{/if}
			<button
				type="button"
				class="board-media-action"
				title={m.board_close_player({}, { locale })}
				aria-label={m.board_close_player({}, { locale })}
				onclick={onClose}
			>
				<X size={14} strokeWidth={2} />
			</button>
		</div>
		{#if src}
			{#key `${playingId}:${media.id}:${src}`}
				{#if media.kind === "video"}
					<video
						bind:this={mediaEl}
						class="board-video-el"
						{src}
						controls
						playsinline
						preload="metadata"
						aria-label={media.title}
						onended={handleEnded}
						onerror={handleMediaError}
					>
						<track kind="captions" src="data:text/vtt,WEBVTT" srclang="en" label="Captions" />
					</video>
				{:else}
					<div class="board-audio-content">
						<audio
							bind:this={mediaEl}
							class="board-audio-el"
							{src}
							controls
							preload="metadata"
							aria-label={media.title}
							onended={handleEnded}
							onerror={handleMediaError}
						></audio>
					</div>
				{/if}
			{/key}
		{:else}
			<div class="board-media-status">
				{loading ? "Loading..." : (error ?? "Unavailable")}
			</div>
		{/if}
	</div>
{/if}

<style>
	.board-media-player {
		position: absolute;
		z-index: 28;
		transform-origin: center;
		overflow: hidden;
		border: 1.5px solid var(--brand-border);
		border-radius: 6px;
		background: var(--bg-primary);
		box-shadow: 0 10px 28px color-mix(in srgb, var(--overlay-scrim-strong) 20%, transparent);
	}

	.board-media-toolbar {
		position: absolute;
		top: 0;
		right: 0;
		left: 0;
		z-index: 2;
		display: flex;
		height: 40px;
		align-items: center;
		gap: 2px;
		padding: 4px 4px 4px 9px;
		background: color-mix(in srgb, var(--bg-elevated) 92%, transparent);
	}

	.board-media-title {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		color: var(--text-secondary);
		font-size: 11px;
		font-weight: 500;
		line-height: 1.2;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.board-media-position {
		flex: none;
		color: var(--text-tertiary);
		font-family: var(--font-mono);
		font-size: 10px;
		font-variant-numeric: tabular-nums;
	}

	.board-media-action {
		display: inline-flex;
		width: 32px;
		height: 32px;
		flex: none;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
	}

	.board-media-action:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.board-media-action:disabled {
		cursor: default;
		opacity: 0.35;
	}

	.board-media-action:focus-visible {
		outline: 2px solid var(--brand-border);
		outline-offset: -2px;
	}

	.board-video-el {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: contain;
		background: var(--bg-primary);
		pointer-events: auto;
	}

	.board-audio-player {
		display: flex;
		align-items: flex-end;
	}

	.board-audio-content {
		width: 100%;
		padding: 0 8px 8px;
	}

	.board-audio-el {
		display: block;
		width: 100%;
		height: 32px;
	}

	.board-media-status {
		display: flex;
		height: 100%;
		align-items: center;
		justify-content: center;
		padding: 46px 12px 12px;
		color: var(--text-tertiary);
		font-size: 12px;
	}
</style>
