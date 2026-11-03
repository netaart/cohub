<script lang="ts">
import type { AppViewSource, AppViewStatsResponse } from "@neta-art/cohub";
import { Eye, RefreshCw } from "lucide-svelte";
import { m } from "$messages";
import type { AppTotals } from "./app";
import { intlTag, type Locale } from "./core";

type Props = {
	locale: Locale;
	stats: AppViewStatsResponse | null;
	totals?: AppTotals | null;
	loading: boolean;
	error: string;
	onRetry: () => void;
	onReveal?: () => void;
};

let { locale, stats, totals = null, loading, error, onRetry, onReveal }: Props = $props();

const compactFormatter = $derived(
	new Intl.NumberFormat(intlTag(locale), {
		notation: "compact",
		maximumFractionDigits: 1,
	}),
);
const exactFormatter = $derived(new Intl.NumberFormat(intlTag(locale)));
const dayFormatter = $derived(
	new Intl.DateTimeFormat(intlTag(locale), {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	}),
);

const waiting = $derived(!stats && (loading || (!error && !onReveal)));
const metrics = $derived.by(() => {
	const summary = stats?.summary;
	const likes = summary ? summary.totalLikes : totals?.likeCount;
	return [
		{ value: summary?.totalViews ?? totals?.totalViews ?? null, label: m.app_stats_total, title: m.app_stats_total_views_title },
		{ value: summary?.views24h ?? null, label: m.app_stats_last_24h, title: m.app_stats_24h_title },
		{ value: summary?.views7d ?? null, label: m.app_stats_last_7d, title: m.app_stats_7d_title },
		...(likes === undefined ? [] : [{ value: likes, label: m.app_stats_likes, title: m.app_like_count_title }]),
	];
});
const maxDailyViews = $derived(
	Math.max(0, ...(stats?.daily.map((point) => point.views) ?? [])),
);
const sourceTotal = $derived(
	stats?.sources.reduce((total, item) => total + item.views, 0) ?? 0,
);
const hasRecentViews = $derived((stats?.summary.views30d ?? 0) > 0);

function compactCount(value: number) {
	return compactFormatter.format(value);
}

function exactCount(value: number) {
	return exactFormatter.format(value);
}

function formatDay(value: string) {
	return dayFormatter.format(new Date(`${value}T00:00:00Z`));
}

function barHeight(value: number) {
	if (value <= 0 || maxDailyViews <= 0) return 2;
	return Math.max(8, Math.round((value / maxDailyViews) * 100));
}

function sourceLabel(source: AppViewSource) {
	if (source === "cli") return "CLI";
	if (source === "api") return "API";
	return "Web";
}

function sourcePercent(views: number) {
	return sourceTotal > 0 ? (views / sourceTotal) * 100 : 0;
}
</script>

