<script lang="ts">
import {
	mount as mountComponent,
	onDestroy,
	onMount,
	unmount as unmountComponent,
	untrack,
} from "svelte";
import { mediaLightbox } from "#lib/components/media-lightbox.svelte.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { createLazyModuleLoader } from "#lib/lazy-module.ts";
import { createMarkdownRegion } from "#lib/markdown-dom.ts";
import { markdownImageVariants } from "#lib/markdown-image.ts";
import { markdownGallery } from "#lib/media/markdown-gallery.ts";
import { m } from "#lib/paraglide/messages.js";
import { insertComposerSnippet } from "#lib/stores/composer-insert.ts";
import {
	createWorkspaceAssetLoader,
	type ResolveWorkspaceAsset,
	WorkspaceAssetAccessError,
} from "#lib/workspace-assets.ts";
import {
	normalizeWorkspaceFileLinkTarget,
	type WorkspaceFileLinkTarget,
} from "#lib/workspace-file-links.ts";

type MarkdownVariant = "chat" | "document";

type Props = {
	stableBlocks: string[];
	tailHtml: string;
	variant?: MarkdownVariant;
	streamingLive?: boolean;
	baseFilePath?: string | null;
	onOpenFile?: (target: WorkspaceFileLinkTarget) => void | Promise<void>;
	onOpenUrl?: (href: string, event: MouseEvent) => void | Promise<void>;
	resolveWorkspaceAsset?: ResolveWorkspaceAsset;
};

const {
	stableBlocks,
	tailHtml,
	variant = "chat",
	streamingLive = false,
	baseFilePath = null,
	onOpenFile,
	onOpenUrl,
	resolveWorkspaceAsset,
}: Props = $props();

let markdownEl = $state<HTMLElement | null>(null);
let regionEl = $state<HTMLElement | null>(null);
let region: {
	element: HTMLElement;
	dom: ReturnType<typeof createMarkdownRegion>;
} | null = null;
let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
let workspaceAssets: {
	load: ReturnType<typeof createWorkspaceAssetLoader>;
	signal: AbortSignal;
} | null = null;
let requestedAssets = new WeakSet<HTMLElement>();
const latestAssetLoad = new WeakMap<HTMLElement, object>();
const latestPosterLoad = new WeakMap<HTMLElement, object>();
let mermaidRenderer: typeof import("#lib/mermaid-renderer.ts") | null = null;

const loadMermaidRenderer = createLazyModuleLoader(
	() => import("#lib/mermaid-renderer.ts"),
);

let codeHighlighter: typeof import("#lib/markdown-highlight.ts") | null = null;
const loadCodeHighlighter = createLazyModuleLoader(
	() => import("#lib/markdown-highlight.ts"),
);
const PLAIN_CODE_SELECTOR =
	'pre:not([data-highlight]) > code[class^="language-"]';

const mountedAudioPlayers: {
	mount: HTMLElement;
	instance: ReturnType<typeof mountComponent>;
	props: { src: string; title: string | null };
	path?: string;
}[] = [];

const COPY_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

const CHECK_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

const ASSET_FALLBACK_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="2" x2="22" y1="2" y2="22"/><path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"/><line x1="13.5" x2="6" y1="13.5" y2="21"/><line x1="18" x2="21" y1="12" y2="15"/><path d="M3.59 3.59A2 2 0 0 0 3 5v14a2 2 0 0 0 2 2h14a2 2 0 0 0 1.41-.59"/><path d="M21 15V5a2 2 0 0 0-2-2H9"/></svg>';

function assetFallbackLabel(element: HTMLElement, path: string) {
	const name = element.getAttribute("alt")?.trim() || path.split("/").pop();
	return name?.trim() || path;
}

/**
 * Replaces an unresolvable workspace asset with a compact, quiet placeholder.
 * Aligns with the surrounding text instead of showing a broken image box.
 */
