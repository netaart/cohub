<script lang="ts">
import type {
	AppRecord,
	SpaceFsFileResponse,
	SpacePendingDiffFileResponse,
} from "@neta-art/cohub";
import {
	ArrowLeft,
	Check,
	Code,
	Copy,
	Download,
	Eye,
	GitCompare,
	ListTree,
	Pencil,
	RefreshCw,
	Rocket,
	TextCursorInput,
	Trash2,
} from "lucide-svelte";
import CenteredLoading from "$lib/components/CenteredLoading.svelte";
import FileContentPreview from "$lib/components/FileContentPreview.svelte";
import type { PreviewCaptureTarget } from "$lib/features/preview-mark";
import PreviewMarkHost from "$lib/features/preview-mark/ui/PreviewMarkHost.svelte";
import type { FilePreviewModel } from "$lib/file-preview-model";
import { getLocale } from "$lib/i18n/locale.svelte";
import { createLazyModuleLoader, pending } from "$lib/lazy-module";
import { m } from "$lib/paraglide/messages.js";
import type { FileViewMode } from "$lib/resource-kit/diff";
import type { ResolveWorkspaceAsset } from "$lib/workspace-assets";
import type {
	OpenWorkspaceFileTarget,
	WorkspaceFilePosition,
} from "$lib/workspace-file-links";
import { formatFileSize } from "../space-utils";
import PreviewHeader from "./PreviewHeader.svelte";
import PreviewViewMode from "./preview-controls/PreviewViewMode.svelte";
import type {
	PreviewChrome,
	PreviewHeaderAction,
	PreviewOption,
} from "./preview-header";
import type { WindowSyncStatus } from "./window-sync-status";
import type { Window } from "./windows";

type InlineFilePanelState = {
	response: SpaceFsFileResponse | null;
	draft: string;
	path: string;
	position: WorkspaceFilePosition | null;
	loading: boolean;
	saving: boolean;
	syncStatus: WindowSyncStatus;
	saveError: string | null;
	error: string | null;
	tooLarge: boolean;
};

type Props = {
	inlineFile: InlineFilePanelState;
	windows: Window[];
	inlineFileCanGoBack: boolean;
	inlineFileDownloadUrl: string;
	inlineFileDownloadName: string;
	inlineFilePreview: FilePreviewModel;
	inlineFileViewMode: FileViewMode;
	inlineFileDiff: SpacePendingDiffFileResponse | null;
	inlineFileDiffLoading: boolean;
	inlineFileDiffError: string | null;
	activeFsReadonly: boolean;
	canEditFiles: boolean;
	inlineFileCopied: boolean;
	inlineFileSpaceId: string;
	inlineFileApp: AppRecord | null;
	chrome: PreviewChrome;
	isMobile: boolean;
	inlineFileZoom: number;
	inlineFilePanX: number;
	inlineFilePanY: number;
	inlineFileDragging: boolean;
	onActivateWindow: (kind: Window["kind"], key: string) => void;
	onCloseWindow: (kind: Window["kind"], key: string) => void;
	onBackInlineFile: () => void | Promise<void>;
	onOpenLinkedInlineFile: (
		target: OpenWorkspaceFileTarget,
	) => void | Promise<void>;
	resolveWorkspaceAsset: ResolveWorkspaceAsset;
	onDownloadInlineFile: () => void | Promise<void>;
	onRetryInlineFile?: () => void | Promise<void>;
	onCopyInlineFileContent: () => void | Promise<void>;
	onUpdateInlineFileDraft: (path: string, draft: string) => void;
	onRetryInlineFileSave: () => void | Promise<void>;
	onOverwriteInlineFile: () => void | Promise<void>;
	onReloadInlineFile: () => void | Promise<void>;
	onPublishInlineFile: () => void;
	onLabelFile: (
		path: string,
		anchorEl?: HTMLElement | null,
	) => void | Promise<void>;
	onInsertFilePathReference: (path: string) => void;
	onDownloadFilePath: (path: string) => void | Promise<void>;
	onRenameFilePath: (path: string) => void | Promise<void>;
	onDeleteFilePath: (path: string) => void | Promise<void>;
	onVisibleLinesChange?: (
		path: string,
		range: { start: number; end: number } | null,
	) => void;
};

