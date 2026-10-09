<script lang="ts">
import {
	mount as mountComponent,
	onDestroy,
	onMount,
	unmount as unmountComponent,
} from "svelte";
import { mediaLightbox } from "$lib/components/media-lightbox.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { insertComposerSnippet } from "$lib/stores/composer-insert";
import {
	createWorkspaceAssetLoader,
	type ResolveWorkspaceAsset,
	WorkspaceAssetAccessError,
} from "$lib/workspace-assets";
import {
	normalizeWorkspaceFileLinkTarget,
	type WorkspaceFileLinkTarget,
} from "$lib/workspace-file-links";

type MarkdownVariant = "chat" | "document";

type Props = {
	stableHtml: string;
	tailHtml: string;
	variant?: MarkdownVariant;
	streamingLive?: boolean;
	baseFilePath?: string | null;
	onOpenFile?: (target: WorkspaceFileLinkTarget) => void | Promise<void>;
	onOpenUrl?: (href: string, event: MouseEvent) => void | Promise<void>;
	resolveWorkspaceAsset?: ResolveWorkspaceAsset;
};

const {
	stableHtml,
	tailHtml,
	variant = "chat",
	streamingLive = false,
	baseFilePath = null,
	onOpenFile,
	onOpenUrl,
	resolveWorkspaceAsset,
}: Props = $props();

let markdownEl = $state<HTMLElement | null>(null);
let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
let themeObserver: MutationObserver | null = null;
let workspaceAssetRun = 0;

const mountedAudioPlayers: {
	mount: HTMLElement;
	instance: ReturnType<typeof mountComponent>;
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
	fallback.title = input.reason;
	fallback.setAttribute("role", "img");
	fallback.setAttribute("aria-label", `${label} — ${input.reason}`);
	fallback.innerHTML = `${ASSET_FALLBACK_ICON}<span class="markdown-asset-fallback-label"></span>`;
	const labelEl = fallback.querySelector(".markdown-asset-fallback-label");
	if (labelEl) labelEl.textContent = label;
	stateElement.parentNode?.insertBefore(fallback, stateElement.nextSibling);
}

$effect(() => {
	const _stableHtml = stableHtml;
	const _streamingLive = streamingLive;
	if (!markdownEl) return;
	// Sweep even while streaming: {@html} can drop mounted players when the
	// stable region is cleared, and Svelte won't dispose those instances.
	sweepDisconnectedAudioPlayers();
	if (_streamingLive) return;
	enhanceCodeBlocks();
	renderMermaid();
	enhanceAudioPlayers();
});

$effect(() => {
	stableHtml;
	const root = markdownEl;
	const resolve = resolveWorkspaceAsset;
	if (!root || !resolve) return;

	const run = ++workspaceAssetRun;
	const controller = new AbortController();
	const elements = Array.from(
		root.querySelectorAll<HTMLElement>(
			"[data-workspace-asset-src], [data-workspace-asset-poster]",
		),
	);
	const targets = elements.flatMap((element) => {
		const parent = element.parentElement;
		const stateElement =
			element.tagName === "SOURCE" && parent instanceof HTMLMediaElement
				? parent
				: element;
		const entries: Array<{
			element: HTMLElement;
			stateElement: HTMLElement;
			attribute: "src" | "poster";
			path: string;
		}> = [];
		if (element.dataset.workspaceAssetSrc) {
			entries.push({
				element,
				stateElement,
				attribute: "src",
				path: element.dataset.workspaceAssetSrc,
			});
		}
		if (element.dataset.workspaceAssetPoster) {
			entries.push({
				element,
				stateElement,
				attribute: "poster",
				path: element.dataset.workspaceAssetPoster,
			});
		}
		return entries;
	});
	const loadAsset = createWorkspaceAssetLoader(resolve, controller.signal);
	const remaining = new Map<HTMLElement, number>();
	const failed = new Map<HTMLElement, unknown>();
	const primaryTarget = new Map<
		HTMLElement,
		{ element: HTMLElement; path: string }
	>();
	for (const { element, stateElement, attribute, path } of targets) {
		remaining.set(stateElement, (remaining.get(stateElement) ?? 0) + 1);
		if (attribute === "src") {
			primaryTarget.set(stateElement, { element, path });
		}
	}

	const locale = getLocale();

	function settle(element: HTMLElement, error: unknown, primary: boolean) {
		if (controller.signal.aborted || run !== workspaceAssetRun) return;
		if (error && primary) failed.set(element, error);
		const next = (remaining.get(element) ?? 1) - 1;
		remaining.set(element, next);
		if (next > 0) return;
		const failure = failed.get(element);
		element.dataset.workspaceAssetState = failure ? "error" : "loaded";
		element.removeAttribute("aria-busy");
		if (!failure) return;
		const target = primaryTarget.get(element);
		if (!target) return;
		renderAssetFallback(target.element, element, {
			path: target.path,
			reason:
				failure instanceof WorkspaceAssetAccessError
					? m.markdown_asset_no_access({}, { locale })
					: m.markdown_asset_unavailable({}, { locale }),
		});
	}

	function observeLoad(
		target: EventTarget,
		event: string,
		stateElement: HTMLElement,
		errorMessage: string,
		primary: boolean,
		onLoad?: () => void,
	) {
		const options = { once: true, signal: controller.signal };
		target.addEventListener(
			event,
			() => {
				onLoad?.();
				settle(stateElement, null, primary);
			},
			options,
		);
		target.addEventListener(
			"error",
			() => settle(stateElement, new Error(errorMessage), primary),
			options,
		);
	}

	for (const { element, stateElement, attribute, path } of targets) {
		const primary = attribute === "src";
		void loadAsset(path)
			.then(({ src }) => {
				if (controller.signal.aborted || run !== workspaceAssetRun) return;
				if (attribute === "poster") {
					const poster = new Image();
					observeLoad(
						poster,
						"load",
						stateElement,
						"Poster failed to load",
						false,
						() => element.setAttribute(attribute, src),
					);
					poster.src = src;
					return;
				}

				if (element instanceof HTMLImageElement) {
					observeLoad(
						element,
						"load",
						stateElement,
						"Image failed to load",
						true,
					);
					element.src = src;
					return;
				}

				const media =
					element instanceof HTMLMediaElement
						? element
						: element.parentElement instanceof HTMLMediaElement
							? element.parentElement
							: null;
				if (!media) {
					element.setAttribute(attribute, src);
					settle(stateElement, null, primary);
					return;
				}

				observeLoad(
					media,
					"loadedmetadata",
					stateElement,
					"Media failed to load",
					true,
					media instanceof HTMLAudioElement ? enhanceAudioPlayers : undefined,
				);
				media.preload = "metadata";
				element.setAttribute(attribute, src);
				if (element.tagName === "SOURCE") media.load();
			})
			.catch((error) => settle(stateElement, error, primary));
	}

	return () => controller.abort();
});

