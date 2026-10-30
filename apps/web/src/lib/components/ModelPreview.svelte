<script lang="ts">
import {
	Box,
	Grid3x3,
	Pause,
	Play,
	Rotate3d,
	RotateCcw,
	TriangleAlert,
} from "lucide-svelte";
import { untrack } from "svelte";
import Spinner from "$lib/components/Spinner.svelte";
import { formatBytes } from "$lib/format-bytes";
import { formatCompactNumber } from "$lib/i18n/format";
import { getLocale } from "$lib/i18n/locale.svelte";
import { loadModelSource } from "$lib/model3d/load";
import type { ModelSource } from "$lib/model3d/source";
import { disposeModel } from "$lib/model3d/studio";
import {
	createModelViewer,
	type ModelStats,
	type ModelViewer,
} from "$lib/model3d/viewer";
import { m } from "$lib/paraglide/messages.js";

const {
	source,
	isMobile = false,
	downloadUrl = null,
	downloadName = null,
}: {
	source: ModelSource;
	isMobile?: boolean;
	downloadUrl?: string | null;
	downloadName?: string | null;
} = $props();

const locale = $derived(getLocale());
const autoLoadMaxBytes = $derived((isMobile ? 32 : 128) * 1024 ** 2);
const sourceKey = $derived(source.key);

let canvas: HTMLCanvasElement | null = $state(null);
let viewer: ModelViewer | null = $state(null);
let attempt = $state(0);
let acceptedKey = $state<string | null>(null);
let phase = $state<"loading" | "ready" | "error">("loading");
let failure = $state<"load" | "webgl">("load");
let progress = $state<number | null>(null);
let stats = $state<ModelStats | null>(null);
let missing = $state<string[]>([]);
let autoRotate = $state(false);
let wireframe = $state(false);
let playing = $state(false);

const gated = $derived(
	(source.size ?? 0) > autoLoadMaxBytes && acceptedKey !== sourceKey,
);
const sizeFormat = $derived(
	new Intl.NumberFormat(locale, { maximumSignificantDigits: 3 }),
);
const sizeLabel = $derived(
	stats
		? m.model3d_size(
				{
					x: sizeFormat.format(stats.size[0]),
					y: sizeFormat.format(stats.size[1]),
					z: sizeFormat.format(stats.size[2]),
				},
				{ locale },
			)
		: "",
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
	let instance: ModelViewer;
	try {
		instance = createModelViewer(target, {
			onContextLost: () => fail("load"),
		});
	} catch {
		fail("webgl");
		return;
	}
	viewer = instance;
	return () => {
		instance.dispose();
		viewer = null;
	};
});

$effect(() => {
	sourceKey;
	const active = viewer;
	if (!active) return;
	phase = "loading";
	progress = null;
	stats = null;
	missing = [];
	active.clearModel();
	if (gated) return;
	const current = untrack(() => source);
	const controller = new AbortController();
	const { signal } = controller;

	void (async () => {
		const model = await loadModelSource(current, {
			signal,
			onProgress: (fraction) => {
				progress = fraction;
			},
		});
		if (signal.aborted) {
			disposeModel(model.root);
			return;
		}
		stats = active.setModel(model);
		missing = model.missing;
		active.setAutoRotate(autoRotate);
		active.setWireframe(wireframe);
		playing = active.playing;
		phase = "ready";
	})().catch(() => {
		if (!signal.aborted) fail("load");
	});

	return () => controller.abort();
});

function toggleAutoRotate() {
	autoRotate = !autoRotate;
	viewer?.setAutoRotate(autoRotate);
}

function toggleWireframe() {
	wireframe = !wireframe;
	viewer?.setWireframe(wireframe);
}

function togglePlaying() {
	playing = !playing;
	viewer?.setPlaying(playing);
}
</script>

<div class="model-preview" data-drawer-swipe-ignore>
	{#key attempt}
		<canvas
			bind:this={canvas}
			class="model-canvas"
			class:ready={phase === "ready"}
			aria-label={source.name}
			ondblclick={() => viewer?.resetView()}
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
				{#if downloadUrl}
					<a class="action-btn" href={downloadUrl} download={downloadName ?? source.name}>{m.download({}, { locale })}</a>
				{/if}
			</div>
		</div>
	{/if}

	{#if phase === "ready" && stats}
		<div class="model-toolbar toolbar-surface" role="toolbar" aria-label={m.model3d_controls({}, { locale })}>
			<span class="model-stat" title={sizeLabel}>
				{m.model3d_triangles({ count: formatCompactNumber(stats.triangles, locale) }, { locale })}
			</span>
			{#if missing.length > 0}
				<span class="model-stat model-missing" title={missing.join("\n")}>
					<TriangleAlert class="h-3.5 w-3.5" />
					{m.model3d_missing({ count: missing.length }, { locale })}
				</span>
			{/if}
			<span class="toolbar-divider"></span>
			{#if stats.animations > 0}
				{@const label = playing ? m.model3d_pause({}, { locale }) : m.model3d_play({}, { locale })}
				<button type="button" class="tool-key" title={label} aria-label={label} onclick={togglePlaying}>
					{#if playing}<Pause class="h-4 w-4" />{:else}<Play class="h-4 w-4" />{/if}
				</button>
			{/if}
			<button
				type="button"
				class="tool-key"
				title={m.model3d_auto_rotate({}, { locale })}
				aria-label={m.model3d_auto_rotate({}, { locale })}
				aria-pressed={autoRotate}
				onclick={toggleAutoRotate}
			>
				<Rotate3d class="h-4 w-4" />
			</button>
			<button
				type="button"
				class="tool-key"
				title={m.model3d_wireframe({}, { locale })}
				aria-label={m.model3d_wireframe({}, { locale })}
				aria-pressed={wireframe}
				onclick={toggleWireframe}
			>
				<Grid3x3 class="h-4 w-4" />
			</button>
			<button
				type="button"
				class="tool-key"
				title={m.model3d_reset_view({}, { locale })}
				aria-label={m.model3d_reset_view({}, { locale })}
				onclick={() => viewer?.resetView()}
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
		max-width: calc(100% - 24px);
		transform: translateX(-50%);
	}

	.model-stat {
		display: inline-flex;
		min-width: 0;
		align-items: center;
		gap: 4px;
		padding: 0 6px;
		overflow: hidden;
		color: var(--text-tertiary);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.model-missing {
		color: var(--color-warning-soft);
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