function renderAssetFallback(
	element: HTMLElement,
	stateElement: HTMLElement,
	input: { path: string; reason: string },
) {
	if (stateElement.dataset.workspaceAssetFallback === "true") return;
	stateElement.dataset.workspaceAssetFallback = "true";
	stateElement.hidden = true;

	const label = assetFallbackLabel(element, input.path);
	const fallback = document.createElement("span");
	fallback.className = "markdown-asset-fallback";
	fallback.dataset.markdownAttached = "";
	fallback.title = input.reason;
	fallback.setAttribute("role", "img");
	fallback.setAttribute("aria-label", `${label} — ${input.reason}`);
	fallback.innerHTML = `${ASSET_FALLBACK_ICON}<span class="markdown-asset-fallback-label"></span>`;
	const labelEl = fallback.querySelector(".markdown-asset-fallback-label");
	if (labelEl) labelEl.textContent = label;
	stateElement.parentNode?.insertBefore(fallback, stateElement.nextSibling);
}

function highlightCode(
	root: HTMLElement,
	include: (pre: HTMLPreElement) => boolean,
) {
	if (codeHighlighter) {
		codeHighlighter.highlightCodeBlocks(root, include);
		return;
	}
	if (!root.querySelector(PLAIN_CODE_SELECTOR)) return;
	void loadCodeHighlighter()
		.then((module) => {
			codeHighlighter = module;
			if (root.isConnected) module.highlightCodeBlocks(root, include);
		})
		.catch((error) => {
			console.warn("[markdown] highlighter failed to load", { error });
		});
}

$effect(() => {
	const resolve = resolveWorkspaceAsset;
	if (!resolve) return;
	const controller = new AbortController();
	requestedAssets = new WeakSet();
	workspaceAssets = {
		load: createWorkspaceAssetLoader(resolve, controller.signal),
		signal: controller.signal,
	};
	untrack(loadWorkspaceAssets);
	const unsubscribe = resolve.onChange?.(refreshWorkspaceAsset);
	return () => {
		unsubscribe?.();
		controller.abort();
		workspaceAssets = null;
	};
});

$effect(() => {
	const element = regionEl;
	const blocks = stableBlocks;
	const html = tailHtml;
	const live = streamingLive;
	if (!element) return;
	if (region?.element !== element) {
		region?.dom.dispose();
		region = { element, dom: createMarkdownRegion(element) };
	}
	region.dom.setBlocks(blocks);
	region.dom.setTail(html, live);
	// Same task as the insert, before any image request starts.
	untrack(() => {
		sizeGalleryTiles();
		loadWorkspaceAssets();
	});
});

$effect(() => {
	const _stableBlocks = stableBlocks;
	const _streamingLive = streamingLive;
	if (!markdownEl) return;
	if (region && region.element === regionEl) {
		const { element, dom } = region;
		const settled = (pre: HTMLPreElement) => !dom.isLive(pre);
		highlightCode(element, settled);
		enhanceCodeBlocks(element, settled);
	}
	// Sweep even while streaming: replaced blocks can drop mounted players.
	sweepDisconnectedAudioPlayers();
	renderDiagrams();
	if (_streamingLive) return;
	enhanceCodeBlocks(markdownEl, () => true);
	enhanceAudioPlayers();
	checkVideoPosters();
});

function waitForMedia(
	target: HTMLElement,
	event: "load" | "loadedmetadata",
	signal: AbortSignal,
) {
	return new Promise<void>((resolve, reject) => {
		let retried = false;
		const settle = (done: () => void) => {
			target.removeEventListener(event, onLoad);
			target.removeEventListener("error", onError);
			signal.removeEventListener("abort", onAbort);
			done();
		};
		const onLoad = () => settle(resolve);
		const onAbort = () => settle(() => reject(signal.reason));
		const onError = () => {
			if (!retried && target.dataset.fallback) retried = true;
			else settle(() => reject(new Error(`Media failed to ${event}`)));
		};
		target.addEventListener(event, onLoad);
		target.addEventListener("error", onError);
		signal.addEventListener("abort", onAbort);
	});
}

type IsCurrent = () => boolean;

