<script lang="ts" module>
import { createLazyModuleLoader, pending } from "$lib/lazy-module";

const loadRuntime = createLazyModuleLoader(() =>
	import.meta.env.SSR
		? pending()
		: Promise.all([
				import("$lib/model3d/viewer"),
				import("$lib/model3d/load"),
				import("$lib/model3d/studio"),
			]),
);

const MAX_EDGE_PX = 2048;
const SETTLE_MS = 160;
const FRAME_MS = 1000 / 30;

function pixelRatio(zoom: number, edge: number) {
	const wanted = (globalThis.devicePixelRatio || 1) * zoom;
	const snapped = Math.max(0.25, 2 ** (Math.round(Math.log2(wanted) * 2) / 2));
	return Math.min(snapped, MAX_EDGE_PX / Math.max(1, edge));
}
</script>

<script lang="ts">
import type { BoardItemViewContext } from "@neta-art/cohub/board/stage";
import { untrack } from "svelte";
import type { ModelSource } from "$lib/model3d/source";
import type { ModelViewer } from "$lib/model3d/viewer";

const {
	source,
	context,
	frame,
	isMobile = false,
}: {
	source: ModelSource;
	context: BoardItemViewContext;
	frame: { width: number; height: number };
	isMobile?: boolean;
} = $props();

const running = $derived(context.running);
const zoom = $derived(context.editor.camera.zoom);
const sourceKey = $derived(source.key);
const edge = $derived(Math.max(frame.width, frame.height));

let canvas: HTMLCanvasElement | null = $state(null);
let viewer: ModelViewer | null = $state(null);
let loaded = false;
let ready = $state(false);
let ratio = $state(untrack(() => pixelRatio(zoom, edge)));

$effect(() => {
	const next = pixelRatio(zoom, edge);
	if (next === untrack(() => ratio)) return;
	const timer = setTimeout(() => {
		ratio = next;
	}, SETTLE_MS);
	return () => clearTimeout(timer);
});

$effect(() => {
	viewer?.setPixelRatio(ratio);
});

$effect(() => {
	const target = canvas;
	if (!target) return;
	let instance: ModelViewer | null = null;
	let disposed = false;
	void loadRuntime().then(([{ createModelViewer }]) => {
		if (disposed) return;
		try {
			instance = createModelViewer(target, {
				onContextLost: () => {
					ready = false;
				},
				onRender: () => {
					context.present(target);
					if (loaded) ready = true;
				},
				pixelRatio: untrack(() => ratio),
				frameMs: FRAME_MS,
			});
			viewer = instance;
		} catch {
		}
	});
	return () => {
		disposed = true;
		instance?.dispose();
		viewer = null;
		loaded = ready = false;
		untrack(() => context).present(null);
	};
});

$effect(() => {
	const active = viewer;
	sourceKey;
	if (!active) return;
	const current = untrack(() => source);
	const maxBytes = (untrack(() => isMobile) ? 32 : 128) * 1024 ** 2;
	const controller = new AbortController();
	const { signal } = controller;
	loaded = ready = false;
	active.clearModel();
	void loadRuntime()
		.then(async ([, { loadModelSource }, { disposeModel }]) => {
			const model = await loadModelSource(current, { signal, maxBytes });
			if (signal.aborted) {
				disposeModel(model.root);
				return;
			}
			loaded = true;
			active.setModel(model);
		})
		.catch(() => {});
	return () => controller.abort();
});

$effect.pre(() => context.setCovering(ready));
</script>

{#if running}
	<canvas bind:this={canvas} class="board-model-item" aria-hidden="true"></canvas>
{/if}

<style>
	.board-model-item {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		visibility: hidden;
		pointer-events: none;
	}
</style>
