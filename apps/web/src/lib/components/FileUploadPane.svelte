<script lang="ts">
import { AlertCircle, Check, RefreshCw, Upload, X } from "lucide-svelte";
import { onDestroy } from "svelte";
import UploadProgress from "$lib/components/UploadProgress.svelte";
import { formatBytes } from "$lib/format-bytes";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import {
	type SpaceUploadProgress,
	type SpaceUploadTask,
	createSpaceUploadTask,
} from "$lib/space-upload";
import type { LocalUploadEntry } from "$lib/upload-entries";
import {
	describeUploadError,
	exceedsUploadFileLimit,
	uploadFileLimitLabel,
} from "$lib/upload-errors";

type UploadItem = {
	file: File;
	relativePath: string;
	id: string;
	/** `rejected` files exceed the size limit and are never sent or retried. */
	status: "pending" | "uploading" | "importing" | "done" | "error" | "rejected";
	progress?: number;
};

type QueuedUploadBatch = {
	entries: LocalUploadEntry[];
	signature: string;
	targetDir: string;
};

const {
	spaceId,
	targetDir = "",
	files = [],
	entries = [],
	open = false,
	onClose,
	onComplete,
}: {
	spaceId: string;
	targetDir?: string;
	files?: File[];
	entries?: LocalUploadEntry[];
	open?: boolean;
	onClose?: () => void;
	onComplete?: () => void;
} = $props();

const locale = $derived(getLocale());
const limitLabel = uploadFileLimitLabel();

let items = $state<UploadItem[]>([]);

const importing = $derived(items.filter((i) => i.status === "importing"));
const rejected = $derived(items.filter((i) => i.status === "rejected"));
const failedCount = $derived(
	items.filter((i) => i.status === "error" || i.status === "rejected").length,
);
const totalCount = $derived(items.length);
const totalBytes = $derived(
	items.reduce((s, i) => (i.status === "rejected" ? s : s + i.file.size), 0),
);
let uploadedBytes = $state(0);
let uploadError = $state.raw<unknown>(null);
const errorMessage = $derived(
	uploadError == null ? null : describeUploadError(uploadError, locale),
);
let uploadController = $state<AbortController | null>(null);
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let stage = $state<
	"idle" | "preparing" | "uploading" | "importing" | "done" | "error"
>("idle");
const progressPercent = $derived(
	totalBytes > 0 ? Math.round((uploadedBytes / totalBytes) * 100) : 100,
);
const busy = $derived(stage === "preparing" || stage === "uploading");

let lastSignature = $state("");
let activeBatchId = $state("");
let activeTargetDir = $state("");
let queuedBatches = $state<QueuedUploadBatch[]>([]);
let uploadTask: SpaceUploadTask | null = null;
let uploadQueue: UploadItem[] = [];
let uploadBaseBytes = 0;

function effectiveEntries() {
	return entries.length > 0
		? entries
		: files.map((file) => ({ file, relativePath: file.name }));
}

function startBatch(
	uploadEntries: LocalUploadEntry[],
	signature: string,
	uploadTargetDir: string,
	carried: UploadItem[] = [],
) {
	if (closeTimer) clearTimeout(closeTimer);
	const previousController = uploadController;
	const batchId = crypto.randomUUID();
	activeBatchId = batchId;
	activeTargetDir = uploadTargetDir;
	previousController?.abort();
	void uploadTask?.cancel();
	uploadTask = null;
	lastSignature = signature;
	items = [
		...carried,
		...uploadEntries.map((entry) => ({
			file: entry.file,
			relativePath: entry.relativePath,
			id: crypto.randomUUID(),
			status: exceedsUploadFileLimit(entry.file)
				? ("rejected" as const)
				: ("pending" as const),
		})),
	];
	uploadQueue = items.filter((item) => item.status !== "done" && item.status !== "rejected");
	uploadBaseBytes = items.reduce((sum, item) => item.status === "done" ? sum + item.file.size : sum, 0);
	uploadedBytes = uploadBaseBytes;
	void uploadAll(batchId, uploadTargetDir);
}

function processNewFiles() {
	const uploadEntries = effectiveEntries();
	const signature = uploadEntries
		.map(
			(entry) =>
				`${entry.relativePath}:${entry.file.size}:${entry.file.lastModified}`,
		)
		.join("|");
	if (
		uploadEntries.length === 0 ||
		(signature === lastSignature && targetDir === activeTargetDir)
	)
		return;
	if (stage === "importing") {
		const duplicate = queuedBatches.some(
			(batch) => batch.signature === signature && batch.targetDir === targetDir,
		);
		if (!duplicate) {
			queuedBatches = [
				...queuedBatches,
				{ entries: uploadEntries, signature, targetDir },
			];
		}
		return;
	}
	startBatch(uploadEntries, signature, targetDir);
}

