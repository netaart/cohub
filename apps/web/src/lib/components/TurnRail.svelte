<script lang="ts">
import type {
	SessionTurnIndexItem,
	SessionTurnRecord,
} from "@cohub/protocol/model";
import { Loader2 } from "lucide-svelte";
import { onDestroy } from "svelte";
import TurnNavigatorPanel from "$lib/components/TurnNavigatorPanel.svelte";
import { toIntlTag } from "$lib/i18n/format";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

type Marker = {
	turn: SessionTurnIndexItem;
	top: number;
	height: number;
	loaded: boolean;
	current: boolean;
};

type Props = {
	turns: SessionTurnIndexItem[];
	loadedTurns?: SessionTurnRecord[];
	markerPositions?: Record<number, number>;
	markerHeights?: Record<number, number>;
	scrollTop?: number;
	scrollHeight?: number;
	clientHeight?: number;
	bottomOffset?: number;
	olderCount?: number;
	newerCount?: number;
	hasMoreOlder?: boolean;
	hasMoreNewer?: boolean;
	loadingOlder?: boolean;
	loadingNewer?: boolean;
	currentSequence?: number | null;
	loadingSequence?: number | null;
	onJump?: (sequence: number) => void;
	onScrollTo?: (scrollTop: number) => void;
	onScrollCommit?: () => void;
	onLoadOlder?: () => void;
	onLoadNewer?: () => void;
};

let {
	turns,
	loadedTurns = [],
	markerPositions = {},
	markerHeights = {},
	scrollTop = 0,
	scrollHeight = 0,
	clientHeight = 0,
	bottomOffset = 0,
	olderCount = 0,
	newerCount = 0,
	hasMoreOlder = false,
	hasMoreNewer = false,
	loadingOlder = false,
	loadingNewer = false,
	currentSequence = null,
	loadingSequence = null,
	onJump,
	onScrollTo,
	onScrollCommit,
	onLoadOlder,
	onLoadNewer,
}: Props = $props();

const locale = $derived(getLocale());

let navigatorOpen = $state(false);
let railEl = $state<HTMLDivElement | null>(null);
let trackEl = $state<HTMLElement | null>(null);
let thumbEl = $state<HTMLDivElement | null>(null);
let navigatorEl = $state<HTMLDivElement | null>(null);
let dragging = $state(false);
let hoveredSequence = $state<number | null>(null);
let navigatorTop = $state(8);
let navigatorAnchorOffset = $state(42);
let dragOffsetPx = 0;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

const loadedSequences = $derived(
	new Set(loadedTurns.map((turn) => turn.sequence)),
);
const minSequence = $derived(turns.at(0)?.sequence ?? 0);
const maxSequence = $derived(turns.at(-1)?.sequence ?? minSequence);
const span = $derived(Math.max(1, maxSequence - minSequence));
const effectiveCurrent = $derived.by(() => {
	if (currentSequence != null) return currentSequence;
	return loadedTurns.at(-1)?.sequence ?? null;
});
// Content-minimap markers use full rail height (0..100). The scrollbar thumb
// still travels in a shorter usable range so it can represent viewport size.
const markers = $derived.by<Marker[]>(() =>
	turns.map((turn) => ({
		turn,
		top:
			markerPositions[turn.sequence] ??
			((turn.sequence - minSequence) / span) * 100,
		height: markerHeights[turn.sequence] ?? 8,
		loaded: loadedSequences.has(turn.sequence),
		current: effectiveCurrent === turn.sequence,
	})),
);
const maxScroll = $derived(Math.max(0, scrollHeight - clientHeight));
const canScroll = $derived(maxScroll > 1 && clientHeight > 0);
const thumbHeightPercent = $derived.by(() => {
	if (!canScroll || scrollHeight <= 0) return 100;
	return Math.min(64, Math.max(6, (clientHeight / scrollHeight) * 100));
});
const thumbTopPercent = $derived.by(() => {
	if (!canScroll) return 0;
	const range = 100 - thumbHeightPercent;
	return Math.min(range, Math.max(0, (scrollTop / maxScroll) * range));
});
const shouldShow = $derived(
	canScroll ||
		markers.length > 1 ||
		hasMoreOlder ||
		hasMoreNewer ||
		loadingOlder,
);
const navigatorSequence = $derived(hoveredSequence ?? effectiveCurrent);
const navigatorAnchorPercent = $derived.by(() => {
	if (navigatorSequence == null) return 0;
	return (
		markers.find((marker) => marker.turn.sequence === navigatorSequence)?.top ??
		0
	);
});

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

