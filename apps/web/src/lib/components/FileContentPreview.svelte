<script lang="ts">
import { modelFormatForPath } from "@cohub/protocol/fs";
import type { AppRecord, SpaceFsFileResponse } from "@neta-art/cohub";
import type { Snippet } from "svelte";
import AudioPlayer from "$lib/components/AudioPlayer.svelte";
import ImageViewer from "$lib/components/ImageViewer.svelte";
import MarkdownView from "$lib/components/MarkdownView.svelte";
import type { PreviewCaptureTarget } from "$lib/features/preview-mark";
import { filePreviewModel } from "$lib/file-preview-model";
import { formatBytes } from "$lib/format-bytes";
import { getLocale } from "$lib/i18n/locale.svelte";
import { createLazyModuleLoader, pending } from "$lib/lazy-module";
import { screenVariantSize } from "$lib/media/media-info";
import {
	type ModelSource,
	readFileModelBytes,
	workspaceReferences,
} from "$lib/model3d/source";
import { m } from "$lib/paraglide/messages.js";
import MediaVideo from "$lib/resource-kit/MediaVideo.svelte";
import type { ResolveWorkspaceAsset } from "$lib/workspace-assets";
import type {
	WorkspaceFileLinkTarget,
	WorkspaceFilePosition,
} from "$lib/workspace-file-links";

const loadCodeEditor = createLazyModuleLoader(() =>
	import.meta.env.SSR ? pending() : import("$lib/components/CodeEditor.svelte"),
);
const loadRenderedPreview = createLazyModuleLoader(() =>
	import.meta.env.SSR
		? pending()
		: import("$lib/components/RenderedFilePreview.svelte"),
);
const loadCsvPreview = createLazyModuleLoader(() =>
	import.meta.env.SSR ? pending() : import("$lib/components/CsvPreview.svelte"),
);
const loadPdfPreview = createLazyModuleLoader(() =>
	import.meta.env.SSR ? pending() : import("$lib/components/PdfPreview.svelte"),
);
const loadModelPreview = createLazyModuleLoader(() =>
	import.meta.env.SSR
		? pending()
		: import("$lib/components/ModelPreview.svelte"),
);

/**
 * Single read-only renderer for every file kind.
 *
 * Workspace preview, published file Apps and any other host share this so a
 * file behaves the same everywhere. Editing, diff and other workspace-only
 * concerns stay with the caller; `render` picks the raw or rich form for the
 * text-like kinds.
 */
let {
	file,
	source = file.content,
	render = "preview",
	readonly = true,
	isMobile = false,
	downloadUrl = null,
	downloadName = null,
	allowDrawerSwipe = false,
	initialPosition = null,
	spaceId = null,
	app = null,
	resolveWorkspaceAsset,
	onOpenFile,
	onOpenUrl,
	onInput,
	onVisibleLinesChange,
	imageZoom = $bindable(1),
	imagePanX = $bindable(0),
	imagePanY = $bindable(0),
	imageDragging = $bindable(false),
	markTarget = $bindable(null),
	fallback,
}: {
	file: SpaceFsFileResponse;
	/** Display source for the text-like kinds (defaults to the raw content). */
	source?: string;
	/** Rich form (markdown / html / csv) or raw source; ignored by media. */
	render?: "preview" | "source";
	readonly?: boolean;
	isMobile?: boolean;
	downloadUrl?: string | null;
	downloadName?: string | null;
	allowDrawerSwipe?: boolean;
	initialPosition?: WorkspaceFilePosition | null;
	spaceId?: string | null;
	app?: AppRecord | null;
	resolveWorkspaceAsset?: ResolveWorkspaceAsset;
	onOpenFile?: (target: WorkspaceFileLinkTarget) => void | Promise<void>;
	onOpenUrl?: (href: string, event: MouseEvent) => void | Promise<void>;
	onInput?: (value: string) => void;
	onVisibleLinesChange?: (range: { start: number; end: number } | null) => void;
	imageZoom?: number;
	imagePanX?: number;
	imagePanY?: number;
	imageDragging?: boolean;
	markTarget?: PreviewCaptureTarget | null;
	/** Overrides the built-in "cannot preview" panel. */
	fallback?: Snippet;
} = $props();

const locale = $derived(getLocale());
const model = $derived(filePreviewModel(file));
const rich = $derived(render === "preview");
const hasPdfSource = $derived(
	file.delivery === "url" ? Boolean(file.url) : Boolean(file.content),
);

// Bumping an attempt re-subscribes the matching #await after a failed import.
let editorAttempt = $state(0);
let renderedAttempt = $state(0);
let csvAttempt = $state(0);
let pdfAttempt = $state(0);
let modelAttempt = $state(0);
const editorPromise = $derived.by(() => {
	editorAttempt;
	return loadCodeEditor();
});
const renderedPromise = $derived.by(() => {
	renderedAttempt;
	return loadRenderedPreview();
});
const csvPromise = $derived.by(() => {
	csvAttempt;
	return loadCsvPreview();
});
const pdfPromise = $derived.by(() => {
	pdfAttempt;
	return loadPdfPreview();
});
const modelPromise = $derived.by(() => {
	modelAttempt;
	return loadModelPreview();
});
const modelSource = $derived.by((): ModelSource | null => {
	const format = modelFormatForPath(file.path, file.mimeType);
	if (!format) return null;
	const current = file;
	const resolve = resolveWorkspaceAsset;
	return {
		key: `${current.path}:${current.size}:${current.mtimeMs}:${current.url ?? ""}`,
		name: current.name,
		format,
		size: current.size,
		read: (options) => readFileModelBytes(current, options),
		references: (signal) =>
			workspaceReferences(current.path, async (path) =>
				resolve ? (await resolve(path, { signal })).src : null,
			),
	};
});
</script>