async function loadWorkspaceSource(
	element: HTMLElement,
	path: string,
	isCurrent: IsCurrent,
) {
	if (!workspaceAssets) return;
	const { load, signal } = workspaceAssets;
	const { src } = await load(path);
	if (!isCurrent()) return;
	if (element instanceof HTMLImageElement) {
		const loaded = waitForMedia(element, "load", signal);
		const variants = markdownImageVariants(src);
		delete element.dataset.fallback;
		if (variants) {
			element.dataset.originalSrc = src;
			element.srcset = variants.srcset;
		} else {
			delete element.dataset.originalSrc;
			element.removeAttribute("srcset");
		}
		element.src = variants?.src ?? src;
		return loaded;
	}
	const media =
		element instanceof HTMLMediaElement
			? element
			: element.parentElement instanceof HTMLMediaElement
				? element.parentElement
				: null;
	if (!media) {
		element.setAttribute("src", src);
		return;
	}
	const loaded = waitForMedia(media, "loadedmetadata", signal);
	media.preload = "metadata";
	element.setAttribute("src", src);
	if (element.tagName === "SOURCE") media.load();
	await loaded;
	if (media instanceof HTMLAudioElement && !streamingLive && isCurrent())
		enhanceAudioPlayers();
}

async function loadWorkspacePoster(
	video: HTMLElement,
	path: string,
	isCurrent: IsCurrent,
) {
	if (!workspaceAssets) return;
	const { load, signal } = workspaceAssets;
	const run = {};
	latestPosterLoad.set(video, run);
	const current = () => isCurrent() && latestPosterLoad.get(video) === run;
	const { src } = await load(path);
	if (!current()) return;
	const poster = new Image();
	const loaded = waitForMedia(poster, "load", signal);
	poster.src = src;
	await loaded;
	if (current()) video.setAttribute("poster", src);
}

function clearAssetFallback(element: HTMLElement) {
	if (element.dataset.workspaceAssetFallback !== "true") return;
	const fallback = element.nextElementSibling;
	if (fallback instanceof HTMLElement && "markdownAttached" in fallback.dataset)
		fallback.remove();
	element.hidden = false;
	delete element.dataset.workspaceAssetFallback;
}

function loadAssetElement(element: HTMLElement) {
	if (!workspaceAssets) return;
	const { signal } = workspaceAssets;
	const run = {};
	latestAssetLoad.set(element, run);
	const isCurrent = () =>
		!signal.aborted && latestAssetLoad.get(element) === run;
	const sources = [element, ...element.querySelectorAll("source")];
	const primary = sources.find((source) => source.dataset.workspaceAssetSrc);
	const jobs = sources.flatMap((source) => {
		const { workspaceAssetSrc: src, workspaceAssetPoster: poster } =
			source.dataset;
		return [
			...(src ? [loadWorkspaceSource(source, src, isCurrent)] : []),
			...(poster
				? [
						loadWorkspacePoster(source, poster, isCurrent).catch(
							() => undefined,
						),
					]
				: []),
		];
	});
	void Promise.all(jobs).then(
		() => {
			if (!isCurrent()) return;
			clearAssetFallback(element);
			element.dataset.workspaceAssetState = "loaded";
			element.removeAttribute("aria-busy");
		},
		(error: unknown) => {
			if (!isCurrent()) return;
			element.dataset.workspaceAssetState = "error";
			element.removeAttribute("aria-busy");
			if (!primary?.dataset.workspaceAssetSrc) return;
			const locale = getLocale();
			renderAssetFallback(primary, element, {
				path: primary.dataset.workspaceAssetSrc,
				reason:
					error instanceof WorkspaceAssetAccessError
						? m.markdown_asset_no_access({}, { locale })
						: m.markdown_asset_unavailable({}, { locale }),
			});
		},
	);
}

function loadWorkspaceAssets() {
	if (!regionEl || !workspaceAssets) return;
	for (const element of regionEl.querySelectorAll<HTMLElement>(
		'[data-workspace-asset-state="loading"]',
	)) {
		if (requestedAssets.has(element)) continue;
		requestedAssets.add(element);
		loadAssetElement(element);
	}
}

