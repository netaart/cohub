<script lang="ts">
import type { ExecutionStats, RequestMetric } from "@cohub/protocol/model";
import StatsTimeline from "$lib/components/StatsTimeline.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import {
	buildStatsViewModel,
	type StatsLabelKey,
	type StatsScope,
	type StatsSectionKey,
} from "$lib/stats-view-model";

let {
	stats,
	scope = "turn",
	requests = [],
}: {
	stats: ExecutionStats;
	scope?: StatsScope;
	requests?: readonly RequestMetric[];
} = $props();

const locale = $derived(getLocale());
const view = $derived(buildStatsViewModel(stats, scope, locale));

function label(key: StatsLabelKey) {
	switch (key) {
		case "turns":
			return m.stats_turns({}, { locale });
		case "calls":
			return m.stats_calls({}, { locale });
		case "tools":
			return m.stats_tools({}, { locale });
		case "elapsed":
			return m.stats_elapsed({}, { locale });
		case "queue":
			return m.stats_queue({}, { locale });
		case "modelTime":
			return m.stats_model_time({}, { locale });
		case "toolTime":
			return m.stats_tool_time({}, { locale });
		case "retries":
			return m.stats_retries({}, { locale });
		case "ttft":
			return m.stats_ttft({}, { locale });
		case "tps":
			return m.stats_tps({}, { locale });
		case "input":
			return m.stats_input({}, { locale });
		case "tokens":
			return m.stats_tokens({}, { locale });
		case "output":
			return m.stats_output({}, { locale });
		case "cache":
			return m.stats_cache({}, { locale });
		case "cacheTokens":
			return m.stats_cache_tokens({}, { locale });
		case "compaction":
			return m.stats_compaction({}, { locale });
		case "imageToText":
			return m.stats_image_to_text({}, { locale });
		case "generations":
			return m.stats_generations({}, { locale });
		case "modelCost":
			return m.stats_model_cost({}, { locale });
		case "generationCost":
			return m.stats_generation_cost({}, { locale });
	}
}

function sectionTitle(key: StatsSectionKey) {
	switch (key) {
		case "summary":
			return m.stats_summary({}, { locale });
		case "timing":
			return m.stats_timing({}, { locale });
		case "usage":
			return m.stats_usage({}, { locale });
		case "additional":
			return m.stats_additional({}, { locale });
	}
}

function segmentClass(tone: "brand" | "strong" | "subtle") {
	if (tone === "brand") return "bg-brand";
	if (tone === "strong") return "bg-text-placeholder";
	return "bg-text-placeholder/50";
}
</script>

<div class="space-y-4">
	{#if view.hero.length}
		<section class="grid grid-cols-3 gap-3" aria-label={m.stats_summary({}, { locale })}>
			{#each view.hero as item (item.key)}
				<div class="min-w-0">
					<div class="truncate font-mono text-[19px] leading-none tabular-nums text-text-primary">{item.value}</div>
					<div class="mt-1.5 truncate text-[10px] text-text-placeholder">{label(item.label)}</div>
				</div>
			{/each}
		</section>
	{/if}

	{#if view.timing.length || view.usage.length}
		<section class="space-y-3" aria-label={m.stats_timing({}, { locale })}>
			{#if view.timing.length}
				<div>
					<div class="mb-1.5 flex items-center justify-between gap-3 text-[10px] text-text-placeholder">
						<span>{m.stats_timing({}, { locale })}</span>
						{#if view.elapsed}<span class="tabular-nums">{view.elapsed}</span>{/if}
					</div>
					<div class="flex h-1.5 overflow-hidden rounded-full bg-border-subtle" role="img" aria-label={m.stats_timing({}, { locale })}>
						{#each view.timing as segment (segment.key)}
							<div class={`${segmentClass(segment.tone)} min-w-0 transition-[width] duration-300`} style={`width: ${segment.share}%;`} title={`${label(segment.label)} · ${segment.value}`}></div>
						{/each}
					</div>
					<div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-text-placeholder">
						{#each view.timing as segment (segment.key)}
							<span class="inline-flex items-center gap-1"><i class={`h-1.5 w-1.5 rounded-full ${segmentClass(segment.tone)}`}></i>{label(segment.label)} <span class="tabular-nums">{segment.value}</span></span>
						{/each}
					</div>
				</div>
			{/if}

			{#if view.usage.length}
				<div>
					<div class="mb-1.5 flex items-center justify-between gap-3 text-[10px] text-text-placeholder">
						<span>{m.stats_usage({}, { locale })}</span>
						{#if stats.usage?.totalTokens != null}<span class="tabular-nums">{stats.usage.totalTokens.toLocaleString(locale)}</span>{/if}
					</div>
					<div class="flex h-1.5 overflow-hidden rounded-full bg-border-subtle" role="img" aria-label={m.stats_usage({}, { locale })}>
						{#each view.usage as segment (segment.key)}
							<div class={`${segmentClass(segment.tone)} min-w-0 transition-[width] duration-300`} style={`width: ${segment.share}%;`} title={`${label(segment.label)} · ${segment.value}`}></div>
						{/each}
					</div>
					<div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-text-placeholder">
						{#each view.usage as segment (segment.key)}
							<span class="inline-flex items-center gap-1"><i class={`h-1.5 w-1.5 rounded-full ${segmentClass(segment.tone)}`}></i>{label(segment.label)} <span class="tabular-nums">{segment.value}</span></span>
						{/each}
					</div>
				</div>
			{/if}
		</section>
	{/if}

	<StatsTimeline requests={requests} />

	{#each view.groups as group (group.key)}
		<section class="border-t border-border-subtle pt-3" aria-label={sectionTitle(group.key)}>
			<h4 class="mb-2 text-[10px] font-medium uppercase tracking-[0.12em] text-text-placeholder">{sectionTitle(group.key)}</h4>
			<dl class="grid grid-cols-1 gap-x-5 gap-y-2 sm:grid-cols-2">
				{#each group.items as item (item.key)}
					<div class="flex min-w-0 items-baseline justify-between gap-3">
						<dt class="min-w-0 truncate text-text-tertiary">{label(item.label)}</dt>
						<dd class="shrink-0 text-right tabular-nums text-text-primary">{item.value}</dd>
					</div>
				{/each}
			</dl>
		</section>
	{/each}
</div>