function sweepDisconnectedAudioPlayers() {
	for (let i = mountedAudioPlayers.length - 1; i >= 0; i -= 1) {
		if (!mountedAudioPlayers[i].mount.isConnected) {
			unmountComponent(mountedAudioPlayers[i].instance);
			mountedAudioPlayers.splice(i, 1);
		}
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
		const src = audio.currentSrc || audio.src;
		const caption =
			figure.querySelector("figcaption")?.textContent?.trim() || null;

		const target = document.createElement("div");
		target.className = "markdown-audio-mount";
		figure.insertBefore(target, audio);

		void import("$lib/components/AudioPlayer.svelte")
			.then(({ default: AudioPlayer }) => {
				if (!target.isConnected) return;
				const instance = mountComponent(AudioPlayer, {
					target,
					props: { src, title: caption },
				});
				mountedAudioPlayers.push({ mount: target, instance });
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

function markMermaidLoadError(error: unknown) {
	console.warn("[mermaid] renderer chunk failed to load", { error });
	if (!markdownEl) return;
	for (const element of markdownEl.querySelectorAll<HTMLElement>(
		".markdown-mermaid",
	)) {
		if (element.dataset.mermaidRendered === "true") continue;
		element.dataset.mermaidRendered = "true";
		element.classList.add("is-unavailable");
		element.replaceChildren();

		const message = document.createElement("div");
		message.className = "markdown-mermaid-error";
		message.textContent = "Diagram preview unavailable";
		element.appendChild(message);

		if (error instanceof Error && error.message) {
			element.title = error.message;
			const detail = document.createElement("div");
			detail.className = "markdown-mermaid-error-detail";
			detail.textContent = error.message;
			element.appendChild(detail);
		}
	}
}

function renderMermaid() {
	if (!markdownEl) return;
	void import("$lib/mermaid-renderer")
		.then(({ renderMermaidDiagrams }) =>
			markdownEl ? renderMermaidDiagrams(markdownEl) : undefined,
		)
		.catch((error) => markMermaidLoadError(error));
}

function resetMermaidDiagrams() {
	if (!markdownEl) return;
	for (const element of markdownEl.querySelectorAll<HTMLElement>(
		".markdown-mermaid",
	)) {
		element.dataset.mermaidRendered = "false";
		delete element.dataset.mermaidRenderToken;
		delete element.dataset.mermaidScale;
		element.classList.remove("is-unavailable");
		element.removeAttribute("title");
		element.innerHTML =
			'<div class="markdown-mermaid-loading">Rendering diagram…</div>';
	}
	renderMermaid();
}

function enhanceCodeBlocks() {
	if (!markdownEl) return;

	for (const pre of markdownEl.querySelectorAll("pre")) {
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

		if (target.tagName === "IMG") {
			e.preventDefault();
			e.stopPropagation();
			const img = target as HTMLImageElement;
			mediaLightbox.show({
				// Rendered images may be CDN variants; view and download the original.
				src: img.dataset.originalSrc ?? img.src,
				type: "image" as const,
				alt: img.alt,
			});
		} else if (
			target.tagName === "VIDEO" ||
			(target.tagName === "SOURCE" && target.parentElement?.tagName === "VIDEO")
		) {
			e.preventDefault();
			e.stopPropagation();
			const video =
				target.tagName === "VIDEO"
					? (target as HTMLVideoElement)
					: (target.parentElement as HTMLVideoElement);
			mediaLightbox.show({
				src: video.src || (video.querySelector("source")?.src ?? ""),
				type: "video" as const,
			});
		}
	}

	el.addEventListener("pointerdown", onPointerDown);
	el.addEventListener("click", onClick);
	// Image `error` does not bubble; capture it to fall back from CDN variants.
	el.addEventListener("error", onImageError, true);
	themeObserver = new MutationObserver(() => resetMermaidDiagrams());
	themeObserver.observe(document.documentElement, {
		attributeFilter: ["data-theme"],
	});

	return () => {
		el.removeEventListener("pointerdown", onPointerDown);
		el.removeEventListener("click", onClick);
		el.removeEventListener("error", onImageError, true);
		themeObserver?.disconnect();
		themeObserver = null;
	};
});

onDestroy(() => {
	if (copyResetTimer) clearTimeout(copyResetTimer);
	themeObserver?.disconnect();
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
	{#if stableHtml}
		<div class="markdown-stable-region">{@html stableHtml}</div>
	{/if}
	{#if tailHtml || streamingLive}
		<div
			class="markdown-live-region"
			class:streaming-live-markdown={streamingLive}
		>
			{@html tailHtml}
		</div>
	{/if}
</div>
