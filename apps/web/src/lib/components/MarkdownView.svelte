<script module lang="ts">
type MarkdownModule = typeof import("#lib/markdown.ts");

let markdownModule: MarkdownModule | null = null;
let markdownModulePromise: Promise<MarkdownModule> | null = null;

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
	markdownModulePromise ??= import("#lib/markdown.ts").then(
		(module) => (markdownModule = module),
		(error) => {
			markdownModulePromise = null;
			throw error;
		},
	);
	return markdownModulePromise;
}

if (typeof document !== "undefined") void loadMarkdownModule().catch(() => {});
</script>

<script lang="ts">
import type { ContentBlock } from "@cohub/protocol/core";
import { onDestroy, tick, untrack } from "svelte";
import MarkdownFrontmatter from "#lib/components/MarkdownFrontmatter.svelte";
import MarkdownSurface from "#lib/components/MarkdownSurface.svelte";
import { parseMarkdownFrontmatter } from "#lib/markdown-frontmatter.ts";
import { buildPublicFileUrl } from "#lib/public-files-url.ts";
import { StreamingMarkdownController } from "#lib/streaming-markdown-controller.ts";
import {
	prepareMarkdownAssetHtml,
	type ResolveWorkspaceAsset,
} from "#lib/workspace-assets.ts";
import type { WorkspaceFileLinkTarget } from "#lib/workspace-file-links.ts";

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
) {
	const seq = ++renderSeq;
	untrack(() => onStart?.());

	const render = (module: MarkdownModule) => {
		if (seq !== renderSeq) return;
		let ready: Promise<void> | null = null;
		try {
			const result = module.renderMarkdownBlocks(markdownSource);
			ready = result.ready;
			stableBlocks = result.blocks.map((html) =>
				prepareMarkdownAssetHtml(html, {
					basePath,
					extractWorkspaceAssets: Boolean(resolver),
					publicFileUrl: buildPublicFileUrl,
				}),
			);
			hasRenderedMarkdown = true;
		} catch (error) {
			console.warn("[markdown] render failed; showing plain text", { error });
			stableBlocks = [renderPlainTextFallback(markdownSource)];
		}
		tailHtml = "";
		void tick().then(() => {
			if (seq === renderSeq) untrack(() => onRendered?.());
		});
		if (ready) void ready.then(() => render(module));
	};

	if (markdownModule) {
		render(markdownModule);
		return;
	}
	if (!hasRenderedMarkdown) {
		stableBlocks = [renderPlainTextFallback(markdownSource)];
		tailHtml = "";
	}
	void loadMarkdownModule()
		.then(render)
		.catch(() => {
			if (seq !== renderSeq) return;
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

	destroyController();
	renderFullMarkdown(markdownSource, basePath, resolver);
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
