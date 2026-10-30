import DOMPurify from "isomorphic-dompurify";
import {
	type Mounted,
	type MountOptions,
	mountAsync,
	type RenderOptions,
	render,
} from "pele/lazy";
import { triggerBlobDownload } from "$lib/browser-download";
import { mediaLightbox } from "$lib/components/media-lightbox.svelte";

export type MermaidLabels = {
	zoomIn: string;
	zoomOut: string;
	resetZoom: string;
	expand: string;
	download: string;
	unavailable: string;
};

const RENDER_OPTIONS = {
	limit: 20_000,
	maxEdges: 1_000,
	images: false,
} satisfies RenderOptions;

const MOUNT_OPTIONS = {
	...RENDER_OPTIONS,
	sanitize,
	zoom: { always: true, controls: false },
} satisfies MountOptions;

const ZOOM_STEP = 1.5;
const ZOOM_EVENTS = ["click", "pointerup", "wheel", "keyup", "gestureend"];

const THEME_VARIABLES = [
	"--pele-bg",
	"--pele-fg",
	"--pele-muted",
	"--pele-line",
	"--pele-surface",
	"--pele-surface-alt",
	"--pele-border",
	"--pele-accent",
	"--pele-critical",
	"--pele-radius",
];

// <img> can't load web fonts.
const EXPORT_FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";
const EXPORT_FONT_MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const PNG_SCALE = 2;
// Stays under iOS Safari's canvas area limit.
const PNG_MAX_PIXELS = 16_000_000;

const ICONS = {
	zoomOut: '<path d="M5 12h14"/>',
	zoomIn: '<path d="M5 12h14M12 5v14"/>',
	reset:
		'<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
	expand:
		'<path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/>',
	download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
};

type Diagram = { mounted: Mounted; canvas: HTMLElement; toolbar: HTMLElement };

const diagrams = new Map<HTMLElement, Diagram>();
let themeObserver: MutationObserver | null = null;
let sweepRequest = 0;

function sanitize(svg: string) {
	const fragment = DOMPurify.sanitize(svg, { RETURN_DOM_FRAGMENT: true });
	for (const link of fragment.querySelectorAll("a[href]")) {
		link.setAttribute("target", "_blank");
		link.setAttribute("rel", "noopener noreferrer");
		link.setAttribute("data-cohub-auto-target", "blank");
	}
	return fragment;
}

function readSource(frame: HTMLElement) {
	return (
		frame.parentElement
			?.querySelector(".markdown-mermaid-source code")
			?.textContent?.trim() ?? ""
	);
}

function showError(frame: HTMLElement, label: string, error?: unknown) {
	frame.dataset.state = "error";
	frame.replaceChildren(label);
	if (!(error instanceof Error)) return;
	const lines = error.message.split("\n").filter((line) => line.trim());
	const detail = document.createElement("div");
	detail.className = "markdown-mermaid-error-detail";
	detail.textContent =
		lines.length > 1 ? `${lines[0]} ${lines.at(-1)}` : (lines[0] ?? "");
	detail.title = error.message;
	frame.append(detail);
}

