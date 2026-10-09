<script lang="ts">
import type { AppNavigationOpenMessage } from "@cohub/protocol/app-navigation";
import type {
	AppDetailResponse,
	AppRuntimeShellContext,
} from "@neta-art/cohub";
import { onDestroy, untrack } from "svelte";
import { toBoardPointerEvent } from "$lib/board/board-pointer";
import type { BoardEditor, BoardPointerEvent } from "$lib/board/editor.svelte";
import AppSurface from "$lib/components/app/AppSurface.svelte";
import CenteredLoading from "$lib/components/CenteredLoading.svelte";
import { sdk } from "$lib/sdk";

let {
	editor,
	spaceId,
	surface,
	shell,
	onNavigationOpen,
	readonly = false,
}: {
	editor: BoardEditor;
	spaceId: string;
	readonly?: boolean;
	surface: { width: number; height: number };
	shell?: AppRuntimeShellContext;
	onNavigationOpen?: (message: AppNavigationOpenMessage) => Promise<{
		handled: boolean;
		reason?: "unsupported" | "invalid_target" | "inaccessible" | "timeout";
		call?:
			| { ok: true; result?: unknown }
			| { ok: false; code: string; message: string };
	}>;
} = $props();

type AppMeta = {
	appId: string;
	ref: string;
	url: string;
	name: string;
	icon?: string;
};

type OverlayApp = {
	id: string;
	frame: BoardEditor["items"][number]["frame"];
	meta: AppMeta;
};

function appMeta(item: BoardEditor["items"][number]): AppMeta | null {
	if (
		item.type !== "frame" ||
		!item.metadata ||
		typeof item.metadata !== "object"
	)
		return null;
	const value = (item.metadata as { cohubApp?: unknown }).cohubApp;
	if (!value || typeof value !== "object") return null;
	const meta = value as Partial<AppMeta>;
	if (!meta.appId || !meta.ref || !meta.url || !meta.name) return null;
	return {
		appId: meta.appId,
		ref: meta.ref,
		url: meta.url,
		name: meta.name,
		icon: meta.icon,
	};
}

const apps = $derived.by<OverlayApp[]>(() =>
	editor.items.flatMap((item) => {
		const meta = appMeta(item);
		return meta ? [{ id: item.id, frame: item.frame, meta }] : [];
	}),
);

let details = $state<Record<string, AppDetailResponse | null>>({});
let loading = $state<Record<string, boolean>>({});
let overlayHost: HTMLDivElement | null = $state(null);
let visualCamera = $state({ ...untrack(() => editor.camera) });
let cameraFrame = 0;
let forwardedPointerId: number | null = null;

// Coalesce camera and geometry changes so iframe layout is updated once per frame.
$effect(() => {
	const nextCamera = { ...editor.camera };
	editor.structureVersion;
	editor.geometryVersion;
	if (cameraFrame) cancelAnimationFrame(cameraFrame);
	cameraFrame = requestAnimationFrame(() => {
		visualCamera = nextCamera;
		cameraFrame = 0;
	});
});

function isVisible(app: OverlayApp) {
	const zoom = visualCamera.zoom;
	const left = app.frame.x * zoom + visualCamera.x;
	const top = app.frame.y * zoom + visualCamera.y;
	const right = left + app.frame.width * zoom;
	const bottom = top + app.frame.height * zoom;
	const margin = 240;
	return (
		right >= -margin &&
		bottom >= -margin &&
		left <= surface.width + margin &&
		top <= surface.height + margin
	);
}

const visibleApps = $derived(apps.filter(isVisible));

$effect(() => {
	for (const item of visibleApps) {
		if (item.meta.appId in details || loading[item.meta.appId]) continue;
		loading[item.meta.appId] = true;
		void sdk.apps
			.get(item.meta.appId)
			.catch((cause: unknown) => {
				const status = (cause as { status?: unknown } | null)?.status;
				if (status !== 401 && status !== 403) throw cause;
				return sdk.apps.getPublicById(item.meta.appId);
			})
			.then(
				(detail) => {
					details[item.meta.appId] = detail;
				},
				() => {
					details[item.meta.appId] = null;
				},
			)
			.finally(() => {
				loading[item.meta.appId] = false;
			});
	}
});

// Keep iframe content mounted only while its rendered viewport is useful. This
// is based on the app's screen size, so a large app remains readable at a far
// board zoom while a small app gets a lightweight title-only representation.
const APP_CONTENT_MIN_WIDTH = 180;
const APP_CONTENT_MIN_HEIGHT = 120;

function styleFor(app: OverlayApp) {
	const { frame } = app;
	const zoom = visualCamera.zoom;
	return `left:${frame.x * zoom + visualCamera.x}px;top:${frame.y * zoom + visualCamera.y}px;width:${frame.width * zoom}px;height:${frame.height * zoom}px;--board-zoom:${zoom};transform:rotate(${frame.rotation}rad);`;
}

