import {
	isDarkTheme,
	isResolvedTheme,
	type ResolvedTheme,
	THEME_REGISTRY,
} from "$lib/theme-registry";

type MermaidApi = typeof import("mermaid").default;

const MAX_MERMAID_SOURCE_LENGTH = 12_000;
const MAX_MERMAID_SOURCE_LINES = 240;
const FONT_FAMILY =
	'"Geist Variable", Geist, ui-sans-serif, system-ui, sans-serif';
const EXPORT_FONT_FAMILY =
	'"Geist Variable", Geist, -apple-system, BlinkMacSystemFont, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", ui-sans-serif, system-ui, sans-serif';
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;
const DEFAULT_MAX_WIDTH = 860;
const DEFAULT_MIN_SCALE = 0.72;

let mermaidPromise: Promise<MermaidApi> | null = null;
let renderSeq = 0;
let currentTheme: ResolvedTheme | null = null;

function getMermaid() {
	mermaidPromise ??= import("mermaid").then((module) => module.default);
	return mermaidPromise;
}

function resolveTheme(): ResolvedTheme {
	const theme = document.documentElement.getAttribute("data-theme");
	return isResolvedTheme(theme) ? theme : "dark";
}

function initializeMermaid(mermaid: MermaidApi, theme: ResolvedTheme) {
	if (currentTheme === theme) return;
	currentTheme = theme;
	mermaid.initialize({
		fontFamily: FONT_FAMILY,
		securityLevel: "strict",
		// Mermaid's default error path draws a huge "Syntax error" SVG into the
		// temporary host and can leave it on document.body when render rejects.
		suppressErrorRendering: true,
		startOnLoad: false,
		theme: isDarkTheme(theme) ? "dark" : "default",
		themeVariables: {
			fontFamily: FONT_FAMILY,
			...THEME_REGISTRY[theme].mermaidVariables,
		},
	});
}

function readMermaidSource(element: HTMLElement) {
	const encoded = element.dataset.mermaidSource;
	if (!encoded) return "";
	try {
		return decodeURIComponent(encoded);
	} catch {
		return "";
	}
}

function isMermaidSourceTooLarge(source: string) {
	return (
		source.length > MAX_MERMAID_SOURCE_LENGTH ||
		source.split(/\r?\n/).length > MAX_MERMAID_SOURCE_LINES
	);
}

function getErrorMessage(error: unknown) {
	return error instanceof Error && error.message
		? error.message
		: String(error || "Unknown error");
}

function warnMermaidFailure(message: string, details: Record<string, unknown>) {
	console.warn(`[mermaid] ${message}`, details);
}

function markMermaidUnavailable(element: HTMLElement, error?: unknown) {
	element.dataset.mermaidRendered = "true";
	delete element.dataset.mermaidRenderToken;
	delete element.dataset.mermaidScale;
	element.replaceChildren();
	element.classList.add("is-unavailable");

	const message = document.createElement("div");
	message.className = "markdown-mermaid-error";
	message.textContent = "Diagram preview unavailable";
	element.appendChild(message);

	if (error) {
		const detail = getErrorMessage(error);
		element.title = detail;
		const detailEl = document.createElement("div");
		detailEl.className = "markdown-mermaid-error-detail";
		detailEl.textContent = summarizeMermaidError(detail);
		element.appendChild(detailEl);
	}
}

function summarizeMermaidError(message: string) {
	const compact = message
		.replace(/\s+/g, " ")
		.replace(/^Error:\s*/i, "")
		.trim();
	if (!compact) return "Invalid Mermaid syntax.";
	return compact.length > 160 ? `${compact.slice(0, 157)}…` : compact;
}

function createMermaidRenderHost() {
	const host = document.createElement("div");
	host.className = "markdown-mermaid-render-host";
	host.setAttribute("aria-hidden", "true");
	document.body.appendChild(host);
	return host;
}