let {
	inlineFile,
	windows,
	inlineFileCanGoBack,
	inlineFileDownloadUrl,
	inlineFileDownloadName,
	inlineFilePreview,
	inlineFileViewMode = $bindable(),
	inlineFileDiff,
	inlineFileDiffLoading,
	inlineFileDiffError,
	activeFsReadonly,
	canEditFiles,
	inlineFileCopied,
	inlineFileSpaceId,
	inlineFileApp,
	chrome,
	isMobile,
	inlineFileZoom = $bindable(),
	inlineFilePanX = $bindable(),
	inlineFilePanY = $bindable(),
	inlineFileDragging,
	onActivateWindow,
	onCloseWindow,
	onBackInlineFile,
	onOpenLinkedInlineFile,
	resolveWorkspaceAsset,
	onDownloadInlineFile,
	onRetryInlineFile,
	onCopyInlineFileContent,
	onUpdateInlineFileDraft,
	onRetryInlineFileSave,
	onOverwriteInlineFile,
	onReloadInlineFile,
	onPublishInlineFile,
	onLabelFile,
	onInsertFilePathReference,
	onDownloadFilePath,
	onRenameFilePath,
	onDeleteFilePath,
	onVisibleLinesChange,
}: Props = $props();

const locale = $derived(getLocale());
const previewKind = $derived(inlineFilePreview.kind);
const inlineFileIsText = $derived(inlineFilePreview.isText);
const inlineFileHasRenderedPreview = $derived(
	inlineFilePreview.hasRenderedPreview,
);
const inlineFileDataUrl = $derived(inlineFilePreview.mediaUrl);

const loadFileDiffViewModule = createLazyModuleLoader(() =>
	import.meta.env.SSR
		? pending()
		: import("$lib/components/FileDiffView.svelte"),
);
let fileDiffLoadAttempt = $state(0);
const fileDiffModulePromise = $derived.by(() => {
	fileDiffLoadAttempt;
	return loadFileDiffViewModule();
});

const showDiffMode = $derived(!activeFsReadonly && inlineFileIsText);
let imageMarkOpen = $state(false);
let htmlMarkOpen = $state(false);
let htmlMarkTarget: PreviewCaptureTarget | null = $state(null);

const activeFilePath = $derived(inlineFile?.path ?? "");
const activeResponsePath = $derived(
	inlineFile?.response?.path ?? activeFilePath,
);

const imageMarkTarget = $derived.by((): PreviewCaptureTarget | null => {
	if (previewKind !== "image" || !inlineFileDataUrl || !activeFilePath)
		return null;
	return { kind: "image", src: inlineFileDataUrl, path: activeFilePath };
});
const showHtmlMark = $derived(
	previewKind === "html" &&
		inlineFileViewMode === "preview" &&
		inlineFileHasRenderedPreview,
);

// Soft-fail: keep content surface when we still have something usable.
// Empty text files (content === "") are still editable when open succeeded.
const hasUsableText = $derived(
	Boolean(
		inlineFile &&
			inlineFileIsText &&
			inlineFile.response &&
			(!inlineFile.error ||
				Boolean(inlineFile.response?.content) ||
				Boolean(inlineFile.draft)),
	),
);
const hasUsableMedia = $derived(
	Boolean(
		((previewKind === "image" ||
			previewKind === "video" ||
			previewKind === "audio") &&
			inlineFileDataUrl) ||
			((previewKind === "pdf" || previewKind === "model3d") &&
				inlineFile.response &&
				(inlineFile.response.content || inlineFile.response.url)),
	),
);
const showExclusiveFallback = $derived(
	Boolean(
		inlineFile?.error &&
			!inlineFile.loading &&
			!hasUsableText &&
			!hasUsableMedia &&
			!inlineFile.tooLarge,
	),
);

