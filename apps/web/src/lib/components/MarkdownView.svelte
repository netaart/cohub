<script module lang="ts">
let markdownModulePromise: Promise<typeof import("$lib/markdown")> | null =
	null;

function escapeHtml(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function renderPlainTextFallback(markdownSource: string) {
	return escapeHtml(markdownSource).replaceAll("\n", "<br>");
}

function loadMarkdownModule() {
	markdownModulePromise ??= import("$lib/markdown");
	return markdownModulePromise;
}

// Lets a remounted settled view (live answer → persisted message) skip the plain-text flash.
let streamHandoff: {
	source: string;
	stableBlocks: string[];
	tailHtml: string;
} | null = null;
</script>

<script lang="ts">
import type { ContentBlock } from "@cohub/protocol/core";
import { onDestroy, tick, untrack } from "svelte";
import MarkdownFrontmatter from "$lib/components/MarkdownFrontmatter.svelte";
import MarkdownSurface from "$lib/components/MarkdownSurface.svelte";
import { parseMarkdownFrontmatter } from "$lib/markdown-frontmatter";
import { buildPublicFileUrl } from "$lib/public-files-url";
import { StreamingMarkdownController } from "$lib/streaming-markdown-controller";
import {
	prepareMarkdownAssetHtml,
	type ResolveWorkspaceAsset,
} from "$lib/workspace-assets";
import type { WorkspaceFileLinkTarget } from "$lib/workspace-file-links";

type MarkdownTextBlock = Extract<ContentBlock, { type: "text" }>;
type MarkdownVariant = "chat" | "document";

type Props = {
	source?: string;
	blocks?: MarkdownTextBlock[];
	variant?: MarkdownVariant;
	isStreaming?: boolean;
	baseFilePath?: string | null;
	onStart?: () => void;
	onRendered?: () => void;
	onOpenFile?: (target: WorkspaceFileLinkTarget) => void | Promise<void>;
	onOpenUrl?: (href: string, event: MouseEvent) => void | Promise<void>;
	resolveWorkspaceAsset?: ResolveWorkspaceAsset;
};

const {
	source: sourceProp,
	blocks,
	variant = "chat",
	isStreaming = false,
	baseFilePath = null,
	onStart,
	onRendered,
	onOpenFile,
	onOpenUrl,
	resolveWorkspaceAsset,
}: Props = $props();

// Shield the render effect from unrelated updates of spread parent props.
const streaming = $derived(isStreaming);
const assetBasePath = $derived(baseFilePath);
const assetResolver = $derived(resolveWorkspaceAsset);

let stableBlocks = $state.raw<string[]>([]);
let tailHtml = $state("");
let renderSeq = 0;
let hasRenderedMarkdown = false;
let controller: StreamingMarkdownController | null = null;
let unsubscribeController: (() => void) | null = null;
let streamingRenderedFrame: number | null = null;

/**
 * Streaming snapshots land several times per second and each `onRendered`
 * consumer (timeline follow, turn-marker measurement) reads layout. Notify at
 * most once per frame, after Svelte has flushed this frame's DOM writes, so
 * consumers batch their layout reads instead of forcing one per snapshot.
 */
function notifyStreamingRenderedSoon() {
	if (streamingRenderedFrame != null) return;
	streamingRenderedFrame = requestAnimationFrame(() => {
		streamingRenderedFrame = null;
		if (!controller) return;
		untrack(() => onRendered?.());
	});
}

function cancelStreamingRenderedNotify() {
	if (streamingRenderedFrame == null) return;
	cancelAnimationFrame(streamingRenderedFrame);
	streamingRenderedFrame = null;
}

const source = $derived.by(() => {
	const raw =
		sourceProp ?? blocks?.map((block) => block.text).join("\n\n") ?? "";
	return streaming ? raw : raw.trim();
});

const frontmatter = $derived(
	!streaming && variant === "document"
		? parseMarkdownFrontmatter(source)
		: null,
);
const renderSource = $derived(frontmatter?.body ?? source);

function ensureController() {
	if (controller) return controller;
	controller = new StreamingMarkdownController();
	unsubscribeController = controller.subscribe((snapshot) => {
		stableBlocks = snapshot.stableBlocks;
		tailHtml = snapshot.tailHtml;
		streamHandoff = {
			source: untrack(() => renderSource).trim(),
			stableBlocks: snapshot.stableBlocks,
			tailHtml: snapshot.tailHtml,
		};
		notifyStreamingRenderedSoon();
	});
	return controller;
}

function destroyController() {
	cancelStreamingRenderedNotify();
	unsubscribeController?.();
	unsubscribeController = null;
	controller?.dispose();
	controller = null;
}

function renderFullMarkdown(
	markdownSource: string,
	basePath: string | null,
	resolver: ResolveWorkspaceAsset | undefined,
	{ settling, replacing }: { settling: boolean; replacing: boolean },
) {
	const seq = ++renderSeq;
	if (!settling && !replacing) {
		const handoff =
			streamHandoff?.source === markdownSource.trim() ? streamHandoff : null;
		stableBlocks = handoff?.stableBlocks ?? [
			renderPlainTextFallback(markdownSource),
		];
		tailHtml = handoff?.tailHtml ?? "";
	}
	untrack(() => onStart?.());
	void loadMarkdownModule()
		.then(({ renderMarkdown }) => renderMarkdown(markdownSource))
		.then((html) => {
			if (seq !== renderSeq) return;
			stableBlocks = [
				prepareMarkdownAssetHtml(html, {
					basePath,
					extractWorkspaceAssets: Boolean(resolver),
					publicFileUrl: buildPublicFileUrl,
				}),
			];
			tailHtml = "";
			hasRenderedMarkdown = true;
			void tick().then(() => {
				if (seq === renderSeq) untrack(() => onRendered?.());
			});
		})
		.catch(() => {
			if (seq !== renderSeq) return;
			if (replacing && !settling) {
				stableBlocks = [renderPlainTextFallback(markdownSource)];
				tailHtml = "";
			}
			void tick().then(() => untrack(() => onRendered?.()));
		});
}

$effect(() => {
	const markdownSource = renderSource;
	const isLive = streaming;
	const basePath = assetBasePath;
	const resolver = assetResolver;

	if (isLive) {
		untrack(() => onStart?.());
		ensureController().setTarget(markdownSource);
		return;
	}

	const settling = controller !== null;
	destroyController();
	renderFullMarkdown(markdownSource, basePath, resolver, {
		settling,
		replacing: hasRenderedMarkdown,
	});
});

onDestroy(() => {
	destroyController();
});
</script>

<div
	class="streaming-markdown-flow"
	class:is-streaming={streaming}
	data-variant={variant}
>
	{#if frontmatter}
		<MarkdownFrontmatter
			raw={frontmatter.raw}
			entries={frontmatter.entries}
		/>
	{/if}
	<MarkdownSurface
		{stableBlocks}
		{tailHtml}
		{variant}
		streamingLive={streaming}
		baseFilePath={assetBasePath}
		{onOpenFile}
		{onOpenUrl}
		resolveWorkspaceAsset={assetResolver}
	/>
</div>
