<script lang="ts">
import {
	File as FileIcon,
	History,
	ListTree,
	Loader2,
	TextCursorInput,
} from "lucide-svelte";
import { setCohubResourceDragData } from "$lib/drag/cohub-resource-drag";
import { pointerDragSource } from "$lib/drag/pointer-drag.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { formatTimeAgo } from "$lib/i18n/time-ago";
import { m } from "$lib/paraglide/messages.js";
import type { SessionFileEntry } from "./side-panel-data";

type Props = {
	files: SessionFileEntry[];
	draggable?: boolean;
	touchDraggable?: boolean;
	onOpenFile: (path: string) => void;
	onShowInFiles: (path: string) => void;
	onInsertReference?: (path: string) => void;
	onJumpToTurn?: (sequence: number) => void;
};

const {
	files,
	draggable = true,
	touchDraggable = false,
	onOpenFile,
	onShowInFiles,
	onInsertReference,
	onJumpToTurn,
}: Props = $props();

const TIME_TICK_MS = 30_000;
const locale = $derived(getLocale());
let now = $state(Date.now());

$effect(() => {
	const timer = setInterval(() => {
		now = Date.now();
	}, TIME_TICK_MS);
	return () => clearInterval(timer);
});

function splitPath(path: string) {
	const index = path.lastIndexOf("/");
	return index < 0
		? { name: path, dir: "" }
		: { name: path.slice(index + 1), dir: path.slice(0, index) };
}

function kindLabel(kind: SessionFileEntry["lastKind"]) {
	return kind === "write"
		? m.session_file_change_write({}, { locale })
		: m.session_file_change_edit({}, { locale });
}

function dragStart(event: DragEvent, file: SessionFileEntry) {
	if (!draggable) {
		event.preventDefault();
		return;
	}
	setCohubResourceDragData(
		event.dataTransfer,
		{
			version: 1,
			resources: [
				{
					type: "file",
					ref: file.path,
					title: splitPath(file.path).name,
					path: file.path,
				},
			],
			origin: { kind: "side-panel" },
			createdAt: Date.now(),
		},
		{ cohubPath: file.path, plainText: file.path, effectAllowed: "copy" },
	);
}
</script>

<ul class="space-y-px">
	{#each files as file (file.path)}
		{@const parts = splitPath(file.path)}
		<li
			class="file-row group"
			draggable={draggable}
			ondragstart={(event) => dragStart(event, file)}
			use:pointerDragSource={{
				enabled: touchDraggable,
				getPayload: () => ({
					origin: "side-panel",
					items: [{ type: "file", path: file.path, name: parts.name }],
				}),
			}}
		>
			<button
				type="button"
				class="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-1.5 text-left"
				title={file.path}
				onclick={() => onOpenFile(file.path)}
			>
				<FileIcon class="h-3.5 w-3.5 shrink-0 text-text-placeholder" />
				<span class="min-w-0 flex-1">
					<span class="block truncate text-[12px] leading-4 text-text-secondary">{parts.name}</span>
					{#if parts.dir}
						<span class="block truncate text-[10px] leading-4 text-text-placeholder" dir="rtl"><bdi>{parts.dir}</bdi></span>
					{/if}
				</span>
				<span class="file-meta">
					{#if file.active}
						<Loader2 class="h-3 w-3 animate-spin text-brand" />
						<span>{m.session_file_writing({}, { locale })}</span>
					{:else}
						<span>{kindLabel(file.lastKind)}</span>
						<span aria-hidden="true">·</span>
						<span class="tabular-nums">{formatTimeAgo(Date.parse(file.lastChangedAt), now, locale)}</span>
					{/if}
				</span>
			</button>
			<span class="file-actions">
				{#if onInsertReference}
					<button type="button" class="file-action" title={m.file_insert({}, { locale })} aria-label={m.file_insert({}, { locale })} onclick={() => onInsertReference(file.path)}>
						<TextCursorInput class="h-3.5 w-3.5" />
					</button>
				{/if}
				<button type="button" class="file-action" title={m.session_file_show_in_files({}, { locale })} aria-label={m.session_file_show_in_files({}, { locale })} onclick={() => onShowInFiles(file.path)}>
					<ListTree class="h-3.5 w-3.5" />
				</button>
				{#if onJumpToTurn && file.lastTurnSequence !== null}
					{@const sequence = file.lastTurnSequence}
					<button type="button" class="file-action" title={m.session_file_jump_to_turn({ sequence }, { locale })} aria-label={m.session_file_jump_to_turn({ sequence }, { locale })} onclick={() => onJumpToTurn(sequence)}>
						<History class="h-3.5 w-3.5" />
					</button>
				{/if}
			</span>
		</li>
	{/each}
</ul>

<style>
	.file-row {
		position: relative;
		display: flex;
		min-width: 0;
		align-items: center;
		border-radius: var(--sidebar-item-radius, 6px);
		transition: background-color 100ms ease;
	}

	.file-row:hover {
		background: var(--sidebar-item-hover-bg, var(--bg-hover));
	}

	.file-meta {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		gap: 4px;
		padding-right: 6px;
		font-size: 10px;
		color: var(--text-placeholder);
	}

	.file-actions {
		position: absolute;
		right: 4px;
		display: none;
		align-items: center;
		gap: 1px;
		padding-left: 12px;
		background: linear-gradient(to right, transparent, var(--sidebar-item-hover-bg, var(--bg-hover)) 12px);
	}

	.file-row:hover .file-actions,
	.file-row:focus-within .file-actions {
		display: inline-flex;
	}

	.file-row:hover .file-meta,
	.file-row:focus-within .file-meta {
		visibility: hidden;
	}

	@media (hover: none) {
		.file-actions {
			display: none !important;
		}

		.file-row .file-meta {
			visibility: visible !important;
		}
	}

	.file-action {
		display: inline-flex;
		height: 24px;
		width: 24px;
		align-items: center;
		justify-content: center;
		border-radius: 5px;
		color: var(--text-tertiary);
		transition: color 100ms ease, background-color 100ms ease;
	}

	.file-action:hover {
		background: var(--bg-hover-strong);
		color: var(--text-primary);
	}
</style>