// React to file changes
$effect(() => {
	void files.length;
	void entries.length;
	queueMicrotask(() => processNewFiles());
});

function queueItemState(
	index: number,
	size: number,
	progress: SpaceUploadProgress,
): Pick<UploadItem, "status" | "progress"> {
	if (progress.stage === "done" || index < progress.importedFiles)
		return { status: "done", progress: 100 };
	if (index < progress.completedFiles)
		return { status: "importing", progress: 100 };
	if (index === progress.activeFileIndex)
		return {
			status: "uploading",
			progress:
				size > 0
					? Math.round((progress.activeFileUploadedBytes / size) * 100)
					: 100,
		};
	return { status: "pending", progress: undefined };
}

function applyQueueState(
	queue: UploadItem[],
	stateOf: (
		index: number,
		item: UploadItem,
	) => Pick<UploadItem, "status" | "progress">,
) {
	const next = new Map(
		queue.map((item, index) => [item.id, stateOf(index, item)]),
	);
	items = items.map((item) => {
		const state = next.get(item.id);
		return state ? { ...item, ...state } : item;
	});
}

async function uploadAll(batchId: string, uploadTargetDir: string) {
	if (activeBatchId !== batchId) return;
	const queue = uploadQueue;
	uploadError = null;
	if (queue.length === 0) {
		finishRun(batchId);
		return;
	}
	const controller = new AbortController();
	uploadController = controller;
	let importedFiles = 0;
	try {
		stage = "preparing";
		uploadTask ??= createSpaceUploadTask({
			spaceId,
			targetDir: uploadTargetDir,
			entries: queue.map(({ file, relativePath }) => ({ file, relativePath })),
		});
		await uploadTask.run({
			signal: controller.signal,
			onProgress: (progress) => {
				if (activeBatchId !== batchId) return;
				importedFiles = progress.importedFiles;
				stage = progress.stage;
				uploadedBytes = uploadBaseBytes + progress.uploadedBytes;
				applyQueueState(queue, (index, item) =>
					queueItemState(index, item.file.size, progress),
				);
			},
		});
		if (activeBatchId !== batchId) return;
		onComplete?.();
		finishRun(batchId);
	} catch (error) {
		if (activeBatchId !== batchId) return;
		if (error instanceof Error && error.name === "AbortError") {
			if (items.length > 0) handleReset();
			return;
		}
		console.warn("[upload] space upload failed", error);
		stage = "error";
		uploadError = error;
		// Earlier batches are already saved; refresh so they show up.
		if (importedFiles > 0) onComplete?.();
		applyQueueState(queue, (index) =>
			index < importedFiles
				? { status: "done", progress: 100 }
				: { status: "error", progress: undefined },
		);
	} finally {
		if (uploadController === controller) uploadController = null;
	}
}

function finishRun(batchId: string) {
	stage = "done";
	const [nextBatch, ...remainingBatches] = queuedBatches;
	if (nextBatch) {
		queuedBatches = remainingBatches;
		// Carry skipped files over so their reason stays visible.
		startBatch(
			nextBatch.entries,
			nextBatch.signature,
			nextBatch.targetDir,
			rejected,
		);
		return;
	}
	// Keep skipped files on screen until the user dismisses them.
	if (rejected.length > 0) return;
	closeTimer = setTimeout(() => {
		if (activeBatchId === batchId) handleReset();
	}, 1600);
}

function handleReset() {
	if (closeTimer) clearTimeout(closeTimer);
	closeTimer = null;
	void uploadTask?.cancel();
	uploadTask = null;
	uploadQueue = [];
	onClose?.();
	items = [];
	lastSignature = "";
	activeBatchId = "";
	activeTargetDir = "";
	queuedBatches = [];
	stage = "idle";
	uploadedBytes = 0;
	uploadError = null;
}

function handleDismiss() {
	if (busy) uploadController?.abort();
	handleReset();
}

function handleRetry() {
	const batchId = crypto.randomUUID();
	activeBatchId = batchId;
	void uploadAll(batchId, activeTargetDir);
}

onDestroy(() => {
	if (closeTimer) clearTimeout(closeTimer);
	activeBatchId = "";
	queuedBatches = [];
	items = [];
	uploadController?.abort();
	void uploadTask?.cancel();
	uploadTask = null;
	uploadQueue = [];
});
</script>

