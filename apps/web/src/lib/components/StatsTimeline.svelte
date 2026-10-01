<script lang="ts">
import type { RequestMetric } from "@cohub/protocol/model";
import { formatDurationMs } from "$lib/format-duration";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import {
	buildStatsTimeline,
	type StatsTimelineModel,
} from "$lib/stats-view-model";

let { requests = [] }: { requests?: readonly RequestMetric[] } = $props();
const locale = $derived(getLocale());
const timeline = $derived<StatsTimelineModel | null>(
	buildStatsTimeline(requests),
);

function statusClass(status: RequestMetric["status"]) {
	if (status === "failed") return "bg-error-soft";
	if (status === "interrupted") return "bg-warning-soft";
	if (status === "running") return "bg-info-soft";
	return "bg-brand";
}

function statusTextClass(status: RequestMetric["status"]) {
	if (status === "failed") return "text-error-soft";
	if (status === "interrupted") return "text-warning-soft";
	if (status === "running") return "text-info-soft";
	return "text-text-tertiary";
}

function requestName(provider: string, model: string, id: string) {
	return model || provider || id.slice(0, 8);
}
</script>

{#if timeline}
	<details class="mt-4 border-t border-border-subtle pt-3">
		<summary class="flex cursor-pointer list-none items-center justify-between gap-3 text-[11px] text-text-secondary marker:hidden">
			<span class="font-medium">{m.stats_request_timeline({}, { locale })}</span>
			<span class="shrink-0 tabular-nums text-text-placeholder">{timeline.requests.length} · {formatDurationMs(timeline.durationMs, locale)}</span>
		</summary>
		<div class="mt-3 space-y-2.5" role="list" aria-label={m.stats_request_timeline({}, { locale })}>
			{#each timeline.requests as request (request.id)}
				{@const name = requestName(request.provider, request.model, request.id)}
				<div class="min-w-0" role="listitem">
					<div class="mb-1 flex min-w-0 items-center justify-between gap-2 text-[10px]">
						<span class="min-w-0 truncate text-text-secondary" title={`${request.provider} · ${request.model}`}>{name}</span>
						<span class={`shrink-0 tabular-nums ${statusTextClass(request.status)}`}>
							{formatDurationMs(request.durationMs, locale)}
						</span>
					</div>
					<div class="relative h-2 overflow-hidden rounded-full bg-border-subtle" aria-label={`${name}: ${formatDurationMs(request.durationMs, locale)}`}>
						<div
							class="absolute inset-y-0 rounded-full bg-border-strong"
							style={`left: ${request.left}%; width: ${request.width}%;`}
						></div>
						{#if request.firstToken > 0}
							<div
								class="absolute inset-y-0 bg-border-strong"
								style={`left: ${request.left}%; width: ${(request.width * request.firstToken) / 100}%;`}
							></div>
						{/if}
						{#if request.output > 0}
							<div
								class={`absolute inset-y-0 rounded-r-full ${statusClass(request.status)}`}
								style={`left: ${request.left + (request.width * request.firstToken) / 100}%; width: ${(request.width * request.output) / 100}%;`}
							></div>
						{:else}
							<div
								class={`absolute inset-y-0 rounded-full ${statusClass(request.status)}`}
								style={`left: ${request.left}%; width: ${request.width}%; opacity: 0.65;`}
							></div>
						{/if}
					</div>
				</div>
			{/each}
		</div>
		<div class="mt-2.5 flex items-center justify-between gap-2 text-[10px] text-text-placeholder">
			<span>0</span>
			<span>{formatDurationMs(timeline.durationMs, locale)}</span>
		</div>
		<div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-text-placeholder">
			<span class="inline-flex items-center gap-1"><i aria-hidden="true" class="h-1.5 w-1.5 rounded-full bg-border-strong"></i>{m.stats_ttft({}, { locale })}</span>
			<span class="inline-flex items-center gap-1"><i aria-hidden="true" class="h-1.5 w-1.5 rounded-full bg-brand"></i>{m.stats_output({}, { locale })}</span>
		</div>
	</details>
{/if}
