<script lang="ts">
import type { GenerationTaskOutput, GenerationTaskView } from "@neta-art/cohub";
import {
	AlertCircle,
	AudioLines,
	FileText,
	Film,
	Image as ImageIcon,
	Info,
	Loader2,
	Play,
	X,
} from "lucide-svelte";
import { nearViewport } from "$lib/actions/near-viewport";
import AudioPlayer from "$lib/components/AudioPlayer.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { formatElapsed } from "./side-panel-data";

type Props = {
	task: GenerationTaskView;
	output: GenerationTaskOutput | null;
	opening: boolean;
	/** Set while this audio output plays inline. */
	audioSrc: string | null;
	draggable: boolean;
	onActivate: () => void;
	onOpenTask: () => void;
	onCloseAudio: () => void;
	onDragStart: (event: DragEvent) => void;
};

const {
	task,
	output,
	opening,
	audioSrc,
	draggable,
	onActivate,
	onOpenTask,
	onCloseAudio,
	onDragStart,
}: Props = $props();

const locale = $derived(getLocale());
const ELAPSED_TICK_MS = 1_000;
let videoVisible = $state(false);
let now = $state(Date.now());

const tileKind = $derived(
	output ? "output" : task.status === "failed" ? "failed" : "active",
);
const statusLabel = $derived(
	task.status === "pending"
		? m.generation_status_queued({}, { locale })
		: m.generation_status_running({}, { locale }),
);
$effect(() => {
	if (tileKind !== "active") return;
	now = Date.now();
	const timer = setInterval(() => {
		now = Date.now();
	}, ELAPSED_TICK_MS);
	return () => clearInterval(timer);
});
const elapsed = $derived.by(() => {
	const startedAt = Date.parse(task.startedAt ?? task.createdAt);
	return Number.isFinite(startedAt) ? formatElapsed(now - startedAt) : "";
});
const label = $derived([task.prompt, task.model].filter(Boolean).join(" · "));
const audioName = $derived(output?.title || label);
const surfaceLabel = $derived(
	output?.type === "audio"
		? audioName
			? m.generation_play_audio_named({ title: audioName }, { locale })
			: m.generation_play_audio({}, { locale })
		: label || statusLabel,
);
const thumbnail = $derived(
	output?.type === "image" ? output.url : (output?.previewUrl ?? null),
);
</script>