const viewModeOptions = $derived.by((): PreviewOption[] => {
	const options: PreviewOption[] = [
		{
			value: "source",
			label: m.inline_source({}, { locale }),
			icon: Code,
			title: m.inline_edit_source({}, { locale }),
		},
	];
	if (inlineFileHasRenderedPreview) {
		options.push({
			value: "preview",
			label: m.inline_preview({}, { locale }),
			icon: Eye,
			title:
				previewKind === "markdown"
					? m.inline_preview_markdown({}, { locale })
					: previewKind === "csv"
						? m.inline_preview_table({}, { locale })
						: m.inline_preview_html({}, { locale }),
		});
	}
	if (showDiffMode) {
		options.push({
			value: "diff",
			label: m.inline_diff({}, { locale }),
			icon: GitCompare,
			title: m.inline_diff_since_save({}, { locale }),
		});
	}
	return options;
});
const activeViewMode = $derived(
	viewModeOptions.find((option) => option.value === inlineFileViewMode) ??
		viewModeOptions[0],
);

const activeActionPath = $derived(activeResponsePath || activeFilePath);
const hasResponse = $derived(Boolean(inlineFile?.response));
const primaryDownload = $derived(
	hasResponse &&
		(previewKind === "video" ||
			previewKind === "audio" ||
			previewKind === "pdf" ||
			previewKind === "model3d"),
);
const canManageFile = $derived(canEditFiles && !activeFsReadonly);
const canEditContent = $derived(canEditFiles && !activeFsReadonly);

const headerActions = $derived.by((): PreviewHeaderAction[] => {
	const list: PreviewHeaderAction[] = [];
	if (inlineFileCanGoBack) {
		list.push({
			id: "back",
			label: m.inline_back({}, { locale }),
			icon: ArrowLeft,
			primary: true,
			run: () => onBackInlineFile(),
		});
	}
	if (hasUsableText) {
		list.push({
			id: "copy",
			label: m.inline_copy_content({}, { locale }),
			icon: inlineFileCopied ? Check : Copy,
			primary: true,
			active: inlineFileCopied,
			run: () => onCopyInlineFileContent(),
		});
	}
	if (primaryDownload || inlineFile?.tooLarge) {
		list.push({
			id: "download",
			label: m.file_download({}, { locale }),
			icon: Download,
			primary: true,
			run: () => onDownloadInlineFile(),
		});
	}
	if (inlineFile?.error && !inlineFile.loading && onRetryInlineFile) {
		list.push({
			id: "retry",
			label: m.common_retry({}, { locale }),
			icon: RefreshCw,
			primary: true,
			run: () => onRetryInlineFile?.(),
		});
	}

	if (hasResponse) {
		list.push({
			id: "label",
			label: m.inline_label_as({}, { locale }),
			icon: ListTree,
			run: (_event, anchor) => onLabelFile(activeActionPath, anchor),
		});
		list.push({
			id: "reference",
			label: m.inline_insert_reference({}, { locale }),
			icon: TextCursorInput,
			run: () => onInsertFilePathReference(activeActionPath),
		});
		if (!primaryDownload && !inlineFile?.tooLarge) {
			list.push({
				id: "download",
				label: m.file_download({}, { locale }),
				icon: Download,
				run: () => onDownloadInlineFile(),
			});
		}
		if (previewKind === "html" && inlineFileViewMode === "preview") {
			list.push({
				id: "publish",
				label: m.inline_publish_app({}, { locale }),
				icon: Rocket,
				run: () => onPublishInlineFile(),
			});
		}
	}
	if (hasResponse && canManageFile) {
		list.push({
			id: "rename",
			label: m.file_rename({}, { locale }),
			icon: Pencil,
			run: () => onRenameFilePath(activeActionPath),
		});
		list.push({
			id: "delete",
			label: m.file_delete({}, { locale }),
			icon: Trash2,
			danger: true,
			run: () => onDeleteFilePath(activeActionPath),
		});
	}
	return list;
});

$effect(() => {
	if (!showHtmlMark) {
		htmlMarkOpen = false;
		htmlMarkTarget = null;
	}
});
</script>

