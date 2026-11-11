<script lang="ts">
import type { BoardReaction } from "@cohub/protocol/realtime";
import {
	type BoardRegionDirection,
	type WorldPoint,
	worldPoint,
} from "@neta-art/cohub/board";
import {
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	Heart,
	X,
} from "lucide-svelte";
import { onDestroy } from "svelte";
import type { BoardEditor } from "$lib/board/editor.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	editor,
	isMobile = false,
	onReact,
}: {
	editor: BoardEditor;
	isMobile?: boolean;
	onReact?: (reaction: BoardReaction, at: WorldPoint) => void;
} = $props();

const HINT_MS = 1600;
const IDLE_MS = 2200;
const MAP_SIZE = { width: 240, height: 150 };
const DIRECTIONS: readonly BoardRegionDirection[] = [
	"left",
	"right",
	"up",
	"down",
];
const HINT_ICONS = {
	left: ChevronLeft,
	right: ChevronRight,
	up: ChevronUp,
	down: ChevronDown,
};

const locale = $derived(getLocale());
const view = $derived(editor.frameView);
const viewId = $derived(view?.id);
const frames = $derived(editor.frames);
const index = $derived(
	view ? frames.findIndex((frame) => frame.id === view.id) : -1,
);
const current = $derived(frames[index]);
const presenting = $derived(view?.present ?? false);
const label = $derived(
	current?.label ?? m.board_frame_numbered({ index: index + 1 }, { locale }),
);
const neighbors = $derived(
	view
		? DIRECTIONS.filter((direction) => editor.frameNeighbor(view.id, direction))
		: [],
);

let nav: HTMLDivElement | null = $state(null);
let mapOpen = $state(false);
let hinting = $state(false);
let awake = $state(true);
let hovered = $state(false);
let hintTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function wake() {
	awake = true;
	if (idleTimer) clearTimeout(idleTimer);
	idleTimer = setTimeout(() => {
		idleTimer = null;
		awake = false;
	}, IDLE_MS);
}

$effect(() => {
	if (!viewId) return;
	hinting = true;
	wake();
	if (hintTimer) clearTimeout(hintTimer);
	hintTimer = setTimeout(() => {
		hintTimer = null;
		hinting = false;
	}, HINT_MS);
});

$effect(() => {
	if (!view) mapOpen = false;
});

$effect(() => {
	if (!mapOpen) return;
	const close = (event: PointerEvent) => {
		if (!nav?.contains(event.target as Node)) mapOpen = false;
	};
	window.addEventListener("pointerdown", close, true);
	return () => window.removeEventListener("pointerdown", close, true);
});

$effect(() => {
	if (!presenting) return;
	const move = (event: PointerEvent) => {
		if (event.pointerType === "mouse") wake();
	};
	window.addEventListener("pointermove", move, { passive: true });
	window.addEventListener("pointerdown", wake, { passive: true });
	return () => {
		window.removeEventListener("pointermove", move);
		window.removeEventListener("pointerdown", wake);
	};
});

onDestroy(() => {
	if (hintTimer) clearTimeout(hintTimer);
	if (idleTimer) clearTimeout(idleTimer);
});

const shown = $derived(!presenting || awake || hovered || mapOpen);

const map = $derived.by(() => {
	if (!mapOpen || frames.length === 0) return null;
	let left = Number.POSITIVE_INFINITY;
	let top = Number.POSITIVE_INFINITY;
	let right = Number.NEGATIVE_INFINITY;
	let bottom = Number.NEGATIVE_INFINITY;
	for (const { rect } of frames) {
		left = Math.min(left, rect.x);
		top = Math.min(top, rect.y);
		right = Math.max(right, rect.x + rect.width);
		bottom = Math.max(bottom, rect.y + rect.height);
	}
	const scale = Math.min(
		MAP_SIZE.width / (right - left),
		MAP_SIZE.height / (bottom - top),
	);
	return {
		width: (right - left) * scale,
		height: (bottom - top) * scale,
		frames: frames.map((frame, at) => ({
			id: frame.id,
			number: at + 1,
			title:
				frame.label ?? m.board_frame_numbered({ index: at + 1 }, { locale }),
			left: (frame.rect.x - left) * scale,
			top: (frame.rect.y - top) * scale,
			width: Math.max(4, frame.rect.width * scale),
			height: Math.max(4, frame.rect.height * scale),
		})),
	};
});

