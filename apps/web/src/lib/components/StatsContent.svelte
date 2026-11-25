<script lang="ts" module>
import type { HarnessKind } from "@cohub/protocol/runtime";

export type StatsIdentity = {
	name: string;
	title: string;
	harness: { kind: HarnessKind; label: string } | null;
	details: string[];
};
</script>

<script lang="ts">
import type { ExecutionStats, RequestMetric } from "@cohub/protocol/model";
import { Info } from "lucide-svelte";
import HarnessIcon from "#lib/components/composer/HarnessIcon.svelte";
import StatsTimeline from "#lib/components/StatsTimeline.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import {
	buildStatsViewModel,
	type StatsBreakdown,
	type StatsContext,
	type StatsLabelKey,
	type StatsScope,
	type StatsSegment,
} from "#lib/stats-view-model.ts";

let {
	stats,
	scope = "turn",
	requests = [],
	identity = null,
	context = null,
	modelName = (_provider: string, model: string) => model,
}: {
	stats: ExecutionStats;
	scope?: StatsScope;
	requests?: readonly RequestMetric[];
	identity?: StatsIdentity | null;
	context?: StatsContext | null;
	modelName?: (provider: string, model: string) => string;
} = $props();

const locale = $derived(getLocale());
const view = $derived(
	buildStatsViewModel(stats, { scope, locale, requests, context }),
);
const modelCostColumn = $derived(view.models.some((row) => row.cost));

function label(key: StatsLabelKey) {
	const options = { locale };
	switch (key) {
		case "turns":
			return m.stats_turns({}, options);
		case "elapsed":
			return m.stats_elapsed({}, options);
		case "tokens":
			return m.stats_tokens({}, options);
		case "modelCost":
			return m.stats_model_cost({}, options);
		case "generationCost":
			return m.stats_generation_cost({}, options);
		case "queue":
			return m.stats_queue({}, options);
		case "modelTime":
			return m.stats_model_time({}, options);
		case "toolTime":
			return m.stats_tool_time({}, options);
		case "otherTime":
			return m.stats_other_time({}, options);
		case "calls":
			return m.stats_calls({}, options);
		case "tools":
			return m.stats_tools({}, options);
		case "ttft":
			return m.stats_ttft({}, options);
		case "tps":
			return m.stats_tps({}, options);
		case "retries":
			return m.stats_retries({}, options);
		case "cached":
			return m.stats_cached({}, options);
		case "input":
			return m.stats_input({}, options);
		case "output":
			return m.stats_output({}, options);
		case "cache":
			return m.stats_cache({}, options);
		case "context":
			return m.stats_context_usage({}, options);
		case "generations":
			return m.stats_generations({}, options);
		case "compaction":
			return m.stats_compaction({}, options);
		case "imageToText":
			return m.stats_image_to_text({}, options);
		case "failedCalls":
			return m.stats_failed_calls({}, options);
		case "toolErrors":
			return m.stats_tool_errors({}, options);
	}
}

function toneClass(tone: StatsSegment["tone"]) {
	if (tone === "brand") return "bg-brand";
	if (tone === "strong") return "bg-text-tertiary";
	if (tone === "muted") return "bg-text-placeholder/60";
	return "bg-text-placeholder/30";
}
</script>