{#snippet LazyError(label: string, retry: () => void)}
	<div class="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
		<div class="text-[12px] text-error-soft">{label}</div>
		<button type="button" class="action-btn" onclick={retry}>{m.common_retry({}, { locale })}</button>
	</div>
{/snippet}

{#snippet DefaultFallback()}
	<div class="flex h-full flex-col items-center justify-center gap-1.5 p-6 text-center">
		<div class="text-sm font-semibold text-text-primary">{m.preview_not_available({}, { locale })}</div>
		<div class="text-xs text-text-tertiary">
			{file.mimeType ?? "application/octet-stream"} · {formatBytes(file.size)}
		</div>
		{#if downloadUrl}
			<a class="action-btn primary mt-2" href={downloadUrl} download={downloadName ?? file.name}>
				{m.download({}, { locale })}
			</a>
		{/if}
	</div>
{/snippet}

<div class="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-content">
	{#if model.kind === "markdown" && rich}
		<div class="flex min-h-0 flex-1 flex-col">
			<MarkdownView
				{source}
				variant="document"
				baseFilePath={file.path}
				{onOpenFile}
				{onOpenUrl}
				{resolveWorkspaceAsset}
			/>
		</div>
	{:else if model.kind === "html" && rich}
		<div class="flex min-h-0 flex-1 flex-col">
			{#await renderedPromise then module}
				{@const RenderedPreview = module.default}
				<RenderedPreview
					name={file.name}
					{source}
					path={file.path}
					{spaceId}
					{readonly}
					{app}
					bind:markTarget
				/>
			{:catch}
				{@render LazyError(m.preview_failed({}, { locale }), () => {
					renderedAttempt += 1;
				})}
			{/await}
		</div>
	{:else if model.kind === "csv" && rich}
		<div class="flex min-h-0 flex-1 flex-col">
			{#await csvPromise then module}
				{@const CsvPreview = module.default}
				<CsvPreview {source} name={file.name} />
			{:catch}
				{@render LazyError(m.preview_failed({}, { locale }), () => {
					csvAttempt += 1;
				})}
			{/await}
		</div>
	{:else if model.isText}
		<div class="flex min-h-0 flex-1 flex-col">
			{#await editorPromise then module}
				{@const CodeEditor = module.default}
				<CodeEditor
					value={source}
					language={model.language}
					{allowDrawerSwipe}
					{initialPosition}
					{readonly}
					{onInput}
					onVisibleLinesChange={(range) => onVisibleLinesChange?.(range)}
				/>
			{:catch}
				{@render LazyError(m.inline_editor_failed({}, { locale }), () => {
					editorAttempt += 1;
				})}
			{/await}
		</div>
	{:else if model.kind === "image" && model.mediaUrl}
		<div class="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden p-4">
			<ImageViewer
				src={model.mediaUrl}
				alt={file.name}
				bind:zoom={imageZoom}
				bind:panX={imagePanX}
				bind:panY={imagePanY}
				bind:dragging={imageDragging}
				showControls
				class="self-stretch rounded-md"
			/>
		</div>
	{:else if model.kind === "video" && model.mediaUrl}
		<div class="flex min-h-0 flex-1 items-center justify-center p-4">
			<MediaVideo
				src={model.mediaUrl}
				size={screenVariantSize(1024)}
				naturalWidth={file.media?.width}
				naturalHeight={file.media?.height}
				controls
				playsinline
				aria-label={file.name}
				class="max-h-full max-w-full rounded-md"
			>
				<track kind="captions" />
			</MediaVideo>
		</div>
	{:else if model.kind === "audio" && model.mediaUrl}
		<div class="flex min-h-0 flex-1 items-center justify-center p-4">
			<div class="w-full max-w-md">
				<AudioPlayer
					src={model.mediaUrl}
					title={file.name}
					subtitle={formatBytes(file.size)}
					downloadUrl={downloadUrl ?? undefined}
					downloadName={downloadName ?? file.name}
				/>
			</div>
		</div>
	{:else if model.kind === "pdf" && hasPdfSource}
		<div class="min-h-0 flex-1">
			{#await pdfPromise then module}
				{@const PdfPreview = module.default}
				<PdfPreview
					name={file.name}
					url={file.delivery === "url" ? (file.url ?? null) : null}
					base64={file.delivery === "url" ? null : file.content}
					version={`${file.path}:${file.size}:${file.mtimeMs}`}
					{isMobile}
				/>
			{:catch}
				{@render LazyError(m.pdf_preview_failed({}, { locale }), () => {
					pdfAttempt += 1;
				})}
			{/await}
		</div>
	{:else if model.kind === "model3d" && modelSource}
		{#await modelPromise then module}
			{@const ModelPreview = module.default}
			<ModelPreview source={modelSource} {isMobile} {downloadUrl} {downloadName} />
		{:catch}
			{@render LazyError(m.model3d_preview_failed({}, { locale }), () => {
				modelAttempt += 1;
			})}
		{/await}
	{:else if fallback}
		{@render fallback()}
	{:else}
		{@render DefaultFallback()}
	{/if}
</div>
