<script lang="ts">
import type {
	CheckpointDiffFile,
	CheckpointDiffFileResponse,
	CheckpointDiffStats,
	CheckpointDiffStatus,
} from "@neta-art/cohub";
import { ChevronDown, ChevronRight, FileDiff, Loader2 } from "lucide-svelte";
import { m } from "../paraglide/messages.js";
import { intlTag, type Locale } from "./core.ts";
import {
	diffStatusClass,
	formatDiffBytes,
	formatDiffCounts,
	patchLineClass,
	patchLinePrefix,
} from "./diff.ts";

type SummaryLike = {
	files: CheckpointDiffFile[];
	truncated: boolean;
	stats: CheckpointDiffStats;
	incomplete?: boolean;
};

type Props = {
	locale: Locale;
	summary: SummaryLike | null;
	loading?: boolean;
	error?: string | null;
	emptyLabel?: string;
	collapsible?: boolean;
	defaultExpanded?: boolean;
	title?: string;
	cacheKey?: string | null;
	onExpand?: () => void;
	loadFile: (path: string) => Promise<CheckpointDiffFileResponse | null>;
};

let {
	locale,
	summary,
	loading = false,
	error = null,
	emptyLabel = "",
	collapsible = false,
	defaultExpanded = false,
	title = "",
	cacheKey = null,
	onExpand,
	loadFile,
}: Props = $props();

const resolvedTitle = $derived(title || m.cdp_changes({}, { locale }));
const resolvedEmptyLabel = $derived(
	emptyLabel || m.cdp_no_changes({}, { locale }),
);

let sectionOpen = $state(false);
let expanded = $state<Record<string, boolean>>({});
let fileCache = $state<Record<string, CheckpointDiffFileResponse | null>>({});
let fileLoading = $state<Record<string, boolean>>({});
let fileError = $state<Record<string, string | null>>({});
let lastCacheKey = $state<string | null>(null);

$effect(() => {
	sectionOpen = collapsible ? defaultExpanded : true;
});

$effect(() => {
	const nextKey = cacheKey ?? null;
	if (lastCacheKey === nextKey) return;
	lastCacheKey = nextKey;
	expanded = {};
	fileCache = {};
	fileLoading = {};
	fileError = {};
});

function toggleSection() {
	const next = !sectionOpen;
	sectionOpen = next;
	if (next) onExpand?.();
}

function statusLabel(status: CheckpointDiffStatus): string {
	switch (status) {
		case "A":
			return "A";
		case "M":
		case "T":
			return "M";
		case "D":
			return "D";
		case "R":
			return "R";
		case "C":
			return "C";
		default:
			return status;
	}
}

function formatCounts(file: CheckpointDiffFile): string {
	if (file.asset || file.binary) return m.cdp_bin({}, { locale });
	return formatDiffCounts(file.additions, file.deletions);
}

async function toggleFile(file: CheckpointDiffFile) {
	const key = file.path;
	const next = !expanded[key];
	expanded = { ...expanded, [key]: next };
	if (!next) return;
	if (key in fileCache || fileLoading[key]) return;
	if (file.asset || file.binary) {
	}
	fileLoading = { ...fileLoading, [key]: true };
	fileError = { ...fileError, [key]: null };
	try {
		const result = await loadFile(file.path);
		fileCache = { ...fileCache, [key]: result };
		if (!result)
			fileError = { ...fileError, [key]: m.cdp_load_failed({}, { locale }) };
	} catch (err) {
		fileError = {
			...fileError,
			[key]:
				err instanceof Error ? err.message : m.cdp_load_failed({}, { locale }),
		};
		fileCache = { ...fileCache, [key]: null };
	} finally {
		fileLoading = { ...fileLoading, [key]: false };
	}
}

function displayPath(file: CheckpointDiffFile): string {
	if (file.oldPath && file.oldPath !== file.path) {
		return `${file.oldPath} → ${file.path}`;
	}
	return file.path;
}

