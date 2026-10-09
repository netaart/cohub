<script lang="ts">
import type { GenerationOutputType } from "@neta-art/cohub";
import { ExternalLink, Loader2 } from "lucide-svelte";
import { onMount } from "svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import GenerationGrid from "./GenerationGrid.svelte";
import type { GenerationFeed } from "./generation-feed.svelte";
import LoadError from "./LoadError.svelte";
import LoadMoreButton from "./LoadMoreButton.svelte";

type Filter = GenerationOutputType | "all";

type Props = {
	feed: GenerationFeed | null;
	draggable: boolean;
	onVisible: () => void;
	onOpenTask: (taskRunId: string) => void;
	onOpenTaskBrowser?: () => void;
};

const { feed, draggable, onVisible, onOpenTask, onOpenTaskBrowser }: Props =
	$props();

const locale = $derived(getLocale());
let filter = $state<Filter>("all");

const filters = $derived<{ id: Filter; label: string }[]>([
	{ id: "all", label: m.media_filter_all({}, { locale }) },
	{ id: "image", label: m.media_filter_image({}, { locale }) },
	{ id: "video", label: m.media_filter_video({}, { locale }) },
	{ id: "audio", label: m.media_filter_audio({}, { locale }) },
]);
const tasks = $derived(feed?.tasks ?? []);
const matches = $derived(
	filter === "all"
		? tasks.length > 0
		: tasks.some((task) =>
				task.outputs.some((output) => output.type === filter),
			),
);

onMount(() => onVisible());
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="flex h-9 shrink-0 items-center gap-0.5 px-2" role="radiogroup" aria-label={m.media_filter_label({}, { locale })}>
		{#each filters as item (item.id)}
			<button
				type="button"
				role="radio"
				aria-checked={filter === item.id}
				class="h-6 rounded-[5px] px-2 text-[11px] transition-colors {filter === item.id ? 'bg-bg-elevated text-text-primary' : 'text-text-tertiary hover:text-text-secondary'}"
				onclick={() => (filter = item.id)}
			>
				{item.label}
			</button>
		{/each}
		{#if feed?.refreshing && feed.ready}
			<Loader2 class="ml-auto h-3 w-3 animate-spin text-text-placeholder" />
		{/if}
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
		{#if !feed || !feed.ready}
			<div class="grid grid-cols-3 gap-1 pt-1" aria-hidden="true">
				{#each [1, 2, 3, 4, 5, 6] as item (item)}
					<div class="aspect-square animate-pulse rounded-[6px] bg-bg-elevated"></div>
				{/each}
			</div>
		{:else if feed.failed && tasks.length === 0}
			<div class="mt-1">
				<LoadError message={m.generation_load_failed({}, { locale })} onRetry={() => void feed.refresh()} />
			</div>
		{:else if !matches}
			<p class="mx-1 mt-3 text-[12px] leading-[18px] text-text-tertiary">
				{tasks.length === 0 ? m.media_empty({}, { locale }) : m.media_empty_filtered({}, { locale })}
			</p>
		{:else}
			<GenerationGrid
				{tasks}
				typeFilter={filter}
				{draggable}
				resolveRun={(id) => feed.run(id)}
				{onOpenTask}
			/>
		{/if}

		{#if feed}
			<LoadMoreButton {feed} />
		{/if}

		{#if onOpenTaskBrowser}
			<button
				type="button"
				class="mt-3 flex w-full items-center justify-center gap-1.5 rounded-[6px] px-1.5 py-1.5 text-[11px] text-text-placeholder transition-colors hover:bg-bg-hover hover:text-text-secondary"
				onclick={onOpenTaskBrowser}
			>
				<ExternalLink class="h-3 w-3" />
				{m.media_open_task_browser({}, { locale })}
			</button>
		{/if}
	</div>
</div>