{#if tileKind === "output" && output?.type === "audio" && audioSrc}
	<div class="relative col-span-full min-w-0">
		<AudioPlayer
			src={audioSrc}
			title={output.title ?? task.prompt}
			subtitle={task.model}
		/>
		<button
			type="button"
			class="tile-action audio-close"
			title={m.common_close({}, { locale })}
			aria-label={m.common_close({}, { locale })}
			onclick={onCloseAudio}
		>
			<X class="h-3 w-3" />
		</button>
	</div>
{:else}
	<div class="tile group" class:tile--failed={tileKind === "failed"}>
		<button
			type="button"
			class="tile-surface"
			title={tileKind === "failed" ? (task.errorMessage ?? label) : label}
			aria-label={surfaceLabel}
			draggable={draggable && tileKind === "output"}
			ondragstart={onDragStart}
			onclick={tileKind === "output" ? onActivate : onOpenTask}
		>
			{#if tileKind === "active"}
				<span class="tile-placeholder">
					<span class="line-clamp-2 text-[11px] leading-4 text-text-tertiary">{task.prompt ?? task.model ?? ""}</span>
					<span class="mt-auto flex items-center gap-1.5 text-[10px] leading-4 text-text-secondary">
						<span class="status-dot" class:status-dot--running={task.status === "running"}></span>
						<span class="truncate">{statusLabel}</span>
					</span>
					<span class="font-mono text-[10px] leading-4 tabular-nums text-text-placeholder">{elapsed}</span>
					{#if task.status === "running"}
						<span class="progress-track" aria-hidden="true"><span class="progress-bar"></span></span>
					{/if}
				</span>
			{:else if tileKind === "failed"}
				<span class="tile-placeholder">
					<span class="flex items-center gap-1 text-[10px] font-medium text-error-soft">
						<AlertCircle class="h-3 w-3 shrink-0" />
						{m.generation_status_failed({}, { locale })}
					</span>
					<span class="mt-1 line-clamp-3 text-[11px] leading-4 text-text-tertiary">{task.prompt ?? task.errorMessage ?? ""}</span>
				</span>
			{:else if output?.type === "text"}
				<span class="tile-placeholder">
					<FileText class="h-3.5 w-3.5 shrink-0 text-text-placeholder" />
					<span class="mt-1 line-clamp-4 text-[11px] leading-4 text-text-secondary">{output.text}</span>
				</span>
			{:else if thumbnail}
				<img
					src={thumbnail}
					alt={task.prompt ?? ""}
					class="tile-media"
					loading="lazy"
					decoding="async"
					draggable="false"
				/>
			{:else if output?.type === "video" && output.url}
				<span class="block h-full w-full" use:nearViewport={() => (videoVisible = true)}>
					{#if videoVisible}
						<video
							src={output.url}
							class="tile-media"
							preload="metadata"
							muted
							playsinline
							disablepictureinpicture
						></video>
					{/if}
				</span>
			{:else}
				<span class="tile-placeholder items-center justify-center text-text-placeholder">
					{#if output?.type === "audio"}
						<AudioLines class="h-5 w-5" />
					{:else if output?.type === "video"}
						<Film class="h-5 w-5" />
					{:else}
						<ImageIcon class="h-5 w-5" />
					{/if}
				</span>
			{/if}

			{#if output?.type === "video" || output?.type === "audio"}
				<span class="tile-badge">
					{#if opening}
						<Loader2 class="h-3 w-3 animate-spin" />
					{:else}
						<Play class="h-3 w-3" />
					{/if}
				</span>
			{:else if opening}
				<span class="tile-badge"><Loader2 class="h-3 w-3 animate-spin" /></span>
			{/if}
		</button>

		{#if tileKind === "output"}
			<div class="tile-actions">
				<button type="button" class="tile-action" title={m.generation_task_details({}, { locale })} aria-label={m.generation_task_details({}, { locale })} onclick={onOpenTask}>
					<Info class="h-3 w-3" />
				</button>
			</div>
		{/if}
	</div>
{/if}

<style>
	.tile {
		position: relative;
		aspect-ratio: 1;
		min-width: 0;
		border-radius: 6px;
		background: var(--bg-elevated);
		overflow: hidden;
	}

	.tile--failed {
		background: color-mix(in srgb, var(--error-bg) 60%, var(--bg-elevated));
	}

	.tile-surface {
		display: block;
		width: 100%;
		height: 100%;
		cursor: pointer;
		text-align: left;
	}

	.tile-surface:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--brand) 50%, transparent);
		outline-offset: -2px;
		border-radius: 6px;
	}

	.tile-media {
		width: 100%;
		height: 100%;
		object-fit: cover;
		transition: opacity 160ms ease;
	}

	.tile-surface:hover .tile-media {
		opacity: 0.92;
	}

	.tile-placeholder {
		position: relative;
		display: flex;
		height: 100%;
		flex-direction: column;
		padding: 8px;
	}

	.tile-badge {
		position: absolute;
		left: 6px;
		bottom: 6px;
		display: inline-flex;
		height: 20px;
		width: 20px;
		align-items: center;
		justify-content: center;
		border-radius: 999px;
		background: var(--overlay-control-bg);
		color: var(--overlay-control-text);
		pointer-events: none;
	}

	.tile-actions {
		position: absolute;
		top: 4px;
		right: 4px;
		display: flex;
		gap: 2px;
		opacity: 0;
		transition: opacity 120ms ease;
	}

	.tile:hover .tile-actions,
	.tile:focus-within .tile-actions {
		opacity: 1;
	}

	@media (hover: none) {
		.tile-actions {
			opacity: 1;
		}
	}

	.tile-action {
		display: inline-flex;
		height: 22px;
		width: 22px;
		align-items: center;
		justify-content: center;
		border-radius: 5px;
		background: color-mix(in srgb, var(--bg-primary) 82%, transparent);
		color: var(--text-secondary);
		transition: color 100ms ease, background-color 100ms ease;
	}

	/* Sits on the corner so it never covers the player's own controls. */
	.audio-close {
		position: absolute;
		top: -6px;
		right: -6px;
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		background: var(--bg-primary);
	}

	.tile-action:hover {
		background: var(--bg-primary);
		color: var(--text-primary);
	}

	.status-dot {
		height: 6px;
		width: 6px;
		flex-shrink: 0;
		border-radius: 999px;
		background: var(--text-placeholder);
	}

	.status-dot--running {
		background: var(--brand);
	}

	.progress-track {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: 2px;
		overflow: hidden;
		background: color-mix(in srgb, var(--brand) 12%, transparent);
	}

	.progress-bar {
		display: block;
		height: 100%;
		width: 40%;
		background: var(--brand);
		animation: tile-progress 1.6s cubic-bezier(0.4, 0, 0.2, 1) infinite;
	}

	@keyframes tile-progress {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(250%);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.progress-bar {
			width: 100%;
			animation: none;
			opacity: 0.5;
		}
	}
</style>