function refreshWorkspaceAsset(path: string) {
	if (!workspaceAssets) return;
	const { load, signal } = workspaceAssets;
	load.invalidate(path);
	if (!regionEl) return;
	const value = CSS.escape(path);
	const sources = new Set<HTMLElement>();
	const posters = new Set<HTMLElement>();
	for (const node of regionEl.querySelectorAll<HTMLElement>(
		`[data-workspace-asset-src="${value}"], [data-workspace-asset-poster="${value}"]`,
	)) {
		const element = node.tagName === "SOURCE" ? node.parentElement : node;
		if (!element || !requestedAssets.has(element)) continue;
		if (node.dataset.workspaceAssetSrc === path) sources.add(element);
		else posters.add(element);
	}
	const players = mountedAudioPlayers.filter(
		(player) => player.path === path && player.mount.isConnected,
	);
	if (sources.size + posters.size + players.length === 0) return;
	for (const element of sources) loadAssetElement(element);
	for (const video of posters)
		if (!sources.has(video))
			void loadWorkspacePoster(video, path, () => !signal.aborted).catch(
				() => undefined,
			);
	if (players.length === 0) return;
	const run = {};
	for (const player of players) latestAssetLoad.set(player.mount, run);
	void load(path).then(
		({ src }) => {
			for (const player of players)
				if (latestAssetLoad.get(player.mount) === run) player.props.src = src;
		},
		() => undefined,
	);
}

const GALLERY_TILE_SELECTOR =
	'.markdown-region > p[data-images]:is(:not([data-images="1"]), :has(+ p[data-images]), p[data-images] + *) > img:not([sizes])';
const canMatchGalleryTiles =
	typeof CSS !== "undefined" && CSS.supports("selector(:has(+ p))");

// Mirrors the gallery CSS in app.css.
function sizeGalleryTiles() {
	if (variant !== "chat" || !canMatchGalleryTiles || !regionEl) return;
	for (const img of regionEl.querySelectorAll<HTMLImageElement>(
		GALLERY_TILE_SELECTOR,
	))
		img.sizes = "8.5rem";
}

function sweepDisconnectedAudioPlayers() {
	for (let i = mountedAudioPlayers.length - 1; i >= 0; i -= 1) {
		if (!mountedAudioPlayers[i].mount.isConnected) {
			unmountComponent(mountedAudioPlayers[i].instance);
			mountedAudioPlayers.splice(i, 1);
		}
	}
}

function checkVideoPosters() {
	if (!markdownEl) return;
	for (const video of markdownEl.querySelectorAll<HTMLVideoElement>(
		"figure.markdown-video video[poster]:not([data-poster-checked])",
	)) {
		video.dataset.posterChecked = "";
		const probe = new Image();
		probe.onerror = () => {
			video.removeAttribute("poster");
			video.preload = "metadata";
		};
		probe.src = video.poster;
	}
}

function enhanceAudioPlayers() {
	if (!markdownEl) return;

	sweepDisconnectedAudioPlayers();

	for (const figure of markdownEl.querySelectorAll<HTMLElement>(
		"figure.markdown-audio",
	)) {
		if (figure.dataset.audioEnhanced === "true") continue;
		const audio = figure.querySelector<HTMLAudioElement>("audio");
		if (!audio?.src) continue;

		figure.dataset.audioEnhanced = "true";
		const props = $state({
			src: audio.currentSrc || audio.src,
			title: figure.querySelector("figcaption")?.textContent?.trim() || null,
		});
		const path =
			audio.dataset.workspaceAssetSrc ??
			audio.querySelector("source")?.dataset.workspaceAssetSrc;

		const target = document.createElement("div");
		target.className = "markdown-audio-mount";
		figure.insertBefore(target, audio);

		void import("#lib/components/AudioPlayer.svelte")
			.then(({ default: AudioPlayer }) => {
				if (!target.isConnected) return;
				const instance = mountComponent(AudioPlayer, { target, props });
				mountedAudioPlayers.push({ mount: target, instance, props, path });
				// Release the native element only after the enhanced player is in
				// place — avoids a duplicate media instance while keeping the
				// native <audio> as the no-JS / streaming fallback.
				audio.remove();
				// The caption is now rendered inside the player; drop the duplicate.
				figure.querySelector("figcaption")?.remove();
			})
			.catch(() => {
				// Dynamic import failed: keep the native player usable and allow
				// retrying on the next render pass.
				if (target.isConnected) target.remove();
				audio.hidden = false;
				delete figure.dataset.audioEnhanced;
			});
	}
}

