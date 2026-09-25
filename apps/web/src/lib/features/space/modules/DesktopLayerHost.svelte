<script lang="ts">
import type { AppNavigationOpenMessage } from "@cohub/protocol/app-navigation";
import type { AppRuntimeShellContext } from "@neta-art/cohub";
import { RefreshCw, X } from "lucide-svelte";
import { untrack } from "svelte";
import AppSurface from "$lib/components/app/AppSurface.svelte";
import type { AppSurfaceHost } from "$lib/features/app/surface-host";
import type { AppSurfaceRegistry } from "$lib/features/app/surface-registry";
import {
	hotAppIdsAt,
	isTrackedInputRegion,
	ownsInput,
	pruneHotAppIds,
	resolveOverlayRect,
	resolveOverlayStyle,
} from "./desktop-layer-geometry";
import type {
	DesktopLayerManager,
	DesktopOverlay,
} from "./desktop-layer-manager.svelte";

type Props = {
	manager: DesktopLayerManager;
	surfaces: AppSurfaceRegistry;
	shell: AppRuntimeShellContext;
	onNavigationOpen?: (message: AppNavigationOpenMessage) => Promise<{
		handled: boolean;
		reason?: "unsupported" | "invalid_target" | "inaccessible" | "timeout";
	}>;
};

const {
	manager,
	surfaces,
	shell,
	onNavigationOpen = undefined,
}: Props = $props();

/**
 * Each surface registers on mount; the disposer removes only that registration.
 */
function registerSurface(appId: string, host: AppSurfaceHost) {
	return surfaces.register({ id: appId, surface: "overlay" }, (input) =>
		host.call(input),
	);
}

/** The window: overlays are a desktop layer, not a workspace-panel layer. */
let viewport = $state({
	width: typeof window !== "undefined" ? window.innerWidth : 1280,
	height: typeof window !== "undefined" ? window.innerHeight : 800,
});

