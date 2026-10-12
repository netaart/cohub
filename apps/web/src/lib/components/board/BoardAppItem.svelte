<script lang="ts">
import type {
	AppDetailResponse,
	AppRuntimeShellContext,
} from "@neta-art/cohub";
import type { BoardItemViewContext } from "@neta-art/cohub/board/stage";
import type { AppNavigationHandler, BoardAppMeta } from "$lib/board/board-app";
import AppSurface from "$lib/components/app/AppSurface.svelte";
import CenteredLoading from "$lib/components/CenteredLoading.svelte";

const {
	id,
	meta,
	width,
	height,
	context,
	loadDetail,
	shell,
	onNavigationOpen,
}: {
	id: string;
	meta: BoardAppMeta;
	width: number;
	height: number;
	context: BoardItemViewContext;
	loadDetail: (appId: string) => Promise<AppDetailResponse | null>;
	shell?: AppRuntimeShellContext;
	onNavigationOpen?: AppNavigationHandler;
} = $props();

// Keep iframe content mounted only while its rendered viewport is useful. This
// is based on the app's screen size, so a large app remains readable at a far
// board zoom while a small app gets a lightweight title-only representation.
const APP_CONTENT_MIN_WIDTH = 180;
const APP_CONTENT_MIN_HEIGHT = 120;

let detail = $state<AppDetailResponse | null>(null);
let loading = $state(true);
let forwardedPointerId: number | null = null;

$effect(() => {
	const appId = meta.appId;
	let current = true;
	loading = true;
	void loadDetail(appId).then((value) => {
		if (!current) return;
		detail = value;
		loading = false;
	});
	return () => {
		current = false;
	};
});

const contentVisible = $derived(
	width * context.zoom >= APP_CONTENT_MIN_WIDTH &&
		height * context.zoom >= APP_CONTENT_MIN_HEIGHT,
);

function handleBarPointerDown(event: PointerEvent) {
	if (event.button !== 0 || forwardedPointerId !== null) return;
	event.preventDefault();
	event.stopPropagation();
	forwardedPointerId = event.pointerId;
	context.editor.pointerDown(context.toPointerEvent(event));
	(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function handleBarPointerMove(event: PointerEvent) {
	if (event.pointerId !== forwardedPointerId) return;
	event.preventDefault();
	event.stopPropagation();
	context.editor.pointerMove(context.toPointerEvent(event));
}

function handleBarPointerEnd(event: PointerEvent) {
	if (event.pointerId !== forwardedPointerId) return;
	event.preventDefault();
	event.stopPropagation();
	context.editor.pointerUp(context.toPointerEvent(event));
	forwardedPointerId = null;
	if (event.type === "pointercancel" || event.type === "lostpointercapture")
		context.editor.pointerLeave();
}
</script>

<div
	class="board-app-node"
	class:selected={context.selected}
	role="button"
	tabindex="-1"
	onpointerdown={(event) => {
		event.stopPropagation();
		context.editor.setSelection([id]);
	}}
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
		{#if meta.icon}<img src={meta.icon} alt="" />{/if}
		<span>{meta.name}</span>
	</div>
	{#if contentVisible}
		<div class="board-app-content">
			{#if detail}
				<AppSurface
					mode="app"
					app={detail.app}
					space={detail.space}
					owner={detail.owner}
					content={detail.content}
					{shell}
					{onNavigationOpen}
				/>
			{:else if loading}
				<CenteredLoading label="Loading App" size="panel" />
			{:else}
				<div class="board-app-error">App unavailable</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.board-app-node {
		position: absolute;
		inset: 0;
		pointer-events: none;
		overflow: hidden;
		border: 1px solid var(--border-subtle);
		border-radius: 8px;
		background: var(--bg-primary);
		box-shadow: 0 8px 24px color-mix(in srgb, var(--text-primary) 12%, transparent);
	}
	.board-app-node.selected {
		border-color: var(--brand-border);
	}
	.board-app-node .board-app-content {
		pointer-events: auto;
	}
	.board-app-node.selected .board-app-content {
		pointer-events: none;
	}
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
	.board-app-bar img {
		width: calc(16px * var(--board-zoom));
		height: calc(16px * var(--board-zoom));
		border-radius: 4px;
		object-fit: cover;
	}
	.board-app-bar span {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.board-app-content {
		height: calc(100% - 28px * var(--board-zoom));
		min-height: 0;
		margin: calc(8px * var(--board-zoom));
		border-radius: calc(4px * var(--board-zoom));
		overflow: hidden;
	}
	.board-app-error {
		display: grid;
		height: 100%;
		place-items: center;
		color: var(--text-tertiary);
		font-size: 12px;
	}
</style>