function renderDiagrams() {
	const frames = markdownEl?.querySelectorAll<HTMLElement>(
		".markdown-mermaid:not([data-state])",
	);
	if (!frames?.length) {
		mermaidRenderer?.releaseDetachedDiagrams();
		return;
	}
	const locale = getLocale();
	const labels = {
		zoomIn: m.media_zoom_in({}, { locale }),
		zoomOut: m.media_zoom_out({}, { locale }),
		resetZoom: m.media_reset_zoom({}, { locale }),
		expand: m.markdown_diagram_expand({}, { locale }),
		download: m.media_download({}, { locale }),
		unavailable: m.markdown_diagram_unavailable({}, { locale }),
	};
	void loadMermaidRenderer()
		.then((renderer) => {
			mermaidRenderer = renderer;
			return renderer.renderMermaidDiagrams(frames, labels);
		})
		.catch((error) => {
			console.warn("[mermaid] renderer failed to load", { error });
			for (const frame of frames) {
				if (frame.dataset.state) continue;
				frame.dataset.state = "error";
				frame.textContent = labels.unavailable;
			}
		});
}

function enhanceCodeBlocks(
	root: HTMLElement,
	include: (pre: HTMLPreElement) => boolean,
) {
	for (const pre of root.querySelectorAll("pre")) {
		if (!include(pre)) continue;
		if (pre.parentElement?.classList.contains("markdown-code-block")) continue;

		const wrapper = document.createElement("div");
		wrapper.className = "markdown-code-block";
		pre.parentNode?.insertBefore(wrapper, pre);
		wrapper.appendChild(pre);

		const button = document.createElement("button");
		button.type = "button";
		button.className = "markdown-code-copy";
		button.dataset.codeCopy = "";
		button.innerHTML = COPY_ICON;
		button.setAttribute("aria-label", "Copy code");
		button.title = "Copy code";
		wrapper.appendChild(button);
	}
}

async function copyText(text: string) {
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}

	const textArea = document.createElement("textarea");
	textArea.value = text;
	textArea.style.position = "fixed";
	textArea.style.opacity = "0";
	document.body.appendChild(textArea);
	textArea.select();
	document.execCommand("copy");
	textArea.remove();
}

function markCopied(button: HTMLButtonElement) {
	button.innerHTML = CHECK_ICON;
	button.classList.add("copied");
	button.setAttribute("aria-label", "Code copied");
	button.title = "Code copied";
	if (copyResetTimer) clearTimeout(copyResetTimer);
	copyResetTimer = setTimeout(() => {
		button.innerHTML = COPY_ICON;
		button.classList.remove("copied");
		button.setAttribute("aria-label", "Copy code");
		button.title = "Copy code";
	}, 1400);
}