function cleanupMermaidArtifacts(
	renderId: string,
	host?: HTMLElement | null,
	preserveRoot?: HTMLElement | null,
) {
	for (const id of [renderId, `d${renderId}`, `i${renderId}`]) {
		const artifact = document.getElementById(id);
		if (artifact && !preserveRoot?.contains(artifact)) artifact.remove();
	}
	host?.remove();
}

function clampScale(scale: number) {
	return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

function getSvgSize(svg: SVGSVGElement) {
	const viewBox = svg.viewBox.baseVal;
	if (viewBox.width > 0 && viewBox.height > 0) {
		return { width: viewBox.width, height: viewBox.height };
	}
	const rect = svg.getBoundingClientRect();
	return {
		width: Math.max(1, rect.width),
		height: Math.max(1, rect.height),
	};
}

function getDefaultScale(svg: SVGSVGElement) {
	const { width } = getSvgSize(svg);
	const fitWidthScale = Math.min(1, DEFAULT_MAX_WIDTH / width);
	return clampScale(Math.max(DEFAULT_MIN_SCALE, fitWidthScale));
}

function getMermaidViewport(element: HTMLElement) {
	return (
		element.querySelector<HTMLElement>(".markdown-mermaid-viewport") ?? element
	);
}

function setMermaidScale(
	element: HTMLElement,
	scale: number,
	anchor?: { clientX: number; clientY: number },
) {
	const svg = element.querySelector<SVGSVGElement>("svg");
	const label = element.querySelector<HTMLElement>("[data-mermaid-zoom-label]");
	if (!svg) return;

	const viewport = getMermaidViewport(element);
	const previousScale = Number(element.dataset.mermaidScale || 1);
	const nextScale = clampScale(scale);
	const { width } = getSvgSize(svg);
	const rect = viewport.getBoundingClientRect();
	const anchorX = anchor ? anchor.clientX - rect.left : rect.width / 2;
	const anchorY = anchor ? anchor.clientY - rect.top : rect.height / 2;
	const scrollX = viewport.scrollLeft + anchorX;
	const scrollY = viewport.scrollTop + anchorY;
	const scaleRatio = previousScale > 0 ? nextScale / previousScale : 1;

	element.dataset.mermaidScale = String(nextScale);
	svg.style.width = `${Math.round(width * nextScale)}px`;
	svg.style.maxWidth = "none";
	svg.style.height = "auto";
	viewport.scrollLeft = Math.max(0, scrollX * scaleRatio - anchorX);
	viewport.scrollTop = Math.max(0, scrollY * scaleRatio - anchorY);
	if (label) label.textContent = `${Math.round(nextScale * 100)}%`;
}

function createMermaidButton(input: {
	label?: string;
	icon?: string;
	title: string;
	onClick: () => void;
}) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "markdown-mermaid-action";
	if (input.icon) button.innerHTML = input.icon;
	else button.textContent = input.label ?? "";
	button.title = input.title;
	button.setAttribute("aria-label", input.title);
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		input.onClick();
	});
	return button;
}