{#snippet breakdownSection(title: string, section: StatsBreakdown)}
	<section aria-label={title}>
		<h4 class="mb-1.5 text-[11px] font-medium text-text-secondary">{title}</h4>
		{#if section.segments.length}
			<div class="flex h-1.5 gap-px overflow-hidden rounded-full" role="img" aria-label={section.segments.map((segment) => `${label(segment.key)} ${segment.value}`).join(", ")}>
				{#each section.segments as segment (segment.key)}
					<div class={`${toneClass(segment.tone)} min-w-0.5`} style={`width: ${segment.share}%;`}></div>
				{/each}
			</div>
			<div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
				{#each section.segments as segment (segment.key)}
					<span class="inline-flex items-center gap-1.5 text-text-tertiary">
						<i aria-hidden="true" class={`h-1.5 w-1.5 rounded-full ${toneClass(segment.tone)}`}></i>{label(segment.key)}
						<span class="tabular-nums text-text-primary">{segment.value}</span>
					</span>
				{/each}
			</div>
		{/if}
		{#if section.facts.length}
			<dl class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
				{#each section.facts as fact (fact.key)}
					<div class="flex gap-1"><dt class="text-text-placeholder">{label(fact.key)}</dt><dd class="tabular-nums text-text-secondary">{fact.value}</dd></div>
				{/each}
			</dl>
		{/if}
	</section>
{/snippet}

<div class="space-y-4">
	{#if identity}
		<header class="min-w-0">
			<div class="flex min-w-0 items-center justify-between gap-3">
				<span class="min-w-0 truncate text-[13px] font-medium text-text-primary" title={identity.title}>{identity.name}</span>
				{#if identity.harness}
					<span class="tag"><HarnessIcon harness={identity.harness.kind} size={10} />{identity.harness.label}</span>
				{/if}
			</div>
			{#if identity.details.length}
				<p class="mt-0.5 truncate text-[11px] text-text-tertiary">{identity.details.join(" · ")}</p>
			{/if}
		</header>
	{/if}

	{#if view.totals.length}
		<dl class="grid gap-3" style={`grid-template-columns: repeat(${view.totals.length}, minmax(0, 1fr));`}>
			{#each view.totals as total (total.key)}
				<div class="flex min-w-0 flex-col-reverse gap-1">
					<dt class="truncate text-[10px] text-text-placeholder">{label(total.key)}</dt>
					<dd title={total.value} class="truncate font-mono text-[16px] leading-none tabular-nums text-text-primary">{total.value}</dd>
				</div>
			{/each}
		</dl>
	{/if}

	{#if view.time}{@render breakdownSection(m.stats_time({}, { locale }), view.time)}{/if}
	{#if view.tokens}{@render breakdownSection(m.stats_token_usage({}, { locale }), view.tokens)}{/if}

	{#if view.models.length}
		<table class="w-full table-fixed text-[11px]">
			<thead class="text-[10px] text-text-placeholder">
				<tr>
					<th class="pb-1 text-left font-normal">{m.stats_models({}, { locale })}</th>
					<th class="w-14 pb-1 text-right font-normal">{m.stats_requests({}, { locale })}</th>
					<th class="w-14 pb-1 text-right font-normal">{m.stats_token_usage({}, { locale })}</th>
					{#if modelCostColumn}<th class="w-16 pb-1 text-right font-normal">{m.stats_cost({}, { locale })}</th>{/if}
				</tr>
			</thead>
			<tbody class="tabular-nums">
				{#each view.models as row (row.key)}
					<tr>
						<td class="truncate py-0.5 text-text-secondary" title={row.key}>{modelName(row.provider, row.model)}</td>
						<td class="py-0.5 text-right text-text-tertiary">{row.calls}</td>
						<td class="py-0.5 text-right text-text-primary">{row.tokens}</td>
						{#if modelCostColumn}<td class="py-0.5 text-right text-text-primary">{row.cost}</td>{/if}
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	<StatsTimeline {requests} {modelName} />

	{#if view.extra.length}
		<dl class="space-y-1.5 border-t border-border-subtle pt-3">
			{#each view.extra as extra (extra.key)}
				<div class="flex min-w-0 items-baseline justify-between gap-3">
					<dt class="min-w-0 truncate text-text-tertiary">{label(extra.key)}</dt>
					<dd class="shrink-0 tabular-nums text-text-primary">{extra.value}</dd>
				</div>
			{/each}
		</dl>
	{/if}

	{#if view.partial}
		<p class="flex items-start gap-1.5 text-[11px] text-text-placeholder"><Info size={12} class="mt-px shrink-0" aria-hidden="true" />{m.stats_partial({}, { locale })}</p>
	{/if}
</div>