function updateNavigatorPosition() {
	if (!railEl || !navigatorEl) return;
	const railHeight = railEl.getBoundingClientRect().height;
	const panelHeight = navigatorEl.getBoundingClientRect().height;
	if (railHeight <= 0 || panelHeight <= 0) return;

	const anchorY = (railHeight * navigatorAnchorPercent) / 100;
	const minTop = 8;
	const maxTop = Math.max(minTop, railHeight - panelHeight - 8);
	const nextTop = clamp(anchorY - panelHeight * 0.34, minTop, maxTop);
	navigatorTop = nextTop;
	navigatorAnchorOffset = clamp(anchorY - nextTop, 18, panelHeight - 18);
}

function trackScrollTopForClientY(clientY: number, offsetPx: number) {
	if (!trackEl || !canScroll) return scrollTop;
	const rect = trackEl.getBoundingClientRect();
	const thumbHeightPx = (rect.height * thumbHeightPercent) / 100;
	const usableHeight = Math.max(1, rect.height - thumbHeightPx);
	const y = clamp(clientY - rect.top - offsetPx, 0, usableHeight);
	return (y / usableHeight) * maxScroll;
}

function handleScrollPointerMove(event: PointerEvent) {
	onScrollTo?.(trackScrollTopForClientY(event.clientY, dragOffsetPx));
}

function endScrollDrag() {
	if (!dragging) return;
	dragging = false;
	window.removeEventListener("pointermove", handleScrollPointerMove);
	window.removeEventListener("pointerup", endScrollDrag);
	window.removeEventListener("pointercancel", endScrollDrag);
	onScrollCommit?.();
}

function startScrollDrag(event: PointerEvent, fromThumb: boolean) {
	if (!canScroll) return;
	event.preventDefault();
	event.stopPropagation();
	closeNavigator();
	dragging = true;
	if (fromThumb && thumbEl) {
		dragOffsetPx = event.clientY - thumbEl.getBoundingClientRect().top;
	} else if (trackEl) {
		dragOffsetPx =
			(trackEl.getBoundingClientRect().height * thumbHeightPercent) / 200;
	}
	onScrollTo?.(trackScrollTopForClientY(event.clientY, dragOffsetPx));
	window.addEventListener("pointermove", handleScrollPointerMove);
	window.addEventListener("pointerup", endScrollDrag);
	window.addEventListener("pointercancel", endScrollDrag);
}

function statusClass(status: SessionTurnIndexItem["status"]) {
	if (status === "failed") return "bg-error-soft";
	if (status === "running") return "bg-info";
	if (status === "interrupted") return "bg-warning-soft";
	return "bg-text-tertiary";
}

const compactCountFormatter = $derived(
	new Intl.NumberFormat(toIntlTag(locale), { notation: "compact" }),
);

function countLabel(count: number) {
	if (count <= 0) return m.turnrail_more({}, { locale });
	return compactCountFormatter.format(count);
}

function clearCloseTimer() {
	if (!closeTimer) return;
	clearTimeout(closeTimer);
	closeTimer = null;
}

function openNavigatorForSequence(sequence: number) {
	if (dragging) return;
	clearCloseTimer();
	hoveredSequence = sequence;
	navigatorOpen = true;
}

function closeNavigator() {
	clearCloseTimer();
	navigatorOpen = false;
	hoveredSequence = null;
}

function jumpFromNavigator(sequence: number) {
	closeNavigator();
	onJump?.(sequence);
}

function jumpFromMarker(sequence: number) {
	closeNavigator();
	onJump?.(sequence);
}

function scheduleNavigatorClose() {
	clearCloseTimer();
	closeTimer = setTimeout(() => {
		navigatorOpen = false;
		hoveredSequence = null;
		closeTimer = null;
	}, 180);
}

