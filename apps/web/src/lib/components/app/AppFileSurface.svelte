<script lang="ts">
import { isTextMime } from "@cohub/protocol/fs";
import type { SpaceFsFileResponse, WorkContent } from "@neta-art/cohub";
import { Download } from "lucide-svelte";
import CenteredLoading from "$lib/components/CenteredLoading.svelte";
import FileContentPreview from "$lib/components/FileContentPreview.svelte";
import { saveFile } from "$lib/downloads.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const locale = $derived(getLocale());

import { tryResolveTextFileResponse } from "$lib/space-file-text";
import type { ResolveWorkspaceAsset } from "$lib/workspace-assets";
import type { WorkspaceFileLinkTarget } from "$lib/workspace-file-links";

const {
	content,
	isMobile = false,
	resolveWorkspaceAsset,
	onOpenFile,
	onOpenUrl,
}: {
	content: Extract<WorkContent, { kind: "file" }>;
	isMobile?: boolean;
	resolveWorkspaceAsset?: ResolveWorkspaceAsset;
	onOpenFile?: (target: WorkspaceFileLinkTarget) => void | Promise<void>;
	onOpenUrl?: (href: string, event: MouseEvent) => void | Promise<void>;
} = $props();

function responseFromContent(value: typeof content): SpaceFsFileResponse {
	const text = isTextMime(value.mimeType);
	return {
		path: value.path,
		name: value.name,
		size: value.sizeBytes,
		mimeType: value.mimeType,
		mtimeMs: 0,
		kind: text ? "text" : "binary",
		encoding: text ? "utf-8" : "base64",
		content: "",
		delivery: "url",
		url: value.url,
	};
}

/** Hydration result, keyed by path so a switch never shows the previous file. */
let hydrated = $state<{
	path: string;
	file: SpaceFsFileResponse;
	error: string | null;
} | null>(null);

const base = $derived(responseFromContent(content));
const resolved = $derived(hydrated?.path === base.path ? hydrated : null);
const file = $derived(resolved?.file ?? base);
const error = $derived(resolved?.error ?? null);
// Only text needs a follow-up fetch; media renders straight from the CDN URL.
const loading = $derived(isTextMime(base.mimeType) && !resolved);

function download() {
	const { url, name, mimeType } = content;
	void saveFile({
		key: url,
		name,
		mimeType,
		source: () => ({ kind: "url", url }),
	});
}

$effect(() => {
	const next = base;
	let cancelled = false;
	void tryResolveTextFileResponse(next).then((result) => {
		if (cancelled) return;
		hydrated = { path: next.path, file: result.file, error: result.error };
	});
	return () => {
		cancelled = true;
	};
});
</script>

<div class="work-file-surface">
	<header class="work-file-header">
		<div class="file-identity">
			<span class="file-name">{content.name}</span>
			<span class="file-type">{content.mimeType ?? "application/octet-stream"}</span>
		</div>
		<button
			type="button"
			class="icon-btn"
			onclick={download}
			title={m.download({}, { locale })}
			aria-label={m.download({}, { locale })}
		>
			<Download class="h-4 w-4" />
		</button>
	</header>
	{#if error}
		<div class="file-error">{error}</div>
	{/if}
	<div class="file-content">
		{#if loading}
			<CenteredLoading label="Loading file…" size="panel" />
		{:else}
			<FileContentPreview
				{file}
				source={file.content}
				onDownload={download}
				{isMobile}
				{resolveWorkspaceAsset}
				{onOpenFile}
				{onOpenUrl}
			/>
		{/if}
	</div>
</div>

<style>
	.work-file-surface {
		display: flex;
		height: 100%;
		min-height: 0;
		flex-direction: column;
		background: var(--bg-content);
	}

	.work-file-header {
		display: flex;
		height: 44px;
		flex-shrink: 0;
		align-items: center;
		gap: 0.75rem;
		border-bottom: 1px solid var(--border-subtle);
		background: var(--bg-surface);
		padding: 0 0.75rem;
	}

	.file-identity {
		display: flex;
		min-width: 0;
		flex: 1;
		align-items: baseline;
		gap: 0.65rem;
	}

	.file-name {
		overflow: hidden;
		color: var(--text-secondary);
		font-size: 0.8125rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file-type {
		display: none;
		color: var(--text-tertiary);
		font-size: 0.6875rem;
	}

	.file-error {
		flex-shrink: 0;
		border-bottom: 1px solid color-mix(in srgb, var(--color-error-soft) 20%, transparent);
		background: var(--color-error-bg);
		padding: 0.4rem 0.75rem;
		color: var(--color-error-soft);
		font-size: 0.6875rem;
	}

	.file-content {
		display: flex;
		min-height: 0;
		flex: 1;
		flex-direction: column;
	}

	@media (min-width: 640px) {
		.file-type {
			display: inline;
		}
	}
</style>
