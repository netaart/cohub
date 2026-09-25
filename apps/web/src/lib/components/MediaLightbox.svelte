<script lang="ts">
import { imageVariantUrl, mediaPreviewCandidates } from "@neta-art/cohub/media";
import {
	AlertCircle,
	AudioLines,
	ChevronLeft,
	ChevronRight,
	Download,
	Film,
	Image as ImageIcon,
	Info,
	Loader2,
	X,
	ZoomIn,
	ZoomOut,
} from "lucide-svelte";
import { untrack } from "svelte";
import { innerHeight, innerWidth } from "svelte/reactivity/window";
import AudioPlayer from "$lib/components/AudioPlayer.svelte";
import ImageViewer from "$lib/components/ImageViewer.svelte";
import MediaImage from "$lib/components/MediaImage.svelte";
import {
	type MediaItem,
	mediaLightbox,
} from "$lib/components/media-lightbox.svelte";
import {
	createGallerySwipe,
	type GallerySwipeOffset,
} from "$lib/gestures/gallery-swipe";
import {
	clampImageZoom,
	IMAGE_MAX_ZOOM,
	IMAGE_MIN_ZOOM,
	IMAGE_ZOOM_STEP,
} from "$lib/gestures/image-gesture";
import { getLocale } from "$lib/i18n/locale.svelte";
import { screenVariantSize } from "$lib/media/media-info";
import { downloadMedia } from "$lib/media-download";
import { EASE_OUT } from "$lib/motion.svelte";
import { m } from "$lib/paraglide/messages.js";

const SLIDE_GAP_PX = 16;
const SETTLE_MS = 220;
/** Bottom band of a video that belongs to its native controls. */
const VIDEO_CONTROLS_PX = 56;
const DISMISS_FADE_PX = 400;
/** Movement that turns a press into a drag, so its click can't close. */
const CLICK_SLOP_PX = 6;
/** Past this zoom the screen-sized variant loses detail; load the original. */
const DETAIL_ZOOM = 1.5;
const AUDIO_COVER_PX = 240;

const locale = $derived(getLocale());
const current = $derived(mediaLightbox.current);
const index = $derived(mediaLightbox.index);
const total = $derived(mediaLightbox.items.length);
const currentSource = $derived(mediaLightbox.source(index));
/** The current slide plus its neighbours, which double as preloads. */
const slides = $derived(
	[index - 1, index, index + 1].filter((slot) => slot >= 0 && slot < total),
);

let rootEl = $state<HTMLDivElement | null>(null);
let stageEl = $state<HTMLDivElement | null>(null);
let zoom = $state(1);
let panX = $state(0);
let panY = $state(0);
let offset = $state<GallerySwipeOffset>({ x: 0, y: 0 });
let settling = $state(false);
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let settleDone: (() => void) | null = null;
let downloading = $state(false);
let press: { x: number; y: number } | null = null;
/** The current image shows its original (zoomed in, or the variant failed). */
let detail = $state(false);
/** Even the original failed to load. */
let broken = $state(false);

const stageSize = $derived(
	screenVariantSize(
		Math.max(innerWidth.current ?? 0, innerHeight.current ?? 0),
	),
);

/** Screen-sized stills for `item`, most faithful first. */
function previews(item: MediaItem, src?: string) {
	return mediaPreviewCandidates(
		{ type: item.type, url: src, previewUrl: item.poster },
		{ size: stageSize },
	);
}

function imageSrc(src: string) {
	return detail ? src : (imageVariantUrl(src, stageSize) ?? src);
}

/** A failed variant retries as the original; a failed original is final. */
function imageFailed(src: string) {
	if (imageSrc(src) === src) broken = true;
	else detail = true;
}

function aspect(item: MediaItem) {
	return item.width && item.height
		? `${item.width} / ${item.height}`
		: undefined;
}