onMount(() => {
	const el = markdownEl;
	if (!el) return;

	function getAskOption(target: EventTarget | null) {
		return target instanceof HTMLElement
			? target.closest<HTMLButtonElement>("[data-cohub-ask-option]")
			: null;
	}

	function getAskOptionValue(option: HTMLButtonElement) {
		const encodedValue = option.dataset.cohubAskValue;
		return encodedValue ? decodeURIComponent(encodedValue) : "";
	}

	function setAskOptionPressed(option: HTMLButtonElement, pressed: boolean) {
		option.setAttribute("aria-pressed", pressed ? "true" : "false");
	}

	function buildMultiSelectSnippet(questionEl: HTMLElement) {
		return Array.from(
			questionEl.querySelectorAll<HTMLButtonElement>(
				'[data-cohub-ask-option][aria-pressed="true"]',
			),
		)
			.map(getAskOptionValue)
			.filter(Boolean)
			.join("\n");
	}

	function onPointerDown(e: Event) {
		if (!getAskOption(e.target)) return;
		// Pointer clicks should not steal composer focus on mobile.
		e.preventDefault();
	}

	function shouldPreserveNativeLinkClick(event: MouseEvent) {
		return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
	}

	/**
	 * A failed CDN variant (see `data-original-src`) falls back to the original,
	 * once: `img.src` is normalized, so comparing URLs could loop on a 404.
	 */
	function onImageError(e: Event) {
		const img = e.target;
		if (!(img instanceof HTMLImageElement)) return;
		const original = img.dataset.originalSrc;
		if (!original || img.dataset.fallback) return;
		img.dataset.fallback = "original";
		img.removeAttribute("srcset");
		img.src = original;
	}

	function onClick(e: Event) {
		const target = e.target as HTMLElement;
		const askOption = getAskOption(e.target);
		if (askOption) {
			e.preventDefault();
			e.stopPropagation();
			const questionEl = askOption.closest<HTMLElement>(
				"[data-cohub-ask-question]",
			);
			const questionKey = askOption.dataset.cohubAskKey;
			const replacementKey = questionKey
				? `cohub-ask:${questionKey}`
				: undefined;
			const isMultiSelect = askOption.dataset.cohubAskMulti === "true";
			if (isMultiSelect && questionEl) {
				const nextPressed = askOption.getAttribute("aria-pressed") !== "true";
				setAskOptionPressed(askOption, nextPressed);
				insertComposerSnippet(buildMultiSelectSnippet(questionEl), {
					focus: false,
					replacementKey,
				});
				return;
			}

			questionEl
				?.querySelectorAll<HTMLButtonElement>("[data-cohub-ask-option]")
				.forEach((option) => {
					setAskOptionPressed(option, option === askOption);
				});
			const value = getAskOptionValue(askOption);
			if (!value) return;
			insertComposerSnippet(value, { focus: false, replacementKey });
			return;
		}

		const link = target.closest<HTMLAnchorElement>("a[href]");
		if (link && e instanceof MouseEvent) {
			const href = link.getAttribute("href") ?? "";
			const fileTarget = normalizeWorkspaceFileLinkTarget(href, {
				basePath: baseFilePath,
			});
			if (fileTarget && onOpenFile && !shouldPreserveNativeLinkClick(e)) {
				e.preventDefault();
				e.stopPropagation();
				void onOpenFile(fileTarget);
				return;
			}

			if (
				onOpenUrl &&
				!e.defaultPrevented &&
				!fileTarget &&
				!link.hasAttribute("download") &&
				(!link.target || link.dataset.cohubAutoTarget === "blank") &&
				!shouldPreserveNativeLinkClick(e)
			) {
				void onOpenUrl(href, e);
				return;
			}
		}

		const copyButton = target.closest<HTMLButtonElement>("[data-code-copy]");
		if (copyButton) {
			e.preventDefault();
			e.stopPropagation();
			const code = copyButton.parentElement?.querySelector("pre code");
			void copyText(code?.textContent ?? "").then(() => markCopied(copyButton));
			return;
		}

		const media =
			target instanceof HTMLImageElement || target instanceof HTMLVideoElement
				? target
				: target.parentElement instanceof HTMLVideoElement
					? target.parentElement
					: null;
		if (media) {
			e.preventDefault();
			e.stopPropagation();
			const gallery = markdownGallery(media);
			mediaLightbox.show(gallery.items, gallery.index);
		}
	}

	el.addEventListener("pointerdown", onPointerDown);
	el.addEventListener("click", onClick);
	// Image `error` does not bubble; capture it to fall back from CDN variants.
	el.addEventListener("error", onImageError, true);

	return () => {
		el.removeEventListener("pointerdown", onPointerDown);
		el.removeEventListener("click", onClick);
		el.removeEventListener("error", onImageError, true);
		mermaidRenderer?.releaseDetachedDiagrams();
	};
});

onDestroy(() => {
	region?.dom.dispose();
	if (copyResetTimer) clearTimeout(copyResetTimer);
	for (const { instance } of mountedAudioPlayers) {
		unmountComponent(instance);
	}
	mountedAudioPlayers.length = 0;
});
</script>

<div
	bind:this={markdownEl}
	class="markdown-content"
	data-variant={variant}
>
	{#if stableBlocks.length > 0 || tailHtml || streamingLive}
		<div
			bind:this={regionEl}
			class="markdown-region"
			class:streaming-live-markdown={streamingLive}
		></div>
	{/if}
</div>