function handleFocusOut(event: FocusEvent) {
	const nextTarget = event.relatedTarget;
	if (nextTarget instanceof Node && railEl?.contains(nextTarget)) return;
	scheduleNavigatorClose();
}

function handleKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") {
		event.stopPropagation();
		closeNavigator();
	}
}

$effect(() => {
	const anchorPercent = navigatorAnchorPercent;
	if (!navigatorOpen || dragging) return;
	const frame = requestAnimationFrame(() => {
		void anchorPercent;
		updateNavigatorPosition();
	});
	return () => cancelAnimationFrame(frame);
});

$effect(() => {
	if (typeof window === "undefined") return;
	window.addEventListener("resize", updateNavigatorPosition);
	return () => window.removeEventListener("resize", updateNavigatorPosition);
});

onDestroy(() => {
	clearCloseTimer();
	window.removeEventListener("pointermove", handleScrollPointerMove);
	window.removeEventListener("pointerup", endScrollDrag);
	window.removeEventListener("pointercancel", endScrollDrag);
});
</script>

{#if shouldShow}
	<div
		bind:this={railEl}
		class="group/rail pointer-events-none absolute right-1 top-0 z-10 hidden w-7 isolate lg:block"
		role="presentation"
		style:bottom={`${bottomOffset}px`}
		onmouseleave={scheduleNavigatorClose}
		onfocusout={handleFocusOut}
		onkeydown={handleKeydown}
	>
		<div class="absolute right-[13.5px] top-0 h-full w-px bg-border-subtle/65 transition-colors duration-150 group-hover/rail:bg-border-subtle"></div>
		{#if canScroll}
			<button
				type="button"
				bind:this={trackEl}
				class="group/scroll pointer-events-auto absolute right-[4px] top-0 z-0 h-full w-5 cursor-pointer rounded-full border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-brand/25"
				aria-label={m.turnrail_scroll({}, { locale })}
				tabindex="-1"
				onpointerdown={(event) =>
					startScrollDrag(
						event,
						event.target instanceof HTMLElement &&
							Boolean(event.target.closest('[data-scroll-thumb]')),
					)}
			>
				<div
					bind:this={thumbEl}
					data-scroll-thumb
					class={`absolute right-[8.5px] w-[3px] rounded-full bg-text-placeholder/35 shadow-[0_0_0_1px_rgba(0,0,0,0.04)] transition-[width,background-color,opacity,box-shadow] duration-150 group-hover/scroll:right-[7.5px] group-hover/scroll:w-[5px] group-hover/scroll:bg-text-tertiary/45 ${dragging ? 'right-[7.5px] w-[5px] bg-brand/70 opacity-100 shadow-[0_0_0_1px_rgba(255,62,0,0.28)]' : 'opacity-80'}`}
					style:top={`${thumbTopPercent}%`}
					style:height={`${thumbHeightPercent}%`}
				></div>
			</button>
		{/if}
		{#if hasMoreOlder || olderCount > 0 || loadingOlder}
			<button
				type="button"
				class="group pointer-events-auto absolute -top-0.5 right-[2px] flex h-6 w-6 items-center justify-center"
				aria-label={olderCount > 0
								? m.turnrail_load_older_n({ count: olderCount }, { locale })
								: m.turnrail_load_older({}, { locale })}
				onclick={() => onLoadOlder?.()}
			>
				<span class="absolute h-4 w-1 rounded-full bg-gradient-to-b from-text-placeholder/55 to-transparent opacity-70 transition-opacity group-hover:opacity-100"></span>
				{#if loadingOlder}
					<Loader2 class="absolute h-3 w-3 animate-spin text-text-tertiary" />
				{:else}
					<span class="absolute -top-0.5 h-1 w-1 rounded-full bg-text-placeholder/70"></span>
					<span class="absolute top-1 h-1 w-1 rounded-full bg-text-placeholder/45"></span>
					<span class="absolute top-2.5 h-1 w-1 rounded-full bg-text-placeholder/25"></span>
				{/if}
				<span class="pointer-events-none absolute right-7 hidden whitespace-nowrap rounded-md border border-border-subtle bg-bg-primary px-2 py-1 text-[10px] text-text-tertiary shadow-[0_6px_20px_rgba(0,0,0,0.18)] group-hover:block">
					{m.turnrail_older_unloaded({ count: countLabel(olderCount) }, { locale })}
				</span>
			</button>
		{/if}
		{#each markers as marker (`${marker.turn.sequence}:${marker.turn.id}`)}
			<button
				type="button"
				class="group pointer-events-auto absolute right-[2px] z-20 flex h-6 w-6 items-start justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
				style:top={`${marker.top}%`}
				aria-label={m.turnrail_jump_turn({ n: marker.turn.sequence }, { locale })}
				onfocus={() => openNavigatorForSequence(marker.turn.sequence)}
				onmouseenter={() => openNavigatorForSequence(marker.turn.sequence)}
				onpointerdown={(event) => event.stopPropagation()}
				onclick={(event) => {
					event.stopPropagation();
					jumpFromMarker(marker.turn.sequence);
				}}
			>
				<span
					role="presentation"
					class={`pointer-events-none block rounded-full ring-1 ring-bg-content/90 transition-[width,opacity,background-color,box-shadow] duration-150 ${statusClass(marker.turn.status)} ${marker.loaded ? 'opacity-85' : 'opacity-35'} ${marker.current ? 'w-3 bg-brand opacity-100 shadow-[0_0_0_3px_rgba(255,62,0,0.20)]' : 'w-1.5 group-hover:w-2.5 group-hover:opacity-100'}`}
					style:height={`${marker.current ? Math.max(12, marker.height) : marker.height}px`}
				></span>
				{#if loadingSequence === marker.turn.sequence}
					<Loader2 class="absolute h-3 w-3 animate-spin text-brand" />
				{/if}
			</button>
		{/each}
		{#if hasMoreNewer || newerCount > 0}
			<button
				type="button"
				class="group pointer-events-auto absolute -bottom-0.5 right-[2px] flex h-6 w-6 items-center justify-center"
				aria-label={newerCount > 0
								? m.turnrail_load_newer_n({ count: newerCount }, { locale })
								: m.turnrail_load_newer({}, { locale })}
				onclick={() => onLoadNewer?.()}
			>
				<span class="absolute h-4 w-1 rounded-full bg-gradient-to-t from-text-placeholder/55 to-transparent opacity-70 transition-opacity group-hover:opacity-100"></span>
				<span class="absolute -bottom-0.5 h-1 w-1 rounded-full bg-text-placeholder/70"></span>
				<span class="absolute bottom-1 h-1 w-1 rounded-full bg-text-placeholder/45"></span>
				<span class="absolute bottom-2.5 h-1 w-1 rounded-full bg-text-placeholder/25"></span>
				<span class="pointer-events-none absolute right-7 hidden whitespace-nowrap rounded-md border border-border-subtle bg-bg-primary px-2 py-1 text-[10px] text-text-tertiary shadow-[0_6px_20px_rgba(0,0,0,0.18)] group-hover:block">
					{m.turnrail_newer_unloaded({ count: countLabel(newerCount) }, { locale })}
				</span>
			</button>
		{/if}
		{#if navigatorOpen && !dragging}
			<div
				bind:this={navigatorEl}
				class="pointer-events-auto absolute right-8 z-50"
				role="presentation"
				style:top={`${navigatorTop}px`}
				onmouseenter={clearCloseTimer}
				onmouseleave={scheduleNavigatorClose}
			>
				<span
					class="pointer-events-none absolute -right-8 h-8 w-8 -translate-y-1/2"
					style:top={`${navigatorAnchorOffset}px`}
					aria-hidden="true"
				></span>
				<TurnNavigatorPanel
					turns={turns}
					currentSequence={hoveredSequence ?? effectiveCurrent}
					hasMoreOlder={hasMoreOlder}
					hasMoreNewer={hasMoreNewer}
					loadingOlder={loadingOlder}
					loadingNewer={loadingNewer}
					onJump={jumpFromNavigator}
					onLoadOlder={onLoadOlder}
					onLoadNewer={onLoadNewer}
				/>
			</div>
		{/if}
	</div>
{/if}
