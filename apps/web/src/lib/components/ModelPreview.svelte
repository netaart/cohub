<script lang="ts">
import {
	loadModelEngine,
	type ModelScene,
	type ModelSource,
	type ModelViewer,
} from "@neta-art/cohub/board/render";
import { Box } from "lucide-svelte";
import { onMount, untrack } from "svelte";
import ModelControls, {
	readModelControls,
} from "#lib/components/ModelControls.svelte";
import Spinner from "#lib/components/Spinner.svelte";
import { saveFile } from "#lib/downloads.svelte.ts";
import { formatBytes } from "#lib/format-bytes.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import "#lib/model3d/decoders.ts";
import { m } from "#lib/paraglide/messages.js";

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

let root: HTMLDivElement | null = $state(null);
let canvas: HTMLCanvasElement | null = $state(null);
let viewer: ModelViewer | null = $state.raw(null);
let attempt = $state(0);
let acceptedKey = $state<string | null>(null);
let phase = $state<"loading" | "ready" | "error">("loading");
let failure = $state<"load" | "webgl">("load");
let progress = $state<number | null>(null);
let revision = $state(0);
let fullscreen = $state<boolean | null>(null);
let spinning = false;

const gated = $derived(
	(source.size ?? 0) > autoLoadMaxBytes && acceptedKey !== sourceKey,
);
const controls = $derived.by(() => {
	revision;
	const scene = phase === "ready" ? viewer?.scene : null;
	return scene ? readModelControls(scene) : null;
});

function fail(kind: "load" | "webgl") {
	failure = kind;
	phase = "error";
}

function retry() {
	phase = "loading";
	attempt += 1;
}

function change(apply: (scene: ModelScene) => void) {
	const scene = viewer?.scene;
	if (!scene) return;
	apply(scene);
	spinning = scene.spinning;
	revision += 1;
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
		if (active.scene) active.scene.spinning = spinning;
		phase = "ready";
		revision += 1;
	})().catch(() => {
		if (!signal.aborted) fail("load");
	});
	return () => controller.abort();
});

onMount(() => {
	const sync = () => {
		fullscreen = document.fullscreenEnabled
			? document.fullscreenElement === root
			: null;
	};
	sync();
	document.addEventListener("fullscreenchange", sync);
	return () => document.removeEventListener("fullscreenchange", sync);
});

function toggleFullscreen() {
	if (!root || fullscreen === null) return;
	if (fullscreen) void document.exitFullscreen().catch(() => {});
	else void root.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
}

async function saveSnapshot() {
	const blob = await viewer?.snapshot();
	if (!blob) return;
	const stem = source.name.replace(/\.[^.]+$/, "") || "model";
	void saveFile({
		key: `model-image:${source.key}`,
		name: `${stem}.png`,
		mimeType: "image/png",
		source: () => ({ kind: "blob", blob }),
	});
}

const toggles: Record<string, (scene: ModelScene) => void> = {
	" ": (scene) => (scene.playing = !scene.playing),
	r: (scene) => (scene.spinning = !scene.spinning),
	w: (scene) => (scene.wireframe = !scene.wireframe),
	f: () => toggleFullscreen(),
};

function onKeydown(event: KeyboardEvent) {
	const scene = viewer?.scene;
	if (event.metaKey || event.ctrlKey || event.altKey || !scene || !controls)
		return;
	const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
	const shading = controls.shadings[Number(key) - 1];
	const toggle = shading
		? (target: ModelScene) => (target.shading = shading)
		: toggles[key];
	if (toggle) change(toggle);
	else if (!scene.key(event.key)) return;
	event.preventDefault();
}
</script>

<div bind:this={root} class="model-preview" data-drawer-swipe-ignore>
	{#key attempt}
		<canvas
			bind:this={canvas}
			class="model-canvas"
			class:ready={phase === "ready"}
			tabindex="0"
			aria-label={source.name}
			onkeydown={onKeydown}
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

	{#if controls}
		<ModelControls
			{controls}
			stats={viewer?.stats ?? null}
			fileSize={source.size}
			{fullscreen}
			{reducedMotion}
			onChange={change}
			onSnapshot={saveSnapshot}
			onFullscreen={toggleFullscreen}
		/>
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

	.model-preview:fullscreen {
		background: var(--bg-content);
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

	.model-canvas:focus-visible {
		box-shadow: inset 0 0 0 2px var(--brand-ring);
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

	@media (prefers-reduced-motion: reduce) {
		.model-canvas {
			transition: none;
		}
	}
</style>