function createButton(icon: string, label: string, onClick: () => void) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "markdown-mermaid-action";
	button.title = label;
	button.setAttribute("aria-label", label);
	button.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>`;
	button.addEventListener("click", onClick);
	return button;
}

function exportSvg(canvas: HTMLElement, source: string) {
	const style = getComputedStyle(canvas);
	const { svg, width, height } = render(source, {
		...RENDER_OPTIONS,
		responsive: false,
		idPrefix: "diagram",
		fontFamily: EXPORT_FONT,
		fontFamilyMono: EXPORT_FONT_MONO,
	});
	const root = new DOMParser().parseFromString(svg, "image/svg+xml")
		.documentElement as unknown as SVGSVGElement;
	for (const name of THEME_VARIABLES) {
		root.style.setProperty(name, style.getPropertyValue(name).trim());
	}
	root.style.setProperty("--pele-font", EXPORT_FONT);
	root.style.setProperty("--pele-font-mono", EXPORT_FONT_MONO);
	root.style.background = "var(--pele-bg)";
	const markup = new XMLSerializer().serializeToString(root);
	const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
	return { src, width, height };
}

function expand(canvas: HTMLElement, source: string) {
	mediaLightbox.show({
		type: "image",
		...exportSvg(canvas, source),
		filename: "diagram.svg",
		mimeType: "image/svg+xml",
	});
}

async function downloadPng(canvas: HTMLElement, source: string) {
	const { src, width, height } = exportSvg(canvas, source);
	const image = new Image();
	image.src = src;
	await image.decode();
	const scale = Math.min(
		PNG_SCALE,
		Math.sqrt(PNG_MAX_PIXELS / (width * height)),
	);
	const output = document.createElement("canvas");
	output.width = Math.round(width * scale);
	output.height = Math.round(height * scale);
	output.getContext("2d")?.drawImage(image, 0, 0, output.width, output.height);
	const blob = await new Promise<Blob | null>((resolve) =>
		output.toBlob(resolve, "image/png"),
	);
	if (blob) triggerBlobDownload(blob, "diagram.png");
}

function createToolbar(
	canvas: HTMLElement,
	mounted: Mounted,
	labels: MermaidLabels,
) {
	let request = 0;
	const sync = () => {
		cancelAnimationFrame(request);
		request = requestAnimationFrame(() => {
			const zoom = mounted.zoom;
			const zoomed = !!zoom && zoom.scale > zoom.fit * 1.001;
			zoomOut.disabled = !zoomed;
			reset.disabled = !zoomed;
		});
	};
	const zoomBy = (factor: number) => () => {
		mounted.zoom?.zoomBy(factor);
		sync();
	};
	const zoomOut = createButton(
		ICONS.zoomOut,
		labels.zoomOut,
		zoomBy(1 / ZOOM_STEP),
	);
	const reset = createButton(ICONS.reset, labels.resetZoom, () => {
		mounted.zoom?.reset();
		sync();
	});
	const toolbar = document.createElement("div");
	toolbar.className = "markdown-mermaid-actions";
	toolbar.append(
		zoomOut,
		createButton(ICONS.zoomIn, labels.zoomIn, zoomBy(ZOOM_STEP)),
		reset,
		createButton(ICONS.expand, labels.expand, () =>
			expand(canvas, mounted.source),
		),
		createButton(ICONS.download, labels.download, () => {
			downloadPng(canvas, mounted.source).catch((error) =>
				console.warn("[mermaid] PNG export failed", { error }),
			);
		}),
	);
	for (const type of ZOOM_EVENTS) {
		canvas.addEventListener(type, sync, { passive: true });
	}
	sync();
	return toolbar;
}

function takeDetached() {
	const detached = new Map<string, Diagram>();
	for (const [frame, diagram] of diagrams) {
		if (frame.isConnected) continue;
		diagrams.delete(frame);
		const { source } = diagram.mounted;
		if (detached.has(source)) diagram.mounted.destroy();
		else detached.set(source, diagram);
	}
	return detached;
}

function destroyAll(detached: Map<string, Diagram>) {
	for (const diagram of detached.values()) diagram.mounted.destroy();
}

/** Deferred a frame so remounted Markdown can adopt them. */
export function releaseDetachedDiagrams() {
	cancelAnimationFrame(sweepRequest);
	sweepRequest = requestAnimationFrame(() => destroyAll(takeDetached()));
}

function observeTheme() {
	if (themeObserver) return;
	themeObserver = new MutationObserver(() => {
		for (const diagram of diagrams.values()) diagram.mounted.refresh();
	});
	themeObserver.observe(document.documentElement, {
		attributeFilter: ["data-theme"],
	});
}

function adopt(frame: HTMLElement, diagram: Diagram) {
	frame.replaceChildren(diagram.canvas);
	frame.parentElement?.append(diagram.toolbar);
	frame.dataset.state = "ready";
	diagrams.set(frame, diagram);
	diagram.mounted.refresh();
}

async function mount(
	frame: HTMLElement,
	source: string,
	labels: MermaidLabels,
) {
	frame.dataset.state = "rendering";
	const canvas = document.createElement("div");
	canvas.className = "markdown-mermaid-canvas";
	frame.replaceChildren(canvas);

	let mounted: Mounted;
	try {
		mounted = await mountAsync(canvas, source, MOUNT_OPTIONS);
	} catch (error) {
		showError(frame, labels.unavailable, error);
		return;
	}
	if (!frame.isConnected || mounted.error) {
		mounted.destroy();
		if (mounted.error) showError(frame, labels.unavailable, mounted.error);
		return;
	}

	const toolbar = createToolbar(canvas, mounted, labels);
	frame.parentElement?.append(toolbar);
	frame.dataset.state = "ready";
	diagrams.set(frame, { mounted, canvas, toolbar });
	observeTheme();
}

export async function renderMermaidDiagrams(
	frames: Iterable<HTMLElement>,
	labels: MermaidLabels,
) {
	const detached = takeDetached();
	const pending: Promise<void>[] = [];
	for (const frame of frames) {
		if (frame.dataset.state || !frame.isConnected) continue;
		const source = readSource(frame);
		if (!source) continue;
		const diagram = detached.get(source);
		if (diagram) {
			detached.delete(source);
			adopt(frame, diagram);
		} else {
			pending.push(mount(frame, source, labels));
		}
	}
	destroyAll(detached);
	await Promise.all(pending);
}