{#snippet LazyLoadError(label: string, onRetry: () => void)}
	<div class="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
		<div class="text-[12px] text-error-soft">{label}</div>
		<button type="button" class="action-btn" onclick={onRetry}>{m.common_retry({}, { locale })}</button>
	</div>
{/snippet}

{#snippet FileOpenFallback(options: {
	title: string;
	detail: string;
	variant?: "error" | "warning" | "neutral";
	showRetry?: boolean;
})}
	{@const variant = options.variant ?? "neutral"}
	{@const border =
		variant === "error"
			? "border-error-soft/30 bg-error-bg"
			: variant === "warning"
				? "border-warning-soft/30 bg-warning-bg"
				: "border-border-subtle bg-bg-primary"}
	{@const titleColor =
		variant === "error"
			? "text-error-soft"
			: variant === "warning"
				? "text-warning-soft"
				: "text-text-primary"}
	<div class="flex flex-1 items-center justify-center p-4">
		<div class="w-full max-w-sm rounded-lg border {border} p-6 text-center">
			<div class="mb-1 text-sm font-semibold {titleColor}">{options.title}</div>
			<div class="mb-1 break-words text-xs text-text-secondary">{options.detail}</div>
			{#if inlineFile?.response}
				<div class="mt-3 space-y-0.5 text-left text-[11px] text-text-tertiary">
					<div><span class="text-text-secondary">{m.inline_name({}, { locale })}</span> · {inlineFile.response.name}</div>
					<div><span class="text-text-secondary">{m.inline_type({}, { locale })}</span> · {inlineFile.response.mimeType ?? "application/octet-stream"}</div>
					<div><span class="text-text-secondary">{m.inline_size({}, { locale })}</span> · {formatFileSize(inlineFile.response.size)}</div>
				</div>
			{/if}
			<div class="mt-4 flex flex-wrap items-center justify-center gap-2">
				{#if options.showRetry !== false && onRetryInlineFile}
					<button type="button" class="action-btn" onclick={() => void onRetryInlineFile?.()}>{m.common_retry({}, { locale })}</button>
				{/if}
				<a
					href={inlineFileDownloadUrl}
					download={inlineFileDownloadName}
					class="action-btn primary"
					onclick={(e) => {
						e.preventDefault();
						void onDownloadInlineFile();
					}}
				>
					<Download class="w-3.5 h-3.5" />
					{m.download({}, { locale })}
				</a>
			</div>
		</div>
	</div>
{/snippet}

{#snippet SoftFailBanner()}
	{#if inlineFile?.error && (hasUsableText || hasUsableMedia)}
		<div
			class="flex shrink-0 items-center gap-2 border-b border-error-soft/20 bg-error-bg px-3 py-1.5 text-[11px] text-error-soft"
		>
			<span class="min-w-0 flex-1 truncate">{inlineFile.error}</span>
			{#if onRetryInlineFile}
				<button type="button" class="action-btn" onclick={() => void onRetryInlineFile?.()}>{m.common_retry({}, { locale })}</button>
			{/if}
			<button type="button" class="action-btn" onclick={() => void onDownloadInlineFile()}>
				<Download class="w-3.5 h-3.5" />
				{m.download({}, { locale })}
			</button>
		</div>
	{/if}
{/snippet}

{#snippet SyncIssueBanner()}
	{#if inlineFile?.saveError}
		<div
			class="flex shrink-0 items-center gap-2 border-b border-error-soft/20 bg-error-bg px-3 py-1.5 text-[11px] text-error-soft"
		>
			<span class="min-w-0 flex-1 truncate">{inlineFile.saveError}</span>
			{#if inlineFile.syncStatus === "conflict"}
				<button type="button" class="action-btn" onclick={() => void onReloadInlineFile()}>{m.inline_reload({}, { locale })}</button>
				<button type="button" class="action-btn" onclick={() => void onOverwriteInlineFile()}>{m.inline_keep_mine({}, { locale })}</button>
			{:else}
				<button type="button" class="action-btn" onclick={() => void onRetryInlineFileSave()}>{m.common_retry({}, { locale })}</button>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet DiffBody()}
	<div class="flex min-h-0 flex-1 flex-col overflow-hidden">
		{#await fileDiffModulePromise then diffModule}
			{@const LazyFileDiffView = diffModule.default}
			<LazyFileDiffView
				patch={inlineFileDiff}
				loading={inlineFileDiffLoading}
				error={inlineFileDiffError}
			/>
		{:catch}
			{@render LazyLoadError(m.inline_diff_failed({}, { locale }), () => {
				fileDiffLoadAttempt += 1;
			})}
		{/await}
	</div>
{/snippet}

{#snippet PreviewNotAvailable()}
	{@render FileOpenFallback({
		title: m.preview_not_available({}, { locale }),
		detail: m.inline_preview_not_available_detail({}, { locale }),
		variant: "neutral",
		showRetry: false,
	})}
{/snippet}

<div class="inline-file-preview relative flex h-full min-w-0 flex-col bg-bg-content">
	<PreviewHeader
		{windows}
		variant={isMobile ? "mobile" : "dock"}
		actions={headerActions}
		{chrome}
		onActivate={onActivateWindow}
		onClose={onCloseWindow}
	>
		{#snippet controls()}
			{#if hasUsableText && (inlineFileHasRenderedPreview || showDiffMode)}
				<PreviewViewMode
					bind:value={inlineFileViewMode}
					options={viewModeOptions}
					triggerIcon={activeViewMode?.icon ?? Code}
					triggerLabel={activeViewMode?.label ?? m.inline_source({}, { locale })}
				/>
			{/if}
			{#if showHtmlMark}
				<PreviewMarkHost bind:open={htmlMarkOpen} target={htmlMarkTarget} />
			{/if}
			{#if imageMarkTarget}
				<PreviewMarkHost bind:open={imageMarkOpen} target={imageMarkTarget} />
			{/if}
			{#if activeFsReadonly}
				<span class="preview-readonly-badge tag">{m.inline_read_only_snapshot({}, { locale })}</span>
			{/if}
		{/snippet}
	</PreviewHeader>

	{#if inlineFile?.loading}
		<CenteredLoading label={m.inline_loading_file({}, { locale })} size="panel" />
	{:else if inlineFile?.tooLarge}
		{@render FileOpenFallback({
			title: m.inline_too_large_title({}, { locale }),
			detail: m.inline_too_large_detail({}, { locale }),
			variant: "warning",
			showRetry: false,
		})}
	{:else if showExclusiveFallback}
		{@render FileOpenFallback({
			title: m.inline_couldnt_open({}, { locale }),
			detail: inlineFile?.error ?? m.inline_failed_open({}, { locale }),
			variant: "error",
		})}
	{:else if inlineFile?.response}
		{@render SoftFailBanner()}
		{@render SyncIssueBanner()}
		{#if inlineFileIsText && inlineFileViewMode === "diff" && showDiffMode}
			{@render DiffBody()}
		{:else}
			<FileContentPreview
				file={inlineFile.response}
				source={inlineFile.draft}
				render={inlineFileViewMode === "preview" ? "preview" : "source"}
				readonly={!canEditContent}
				{isMobile}
				allowDrawerSwipe={isMobile}
				downloadUrl={inlineFileDownloadUrl}
				downloadName={inlineFileDownloadName}
				spaceId={inlineFileSpaceId}
				app={inlineFileApp}
				bind:markTarget={htmlMarkTarget}
				initialPosition={inlineFile.position}
				{resolveWorkspaceAsset}
				onOpenFile={onOpenLinkedInlineFile}
				onInput={(value) => onUpdateInlineFileDraft(inlineFile.path, value)}
				onVisibleLinesChange={(range) =>
					onVisibleLinesChange?.(inlineFile.path, range)}
				bind:imageZoom={inlineFileZoom}
				bind:imagePanX={inlineFilePanX}
				bind:imagePanY={inlineFilePanY}
				bind:imageDragging={inlineFileDragging}
			>
				{#snippet fallback()}
					{@render PreviewNotAvailable()}
				{/snippet}
			</FileContentPreview>
		{/if}
	{:else}
		<div class="flex flex-1 items-center justify-center text-xs text-text-tertiary">{m.inline_no_file_selected({}, { locale })}</div>
	{/if}
</div>

<style>
	@container preview-header (max-width: 460px) {
		.preview-readonly-badge {
			display: none;
		}
	}
</style>