function syncViewport() {
	viewport = { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Rect regions are hit-tested by the host: the overlay paints everywhere but
 * only takes pointer events while the pointer is inside a declared rect. The
 * flag flips on the move that enters the region, so that event still reaches
 * whatever is underneath — one move later the App owns the pointer. Once it
 * does, a cross-origin frame swallows the moves this window would need, so the
 * App reports the pointer back through `onPointerState`.
 */
let layerHost: HTMLDivElement | null = $state(null);
let hotAppIds = $state<ReadonlySet<string>>(new Set());
let pointer: { x: number; y: number } | null = null;
// A held button freezes the current owners: every hit-test entry point honours
// it, so a config update mid-drag cannot release the App's pointer.
let pointerDown = false;

const tracksPointer = $derived(
	manager.overlays.some((overlay) => isTrackedInputRegion(overlay.inputRegion)),
);

function isInteractive(overlay: DesktopOverlay) {
	return overlay.inputRegion === "all" || ownsInput(overlay, hotAppIds);
}

function hitTest() {
	if (!pointer || !layerHost || pointerDown) return;
	const origin = layerHost.getBoundingClientRect();
	const next = hotAppIdsAt(manager.overlays, pointer, viewport, origin);
	if (!sameSet(next, hotAppIds)) hotAppIds = next;
}

// Coalesce moves to one hit-test per frame; a release flushes immediately.
let pointerFrame: number | null = null;
let pendingPointer: { x: number; y: number } | null = null;

function cancelPointerFrame() {
	if (pointerFrame !== null) {
		cancelAnimationFrame(pointerFrame);
		pointerFrame = null;
	}
	pendingPointer = null;
}

function trackPointer(event: PointerEvent) {
	// A held button freezes ownership: an App's drag would lose the pointer the
	// moment it left the declared rect, and an underlying drag must not let a
	// region that moves under the cursor grab it mid-gesture.
	if (event.buttons !== 0) {
		pointerDown = true;
		return;
	}
	pointerDown = false;
	pendingPointer = { x: event.clientX, y: event.clientY };
	if (pointerFrame !== null) return;
	pointerFrame = requestAnimationFrame(() => {
		pointerFrame = null;
		if (!pendingPointer) return;
		pointer = pendingPointer;
		pendingPointer = null;
		hitTest();
	});
}

/**
 * Pointer reported by an overlay that currently owns it. Coordinates are
 * frame-local and the frame fills the overlay, so adding the overlay rect
 * gives layer coordinates — the same space `trackPointer` records. `down`
 * freezes ownership in `hitTest` until the button is released.
 */
function trackAppPointer(
	overlay: DesktopOverlay,
	state: { x: number; y: number; down: boolean },
) {
	const rect = resolveOverlayRect(overlay.geometry, viewport);
	const origin = layerHost?.getBoundingClientRect();
	pointer = {
		x: (origin?.left ?? 0) + rect.left + state.x,
		y: (origin?.top ?? 0) + rect.top + state.y,
	};
	pointerDown = state.down;
	hitTest();
}

function beginPointer() {
	pointerDown = true;
}

/** Release: adopt the release point, then let ownership settle again. */
function endPointer(event: PointerEvent) {
	cancelPointerFrame();
	pointerDown = false;
	pointer = { x: event.clientX, y: event.clientY };
	hitTest();
}

function cancelPointer() {
	cancelPointerFrame();
	pointerDown = false;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>) {
	if (a.size !== b.size) return false;
	for (const item of a) if (!b.has(item)) return false;
	return true;
}

$effect(() => {
	if (!tracksPointer) {
		hotAppIds = new Set();
		return;
	}
	window.addEventListener("pointermove", trackPointer, true);
	return () => {
		window.removeEventListener("pointermove", trackPointer, true);
		cancelPointerFrame();
	};
});

$effect(() => {
	void manager.overlays;
	void viewport;
	untrack(() => {
		// An overlay that closed or left the rect family must lose its hot flag
		// at once — even mid-press — since it no longer reports the pointer.
		const pruned = pruneHotAppIds(hotAppIds, manager.overlays);
		if (!sameSet(pruned, hotAppIds)) hotAppIds = pruned;
		hitTest();
	});
});

$effect(() => {
	// A real loss of focus (or a hidden page) drops every owner and clears the
	// resting pointer, so a later config update cannot reactivate an overlay
	// from stale coordinates. Focus moving into an iframe also blurs this
	// window while `document.hasFocus()` stays true; that is not a real loss.
	const release = () => {
		hotAppIds = new Set();
		pointer = null;
		pointerDown = false;
	};
	const onBlur = () => {
		if (!document.hasFocus()) release();
	};
	const onVisibility = () => {
		if (document.hidden) release();
	};
	window.addEventListener("blur", onBlur);
	document.addEventListener("visibilitychange", onVisibility);
	// Presses that begin on the page underneath (a drag, a selection) must
	// freeze ownership too, so a resting region cannot be grabbed mid-gesture.
	window.addEventListener("pointerdown", beginPointer, true);
	window.addEventListener("pointerup", endPointer, true);
	window.addEventListener("pointercancel", cancelPointer, true);
	return () => {
		window.removeEventListener("blur", onBlur);
		document.removeEventListener("visibilitychange", onVisibility);
		window.removeEventListener("pointerdown", beginPointer, true);
		window.removeEventListener("pointerup", endPointer, true);
		window.removeEventListener("pointercancel", cancelPointer, true);
	};
});
</script>

<svelte:window onresize={syncViewport} />

<!--
	Overlays cover the window (--z-workspace-overlay) and sit below every system
	surface (toasts, dialogs, command palette, drag ghost). The layer itself
	never takes pointer events and never clips what an App paints; each overlay
	opts in to input through its inputRegion, so the desktop underneath stays
	reachable everywhere the App did not claim.
-->
{#if manager.count > 0}
	<div
		bind:this={layerHost}
		class="desktop-layer-host"
		role="region"
		aria-label="App overlays"
	>
	{#each manager.overlays as overlay (overlay.id)}
		<div
			class="desktop-overlay"
			class:interactive={isInteractive(overlay)}
			style={resolveOverlayStyle(overlay.geometry, viewport)}
		>
			{#if overlay.error}
				<div class="overlay-error" role="status">
					<span class="overlay-error-text" title={overlay.error}>{overlay.error}</span>
					<button
						type="button"
						class="overlay-btn"
						onclick={() => manager.retry(overlay.appId)}
						aria-label="Retry loading {overlay.label}"
					>
						<RefreshCw class="h-3 w-3" />
					</button>
					<button
						type="button"
						class="overlay-btn"
						onclick={() => manager.closeOverlay(overlay.appId)}
						aria-label="Dismiss {overlay.label}"
					>
						<X class="h-3 w-3" />
					</button>
				</div>
			{:else if overlay.detail}
				<div class="overlay-surface">
					{#key overlay.mountKey}
						<AppSurface
							mode="overlay"
							app={overlay.detail.app}
							space={overlay.detail.space}
							owner={overlay.detail.owner}
							content={overlay.detail.content ?? null}
							invocation={overlay.invocation}
							{shell}
							onSurfaceHost={(host) => registerSurface(overlay.appId, host)}
							onComposerChip={(chip) => manager.setComposerChip(overlay.appId, chip)}
							onCloseRequest={() => manager.closeOverlay(overlay.appId)}
							onConfigureRequest={(request) => manager.configure(overlay.appId, request)}
							onPointerState={(state) => trackAppPointer(overlay, state)}
							{onNavigationOpen}
						/>
					{/key}
				</div>
			{/if}
		</div>
	{/each}
	</div>
{/if}

<style>
	.desktop-layer-host {
		position: fixed;
		inset: 0;
		z-index: var(--z-workspace-overlay);
		overflow: hidden;
		pointer-events: none;
	}

	.desktop-overlay {
		position: absolute;
		pointer-events: none;
	}

	.overlay-surface {
		width: 100%;
		height: 100%;
	}

	.desktop-overlay.interactive .overlay-surface {
		pointer-events: auto;
	}

	.overlay-error {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		border: 1px solid var(--border-subtle);
		border-radius: 6px;
		background: var(--bg-elevated);
		padding: 3px 8px;
		font-size: 11px;
		color: var(--text-secondary);
		white-space: nowrap;
		pointer-events: auto;
		box-shadow: 0 2px 8px color-mix(in srgb, var(--overlay-scrim) 12%, transparent);
	}

	.overlay-error-text {
		max-width: 160px;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--error-soft);
	}

	.overlay-btn {
		display: inline-flex;
		width: 20px;
		height: 20px;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: var(--text-tertiary);
		cursor: pointer;
		transition: background-color 100ms ease, color 100ms ease;
	}

	.overlay-btn:hover {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}
</style>
