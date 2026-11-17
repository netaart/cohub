<script lang="ts">
import { LoaderCircle, Minus, MoveHorizontal, Plus } from "lucide-svelte";
import type {
	PDFDocumentLoadingTask,
	PDFDocumentProxy,
	RenderTask,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { onDestroy, onMount, untrack } from "svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

type PageLayout = {
	page: number;
	width: number;
	height: number;
};

type Props = {
	name: string;
	url?: string | null;
	base64?: string | null;
	version: string;
	isMobile?: boolean;
};

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const SCALE_STEP = 1.2;
const MAX_CANVAS_PIXELS = 16_777_216;
const PAGE_GAP = 16;
// Pre-render roughly one screen beyond the viewport so scrolling stays ahead of
// rendering without materializing many canvases on short mobile pages.
const RENDER_MARGIN_RATIO = 1;
const MIN_RENDER_MARGIN = 400;
// Pages are measured in batches after the first screen is already laid out, so a
// long document paints immediately instead of waiting on every page.
const MEASURE_BATCH = 24;

let {
	name,
	url = null,
	base64 = null,
	version,
	isMobile = false,
}: Props = $props();

const locale = $derived(getLocale());

let viewportElement: HTMLDivElement | null = $state(null);
let pagesElement: HTMLDivElement | null = $state(null);
let viewportWidth = $state(0);
let viewportHeight = $state(0);
let pdfDocument: PDFDocumentProxy | null = $state(null);
let pageLayouts: PageLayout[] = $state([]);
let visiblePages: number[] = $state([]);
let pageNumber = $state(1);
let pageDraft = $state("");
let pageInputFocused = $state(false);
let manualScale = $state(1);
let renderedScale = $state(1);
let fitWidth = $state(true);
let loading = $state(true);
let progress = $state<number | null>(null);
let error = $state<string | null>(null);
let passwordPrompt = $state(false);
let passwordError = $state<string | null>(null);
let passwordValue = $state("");
let passwordInput: HTMLInputElement | null = $state(null);
let passwordSubmit: ((password: string) => void) | null = null;
let loadAttempt = $state(0);
let loadGeneration = 0;
let layoutGeneration = 0;
let loadingTask: PDFDocumentLoadingTask | null = null;
const canvases = new Map<number, HTMLCanvasElement>();
const renderTasks = new Map<number, RenderTask>();
const renderedScales = new Map<number, number>();
/** Content-space top offset of each page, so scrolling never measures the DOM. */
let pageOffsets: number[] = [];
let mountVersion = $state(0);

// Keep the control bar out of the reader's way: it shows on first paint, on
// pointer / scroll activity, and for keyboard focus, then fades when idle.
const CONTROLS_IDLE_MS = 1800;
let controlsRevealed = $state(true);
let controlsIdleTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleControlsIdle() {
	if (controlsIdleTimer) clearTimeout(controlsIdleTimer);
	controlsIdleTimer = setTimeout(() => {
		controlsRevealed = false;
		controlsIdleTimer = null;
	}, CONTROLS_IDLE_MS);
}

function noteControlsActivity() {
	controlsRevealed = true;
	scheduleControlsIdle();
}

onMount(scheduleControlsIdle);
onDestroy(() => {
	if (controlsIdleTimer) clearTimeout(controlsIdleTimer);
});

const sourceKey = $derived(
	`${version}:${url ?? `inline:${base64?.length ?? 0}`}`,
);
const pageCount = $derived(pageLayouts.length);
const pageInputValue = $derived(
	pageInputFocused ? pageDraft : String(pageNumber),
);

function commitPage() {
	const parsed = Number.parseInt(pageDraft, 10);
	if (Number.isFinite(parsed)) goToPage(parsed);
	pageDraft = String(pageNumber);
}

function clampScale(value: number) {
	return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

function decodeBase64(value: string) {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function readableLoadError(cause: unknown) {
	const errorName =
		cause && typeof cause === "object" && "name" in cause
			? String(cause.name)
			: "";
	if (errorName === "InvalidPDFException")
		return "This PDF is damaged or invalid.";
	if (errorName === "MissingPDFException")
		return "This PDF is no longer available.";
	if (errorName === "UnexpectedResponseException")
		return "The PDF could not be downloaded.";
	return "The PDF could not be opened.";
}

function cancelRenders() {
	for (const task of renderTasks.values()) task.cancel();
	renderTasks.clear();
	renderedScales.clear();
}

function releaseCanvas(canvas: HTMLCanvasElement) {
	canvas.width = 1;
	canvas.height = 1;
}

function disposeDocument() {
	layoutGeneration += 1;
	cancelRenders();
	for (const canvas of canvases.values()) releaseCanvas(canvas);
	canvases.clear();
	pageLayouts = [];
	pageOffsets = [];
	visiblePages = [];

	const task = loadingTask;
	const document = pdfDocument;
	loadingTask = null;
	pdfDocument = null;
	if (task) void task.destroy();
	else if (document) void document.cleanup();
}

async function openPdf(
	generation: number,
	sourceUrl: string | null,
	sourceBase64: string | null,
) {
	loading = true;
	progress = null;
	error = null;
	passwordPrompt = false;
	passwordError = null;
	passwordValue = "";
	passwordSubmit = null;
	pageNumber = 1;
	fitWidth = true;
	manualScale = 1;
	renderedScale = 1;

	try {
		const pdfjs = await import("pdfjs-dist");
		if (generation !== loadGeneration) return;
		pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

		if (!sourceUrl && !sourceBase64) {
			throw new Error("PDF source is unavailable.");
		}
		const source = sourceUrl
			? { url: sourceUrl }
			: { data: decodeBase64(sourceBase64 ?? "") };
		const task = pdfjs.getDocument({
			...source,
			enableXfa: false,
			canvasMaxAreaInBytes: MAX_CANVAS_PIXELS * 4,
		});
		loadingTask = task;
		task.onProgress = ({ percent }: { percent: number }) => {
			if (generation !== loadGeneration || !Number.isFinite(percent)) return;
			progress = Math.min(100, Math.max(0, Math.round(percent)));
		};
		task.onPassword = (
			updatePassword: (password: string) => void,
			reason: number,
		) => {
			if (generation !== loadGeneration) return;
			passwordSubmit = updatePassword;
			passwordError =
				reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD
					? "Incorrect password."
					: null;
			passwordPrompt = true;
			loading = false;
		};

		const document = await task.promise;
		if (generation !== loadGeneration) {
			await task.destroy();
			return;
		}
		pdfDocument = document;
		passwordPrompt = false;
		passwordSubmit = null;
		loading = false;
	} catch (cause) {
		if (generation !== loadGeneration) return;
		error = readableLoadError(cause);
		loading = false;
	}
}

function calculateScale(firstPageWidth: number) {
	if (!fitWidth) return clampScale(manualScale);
	const horizontalPadding = isMobile ? 16 : 32;
	const availableWidth = Math.max(160, viewportWidth - horizontalPadding);
	return clampScale(availableWidth / firstPageWidth);
}

/** Distance from the scroll container's top to the page stack's first pixel. */
function contentTop() {
	const viewport = viewportElement;
	const pages = pagesElement;
	if (!viewport || !pages) return 0;
	return (
		pages.getBoundingClientRect().top -
		viewport.getBoundingClientRect().top +
		viewport.scrollTop
	);
}

function rebuildOffsets(layouts: PageLayout[]) {
	const offsets = new Array<number>(layouts.length);
	let top = 0;
	for (let index = 0; index < layouts.length; index += 1) {
		offsets[index] = top;
		top += (layouts[index]?.height ?? 0) + PAGE_GAP;
	}
	pageOffsets = offsets;
}

/**
 * Publish a layout set, keeping `anchorPage` visually still.
 *
 * Page heights change on zoom and again as batches are measured, so the scroll
 * position is re-derived from the offsets rather than read back from the DOM.
 */
function applyLayouts(
	layouts: PageLayout[],
	scale: number,
	anchor: { page: number; offset: number },
) {
	const previousTop = pageOffsets[anchor.page - 1];
	pageLayouts = layouts;
	rebuildOffsets(layouts);
	renderedScale = scale;
	const nextTop = pageOffsets[anchor.page - 1];
	if (viewportElement && previousTop !== undefined && nextTop !== undefined) {
		viewportElement.scrollTop = contentTop() + nextTop - anchor.offset;
	}
	updateVisiblePages();
}

async function buildPageLayouts(document: PDFDocumentProxy) {
	const generation = ++layoutGeneration;
	const anchorPage = pageNumber;
	const anchorTop = pageOffsets[anchorPage - 1];
	const anchor = {
		page: anchorPage,
		offset:
			viewportElement && anchorTop !== undefined
				? contentTop() + anchorTop - viewportElement.scrollTop
				: 0,
	};

	try {
		const firstPage = await document.getPage(1);
		if (generation !== layoutGeneration) return;
		const firstViewport = firstPage.getViewport({ scale: 1 });
		const scale = calculateScale(firstViewport.width);
		const first: PageLayout = {
			page: 1,
			width: Math.floor(firstViewport.width * scale),
			height: Math.floor(firstViewport.height * scale),
		};
		// Most documents are uniform, so the first page is a good provisional size
		// for the rest. This paints the first screen without touching every page;
		// the real sizes land batch by batch below.
		const layouts: PageLayout[] = Array.from(
			{ length: document.numPages },
			(_, index) => ({ ...first, page: index + 1 }),
		);
		cancelRenders();
		applyLayouts(layouts, scale, anchor);

		let pending = 0;
		for (let page = 2; page <= document.numPages; page += 1) {
			const viewport = (await document.getPage(page)).getViewport({ scale });
			if (generation !== layoutGeneration) return;
			const width = Math.floor(viewport.width);
			const height = Math.floor(viewport.height);
			const current = layouts[page - 1];
			if (!current || (current.width === width && current.height === height))
				continue;
			layouts[page - 1] = { page, width, height };
			// The provisional canvas was sized for the wrong page box.
			renderedScales.delete(page);
			pending += 1;
			if (pending >= MEASURE_BATCH) {
				pending = 0;
				applyLayouts([...layouts], scale, anchor);
			}
		}
		if (pending > 0) applyLayouts([...layouts], scale, anchor);
	} catch (cause) {
		if (generation !== layoutGeneration) return;
		console.error("PDF layout failed", cause);
		error = "This PDF could not be laid out.";
	}
}

async function renderPage(
	pageNumber: number,
	canvas: HTMLCanvasElement,
	scale: number,
) {
	const document = pdfDocument;
	const layout = pageLayouts[pageNumber - 1];
	if (!document || !layout || renderTasks.has(pageNumber)) return;
	renderedScales.set(pageNumber, scale);
	try {
		const page = await document.getPage(pageNumber);
		if (canvases.get(pageNumber) !== canvas) return;
		const viewport = page.getViewport({ scale });
		const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
		const maxOutputScale = Math.sqrt(
			MAX_CANVAS_PIXELS / Math.max(1, viewport.width * viewport.height),
		);
		const outputScale = Math.min(pixelRatio, maxOutputScale);
		canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
		canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
		canvas.style.width = `${layout.width}px`;
		canvas.style.height = `${layout.height}px`;
		const task = page.render({
			canvas,
			viewport,
			transform:
				outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
		});
		renderTasks.set(pageNumber, task);
		try {
			await task.promise;
		} finally {
			// Only retract our own entry: a cancelled generation may already have
			// started a replacement render for this page.
			if (renderTasks.get(pageNumber) === task) renderTasks.delete(pageNumber);
		}
	} catch (cause) {
		const errorName =
			cause && typeof cause === "object" && "name" in cause
				? String(cause.name)
				: "";
		if (errorName !== "RenderingCancelledException") {
			renderedScales.delete(pageNumber);
			console.error(`PDF page ${pageNumber} render failed`, cause);
		}
	}
}

function mountCanvas(canvas: HTMLCanvasElement, page: number) {
	canvases.set(page, canvas);
	mountVersion += 1;
	return {
		destroy() {
			if (canvases.get(page) !== canvas) return;
			renderTasks.get(page)?.cancel();
			renderTasks.delete(page);
			renderedScales.delete(page);
			canvases.delete(page);
			releaseCanvas(canvas);
		},
	};
}

/** Index of the last page whose top offset is at or above `top`. */
function pageIndexAt(top: number) {
	let low = 0;
	let high = pageOffsets.length - 1;
	while (low < high) {
		const middle = (low + high + 1) >> 1;
		if ((pageOffsets[middle] ?? 0) <= top) low = middle;
		else high = middle - 1;
	}
	return low;
}

function updateVisiblePages() {
	const viewport = viewportElement;
	if (!viewport || pageLayouts.length === 0) return;
	const height = viewport.clientHeight;
	const renderMargin = Math.max(
		MIN_RENDER_MARGIN,
		height * RENDER_MARGIN_RATIO,
	);
	// Everything below is arithmetic over cached offsets, so scrolling a thousand
	// page document costs the same as scrolling a two page one.
	const scrollTop = viewport.scrollTop - contentTop();
	const renderTop = scrollTop - renderMargin;
	const renderBottom = scrollTop + height + renderMargin;
	const viewportCenter = scrollTop + height / 2;
	const nextVisible: number[] = [];
	let nearestPage = pageNumber;
	let nearestDistance = Number.POSITIVE_INFINITY;

	for (
		let index = pageIndexAt(renderTop);
		index < pageLayouts.length;
		index += 1
	) {
		const layout = pageLayouts[index];
		const top = pageOffsets[index];
		if (!layout || top === undefined || top > renderBottom) break;
		if (top + layout.height < renderTop) continue;
		nextVisible.push(layout.page);
		const distance = Math.abs(top + layout.height / 2 - viewportCenter);
		if (distance < nearestDistance) {
			nearestDistance = distance;
			nearestPage = layout.page;
		}
	}
	visiblePages = nextVisible;
	pageNumber = nearestPage;
}

function goToPage(page: number) {
	if (pageLayouts.length < 1) return;
	const target = Math.min(pageLayouts.length, Math.max(1, Math.round(page)));
	pageNumber = target;
	const top = pageOffsets[target - 1];
	// Offsets cover unmounted pages too, so a jump does not depend on rendering.
	if (viewportElement && top !== undefined) {
		viewportElement.scrollTop = contentTop() + top;
	}
}

function zoomBy(factor: number) {
	fitWidth = false;
	manualScale = clampScale(renderedScale * factor);
}

function fitPageWidth() {
	fitWidth = true;
}

function submitPassword(event: SubmitEvent) {
	event.preventDefault();
	const password = passwordValue;
	if (!password || !passwordSubmit) return;
	passwordPrompt = false;
	loading = true;
	passwordSubmit(password);
	passwordSubmit = null;
	passwordValue = "";
}

$effect(() => {
	const element = viewportElement;
	if (!element) return;
	const updateSize = () => {
		viewportWidth = Math.floor(element.clientWidth);
		viewportHeight = Math.floor(element.clientHeight);
	};
	updateSize();
	const observer = new ResizeObserver(updateSize);
	observer.observe(element);
	return () => observer.disconnect();
});

$effect(() => {
	viewportHeight;
	updateVisiblePages();
});

$effect(() => {
	if (passwordPrompt) passwordInput?.focus();
});

$effect(() => {
	sourceKey;
	loadAttempt;
	const sourceUrl = url;
	const sourceBase64 = base64;
	const generation = ++loadGeneration;
	untrack(() => {
		disposeDocument();
		void openPdf(generation, sourceUrl, sourceBase64);
	});
	return () => {
		if (generation !== loadGeneration) return;
		loadGeneration += 1;
		disposeDocument();
	};
});

$effect(() => {
	const document = pdfDocument;
	const width = viewportWidth;
	fitWidth;
	manualScale;
	if (!document || width <= 0) return;
	void buildPageLayouts(document);
});

$effect(() => {
	const document = pdfDocument;
	const scale = renderedScale;
	const pages = visiblePages;
	mountVersion;
	if (!document || pages.length === 0) return;
	untrack(() => {
		for (const page of pages) {
			const canvas = canvases.get(page);
			if (!canvas) continue;
			if (renderedScales.get(page) === scale) continue;
			void renderPage(page, canvas, scale);
		}
	});
});
</script>

<div
	class="pdf-root relative h-full min-h-0 w-full overflow-hidden bg-bg-primary"
	role="region"
	aria-label={`PDF preview: ${name}`}
	onpointermove={noteControlsActivity}
	onpointerdown={noteControlsActivity}
>
	<div
		bind:this={viewportElement}
		class="h-full overflow-auto overscroll-contain px-2 py-2 sm:px-4 sm:py-4"
		onscroll={() => {
			updateVisiblePages();
			noteControlsActivity();
		}}
	>
		<div
			bind:this={pagesElement}
			class="flex min-h-full min-w-full flex-col items-center"
			style={`gap: ${PAGE_GAP}px`}
		>
			{#each pageLayouts as layout (layout.page)}
				<div
					class="pdf-page relative shrink-0 bg-bg-surface shadow-md"
					style={`width: ${layout.width}px; height: ${layout.height}px`}
					aria-label={`Page ${layout.page} of ${pageCount}`}
				>
					{#if visiblePages.includes(layout.page)}
						<canvas use:mountCanvas={layout.page}></canvas>
					{/if}
				</div>
			{/each}
		</div>
	</div>

	{#if loading}
		<div class="pointer-events-none absolute inset-0 flex items-center justify-center bg-bg-primary/80">
			<div class="flex items-center gap-2 text-xs text-text-tertiary" role="status">
				<LoaderCircle class="h-4 w-4 animate-spin" />
				<span>{progress === null ? "Loading PDF…" : `Loading PDF · ${progress}%`}</span>
			</div>
		</div>
	{:else if passwordPrompt}
		<div class="absolute inset-0 flex items-center justify-center bg-bg-primary/90 p-4">
			<form
				class="w-full max-w-xs rounded-md border border-border-subtle bg-bg-surface p-4 shadow-lg"
				onsubmit={submitPassword}
			>
				<label for="pdf-password" class="block text-xs font-medium text-text-primary">
					{m.pdf_password_protected({}, { locale })}
				</label>
				{#if passwordError}
					<div class="mt-1 text-[11px] text-error-soft">{passwordError}</div>
				{/if}
				<div class="mt-3 flex gap-2">
					<input
						bind:this={passwordInput}
						id="pdf-password"
						type="password"
						bind:value={passwordValue}
						autocomplete="off"
						class="h-8 min-w-0 flex-1 rounded-md border border-border-subtle bg-bg-input px-2.5 text-xs text-text-primary focus:border-brand/50 focus:outline-none"
						placeholder={m.pdf_password({}, { locale })}
					/>
					<button type="submit" class="action-btn primary" disabled={!passwordValue}>{m.pdf_open({}, { locale })}</button>
				</div>
			</form>
		</div>
	{:else if error}
		<div class="absolute inset-0 flex items-center justify-center bg-bg-primary/90 p-4">
			<div class="max-w-xs text-center">
				<div class="text-xs text-error-soft">{error}</div>
				<button type="button" class="action-btn mt-3" onclick={() => (loadAttempt += 1)}>{m.common_retry({}, { locale })}</button>
			</div>
		</div>
	{/if}

	{#if pageCount > 0 && !loading && !passwordPrompt && !error}
		<div
			class="pdf-controls"
			data-revealed={controlsRevealed}
			role="group"
			aria-label={m.preview_pages({}, { locale })}
		>
			<input
				class="pdf-controls-input"
				type="text"
				inputmode="numeric"
				aria-label={m.inline_page_number({}, { locale })}
				value={pageInputValue}
				oninput={(event) => (pageDraft = event.currentTarget.value)}
				onfocus={(event) => {
					pageInputFocused = true;
					pageDraft = String(pageNumber);
					event.currentTarget.select();
				}}
				onblur={() => {
					pageInputFocused = false;
					commitPage();
				}}
				onkeydown={(event) => {
					if (event.key === "Enter") event.currentTarget.blur();
				}}
			/>
			<span class="pdf-controls-total">/ {pageCount}</span>
			<span class="pdf-controls-divider"></span>
			<button
				type="button"
				class="pdf-controls-btn"
				title={m.inline_zoom_out({}, { locale })}
				aria-label={m.inline_zoom_out({}, { locale })}
				onclick={() => zoomBy(1 / SCALE_STEP)}
			>
				<Minus class="h-4 w-4" />
			</button>
			<span class="pdf-controls-scale">{Math.round(renderedScale * 100)}%</span>
			<button
				type="button"
				class="pdf-controls-btn"
				title={m.inline_zoom_in({}, { locale })}
				aria-label={m.inline_zoom_in({}, { locale })}
				onclick={() => zoomBy(SCALE_STEP)}
			>
				<Plus class="h-4 w-4" />
			</button>
			<span class="pdf-controls-divider"></span>
			<button
				type="button"
				class="pdf-controls-btn"
				class:active={fitWidth}
				title={m.inline_fit_width({}, { locale })}
				aria-label={m.inline_fit_width({}, { locale })}
				aria-pressed={fitWidth}
				onclick={fitPageWidth}
			>
				<MoveHorizontal class="h-4 w-4" />
			</button>
		</div>
	{/if}
</div>

<style>
	.pdf-page {
		contain: layout paint;
	}

	canvas {
		display: block;
		background: var(--bg-surface);
	}

	.pdf-controls {
		position: absolute;
		bottom: 16px;
		left: 50%;
		z-index: 10;
		display: flex;
		max-width: calc(100% - 24px);
		transform: translateX(-50%);
		align-items: center;
		gap: 2px;
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);
		padding: 4px 6px;
		box-shadow: 0 8px 20px
			color-mix(in srgb, var(--overlay-scrim-strong) 14%, transparent);
		backdrop-filter: blur(12px);
		/* Idle: stay out of the document's way; revealed by activity or focus. */
		opacity: 0;
		pointer-events: none;
		transition: opacity 160ms ease;
	}

	.pdf-controls[data-revealed="true"],
	.pdf-controls:focus-within {
		opacity: 1;
		pointer-events: auto;
	}

	.pdf-controls-input {
		width: 2.5rem;
		height: 1.5rem;
		flex: 0 0 auto;
		border: 1px solid var(--border-subtle);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		text-align: center;
	}

	.pdf-controls-input:focus {
		border-color: color-mix(in srgb, var(--brand) 50%, transparent);
		outline: none;
	}

	.pdf-controls-total,
	.pdf-controls-scale {
		flex: 0 0 auto;
		color: var(--text-tertiary);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}

	.pdf-controls-scale {
		min-width: 2.25rem;
		text-align: center;
	}

	.pdf-controls-divider {
		width: 1px;
		height: 1rem;
		margin-inline: 3px;
		flex: 0 0 auto;
		background: var(--border-subtle);
	}

	.pdf-controls-btn {
		display: inline-flex;
		height: 1.5rem;
		width: 1.5rem;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: var(--text-tertiary);
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.pdf-controls-btn:hover {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	.pdf-controls-btn.active {
		background: var(--bg-hover-strong);
		color: var(--text-secondary);
	}

	@media (pointer: coarse) {
		.pdf-controls {
			bottom: calc(12px + env(safe-area-inset-bottom, 0px));
		}
		.pdf-controls-btn {
			height: 1.75rem;
			width: 1.75rem;
		}
	}
</style>