<section class="border-b border-border-subtle/70 pb-5" aria-labelledby="work-views-heading">
	<div class="mb-4 flex items-center justify-between gap-3">
		<div class="flex items-center gap-2">
			<Eye class="h-3.5 w-3.5 text-text-tertiary" />
			<h2 id="work-views-heading" class="text-[10px] font-medium uppercase tracking-[0.18em] text-text-placeholder">{m.app_stats_views({}, { locale })}</h2>
		</div>
		{#if error && stats}
			<button type="button" class="inline-flex h-7 w-7 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary" onclick={onRetry} title={m.app_stats_retry({}, { locale })} aria-label={m.app_stats_retry({}, { locale })}>
				<RefreshCw class="h-3.5 w-3.5" />
			</button>
		{/if}
	</div>

	<div class="grid gap-4 sm:max-w-xl sm:gap-8 {metrics.length === 3 ? 'grid-cols-3' : 'grid-cols-2 sm:grid-cols-4'}">
		{#each metrics as metric (metric.label)}
			<div class="min-w-0" title={metric.value === null ? undefined : metric.title({ count: exactCount(metric.value) }, { locale })}>
				<div class="truncate font-mono text-[18px] font-semibold {metric.value === null ? 'text-text-placeholder' : 'text-text-primary'}" class:animate-pulse={waiting && metric.value === null}>{metric.value === null ? "—" : compactCount(metric.value)}</div>
				<div class="mt-0.5 text-[10px] text-text-placeholder">{metric.label({}, { locale })}</div>
			</div>
		{/each}
	</div>

	{#if !stats}
		<div class="mt-6 flex h-36 items-center justify-center gap-3 rounded-[4px] bg-bg-elevated/30 text-[12px] text-text-tertiary" class:animate-pulse={waiting} aria-busy={waiting}>
			{#if waiting}
				<span class="sr-only">{m.app_stats_loading({}, { locale })}</span>
			{:else if error}
				<span>{m.app_stats_unavailable({}, { locale })}</span>
				<button type="button" class="inline-flex min-h-8 items-center gap-1.5 rounded-[5px] px-2.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary" onclick={onRetry}>
					<RefreshCw class="h-3.5 w-3.5" />
					<span>{m.common_retry({}, { locale })}</span>
				</button>
			{:else if onReveal}
				<button type="button" class="inline-flex min-h-8 items-center gap-1.5 rounded-[5px] px-2.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary" onclick={onReveal}>
					<Eye class="h-3.5 w-3.5" />
					<span>{m.resource_app_show_stats({}, { locale })}</span>
				</button>
			{/if}
		</div>
	{:else}
		<div class="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_220px] lg:gap-10">
			<div class="min-w-0">
				<div class="mb-2 flex items-center justify-between gap-3 text-[10px] text-text-placeholder">
					<span>{m.app_stats_activity_30d({}, { locale })}</span>
					<span>UTC</span>
				</div>
				{#if hasRecentViews}
					<div class="grid h-24 items-end gap-[2px]" style={`grid-template-columns: repeat(${stats.daily.length}, minmax(0, 1fr));`} role="img" aria-label={m.app_stats_daily_aria({}, { locale })}>
						{#each stats.daily as point (point.date)}
							<div class="flex h-full items-end" title={m.app_stats_day_title({ date: formatDay(point.date), count: exactCount(point.views) }, { locale })} aria-label={m.app_stats_day_title({ date: formatDay(point.date), count: exactCount(point.views) }, { locale })}>
								<div class="w-full rounded-[1px] bg-brand/70 transition-colors hover:bg-brand" style={`height: ${barHeight(point.views)}%;`}></div>
							</div>
						{/each}
					</div>
					<div class="mt-1.5 flex justify-between text-[9px] text-text-placeholder">
						<span>{stats.daily[0] ? formatDay(stats.daily[0].date) : ""}</span>
						<span>{m.app_stats_today({}, { locale })}</span>
					</div>
				{:else}
					<div class="flex h-24 items-center border-b border-border-subtle/70 text-[12px] text-text-placeholder">{stats.summary.totalViews > 0 ? m.app_stats_no_views_30d({}, { locale }) : m.app_stats_no_views_yet({}, { locale })}</div>
				{/if}
			</div>

			<div class="min-w-0">
				<div class="mb-3 text-[10px] text-text-placeholder">{m.app_stats_sources_30d({}, { locale })}</div>
				{#if stats.sources.length}
					<div class="space-y-3">
						{#each stats.sources as item (item.source)}
							{@const percent = sourcePercent(item.views)}
							<div title={m.app_stats_source_title({ source: sourceLabel(item.source), count: exactCount(item.views), percent: percent.toFixed(1) }, { locale })}>
								<div class="mb-1 flex items-center justify-between gap-3 text-[11px]">
									<span class="text-text-secondary">{sourceLabel(item.source)}</span>
									<span class="font-mono text-text-tertiary">{compactCount(item.views)} · {percent.toFixed(1)}%</span>
								</div>
								<div class="h-1 overflow-hidden rounded-full bg-bg-elevated">
									<div class="h-full rounded-full bg-text-tertiary" style={`width: ${Math.max(2, percent)}%;`}></div>
								</div>
							</div>
						{/each}
					</div>
				{:else}
					<div class="text-[11px] text-text-placeholder">{m.app_stats_no_source_data({}, { locale })}</div>
				{/if}
			</div>
		</div>
	{/if}
</section>