function downloadMermaidSvg(element: HTMLElement) {
	const svg = element.querySelector<SVGSVGElement>("svg");
	if (!svg) return;

	const { width, height } = getSvgSize(svg);
	const clone = svg.cloneNode(true) as SVGSVGElement;
	clone.removeAttribute("style");
	clone.setAttribute("width", String(width));
	clone.setAttribute("height", String(height));
	clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
	clone.setAttribute("font-family", EXPORT_FONT_FAMILY);

	const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
	style.textContent = `
		text, tspan, foreignObject, .nodeLabel, .edgeLabel, .label {
			font-family: ${EXPORT_FONT_FAMILY};
			text-rendering: geometricPrecision;
		}
	`;
	clone.insertBefore(style, clone.firstChild);

	const blob = new Blob([new XMLSerializer().serializeToString(clone)], {
		type: "image/svg+xml;charset=utf-8",
	});
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = "mermaid-diagram.svg";
	document.body.appendChild(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}

const DOWNLOAD_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';

function enhanceMermaidDiagram(element: HTMLElement) {
	const svg = element.querySelector<SVGSVGElement>("svg");
	if (!svg) return;

	const viewport = document.createElement("div");
	viewport.className = "markdown-mermaid-viewport";
	svg.parentNode?.insertBefore(viewport, svg);

	const canvas = document.createElement("div");
	canvas.className = "markdown-mermaid-canvas";
	viewport.appendChild(canvas);
	canvas.appendChild(svg);

	const controls = document.createElement("div");
	controls.className = "markdown-mermaid-actions";
	controls.append(
		createMermaidButton({
			label: "−",
			title: "Zoom out",
			onClick: () =>
				setMermaidScale(
					element,
					Number(element.dataset.mermaidScale || 1) - 0.1,
				),
		}),
	);

	const zoomLabel = document.createElement("button");
	zoomLabel.type = "button";
	zoomLabel.className = "markdown-mermaid-action markdown-mermaid-zoom-label";
	zoomLabel.dataset.mermaidZoomLabel = "";
	zoomLabel.title = "Reset zoom";
	zoomLabel.setAttribute("aria-label", "Reset zoom");
	zoomLabel.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setMermaidScale(element, getDefaultScale(svg));
	});
	controls.append(zoomLabel);

	controls.append(
		createMermaidButton({
			label: "+",
			title: "Zoom in",
			onClick: () =>
				setMermaidScale(
					element,
					Number(element.dataset.mermaidScale || 1) + 0.1,
				),
		}),
		createMermaidButton({
			icon: DOWNLOAD_ICON,
			title: "Download SVG",
			onClick: () => {
				try {
					downloadMermaidSvg(element);
				} catch (error) {
					warnMermaidFailure("diagram download failed", {
						error: getErrorMessage(error),
					});
				}
			},
		}),
	);
	element.appendChild(controls);

	const pointers = new Map<number, { clientX: number; clientY: number }>();
	let panStart: {
		pointerId: number;
		clientX: number;
		clientY: number;
		scrollLeft: number;
		scrollTop: number;
	} | null = null;
	let pinchStart: {
		distance: number;
		scale: number;
		center: { clientX: number; clientY: number };
	} | null = null;

	const getPinchState = () => {
		const [first, second] = [...pointers.values()];
		if (!first || !second) return null;
		return {
			center: {
				clientX: (first.clientX + second.clientX) / 2,
				clientY: (first.clientY + second.clientY) / 2,
			},
			distance: Math.hypot(
				first.clientX - second.clientX,
				first.clientY - second.clientY,
			),
		};
	};

	viewport.addEventListener("pointerdown", (event) => {
		if (event.button !== 0 || event.target instanceof HTMLButtonElement) return;
		event.preventDefault();
		pointers.set(event.pointerId, {
			clientX: event.clientX,
			clientY: event.clientY,
		});
		viewport.setPointerCapture(event.pointerId);

		if (pointers.size === 1) {
			panStart = {
				pointerId: event.pointerId,
				clientX: event.clientX,
				clientY: event.clientY,
				scrollLeft: viewport.scrollLeft,
				scrollTop: viewport.scrollTop,
			};
			viewport.classList.add("is-panning");
			return;
		}

		const state = getPinchState();
		if (!state) return;
		panStart = null;
		pinchStart = {
			...state,
			scale: Number(element.dataset.mermaidScale || 1),
		};
	});

	viewport.addEventListener("pointermove", (event) => {
		if (!pointers.has(event.pointerId)) return;
		event.preventDefault();
		pointers.set(event.pointerId, {
			clientX: event.clientX,
			clientY: event.clientY,
		});

		if (pointers.size >= 2 && pinchStart) {
			const state = getPinchState();
			if (!state || state.distance <= 0 || pinchStart.distance <= 0) return;
			setMermaidScale(
				element,
				pinchStart.scale * (state.distance / pinchStart.distance),
				state.center,
			);
			return;
		}

		if (!panStart || panStart.pointerId !== event.pointerId) return;
		viewport.scrollLeft =
			panStart.scrollLeft - (event.clientX - panStart.clientX);
		viewport.scrollTop =
			panStart.scrollTop - (event.clientY - panStart.clientY);
	});

	const endPointer = (event: PointerEvent) => {
		pointers.delete(event.pointerId);
		if (viewport.hasPointerCapture(event.pointerId)) {
			viewport.releasePointerCapture(event.pointerId);
		}

		pinchStart = null;
		panStart = null;
		viewport.classList.remove("is-panning");

		const [remaining] = pointers.entries();
		if (!remaining) return;
		const [pointerId, pointer] = remaining;
		panStart = {
			pointerId,
			clientX: pointer.clientX,
			clientY: pointer.clientY,
			scrollLeft: viewport.scrollLeft,
			scrollTop: viewport.scrollTop,
		};
		viewport.classList.add("is-panning");
	};
	viewport.addEventListener("pointerup", endPointer);
	viewport.addEventListener("pointercancel", endPointer);

	element.onwheel = (event) => {
		if (!event.ctrlKey && !event.metaKey) return;
		event.preventDefault();
		const step = event.deltaY > 0 ? -0.08 : 0.08;
		setMermaidScale(
			element,
			Number(element.dataset.mermaidScale || 1) + step,
			event,
		);
	};

	setMermaidScale(element, getDefaultScale(svg));
}

