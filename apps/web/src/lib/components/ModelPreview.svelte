<script lang="ts">
import {
	loadModelEngine,
	type ModelSource,
	type ModelViewer,
} from "@neta-art/cohub/board/render";
import { Box, Pause, Play, RotateCcw } from "lucide-svelte";
import { untrack } from "svelte";
import Spinner from "$lib/components/Spinner.svelte";
import { formatBytes } from "$lib/format-bytes";
import { getLocale } from "$lib/i18n/locale.svelte";
import "$lib/model3d/decoders";
import { m } from "$lib/paraglide/messages.js";

const {
	source,
	isMobile = false,
	onDownload,
}: {
	source: ModelSource;
	isMobile?: boolean;
	onDownload?: () => void;
} = $props();

const locale = $derived(getLocale());
const autoLoadMaxBytes = $derived((isMobile ? 32 : 128) * 1024 ** 2);
const sourceKey = $derived(source.key);
const reducedMotion =
	typeof matchMedia === "function" &&
	matchMedia("(prefers-reduced-motion: reduce)").matches;

let canvas: HTMLCanvasElement | null = $state(null);
let viewer: ModelViewer | null = $state(null);
let attempt = $state(0);
let acceptedKey = $state<string | null>(null);
let phase = $state<"loading" | "ready" | "error">("loading");
let failure = $state<"load" | "webgl">("load");
let progress = $state<number | null>(null);
let animated = $state(false);
let playing = $state(false);

const gated = $derived(
	(source.size ?? 0) > autoLoadMaxBytes && acceptedKey !== sourceKey,
);

function fail(kind: "load" | "webgl") {
	failure = kind;
	phase = "error";
}

function retry() {
	phase = "loading";
	attempt += 1;
}

$effect(() => {
	const target = canvas;
	if (!target) return;
	let instance: ModelViewer | null = null;
	let disposed = false;
	void loadModelEngine()
		.then(({ mountModelViewer }) =>
			mountModelViewer(target, {
				reducedMotion,
				onContextLost: () => fail("load"),
			}),
		)
		.then((mounted) => {
			if (disposed) return mounted.destroy();
			instance = mounted;
			viewer = mounted;
		})
		.catch(() => {
			if (!disposed) fail("webgl");
		});
	return () => {
		disposed = true;
		instance?.destroy();
		viewer = null;
	};
});

$effect(() => {
	sourceKey;
	const active = viewer;
	if (!active) return;
	phase = "loading";
	progress = null;
	animated = playing = false;
	active.setModel(null);
	if (gated) return;
	const current = untrack(() => source);
	const controller = new AbortController();
	const { signal } = controller;
	void (async () => {
		const { loadModel } = await loadModelEngine();
		const model = await loadModel(current, {
			signal,
			onProgress: (fraction) => {
				progress = fraction;
			},
		});
		if (signal.aborted) return model.destroy();
		active.setModel(model);
		animated = active.animated;
		playing = active.playing;
		phase = "ready";
	})().catch(() => {
		if (!signal.aborted) fail("load");
	});
	return () => controller.abort();
});

function togglePlaying() {
	if (!viewer) return;
	viewer.playing = !playing;
	playing = viewer.playing;
}
</script>

<div class="model-preview" data-drawer-swipe-ignore>
	{#key attempt}
		<canvas
			bind:this={canvas}
			class="model-canvas"
			class:ready={phase === "ready"}
			aria-label={source.name}
		></canvas>
	{/key}

	{#if gated}
		<div class="model-overlay">
			<Box class="h-6 w-6 text-text-tertiary" />
			<div class="text-sm font-semibold text-text-primary">{m.model3d_large_title({}, { locale })}</div>
			<div class="text-xs text-text-tertiary">{source.name} · {formatBytes(source.size ?? 0)}</div>
			<button type="button" class="primary-key mt-2 h-8 px-3 text-xs" onclick={() => (acceptedKey = sourceKey)}>
				{m.model3d_load_preview({}, { locale })}
			</button>
		</div>
	{:else if phase === "loading"}
		<div class="model-overlay pointer-events-none" role="status">
			<div class="flex items-center gap-2 text-xs text-text-tertiary">
				<Spinner />
				<span>{m.model3d_loading({}, { locale })}</span>
				{#if progress !== null}
					<span class="tabular-nums">{Math.round(progress * 100)}%</span>
				{/if}
			</div>
		</div>
	{:else if phase === "error"}
		<div class="model-overlay">
			<div class="max-w-xs text-xs text-error-soft">
				{failure === "webgl"
					? m.model3d_webgl_unavailable({}, { locale })
					: m.model3d_preview_failed({}, { locale })}
			</div>
			<div class="mt-1 flex gap-2">
				{#if failure === "load"}
					<button type="button" class="action-btn" onclick={retry}>{m.common_retry({}, { locale })}</button>
				{/if}
				{#if onDownload}
					<button type="button" class="action-btn" onclick={onDownload}>{m.download({}, { locale })}</button>
				{/if}
			</div>
		</div>
	{/if}

	{#if phase === "ready"}
		<div class="model-toolbar toolbar-surface" role="toolbar" aria-label={m.model3d_controls({}, { locale })}>
			{#if animated}
				{@const label = playing ? m.model3d_pause({}, { locale }) : m.model3d_play({}, { locale })}
				<button type="button" class="tool-key" title={label} aria-label={label} onclick={togglePlaying}>
					{#if playing}<Pause class="h-4 w-4" />{:else}<Play class="h-4 w-4" />{/if}
				</button>
			{/if}
			<button
				type="button"
				class="tool-key"
				title={m.model3d_reset_view({}, { locale })}
				aria-label={m.model3d_reset_view({}, { locale })}
				onclick={() => viewer?.home()}
			>
				<RotateCcw class="h-4 w-4" />
			</button>
		</div>
	{/if}
</div>

<style>
	.model-preview {
		position: relative;
		display: flex;
		min-height: 0;
		flex: 1;
		overflow: hidden;
	}

	.model-canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		cursor: grab;
		opacity: 0;
		outline: none;
		touch-action: none;
		transition: opacity 180ms ease;
	}

	.model-canvas:active {
		cursor: grabbing;
	}

	.model-canvas.ready {
		opacity: 1;
	}

	.model-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 24px;
		text-align: center;
	}

	.model-toolbar {
		position: absolute;
		bottom: 16px;
		left: 50%;
		z-index: 10;
		transform: translateX(-50%);
	}

	@media (pointer: coarse) {
		.model-toolbar {
			--tool-key-size: 36px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.model-canvas {
			transition: none;
		}
	}
</style>