function statsLine(stats: CheckpointDiffStats): string {
	const parts: string[] = [];
	if (stats.changedFileCount > 0) {
		const count = stats.changedFileCount;
		parts.push(
			count === 1
				? m.cdp_files_one({ count }, { locale })
				: m.cdp_files_many({ count }, { locale }),
		);
	}
	if (stats.additions > 0)
		parts.push(`+${stats.additions.toLocaleString(intlTag(locale))}`);
	if (stats.deletions > 0)
		parts.push(`−${stats.deletions.toLocaleString(intlTag(locale))}`);
	return parts.join(" · ") || m.cdp_no_changes({}, { locale });
}
</script>

<div class="min-w-0">
	{#if collapsible}
		<button
			type="button"
			class="group flex w-full items-center gap-2 rounded-[6px] px-0 py-1.5 text-left transition-colors"
			onclick={toggleSection}
			aria-expanded={sectionOpen}
		>
			<span class="shrink-0 text-text-placeholder transition-colors group-hover:text-text-tertiary">
				{#if sectionOpen}
					<ChevronDown class="h-3.5 w-3.5" />
				{:else}
					<ChevronRight class="h-3.5 w-3.5" />
				{/if}
			</span>
			<span class="flex min-w-0 flex-1 items-center gap-2">
				<span class="text-[11px] font-medium uppercase tracking-wider text-text-placeholder">{resolvedTitle}</span>
				{#if loading && !summary}
					<span class="inline-flex items-center gap-1.5 text-[12px] text-text-tertiary">
						<Loader2 class="h-3 w-3 animate-spin" />
						{m.cdp_scanning({}, { locale })}
					</span>
				{:else if summary}
					<span class="truncate font-mono text-[12px] tabular-nums text-text-tertiary">
						{statsLine(summary.stats)}
						{#if summary.incomplete}
							<span class="text-text-placeholder">{m.cdp_partial({}, { locale })}</span>
						{/if}
					</span>
				{:else if error}
					<span class="truncate text-[12px] text-error-soft">{m.cdp_unavailable({}, { locale })}</span>
				{:else}
					<span class="text-[12px] text-text-placeholder">{resolvedEmptyLabel}</span>
				{/if}
			</span>
			{#if !sectionOpen && summary && summary.stats.changedFileCount > 0}
				<span class="shrink-0 text-[11px] text-text-placeholder opacity-0 transition-opacity group-hover:opacity-100">
					{m.cdp_review({}, { locale })}
				</span>
			{/if}
		</button>
	{:else}
		<div class="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-text-placeholder">
			<FileDiff class="h-3.5 w-3.5 shrink-0" />
			{resolvedTitle}
			{#if summary}
				<span class="font-mono normal-case tracking-normal text-text-tertiary">
					{statsLine(summary.stats)}
				</span>
			{/if}
		</div>
	{/if}

	{#if sectionOpen}
		<div class={collapsible ? "mt-1.5" : ""}>
			{#if loading && !summary}
				<div class="flex items-center gap-2 px-1 py-3 text-[12px] text-text-tertiary">
					<Loader2 class="h-3.5 w-3.5 animate-spin" />
					{m.cdp_loading_changes({}, { locale })}
				</div>
			{:else if error}
				<div class="rounded-[6px] border border-error-soft/25 bg-error-bg/30 px-3 py-2.5 text-[12px] text-error-soft">
					{error}
				</div>
			{:else if !summary || summary.files.length === 0}
				<div class="px-1 py-3 text-[12px] text-text-tertiary">
					{#if summary?.incomplete}
						{m.cdp_pending_unavailable({}, { locale })}
					{:else}
						{resolvedEmptyLabel}
					{/if}
				</div>
			{:else}
				<div class="overflow-hidden rounded-[6px] border border-border-subtle/60">
					<ul class="divide-y divide-border-subtle/40">
						{#each summary.files as file (file.path)}
							{@const isOpen = Boolean(expanded[file.path])}
							{@const patch = fileCache[file.path]}
							{@const isFileLoading = Boolean(fileLoading[file.path])}
							{@const err = fileError[file.path]}
							<li class="min-w-0">
								<button
									type="button"
									class="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-bg-hover/50"
									onclick={() => toggleFile(file)}
								>
									<span class="w-3 shrink-0 text-text-placeholder">
										{#if isOpen}
											<ChevronDown class="h-3 w-3" />
										{:else}
											<ChevronRight class="h-3 w-3" />
										{/if}
									</span>
									<span class={`w-3.5 shrink-0 text-center font-mono text-[11px] font-semibold ${diffStatusClass(file.status)}`}>
										{statusLabel(file.status)}
									</span>
									<span
										class="min-w-0 flex-1 truncate font-mono text-[12px] text-text-secondary"
										title={displayPath(file)}
									>
										{displayPath(file)}
									</span>
									<span class="shrink-0 font-mono text-[11px] tabular-nums text-text-placeholder">
										{formatCounts(file)}
									</span>
								</button>

								{#if isOpen}
									<div class="border-t border-border-subtle/30 bg-bg-elevated/20">
										{#if isFileLoading}
											<div class="flex items-center gap-2 px-3 py-2.5 text-[12px] text-text-tertiary">
												<Loader2 class="h-3.5 w-3.5 animate-spin" />
												{m.cdp_loading({}, { locale })}
											</div>
										{:else if err}
											<div class="px-3 py-2.5 text-[12px] text-error-soft">{err}</div>
										{:else if patch}
											{#if patch.kind === "asset"}
												<div class="px-3 py-2.5 text-[12px] text-text-tertiary">
													{m.diff_binary_asset({}, { locale })}
													<span class="font-mono text-text-secondary">
														({formatDiffBytes(patch.oldSize)} → {formatDiffBytes(patch.newSize)})
													</span>
												</div>
											{:else if patch.kind === "binary"}
												<div class="px-3 py-2.5 text-[12px] text-text-tertiary">
													{m.diff_binary_file({}, { locale })}
													<span class="font-mono text-text-secondary">
														({formatDiffBytes(patch.oldSize)} → {formatDiffBytes(patch.newSize)})
													</span>
												</div>
											{:else if patch.kind === "too_large"}
												<div class="px-3 py-2.5 text-[12px] text-text-tertiary">
													{m.diff_too_large({}, { locale })}
												</div>
											{:else if patch.lines.length === 0}
												<div class="px-3 py-2.5 text-[12px] text-text-tertiary">{m.cdp_no_textual({}, { locale })}</div>
											{:else}
												<div class="max-h-[min(42dvh,18rem)] overflow-auto overscroll-contain [scrollbar-width:thin]">
													{#each patch.lines as line, index (`${index}-${line.type}`)}
														{#if line.type !== "meta"}
															<div class={`grid grid-cols-[1rem_minmax(0,1fr)] gap-1 border-l px-2 py-px font-mono text-[11.5px] leading-snug ${patchLineClass(line.type)}`}>
																<span class="select-none opacity-80">{patchLinePrefix(line.type)}</span>
																<span class="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{line.text || " "}</span>
															</div>
														{/if}
													{/each}
													{#if patch.truncated}
														<div class="px-3 py-1.5 text-[11px] text-text-placeholder">{m.diff_truncated_suffix({}, { locale })}</div>
													{/if}
												</div>
											{/if}
										{:else}
											<div class="px-3 py-2.5 text-[12px] text-text-tertiary">{m.cdp_unavailable({}, { locale })}</div>
										{/if}
									</div>
								{/if}
							</li>
						{/each}
					</ul>
					{#if summary.truncated || summary.incomplete}
						<div class="border-t border-border-subtle/40 px-2.5 py-1.5 text-[11px] text-text-placeholder">
							{#if summary.incomplete}
								{m.cdp_partial_scan({}, { locale })}
							{:else}
								{m.cdp_showing_first({ count: summary.files.length }, { locale })}
							{/if}
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>
