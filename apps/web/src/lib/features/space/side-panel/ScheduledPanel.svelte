<script lang="ts">
import { Loader2, Plus } from "lucide-svelte";
import { untrack } from "svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import type { SpaceCronjobsFeed } from "../resources/space-cronjobs-feed.svelte";
import CronjobRow from "./CronjobRow.svelte";
import LoadError from "./LoadError.svelte";

type Props = {
	feed: SpaceCronjobsFeed | null;
	activeCronjobId: string | null;
	canManage: boolean;
	onVisible: () => void;
	onOpenCronjob: (id: string) => void;
};

const { feed, activeCronjobId, canManage, onVisible, onOpenCronjob }: Props =
	$props();

const locale = $derived(getLocale());
const jobs = $derived(feed?.items ?? []);

$effect(() => {
	if (feed) untrack(onVisible);
});
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="flex h-9 shrink-0 items-center gap-1 px-2">
		{#if canManage}
			<button
				type="button"
				class="inline-flex h-6 items-center gap-1 rounded-[5px] px-1.5 text-[11px] font-medium text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 {activeCronjobId === 'new' ? 'bg-bg-active text-text-primary' : ''}"
				onclick={() => onOpenCronjob("new")}
			>
				<Plus class="h-3.5 w-3.5" />
				{m.cron_new_scheduled({}, { locale })}
			</button>
		{/if}
		{#if feed?.refreshing && feed.ready}
			<Loader2 class="ml-auto h-3 w-3 animate-spin text-text-placeholder" />
		{/if}
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
		{#if feed && !feed.ready}
			<div class="space-y-1 px-1.5 py-1" aria-hidden="true">
				{#each [1, 2, 3] as item (item)}
					<div class="flex h-9 items-center gap-2">
						<div class="h-7 w-7 animate-pulse rounded-[8px] bg-bg-elevated"></div>
						<div class="h-2.5 w-1/2 animate-pulse rounded bg-bg-elevated"></div>
					</div>
				{/each}
			</div>
		{:else if feed?.failed && jobs.length === 0}
			<div class="px-1.5">
				<LoadError message={m.scheduled_panel_load_failed({}, { locale })} onRetry={() => void feed.refresh()} />
			</div>
		{:else if jobs.length === 0}
			<p class="mx-1.5 mt-1 text-[12px] leading-[18px] text-text-tertiary">{m.scheduled_panel_empty({}, { locale })}</p>
		{:else}
			<div role="list">
				{#each jobs as job (job.id)}
					<CronjobRow {job} active={job.id === activeCronjobId} onOpen={() => onOpenCronjob(job.id)} />
				{/each}
			</div>
		{/if}
	</div>
</div>
