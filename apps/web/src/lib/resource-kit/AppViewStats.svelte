<script lang="ts">
import type { AppViewSource, AppViewStatsResponse } from "@neta-art/cohub";
import { Eye, RefreshCw } from "lucide-svelte";
import { m } from "$messages";
import { intlTag, type Locale } from "./core";

type Props = {
	locale: Locale;
	stats: AppViewStatsResponse | null;
	loading: boolean;
	error: string;
	onRetry: () => void;
};

let { locale, stats, loading, error, onRetry }: Props = $props();

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

	{#if loading && !stats}
		<div class="space-y-5" aria-label={m.app_stats_loading({}, { locale })}>
			<div class="grid grid-cols-3 gap-4">
				{#each Array(3) as _}
					<div class="space-y-2"><div class="h-5 w-16 animate-pulse rounded bg-bg-elevated"></div><div class="h-3 w-12 animate-pulse rounded bg-bg-elevated/70"></div></div>
				{/each}
			</div>
			<div class="h-24 animate-pulse rounded-[4px] bg-bg-elevated/50"></div>
		</div>
	{:else if error && !stats}
		<div class="flex min-h-20 items-center justify-between gap-4 text-[12px] text-text-tertiary">
			<span>{m.app_stats_unavailable({}, { locale })}</span>
			<button type="button" class="inline-flex min-h-8 items-center gap-1.5 rounded-[5px] px-2.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary" onclick={onRetry}>
				<RefreshCw class="h-3.5 w-3.5" />
				<span>{m.common_retry({}, { locale })}</span>
			</button>
		</div>
	{:else if stats}
		<div class="grid gap-4 sm:max-w-xl sm:gap-8 {stats.summary.totalLikes === undefined ? 'grid-cols-3' : 'grid-cols-2 sm:grid-cols-4'}">
			<div class="min-w-0" title={m.app_stats_total_views_title({ count: exactCount(stats.summary.totalViews) }, { locale })}>
				<div class="truncate font-mono text-[18px] font-semibold text-text-primary">{compactCount(stats.summary.totalViews)}</div>
				<div class="mt-0.5 text-[10px] text-text-placeholder">{m.app_stats_total({}, { locale })}</div>
			</div>
			<div class="min-w-0" title={m.app_stats_24h_title({ count: exactCount(stats.summary.views24h) }, { locale })}>
				<div class="truncate font-mono text-[18px] font-semibold text-text-primary">{compactCount(stats.summary.views24h)}</div>
				<div class="mt-0.5 text-[10px] text-text-placeholder">{m.app_stats_last_24h({}, { locale })}</div>
			</div>
			<div class="min-w-0" title={m.app_stats_7d_title({ count: exactCount(stats.summary.views7d) }, { locale })}>
				<div class="truncate font-mono text-[18px] font-semibold text-text-primary">{compactCount(stats.summary.views7d)}</div>
				<div class="mt-0.5 text-[10px] text-text-placeholder">{m.app_stats_last_7d({}, { locale })}</div>
			</div>
			{#if stats.summary.totalLikes !== undefined}
				<div class="min-w-0" title={m.app_like_count_title({ count: exactCount(stats.summary.totalLikes) }, { locale })}>
					<div class="truncate font-mono text-[18px] font-semibold text-text-primary">{compactCount(stats.summary.totalLikes)}</div>
					<div class="mt-0.5 text-[10px] text-text-placeholder">{m.app_stats_likes({}, { locale })}</div>
				</div>
			{/if}
		</div>

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
