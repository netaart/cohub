<script lang="ts">
import type { Snippet } from "svelte";
import { prefersReducedMotion } from "svelte/motion";
import { setFilterBarPill } from "$lib/components/list-page/filter-bar";
import type { PagerGlide } from "$lib/gestures/pager";
import { EASE_OUT } from "$lib/motion.svelte";

const {
	label,
	role = "group",
	activeKey = null,
	position = null,
	glide = null,
	leading,
	trailing,
	children,
}: {
	label: string;
	role?: "group" | "tablist" | "navigation";
	activeKey?: string | null;
	position?: number | null;
	glide?: PagerGlide | null;
	leading?: Snippet;
	trailing?: Snippet;
	children: Snippet;
} = $props();

const EDGE_PX = 20;
const KEEP_IN_VIEW_PX = 24;
const PIN_LEADING_MIN_PX = 320;
const PILL_GLIDE: PagerGlide = { duration: 240, easing: EASE_OUT };

let scroller = $state<HTMLDivElement | null>(null);
let group = $state<HTMLDivElement | null>(null);
let pill = $state<HTMLSpanElement | null>(null);
let pillPlaced = false;
let barWidth = $state(0);
const pinLeading = $derived(barWidth === 0 || barWidth >= PIN_LEADING_MIN_PX);
let fadeStart = $state(false);
let fadeEnd = $state(false);
let revealedOnce = false;
let interacted = false;

setFilterBarPill(() => position !== null);

function updateEdges() {
	const el = scroller;
	if (!el) return;
	const max = el.scrollWidth - el.clientWidth;
	fadeStart = el.scrollLeft > 1;
	fadeEnd = max - el.scrollLeft > 1;
}

function revealActive(smooth: boolean) {
	const el = scroller;
	if (!el || activeKey == null) return;
	const chip = el.querySelector<HTMLElement>("[data-active='true']");
	if (!chip) return;
	const start = chip.offsetLeft - KEEP_IN_VIEW_PX;
	const end = chip.offsetLeft + chip.offsetWidth + KEEP_IN_VIEW_PX;
	let next = el.scrollLeft;
	if (start < el.scrollLeft) next = start;
	else if (end > el.scrollLeft + el.clientWidth) next = end - el.clientWidth;
	if (next === el.scrollLeft) return;
	el.scrollTo({
		left: Math.max(0, next),
		behavior: smooth && !prefersReducedMotion.current ? "smooth" : "auto",
	});
}

function settleMotion(value: number) {
	return Number.isInteger(value) ? PILL_GLIDE : null;
}

function placePill(value: number, motion: PagerGlide | null) {
	const chips = group?.querySelectorAll<HTMLElement>("[data-filter-chip]");
	if (!pill || !chips?.length) return;
	const clamped = Math.min(Math.max(value, 0), chips.length - 1);
	const from = chips[Math.floor(clamped)] as HTMLElement;
	const to = chips[Math.ceil(clamped)] as HTMLElement;
	const t = clamped - Math.floor(clamped);
	const x = from.offsetLeft + (to.offsetLeft - from.offsetLeft) * t;
	const width = from.offsetWidth + (to.offsetWidth - from.offsetWidth) * t;
	pill.style.transition =
		motion && pillPlaced && !prefersReducedMotion.current
			? `transform ${motion.duration}ms ${motion.easing}, width ${motion.duration}ms ${motion.easing}`
			: "none";
	pill.style.top = `${from.offsetTop}px`;
	pill.style.height = `${from.offsetHeight}px`;
	pill.style.width = `${width}px`;
	pill.style.transform = `translate3d(${x}px, 0, 0)`;
	pillPlaced = true;
}

function scrollInput(node: HTMLElement) {
	const onPointerDown = () => {
		interacted = true;
	};
	const onWheel = (event: WheelEvent) => {
		if (event.ctrlKey) return;
		if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
		if (node.scrollWidth <= node.clientWidth) return;
		event.preventDefault();
		interacted = true;
		node.scrollLeft += event.deltaY;
	};
	node.addEventListener("wheel", onWheel, { passive: false });
	node.addEventListener("pointerdown", onPointerDown, { passive: true });
	return {
		destroy() {
			node.removeEventListener("wheel", onWheel);
			node.removeEventListener("pointerdown", onPointerDown);
		},
	};
}

function handleKeydown(event: KeyboardEvent) {
	if (event.defaultPrevented) return;
	if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
	const root = (event.currentTarget as HTMLElement | null) ?? null;
	const chips = [
		...(root?.querySelectorAll<HTMLElement>("[data-filter-chip]") ?? []),
	];
	const index = chips.indexOf(document.activeElement as HTMLElement);
	if (index < 0) return;
	const next = chips[index + (event.key === "ArrowRight" ? 1 : -1)];
	if (!next) return;
	event.preventDefault();
	next.focus();
}

$effect(() => {
	const el = scroller;
	if (!el) return;
	updateEdges();
	const observer = new ResizeObserver(() => {
		updateEdges();
		if (!interacted) revealActive(false);
		if (position !== null) placePill(position, settleMotion(position));
	});
	observer.observe(el);
	if (el.firstElementChild) observer.observe(el.firstElementChild);
	return () => observer.disconnect();
});

$effect(() => {
	if (position === null || !pill) return;
	placePill(position, glide ?? settleMotion(position));
});

$effect(() => {
	activeKey;
	if (!scroller) return;
	interacted = false;
	const smooth = revealedOnce;
	revealedOnce = true;
	const frame = requestAnimationFrame(() => revealActive(smooth));
	return () => cancelAnimationFrame(frame);
});
</script>

<div
	class="flex h-11 shrink-0 items-center gap-1.5 px-[var(--list-gutter-x)] lg:h-9"
	bind:clientWidth={barWidth}
>
	{#if leading && pinLeading}
		<div class="flex shrink-0 items-center gap-1">{@render leading()}</div>
		<span class="h-4 w-px shrink-0 bg-border-subtle" aria-hidden="true"></span>
	{/if}
	<div
		bind:this={scroller}
		use:scrollInput
		class="filter-scroll relative min-w-0 flex-1 overflow-x-auto overscroll-x-contain"
		style:--fade-start={fadeStart ? `${EDGE_PX}px` : "0px"}
		style:--fade-end={fadeEnd ? `${EDGE_PX}px` : "0px"}
		onscroll={updateEdges}
	>
		<div class="flex w-max items-center gap-1">
			{#if leading && !pinLeading}
				{@render leading()}
				<span class="mx-0.5 h-4 w-px shrink-0 bg-border-subtle" aria-hidden="true"></span>
			{/if}
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<div
				bind:this={group}
				class="relative flex items-center gap-1"
				{role}
				aria-label={label}
				onkeydown={handleKeydown}
			>
				{#if position !== null}
					<span
						bind:this={pill}
						class="pointer-events-none absolute left-0 rounded-[7px] bg-brand-muted lg:rounded-[6px]"
						aria-hidden="true"
					></span>
				{/if}
				{@render children()}
			</div>
		</div>
	</div>
	{#if trailing}
		<div class="flex shrink-0 items-center gap-1">{@render trailing()}</div>
	{/if}
</div>

<style>
	.filter-scroll {
		scrollbar-width: none;
		mask-image: linear-gradient(
			to right,
			transparent 0,
			#000 var(--fade-start),
			#000 calc(100% - var(--fade-end)),
			transparent 100%
		);
	}

	.filter-scroll::-webkit-scrollbar {
		display: none;
	}
</style>
