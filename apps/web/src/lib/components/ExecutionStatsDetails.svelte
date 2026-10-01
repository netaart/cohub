<script lang="ts">
import type { ExecutionStats } from "@cohub/protocol/model";
import { formatDurationMs } from "$lib/format-duration";
import { formatTokenCount, getDisplayInputTokens } from "$lib/format-usage";
import { formatCurrency } from "$lib/i18n/format";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

let {
	stats,
	showTurns = false,
}: { stats: ExecutionStats; showTurns?: boolean } = $props();
const locale = $derived(getLocale());
const input = $derived(getDisplayInputTokens(stats.usage));
const cache = $derived(
	input > 0 &&
		stats.unknownUsageCalls === 0 &&
		stats.usage?.input != null &&
		stats.usage.cacheRead != null &&
		stats.usage.cacheWrite != null
		? (stats.usage.cacheRead / input) * 100
		: null,
);
const number = (value: number) =>
	new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
const duration = (value: number) => formatDurationMs(value, locale);
const rows = $derived([
	...(showTurns ? [[m.stats_turns({}, { locale }), number(stats.turns)]] : []),
	...(stats.calls != null
		? [[m.stats_calls({}, { locale }), number(stats.calls)]]
		: []),
	...(stats.toolCalls != null
		? [[m.stats_tools({}, { locale }), number(stats.toolCalls)]]
		: []),
	...(stats.elapsedMs != null
		? [[m.stats_elapsed({}, { locale }), duration(stats.elapsedMs)]]
		: []),
	...(stats.queueMs != null
		? [[m.stats_queue({}, { locale }), duration(stats.queueMs)]]
		: []),
	...(stats.modelMs != null
		? [[m.stats_model_time({}, { locale }), duration(stats.modelMs)]]
		: []),
	...(stats.toolMs != null && stats.toolCalls
		? [[m.stats_tool_time({}, { locale }), duration(stats.toolMs)]]
		: []),
	...(stats.retryCount
		? [
				[
					m.stats_retries({}, { locale }),
					`${number(stats.retryCount)} · ${duration(stats.retryWaitMs ?? 0)}`,
				],
			]
		: []),
	...(stats.ttftSamples
		? [
				[
					m.stats_ttft({}, { locale }),
					duration(stats.ttftMs / stats.ttftSamples),
				],
			]
		: []),
	...(stats.outputMs > 0
		? [
				[
					m.stats_tps({}, { locale }),
					`${number((stats.timedOutputTokens / stats.outputMs) * 1000)} tok/s`,
				],
			]
		: []),
	...(stats.usage &&
	(stats.usage.input != null ||
		stats.usage.cacheRead != null ||
		stats.usage.cacheWrite != null)
		? [[m.stats_input({}, { locale }), formatTokenCount(input)]]
		: []),
	...(stats.usage?.totalTokens != null
		? [
				[
					m.stats_tokens({}, { locale }),
					formatTokenCount(stats.usage.totalTokens),
				],
			]
		: []),
	...(stats.usage?.output != null
		? [[m.stats_output({}, { locale }), formatTokenCount(stats.usage.output)]]
		: []),
	...(stats.usage?.cacheRead
		? [
				[
					m.stats_cache_tokens({}, { locale }),
					formatTokenCount(stats.usage.cacheRead),
				],
			]
		: []),
	...(cache != null
		? [[m.stats_cache({}, { locale }), `${number(cache)}%`]]
		: []),
	...(stats.compactions
		? [
				[
					m.stats_compaction({}, { locale }),
					`${number(stats.compactions)}${stats.compactionMs != null ? ` · ${duration(stats.compactionMs)}` : ""}`,
				],
			]
		: []),
	...(stats.imageToTextCalls
		? [
				[
					m.stats_image_to_text({}, { locale }),
					`${number(stats.imageToTextCalls)}${stats.imageToTextMs != null ? ` · ${duration(stats.imageToTextMs)}` : ""}`,
				],
			]
		: []),
	...(stats.generations
		? [[m.stats_generations({}, { locale }), number(stats.generations)]]
		: []),
	...(stats.modelCostUsd != null
		? [
				[
					m.stats_model_cost({}, { locale }),
					formatCurrency(stats.modelCostUsd, "USD", { locale }),
				],
			]
		: []),
	...(stats.generationCostUsd != null
		? [
				[
					m.stats_generation_cost({}, { locale }),
					formatCurrency(stats.generationCostUsd, "USD", { locale }),
				],
			]
		: []),
]);
</script>

<dl class="space-y-2">
  {#each rows as [label, value] (label)}
    <div class="flex items-baseline justify-between gap-5">
      <dt class="min-w-0 text-text-tertiary">{label}</dt>
      <dd class="shrink-0 text-right tabular-nums text-text-primary">{value}</dd>
    </div>
  {/each}
</dl>
{#if stats.modelCostUsd != null || stats.generationCostUsd != null}
  <p class="mt-3 text-[11px] leading-relaxed text-text-tertiary">{m.stats_cost_note({}, { locale })}</p>
{/if}
{#if stats.compactions || stats.imageToTextCalls}
  <p class="mt-3 text-[11px] leading-relaxed text-text-tertiary">{m.stats_aux_included({}, { locale })}</p>
{/if}
{#if stats.partial}
  <p class="mt-3 text-[11px] leading-relaxed text-text-tertiary">{m.stats_partial({}, { locale })}</p>
{/if}
{#if stats.modelMs != null || stats.toolMs != null}
  <p class="mt-2 text-[11px] leading-relaxed text-text-tertiary">{m.stats_timing_note({}, { locale })}</p>
{/if}