function heart() {
	const rect = current?.rect;
	if (rect)
		onReact?.(
			"heart",
			worldPoint(rect.x + rect.width / 2, rect.y + rect.height * 0.9),
		);
}

function go(id: string) {
	mapOpen = false;
	editor.goToFrame(id);
}
</script>

{#if view && current}
	<div class="frame-hints" class:frame-hints--mobile={isMobile} class:frame-hints--present={presenting} aria-hidden="true">
		{#each neighbors as direction (direction)}
			{@const Icon = HINT_ICONS[direction]}
			<button
				type="button"
				class="frame-hint frame-hint--{direction}"
				class:frame-hint--on={hinting && shown}
				tabindex="-1"
				onclick={() => editor.stepFrame(direction)}
			>
				<Icon class="h-4 w-4" />
			</button>
		{/each}
	</div>

	<div
		bind:this={nav}
		class="frame-nav"
		class:frame-nav--mobile={isMobile}
		class:frame-nav--present={presenting}
		class:frame-nav--asleep={!shown}
		role="toolbar"
		tabindex="-1"
		aria-label={m.board_frames({}, { locale })}
		onpointerenter={() => { hovered = true; }}
		onpointerleave={() => { hovered = false; }}
	>
		{#if map}
			<div class="frame-map menu-surface" style:width="{map.width + 16}px" style:height="{map.height + 16}px">
				{#each map.frames as frame (frame.id)}
					<button
						type="button"
						class="frame-map-cell"
						aria-current={frame.id === view.id}
						title={frame.title}
						aria-label={frame.title}
						style:left="{frame.left + 8}px"
						style:top="{frame.top + 8}px"
						style:width="{frame.width}px"
						style:height="{frame.height}px"
						onclick={() => go(frame.id)}
					>
						{#if frame.width >= 18 && frame.height >= 14}<span>{frame.number}</span>{/if}
					</button>
				{/each}
			</div>
		{/if}

		<div class="toolbar-surface">
			<button
				type="button"
				class="tool-key"
				title={m.board_frame_previous({}, { locale })}
				aria-label={m.board_frame_previous({}, { locale })}
				disabled={index <= 0}
				onclick={() => editor.stepFrame("previous")}
			>
				<ChevronLeft class="h-3.5 w-3.5" />
			</button>
			<button
				type="button"
				class="tool-key frame-nav-label"
				title={m.board_frame_all({}, { locale })}
				aria-expanded={mapOpen}
				onclick={() => { mapOpen = !mapOpen; }}
			>
				<span class="frame-nav-count">{index + 1}<span class="frame-nav-total">/{frames.length}</span></span>
				<span class="frame-nav-name">{label}</span>
			</button>
			<button
				type="button"
				class="tool-key"
				title={m.board_frame_next({}, { locale })}
				aria-label={m.board_frame_next({}, { locale })}
				disabled={index >= frames.length - 1}
				onclick={() => editor.stepFrame("next")}
			>
				<ChevronRight class="h-3.5 w-3.5" />
			</button>
			<div class="toolbar-divider"></div>
			{#if presenting && onReact}
				<button
					type="button"
					class="tool-key"
					title={m.board_reaction_heart({}, { locale })}
					aria-label={m.board_reaction_heart({}, { locale })}
					onclick={heart}
				>
					<Heart class="h-3.5 w-3.5" />
				</button>
			{/if}
			<button
				type="button"
				class="tool-key"
				title={presenting ? m.board_present_exit({}, { locale }) : m.board_frame_close({}, { locale })}
				aria-label={presenting ? m.board_present_exit({}, { locale }) : m.board_frame_close({}, { locale })}
				onclick={() => editor.exitFrameView()}
			>
				<X class="h-3.5 w-3.5" />
			</button>
		</div>
	</div>
{/if}

<style>
	.frame-nav {
		position: absolute;
		top: 12px;
		left: 50%;
		z-index: 26;
		display: flex;
		flex-direction: column-reverse;
		align-items: center;
		gap: 6px;
		max-width: calc(100% - 24px);
		transform: translateX(-50%);
		transition: opacity 160ms ease;
	}

	.frame-nav--mobile {
		--tool-key-size: 36px;
		top: auto;
		bottom: calc(66px + env(safe-area-inset-bottom, 0px));
		flex-direction: column;
	}

	.frame-nav--present {
		top: auto;
		bottom: calc(16px + env(safe-area-inset-bottom, 0px));
		flex-direction: column;
	}

	.frame-nav--asleep {
		opacity: 0;
		pointer-events: none;
	}

	.frame-nav .toolbar-surface {
		max-width: 100%;
	}

	.frame-nav-label {
		min-width: 0;
		padding: 0 8px;
		font-size: 12px;
	}

	.frame-nav-count {
		flex: none;
		color: var(--text-primary);
		font-variant-numeric: tabular-nums;
	}

	.frame-nav-total {
		color: var(--text-tertiary);
	}

	.frame-nav-name {
		overflow: hidden;
		max-width: 22ch;
		color: var(--text-secondary);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.frame-map {
		position: relative;
		flex: none;
	}

	.frame-map-cell {
		position: absolute;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--border-strong);
		border-radius: 2px;
		background: var(--bg-hover);
		color: var(--text-tertiary);
		font-size: 10px;
		font-variant-numeric: tabular-nums;
		cursor: pointer;
		transition: background-color 100ms ease, border-color 100ms ease;

		&:hover {
			border-color: var(--text-tertiary);
			color: var(--text-primary);
		}

		&[aria-current="true"] {
			border-color: var(--brand-border);
			background: var(--brand-bg);
			color: var(--brand-muted-fg);
		}

		&:focus-visible {
			outline: 2px solid var(--brand-ring);
			outline-offset: 1px;
		}
	}

	.frame-hints {
		position: absolute;
		inset: 0;
		z-index: 25;
		pointer-events: none;
	}

	.frame-hint {
		position: absolute;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		background: color-mix(in srgb, var(--bg-elevated) 88%, transparent);
		color: var(--text-secondary);
		opacity: 0;
		pointer-events: none;
		transition: opacity 240ms ease;
		cursor: pointer;
	}

	.frame-hint--on {
		opacity: 0.85;
		pointer-events: auto;
	}

	.frame-hint--left { top: 50%; left: 10px; transform: translateY(-50%); }
	.frame-hint--right { top: 50%; right: 10px; transform: translateY(-50%); }
	.frame-hint--up { top: 10px; left: 50%; transform: translateX(-50%); }
	.frame-hint--down { bottom: 10px; left: 50%; transform: translateX(-50%); }

	.frame-hints:not(.frame-hints--mobile):not(.frame-hints--present) .frame-hint--up {
		top: 56px;
	}

	.frame-hints:not(.frame-hints--mobile):not(.frame-hints--present) .frame-hint--down {
		bottom: 64px;
	}

	.frame-hints--mobile:not(.frame-hints--present) .frame-hint--down {
		bottom: calc(118px + env(safe-area-inset-bottom, 0px));
	}

	.frame-hints--present .frame-hint--down {
		bottom: calc(68px + env(safe-area-inset-bottom, 0px));
	}

	@media (prefers-reduced-motion: reduce) {
		.frame-nav,
		.frame-hint,
		.frame-map-cell {
			transition: none;
		}
	}
</style>