export async function renderMermaidDiagrams(root: HTMLElement) {
	const elements = [...root.querySelectorAll<HTMLElement>(".markdown-mermaid")];
	if (elements.length === 0) return;

	let mermaid: MermaidApi;
	try {
		mermaid = await getMermaid();
		initializeMermaid(mermaid, resolveTheme());
	} catch (error) {
		warnMermaidFailure("renderer failed to load or initialize", {
			error: getErrorMessage(error),
		});
		for (const element of elements) {
			if (element.dataset.mermaidRendered !== "true") {
				markMermaidUnavailable(element, error);
			}
		}
		return;
	}

	await Promise.all(
		elements.map(async (element) => {
			if (
				element.dataset.mermaidRendered === "true" ||
				element.dataset.mermaidRendered === "pending"
			) {
				return;
			}

			const source = readMermaidSource(element).trim();
			if (!source) return;

			if (isMermaidSourceTooLarge(source)) {
				warnMermaidFailure("diagram source is too large", {
					length: source.length,
					lines: source.split(/\r?\n/).length,
				});
				markMermaidUnavailable(element);
				return;
			}

			const token = `${++renderSeq}`;
			const renderId = `markdown-mermaid-${token}`;
			element.dataset.mermaidRendered = "pending";
			element.dataset.mermaidRenderToken = token;

			const host = createMermaidRenderHost();
			try {
				const { svg, bindFunctions } = await mermaid.render(
					renderId,
					source,
					host,
				);
				if (
					!element.isConnected ||
					element.dataset.mermaidRenderToken !== token
				) {
					return;
				}
				element.classList.remove("is-unavailable");
				element.innerHTML = svg;
				bindFunctions?.(element);
				enhanceMermaidDiagram(element);
				element.dataset.mermaidRendered = "true";
			} catch (error) {
				if (
					!element.isConnected ||
					element.dataset.mermaidRenderToken !== token
				) {
					return;
				}
				warnMermaidFailure("diagram render failed", {
					error: getErrorMessage(error),
					theme: currentTheme,
					source,
				});
				markMermaidUnavailable(element, error);
			} finally {
				cleanupMermaidArtifacts(renderId, host, element);
			}
		}),
	);
}