{#if open && items.length > 0}
  <div class="upload-pane">
    <div class="header">
      <span class="title">
        {#if stage === "preparing"}
          {m.upload_preparing({}, { locale })}
        {:else if stage === "uploading"}
          {m.upload_uploading({ percent: progressPercent }, { locale })}
        {:else if importing.length > 0 || stage === "importing"}
          {m.upload_finalizing({}, { locale })}
        {:else if failedCount > 0}
          {failedCount === 1
            ? m.upload_failed({ count: failedCount }, { locale })
            : m.upload_failed_many({ count: failedCount }, { locale })}
        {:else}
          {m.upload_complete({}, { locale })}
        {/if}
      </span>
      {#if stage !== "importing"}
        <div class="header-actions">
          {#if stage === "error"}
            <button class="close-btn" type="button" onclick={handleRetry} title={m.upload_retry({}, { locale })} aria-label={m.upload_retry({}, { locale })}>
              <RefreshCw class="w-3.5 h-3.5" />
            </button>
          {/if}
          <button class="close-btn" type="button" onclick={handleDismiss} title={busy ? m.upload_cancel({}, { locale }) : m.upload_close({}, { locale })} aria-label={busy ? m.upload_cancel({}, { locale }) : m.upload_close({}, { locale })}>
            <X class="w-3.5 h-3.5" />
          </button>
        </div>
      {/if}
    </div>

    {#if stage !== "error" && totalBytes > 0}
      <UploadProgress value={stage === "uploading" || stage === "done" ? progressPercent : null} label={stage === "importing" ? m.upload_finalizing_label({}, { locale }) : m.upload_progress_label({}, { locale })} />
    {/if}

    {#if errorMessage || rejected.length > 0}
      <div class="notice" role="status">
        {#if errorMessage}<p>{errorMessage}</p>{/if}
        {#if rejected.length > 0}
          <p>
            {rejected.length === 1
              ? m.upload_skipped_too_large_one({ count: 1, limit: limitLabel }, { locale })
              : m.upload_skipped_too_large_many({ count: rejected.length, limit: limitLabel }, { locale })}
          </p>
        {/if}
      </div>
    {/if}

    <div class="list">
      {#each items as item (item.id)}
        <div class="item" class:error={item.status === "error" || item.status === "rejected"} title={item.relativePath}>
          <span class="name">{item.relativePath}</span>
          {#if item.status === "uploading" && item.progress !== undefined}
            <span class="meta">{item.progress}%</span>
          {:else if item.status === "rejected"}
            <span class="meta reason">{m.upload_reason_too_large({ limit: limitLabel }, { locale })}</span>
          {/if}
          {#if item.status === "error" || item.status === "rejected"}
            <AlertCircle class="w-3.5 h-3.5 shrink-0 text-error-soft" />
          {:else if item.status === "done"}
            <Check class="w-3.5 h-3.5 shrink-0 text-success-soft" />
          {:else}
            <Upload class="w-3.5 h-3.5 shrink-0 animate-pulse text-text-tertiary" />
          {/if}
        </div>
      {/each}
    </div>

    <div class="footer">
      {totalCount === 1
        ? m.upload_file_count_one({ count: totalCount }, { locale })
        : m.upload_file_count_many({ count: totalCount }, { locale })} · {formatBytes(stage === "done" ? totalBytes : uploadedBytes)} / {formatBytes(totalBytes)}{#if queuedBatches.length > 0} · {m.upload_queued({ count: queuedBatches.length }, { locale })}{/if}
    </div>
  </div>
{/if}

<style>
  .upload-pane {
    position: absolute;
    bottom: 12px;
    right: 12px;
    width: 260px;
    max-height: 320px;
    background: var(--bg-primary);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
    z-index: 50;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .title {
    min-width: 0;
    overflow: hidden;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .header-actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 2px;
  }

  .close-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
  }

  .close-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .list {
    flex: 1;
    overflow-y: auto;
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px;
    border-radius: 6px;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .item.error {
    color: var(--color-error-soft);
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    flex-shrink: 0;
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
  }

  .meta.reason {
    color: inherit;
  }

  .notice {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 12px;
    line-height: 1.45;
    color: var(--color-error-soft);
  }

  .footer {
    padding: 6px 12px;
    border-top: 1px solid var(--border-subtle);
    font-size: 11px;
    color: var(--text-tertiary);
  }
</style>
