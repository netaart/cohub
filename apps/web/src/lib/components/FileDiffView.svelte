<script lang="ts">
import type { SpacePendingDiffFileResponse } from "@neta-art/cohub";
import { Loader2 } from "lucide-svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import {
	diffStatusClass,
	diffStatusLabel,
	formatDiffBytes,
	formatDiffCounts,
	isUnchangedPendingDiff,
	patchLineClass,
	patchLinePrefix,
} from "#lib/resource-kit/diff.ts";

type Props = {
	patch: SpacePendingDiffFileResponse | null;
	loading?: boolean;
	error?: string | null;
	emptyLabel?: string;
};

let { patch, loading = false, error = null, emptyLabel = "" }: Props = $props();

const locale = $derived(getLocale());
const resolvedEmptyLabel = $derived(
	emptyLabel || m.diff_no_changes({}, { locale }),
);

const counts = $derived(
	patch ? formatDiffCounts(patch.additions, patch.deletions) : "",
);
const unchanged = $derived(isUnchangedPendingDiff(patch));
</script>

<div class="flex h-full min-h-0 flex-col overflow-hidden bg-bg-content">
	{#if loading && !patch}
		<div class="flex flex-1 items-center justify-center gap-2 text-[12px] text-text-tertiary">
			<Loader2 class="h-3.5 w-3.5 animate-spin" />
			{m.diff_loading({}, { locale })}
		</div>
	{:else if error && !patch}
		<div class="m-4 rounded-[6px] border border-error-soft/25 bg-error-bg/30 px-3 py-2.5 text-[12px] text-error-soft">
			{error}
		</div>
	{:else if !patch || unchanged}
		<div class="flex flex-1 items-center justify-center px-4 text-[12px] text-text-tertiary">
			{resolvedEmptyLabel}
		</div>
	{:else}
		<div class="flex h-8 shrink-0 items-center gap-2 border-b border-border-subtle/60 bg-bg-surface px-3">
			<span class={`text-[11px] font-semibold ${diffStatusClass(patch.status)}`}>
				{diffStatusLabel(patch.status, locale)}
			</span>
			{#if counts}
				<span class="font-mono text-[11px] tabular-nums text-text-placeholder">{counts}</span>
			{/if}
			{#if loading}
				<Loader2 class="h-3 w-3 animate-spin text-text-placeholder" />
			{/if}
			{#if patch.truncated}
				<span class="text-[11px] text-text-placeholder">{m.diff_truncated({}, { locale })}</span>
			{/if}
		</div>
		<div class="min-h-0 flex-1 overflow-auto overscroll-contain [scrollbar-width:thin]">
			{#if patch.kind === "asset"}
				<div class="px-4 py-6 text-[12px] text-text-tertiary">
					{m.diff_binary_asset({}, { locale })}
					<span class="font-mono text-text-secondary">
						({formatDiffBytes(patch.oldSize)} → {formatDiffBytes(patch.newSize)})
					</span>
				</div>
			{:else if patch.kind === "binary"}
				<div class="px-4 py-6 text-[12px] text-text-tertiary">
					{m.diff_binary_file({}, { locale })}
					<span class="font-mono text-text-secondary">
						({formatDiffBytes(patch.oldSize)} → {formatDiffBytes(patch.newSize)})
					</span>
				</div>
			{:else if patch.kind === "too_large"}
				<div class="px-4 py-6 text-[12px] text-text-tertiary">
					{m.diff_too_large({}, { locale })}
				</div>
			{:else if patch.kind === "unavailable"}
				<div class="px-4 py-6 text-[12px] text-text-tertiary">
					{m.diff_unavailable({}, { locale })}
				</div>
			{:else if patch.lines.length === 0}
				<div class="px-4 py-6 text-[12px] text-text-tertiary">{resolvedEmptyLabel}</div>
			{:else}
				<div class="min-w-0 py-1">
					{#each patch.lines as line, index (`${index}-${line.type}`)}
						{#if line.type !== "meta"}
							<div
								class={`grid grid-cols-[1rem_minmax(0,1fr)] gap-1 border-l px-3 py-px font-mono text-[11.5px] leading-snug ${patchLineClass(line.type)}`}
							>
								<span class="select-none opacity-80">{patchLinePrefix(line.type)}</span>
								<span class="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{line.text || " "}</span>
							</div>
						{/if}
					{/each}
					{#if patch.truncated}
						<div class="px-3 py-2 text-[11px] text-text-placeholder">{m.diff_truncated_suffix({}, { locale })}</div>
					{/if}
				</div>
			{/if}
		</div>
		{#if error}
			<div class="shrink-0 border-t border-error-soft/20 bg-error-bg/20 px-3 py-1.5 text-[11px] text-error-soft">
				{error}
			</div>
		{/if}
	{/if}
</div>