const imageReady = $derived(
	current?.type === "image" && currentSource.status === "ready",
);
const zoomed = $derived(imageReady && zoom > 1);
const trackStyle = $derived(
	`transform: translate3d(${offset.x}px, ${offset.y}px, 0); transition: ${settling ? `transform ${SETTLE_MS}ms ${EASE_OUT}` : "none"};`,
);
const backdropOpacity = $derived(
	1 - Math.min(0.6, Math.max(0, offset.y) / DISMISS_FADE_PX),
);

// ─── Navigation ───

/** Jump an in-flight settle to its end, so quick input is never dropped. */
function finishSettle() {
	if (settleTimer) clearTimeout(settleTimer);
	const done = settleDone;
	settleTimer = null;
	settleDone = null;
	settling = false;
	done?.();
	offset = { x: 0, y: 0 };
}

function reducedMotion() {
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Animate the track to `target`, then run `done` and rest at zero. */
function settle(target: GallerySwipeOffset, done?: () => void) {
	finishSettle();
	settleDone = done ?? null;
	if (reducedMotion()) return finishSettle();
	settling = true;
	offset = target;
	settleTimer = setTimeout(finishSettle, SETTLE_MS);
}

function step(direction: -1 | 1) {
	finishSettle();
	if (zoomed) return;
	if (direction < 0 ? !mediaLightbox.hasPrev : !mediaLightbox.hasNext) return;
	const width = (stageEl?.clientWidth ?? 0) + SLIDE_GAP_PX;
	settle({ x: -direction * width, y: 0 }, () =>
		mediaLightbox.go(mediaLightbox.index + direction),
	);
}

function openDetails(item: MediaItem) {
	const onDetails = item.onDetails;
	mediaLightbox.close();
	onDetails?.();
}

// ─── Gestures ───

function canSwipeFrom(event: PointerEvent) {
	if (zoomed) return false;
	const target = event.target instanceof Element ? event.target : null;
	if (target?.closest("button, a, input")) return false;
	const video = target?.closest("video");
	return (
		!video ||
		event.clientY < video.getBoundingClientRect().bottom - VIDEO_CONTROLS_PX
	);
}

const swipe = createGallerySwipe({
	canStart: canSwipeFrom,
	canPrev: () => mediaLightbox.hasPrev,
	canNext: () => mediaLightbox.hasNext,
	onMove: (next) => {
		offset = next;
	},
	onEnd: (outcome) => {
		if (outcome === "dismiss") mediaLightbox.close();
		else if (outcome) step(outcome === "prev" ? -1 : 1);
		else settle({ x: 0, y: 0 });
	},
});

function onPointerDown(event: PointerEvent) {
	press = { x: event.clientX, y: event.clientY };
	finishSettle();
	swipe.onPointerDown(event);
}

/**
 * Hit-test by coordinates: the image stage captures the pointer, so the click
 * targets the stage rather than the image under the finger.
 */
function hitsMedia(x: number, y: number) {
	const media = stageEl?.querySelector("[data-active-slide] :is(img, video)");
	const rect = media?.getBoundingClientRect();
	return (
		!!rect &&
		x >= rect.left &&
		x <= rect.right &&
		y >= rect.top &&
		y <= rect.bottom
	);
}

/** Close on taps outside the media; drags and content taps keep it open. */
function onClick(event: MouseEvent) {
	const { clientX: x, clientY: y } = event;
	if (press && Math.hypot(x - press.x, y - press.y) > CLICK_SLOP_PX) return;
	const target = event.target instanceof Element ? event.target : null;
	if (target?.closest("button, a, input, [data-lightbox-content]")) return;
	if (hitsMedia(x, y)) return;
	mediaLightbox.close();
}

// ─── Zoom ───

function setZoom(next: number) {
	zoom = clampImageZoom(next);
	panX = 0;
	panY = 0;
}

// ─── Download ───

async function download() {
	const item = current;
	const source = currentSource;
	if (!item || source.status !== "ready" || downloading) return;
	downloading = true;
	try {
		await downloadMedia({ ...item, src: source.src });
	} finally {
		downloading = false;
	}
}

// ─── Lifecycle ───

// Fresh view per item.
$effect(() => {
	void mediaLightbox.index;
	void mediaLightbox.open;
	zoom = 1;
	panX = 0;
	panY = 0;
	detail = false;
	broken = false;
});

$effect(() => {
	if (zoom > DETAIL_ZOOM) detail = true;
});

// Resolve on-demand sources for the visible window.
$effect(() => {
	const visible = slides;
	untrack(() => {
		for (const slot of visible) mediaLightbox.load(slot);
	});
});

$effect(() => {
	if (!mediaLightbox.open) return;
	const original = document.body.style.overflow;
	document.body.style.overflow = "hidden";
	return () => {
		document.body.style.overflow = original;
		settleDone = null;
		finishSettle();
		swipe.reset();
	};
});

// Focus the dialog while open and hand focus back on close.
$effect(() => {
	const root = rootEl;
	if (!root) return;
	const previous =
		document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;
	root.focus({ preventScroll: true });
	return () => previous?.focus({ preventScroll: true });
});

$effect(() => {
	if (!mediaLightbox.open) return;
	function onKey(event: KeyboardEvent) {
		// Focused controls (seek and volume sliders, native video) own their keys.
		const target = event.target instanceof Element ? event.target : null;
		if (
			event.key !== "Escape" &&
			target?.closest("input, textarea, select, video, [contenteditable]")
		)
			return;
		switch (event.key) {
			case "Escape":
				mediaLightbox.close();
				break;
			case "ArrowLeft":
				step(-1);
				break;
			case "ArrowRight":
				step(1);
				break;
			case "+":
			case "=":
				if (!imageReady) return;
				setZoom(zoom + IMAGE_ZOOM_STEP);
				break;
			case "-":
			case "_":
				if (!imageReady) return;
				setZoom(zoom - IMAGE_ZOOM_STEP);
				break;
			case "0":
				if (!imageReady) return;
				setZoom(1);
				break;
			default:
				return;
		}
		event.preventDefault();
	}
	window.addEventListener("keydown", onKey);
	return () => window.removeEventListener("keydown", onKey);
});
</script>

{#snippet control(label: string, onclick: () => void, Icon: typeof X)}
	<button type="button" class="control" {onclick} title={label} aria-label={label}>
		<Icon class="h-[18px] w-[18px]" />
	</button>
{/snippet}

{#snippet pending(item: MediaItem)}
	<MediaImage candidates={previews(item)} loading="eager" class="max-h-full max-w-full object-contain opacity-60 select-none" />
	<Loader2 class="absolute h-6 w-6 animate-spin text-overlay-control-text" />
{/snippet}

{#snippet failed()}
	<div class="flex flex-col items-center gap-3 px-6 text-center" data-lightbox-content>
		<AlertCircle class="h-6 w-6 text-overlay-control-text opacity-70" />
		<p class="text-[13px] leading-5 text-overlay-control-text">{m.media_load_failed({}, { locale })}</p>
	</div>
{/snippet}

{#snippet slide(item: MediaItem, slot: number)}
	{@const active = slot === index}
	{@const source = mediaLightbox.source(slot)}
	{#if item.type === "audio"}
		<div class="flex w-full max-w-md flex-col items-center gap-5 px-4" data-lightbox-content>
			<div class="flex aspect-square w-[min(240px,32vh)] items-center justify-center overflow-hidden rounded-xl bg-overlay-control">
				<MediaImage
					candidates={mediaPreviewCandidates(
						{ type: "audio", previewUrl: item.poster },
						{ size: screenVariantSize(AUDIO_COVER_PX), fit: "cover" },
					)}
					loading="eager"
					class="h-full w-full object-cover"
				>
					{#snippet fallback()}
						<AudioLines class="h-10 w-10 text-overlay-control-text opacity-50" />
					{/snippet}
				</MediaImage>
			</div>
			{#if source.status === "ready"}
				<AudioPlayer src={source.src} title={item.alt ?? item.title} autoplay={active} />
			{:else if source.status === "loading"}
				<Loader2 class="h-6 w-6 animate-spin text-overlay-control-text" />
			{:else}
				{@render failed()}
			{/if}
		</div>
	{:else if source.status === "loading"}
		{@render pending(item)}
	{:else if source.status === "error"}
		{@render failed()}
	{:else if item.type === "image" && active && broken}
		{@render failed()}
	{:else if item.type === "image" && active}
		<ImageViewer
			src={imageSrc(source.src)}
			alt={item.alt ?? ""}
			bind:zoom
			bind:panX
			bind:panY
			class="self-stretch"
			onerror={() => imageFailed(source.src)}
		/>
	{:else if active && item.type === "video"}
		<!-- svelte-ignore a11y_media_has_caption: Generated and shared videos carry no caption tracks. -->
		<video
			src={source.src}
			poster={previews(item, source.src)[0]}
			controls
			autoplay
			playsinline
			aria-label={item.alt ?? m.media_preview({}, { locale })}
			class="max-h-full max-w-full"
			style:aspect-ratio={aspect(item)}
		></video>
	{:else}
		<!-- Neighbours show stills only: no decoders, and the image variant is
		     the one the active slide reuses from cache. Eager, since slides sit
		     offscreen by transform where lazy images never load. -->
		<MediaImage
			candidates={previews(item, source.src)}
			alt={item.alt ?? ""}
			loading="eager"
			class="max-h-full max-w-full object-contain select-none"
		>
			{#snippet fallback()}
				{#if item.type === "video"}
					<Film class="h-8 w-8 text-overlay-control-text opacity-50" />
				{:else}
					<ImageIcon class="h-8 w-8 text-overlay-control-text opacity-50" />
				{/if}
			{/snippet}
		</MediaImage>
	{/if}
{/snippet}

{#if mediaLightbox.open && current}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions: Keys are handled on window; clicks only dismiss. -->
	<div
		bind:this={rootEl}
		class="fixed inset-0 z-[var(--z-lightbox)] flex flex-col outline-none select-none"
		style="touch-action: none;"
		role="dialog"
		aria-modal="true"
		aria-label={m.media_preview({}, { locale })}
		tabindex="-1"
		data-drawer-swipe-ignore
		onpointerdown={onPointerDown}
		onpointermove={swipe.onPointerMove}
		onpointerup={swipe.onPointerUp}
		onpointercancel={swipe.onPointerCancel}
		onclick={onClick}
	>
		<div class="absolute inset-0 bg-overlay-scrim-strong" style:opacity={backdropOpacity} aria-hidden="true"></div>

		<header class="relative z-10 flex h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 items-center gap-2 px-3 pt-[env(safe-area-inset-top)] sm:px-4">
			{#if total > 1}
				<span class="rounded-full bg-overlay-control px-2.5 py-1 font-mono text-[12px] tabular-nums text-overlay-control-text">
					{index + 1} / {total}
				</span>
			{/if}
			<div class="ml-auto flex items-center gap-2">
				{#if imageReady}
					<div class="hidden items-center gap-0.5 rounded-full bg-overlay-control p-1 sm:flex">
						<button type="button" class="zoom-button" onclick={() => setZoom(zoom - IMAGE_ZOOM_STEP)} disabled={zoom <= IMAGE_MIN_ZOOM} title={m.media_zoom_out({}, { locale })} aria-label={m.media_zoom_out({}, { locale })}>
							<ZoomOut class="h-4 w-4" />
						</button>
						<button type="button" class="zoom-button min-w-11 px-1 font-mono text-[12px] tabular-nums" onclick={() => setZoom(1)} title={m.media_reset_zoom({}, { locale })} aria-label={m.media_reset_zoom({}, { locale })}>
							{Math.round(zoom * 100)}%
						</button>
						<button type="button" class="zoom-button" onclick={() => setZoom(zoom + IMAGE_ZOOM_STEP)} disabled={zoom >= IMAGE_MAX_ZOOM} title={m.media_zoom_in({}, { locale })} aria-label={m.media_zoom_in({}, { locale })}>
							<ZoomIn class="h-4 w-4" />
						</button>
					</div>
				{/if}
				{#if currentSource.status === "ready" && !broken}
					<button type="button" class="control" onclick={download} disabled={downloading} title={m.media_download({}, { locale })} aria-label={m.media_download({}, { locale })}>
						{#if downloading}
							<Loader2 class="h-[18px] w-[18px] animate-spin" />
						{:else}
							<Download class="h-[18px] w-[18px]" />
						{/if}
					</button>
				{/if}
				{@render control(m.common_close({}, { locale }), () => mediaLightbox.close(), X)}
			</div>
		</header>

		<div bind:this={stageEl} class="relative min-h-0 flex-1 overflow-hidden">
			<div class="absolute inset-0" style={trackStyle}>
				{#each slides as slot (slot)}
					<div
						class="absolute inset-0 flex items-center justify-center"
						style:transform={`translateX(calc(${slot - index} * (100% + ${SLIDE_GAP_PX}px)))`}
						data-active-slide={slot === index ? "" : undefined}
						aria-hidden={slot !== index}
						inert={slot !== index}
					>
						{@render slide(mediaLightbox.items[slot], slot)}
					</div>
				{/each}
			</div>

			{#if !zoomed}
				{#if mediaLightbox.hasPrev}
					<div class="nav left-2 sm:left-4">
						{@render control(m.media_previous({}, { locale }), () => step(-1), ChevronLeft)}
					</div>
				{/if}
				{#if mediaLightbox.hasNext}
					<div class="nav right-2 sm:right-4">
						{@render control(m.media_next({}, { locale }), () => step(1), ChevronRight)}
					</div>
				{/if}
			{/if}
		</div>

		{#if current.title || current.subtitle || current.onDetails}
			<footer class="relative z-10 mx-auto flex w-full max-w-3xl shrink-0 items-start gap-3 px-4 pt-3 pb-[max(env(safe-area-inset-bottom),16px)]" data-lightbox-content>
				<div class="min-w-0 flex-1 select-text">
					{#if current.title}
						<p class="line-clamp-2 text-[13px] leading-5 text-overlay-control-text" title={current.title}>{current.title}</p>
					{/if}
					{#if current.subtitle}
						<p class="mt-0.5 truncate font-mono text-[11px] leading-4 text-overlay-control-text/60">{current.subtitle}</p>
					{/if}
				</div>
				{#if current.onDetails}
					<button type="button" class="pill shrink-0" onclick={() => openDetails(current)}>
						<Info class="h-3.5 w-3.5" />
						{m.generation_task_details({}, { locale })}
					</button>
				{/if}
			</footer>
		{/if}
	</div>
{/if}

<style>
	.control {
		display: inline-flex;
		height: 36px;
		width: 36px;
		align-items: center;
		justify-content: center;
		border-radius: 999px;
		background: var(--overlay-control-bg);
		color: var(--overlay-control-text);
		transition: background-color 120ms ease;
	}

	.control:hover {
		background: var(--overlay-control-bg-hover);
	}

	.control:disabled {
		opacity: 0.5;
	}

	.zoom-button {
		display: inline-flex;
		height: 28px;
		min-width: 28px;
		align-items: center;
		justify-content: center;
		border-radius: 999px;
		color: var(--overlay-control-text);
		transition: background-color 120ms ease;
	}

	.zoom-button:hover {
		background: var(--overlay-control-bg-hover);
	}

	.zoom-button:disabled {
		opacity: 0.4;
	}

	.nav {
		position: absolute;
		top: 50%;
		z-index: 10;
		transform: translateY(-50%);
	}

	.pill {
		display: inline-flex;
		height: 28px;
		align-items: center;
		gap: 6px;
		border-radius: 999px;
		background: var(--overlay-control-bg);
		padding: 0 12px;
		font-size: 12px;
		color: var(--overlay-control-text);
		transition: background-color 120ms ease;
	}

	.pill:hover {
		background: var(--overlay-control-bg-hover);
	}

	.control:focus-visible,
	.zoom-button:focus-visible,
	.pill:focus-visible {
		outline: 2px solid var(--overlay-control-text);
		outline-offset: 2px;
	}
</style>