function toPointerEvent(event: PointerEvent): BoardPointerEvent {
	return toBoardPointerEvent(
		event,
		overlayHost?.getBoundingClientRect() ?? new DOMRect(),
		editor.camera,
	);
}

function handleBarPointerDown(event: PointerEvent) {
	if (event.button !== 0 || forwardedPointerId !== null) return;
	event.preventDefault();
	event.stopPropagation();
	forwardedPointerId = event.pointerId;
	editor.pointerDown(toPointerEvent(event));
	(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function handleBarPointerMove(event: PointerEvent) {
	if (event.pointerId !== forwardedPointerId) return;
	event.preventDefault();
	event.stopPropagation();
	editor.pointerMove(toPointerEvent(event));
}

function handleBarPointerEnd(event: PointerEvent) {
	if (event.pointerId !== forwardedPointerId) return;
	event.preventDefault();
	event.stopPropagation();
	editor.pointerUp(toPointerEvent(event));
	forwardedPointerId = null;
	if (event.type === "pointercancel" || event.type === "lostpointercapture")
		editor.pointerLeave();
}

function contentVisible(app: OverlayApp) {
	const zoom = visualCamera.zoom;
	return (
		app.frame.width * zoom >= APP_CONTENT_MIN_WIDTH &&
		app.frame.height * zoom >= APP_CONTENT_MIN_HEIGHT
	);
}

function select(id: string) {
	editor.setSelection([id]);
}

onDestroy(() => {
	if (cameraFrame) cancelAnimationFrame(cameraFrame);
});
</script>

<div bind:this={overlayHost} class="board-app-overlay">
	{#each visibleApps as app (app.id)}
		{@const detail = details[app.meta.appId]}
		<div
			class="board-app-node"
			class:selected={editor.selection.includes(app.id)}
			style={styleFor(app)}
			role="button"
			tabindex="-1"
			onpointerdown={(event) => { event.stopPropagation(); select(app.id); }}
		>
			<div
				class="board-app-bar"
				role="button"
				tabindex="-1"
				onpointerdown={handleBarPointerDown}
				onpointermove={handleBarPointerMove}
				onpointerup={handleBarPointerEnd}
				onpointercancel={handleBarPointerEnd}
				onlostpointercapture={handleBarPointerEnd}
			>
				{#if app.meta.icon}<img src={app.meta.icon} alt="" />{/if}
				<span>{app.meta.name}</span>
			</div>
			{#if contentVisible(app)}
			<div class="board-app-content">
				{#if detail}
					<AppSurface
						mode="app"
						app={detail.app}
						space={detail.space}
						owner={detail.owner}
						content={detail.content}
						shell={shell}
						onNavigationOpen={onNavigationOpen}
					/>
				{:else if loading[app.meta.appId]}
					<CenteredLoading label="Loading App" size="panel" />
				{:else}
					<div class="board-app-error">App unavailable</div>
				{/if}
			</div>
			{/if}
		</div>
	{/each}
</div>

<style>
	.board-app-overlay {
		position: absolute;
		inset: 0;
		z-index: 2;
		pointer-events: none;
		overflow: hidden;
	}
	.board-app-node {
		position: absolute;
		min-width: 0;
		min-height: 0;
		pointer-events: none;
		overflow: hidden;
		border: 1px solid var(--border-subtle);
		border-radius: 8px;
		background: var(--bg-primary);
		box-shadow: 0 8px 24px color-mix(in srgb, var(--text-primary) 12%, transparent);
		transform-origin: center;
	}
	.board-app-node.selected { border-color: var(--brand-border); }
	.board-app-node .board-app-content { pointer-events: auto; }
	.board-app-node.selected .board-app-content { pointer-events: none; }
	.board-app-bar {
		display: flex;
		height: calc(28px * var(--board-zoom));
		min-height: 1px;
		align-items: center;
		gap: calc(6px * var(--board-zoom));
		padding: 0 calc(8px * var(--board-zoom));
		pointer-events: auto;
		cursor: grab;
		background: var(--bg-elevated);
		color: var(--text-secondary);
		font-size: max(1px, calc(11px * var(--board-zoom)));
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
	}
	.board-app-bar img { width: calc(16px * var(--board-zoom)); height: calc(16px * var(--board-zoom)); border-radius: 4px; object-fit: cover; }
	.board-app-bar span { overflow: hidden; text-overflow: ellipsis; }
	.board-app-content {
		height: calc(100% - 28px * var(--board-zoom));
		min-height: 0;
		margin: calc(8px * var(--board-zoom));
		border-radius: calc(4px * var(--board-zoom));
		overflow: hidden;
	}
	.board-app-error { display: grid; height: 100%; place-items: center; color: var(--text-tertiary); font-size: 12px; }
</style>
