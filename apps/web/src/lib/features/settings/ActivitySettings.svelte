<script lang="ts">
import type { UserActivityRange, UserActivityRankings } from "@neta-art/cohub";
import { Loader2 } from "lucide-svelte";
import { ensureAuth } from "$lib/auth";
import { handleUnauthorizedError } from "$lib/auth-redirect";
import ActivityHeatmap from "$lib/components/activity/ActivityHeatmap.svelte";
import { onSettingsPageActive } from "$lib/features/settings/page-context.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { authStore } from "$lib/stores/auth.svelte";
import {
	type ActivityDay,
	buildActivityDays,
	formatCompact,
	formatCost,
	formatDay,
	getActivityStats,
	isActivityCacheFresh,
	readActivityCache,
	writeActivityCache,
} from "$lib/user-activity";

const ranges = [
	{ days: 7, label: "7D" },
	{ days: 30, label: "30D" },
	{ days: 365, label: "1Y" },
] as const;
const EMPTY_RANKINGS: UserActivityRankings = {
	llmModels: [],
	generationModels: [],
	apps: [],
};
type HeatmapMode = "llm" | "generation";
const heatmapModes: HeatmapMode[] = ["llm", "generation"];

function heatmapModeLabel(mode: HeatmapMode): string {
	return mode === "generation"
		? m.activity_mode_generation({}, { locale })
		: "LLM";
}

let selectedDays = $state(365);
let heatmapMode = $state<HeatmapMode>("llm");
let activityDays = $state<ActivityDay[] | null>(null);
let rankings = $state<UserActivityRankings | null>(null);
let activityRange = $state<UserActivityRange | null>(null);
let loading = $state(true);
let refreshing = $state(false);
let loadError = $state("");
let requestId = 0;

const locale = $derived(getLocale());

const displayedDays = $derived(activityDays ?? []);
const displayedRankings = $derived(rankings ?? EMPTY_RANKINGS);
const identityLabel = $derived(
	authStore.profile?.username
		? `@${authStore.profile.username}`
		: authStore.profile?.displayName || m.activity_your_account({}, { locale }),
);
const rangeLabel = $derived(
	selectedDays === 365
		? m.activity_last_year({}, { locale })
		: m.activity_last_days({ days: selectedDays }, { locale }),
);
const stats = $derived(getActivityStats(displayedDays));
function getSelectedRange(days: number) {
	const to = new Date();
	const from = new Date(to);
	from.setHours(0, 0, 0, 0);
	from.setDate(from.getDate() - (days - 1));
	return { from, to };
}

async function loadActivity({ force = false } = {}) {
	const id = ++requestId;
	loadError = "";
	await authStore.ensureLoaded();
	const userUuid = authStore.userUuid;
	if (!userUuid) {
		loading = false;
		return;
	}

	const cached = readActivityCache(userUuid, selectedDays);
	if (cached && !force) {
		activityDays = cached.activityDays;
		rankings = cached.rankings;
		activityRange = cached.range;
	}
	loading = !activityDays;
	refreshing = Boolean(activityDays);
	try {
		if (!force && cached && isActivityCacheFresh(cached)) {
			refreshing = false;
			return;
		}
		const data = await sdk.user.getActivity(getSelectedRange(selectedDays));
		if (id !== requestId) return;
		const nextActivityDays = buildActivityDays(data, selectedDays);
		const nextRankings = data.rankings;
		activityDays = nextActivityDays;
		rankings = nextRankings;
		activityRange = data.range;
		writeActivityCache(userUuid, {
			days: selectedDays,
			activityDays: nextActivityDays,
			range: data.range,
			rankings: nextRankings,
		});
	} catch (error) {
		if (id !== requestId) return;
		if (await handleUnauthorizedError(error)) return;
		loadError =
			error instanceof Error
				? error.message
				: m.activity_load_failed({}, { locale });
	} finally {
		if (id === requestId) {
			loading = false;
			refreshing = false;
		}
	}
}

function selectRange(days: number) {
	if (selectedDays === days) return;
	selectedDays = days;
	activityDays = null;
	rankings = null;
	activityRange = null;
	void loadActivity();
}

onSettingsPageActive(async () => {
	if (await ensureAuth()) void loadActivity();
});
</script>

<div class="w-full max-w-5xl px-4 py-7 sm:px-6 lg:px-8">
	<header class="flex flex-wrap items-end justify-between gap-4 border-b border-border-subtle pb-5">
		<div>
			<p class="text-[11px] font-semibold text-brand">Cohub</p>
			<h1 class="mt-1 text-[20px] font-semibold text-text-primary">{m.page_title_activity({}, { locale })}</h1>
			<p class="mt-1 text-[12px] text-text-tertiary" title={activityRange ? `${activityRange.from} to ${activityRange.to}` : undefined}>{identityLabel} · {rangeLabel}</p>
		</div>
		<div class="flex rounded-md bg-bg-surface p-0.5" aria-label={m.activity_range_aria({}, { locale })}>
			{#each ranges as range (range.days)}
				<button type="button" class="min-w-11 rounded-[4px] px-2.5 py-1.5 text-[11px] font-medium transition-colors {selectedDays === range.days ? 'bg-bg-active text-text-primary' : 'text-text-placeholder hover:text-text-secondary'}" aria-pressed={selectedDays === range.days} onclick={() => selectRange(range.days)}>{range.label}</button>
			{/each}
		</div>
	</header>

	{#if loading}
		<div class="flex min-h-72 items-center justify-center"><Loader2 class="h-5 w-5 animate-spin text-text-placeholder" /></div>
	{:else if !activityDays}
		<div class="py-16 text-center">
			<p class="text-[13px] text-text-secondary">{m.activity_unavailable({}, { locale })}</p>
			{#if loadError}<p class="mt-2 text-[12px] text-error-soft">{loadError}</p>{/if}
			<button type="button" class="mt-4 text-[12px] font-medium text-brand hover:underline" onclick={() => void loadActivity({ force: true })}>{m.activity_try_again({}, { locale })}</button>
		</div>
	{:else}
		<section class="grid grid-cols-2 border-b border-border-subtle py-6 sm:grid-cols-4" aria-label={m.activity_summary_aria({}, { locale })}>
			<div class="border-r border-border-subtle pr-3 sm:pr-5"><div class="font-mono text-[20px] text-text-primary sm:text-[22px]">{formatCompact(stats.totalTokens, locale)}</div><div class="mt-1 text-[11px] text-text-placeholder">{m.activity_tokens({}, { locale })}</div></div>
			<div class="pl-3 sm:border-r sm:border-border-subtle sm:px-5"><div class="font-mono text-[20px] text-text-primary sm:text-[22px]">{formatCompact(stats.totalRequests, locale)}</div><div class="mt-1 text-[11px] text-text-placeholder">{m.activity_requests({}, { locale })}</div></div>
			<div class="mt-5 border-r border-border-subtle pr-3 sm:mt-0 sm:px-5"><div class="font-mono text-[20px] text-text-primary sm:text-[22px]">{stats.activeDays}</div><div class="mt-1 text-[11px] text-text-placeholder">{m.activity_active_days({}, { locale })}</div></div>
			<div class="mt-5 pl-3 sm:mt-0 sm:pl-5"><div class="font-mono text-[20px] text-text-primary sm:text-[22px]">{stats.currentStreak}</div><div class="mt-1 text-[11px] text-text-placeholder">{m.activity_current_streak({}, { locale })}</div></div>
		</section>

		<section class="border-b border-border-subtle py-7">
			<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
				<h2 class="text-[13px] font-medium text-text-primary">{m.activity_daily_activity({}, { locale })}</h2>
				<div class="flex flex-wrap items-center justify-end gap-3">
					<div class="flex rounded-md bg-bg-surface p-0.5" aria-label={m.activity_type_aria({}, { locale })}>
						{#each heatmapModes as mode (mode)}
							<button type="button" class="rounded-[4px] px-2.5 py-1 text-[10px] font-medium transition-colors {heatmapMode === mode ? 'bg-bg-active text-text-primary' : 'text-text-placeholder hover:text-text-secondary'}" aria-pressed={heatmapMode === mode} onclick={() => heatmapMode = mode}>{heatmapModeLabel(mode)}</button>
						{/each}
					</div>
					<div class="flex items-center gap-1.5 text-[10px] text-text-placeholder"><span>{m.activity_less({}, { locale })}</span>{#each [0, 1, 2, 3, 4] as level}<span class="heat-cell" data-mode={heatmapMode} data-level={level}></span>{/each}<span>{m.activity_more({}, { locale })}</span></div>
				</div>
			</div>
			<ActivityHeatmap days={displayedDays} mode={heatmapMode} />
		</section>

		<div class="grid gap-8 py-7 md:grid-cols-2 md:gap-x-10 lg:grid-cols-3">
			<section>
				<div class="mb-4 flex items-center justify-between"><h2 class="text-[13px] font-medium text-text-primary">{m.activity_llm_models({}, { locale })}</h2><span class="text-[10px] text-text-placeholder">{m.activity_tokens_cost({}, { locale })}</span></div>
				{#if displayedRankings.llmModels.length}
					<ol class="space-y-3">
						{#each displayedRankings.llmModels as row, index (`${row.provider}:${row.model}`)}
							<li class="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 text-[12px]">
								<span class="font-mono text-[10px] text-text-placeholder">{index + 1}</span>
								<div class="min-w-0" title={`${row.provider}/${row.model}`}><div class="truncate text-text-secondary">{row.model}</div><div class="truncate text-[10px] text-text-placeholder">{row.provider}</div></div>
								<div class="whitespace-nowrap text-right font-mono text-text-secondary">{formatCompact(row.totalTokens, locale)} · {formatCost(row.costTotal, locale)}</div>
							</li>
						{/each}
					</ol>
				{:else}<p class="text-[12px] text-text-placeholder">{m.activity_no_llm_usage({}, { locale })}</p>{/if}
			</section>

			<section class="border-t border-border-subtle pt-7 md:border-0 md:pt-0">
				<div class="mb-4 flex items-center justify-between"><h2 class="text-[13px] font-medium text-text-primary">{m.activity_generation_models({}, { locale })}</h2><span class="text-[10px] text-text-placeholder">{m.activity_calls_cost({}, { locale })}</span></div>
				{#if displayedRankings.generationModels.length}
					<ol class="space-y-3">
						{#each displayedRankings.generationModels as row, index (`${row.provider}:${row.model}`)}
							<li class="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 text-[12px]">
								<span class="font-mono text-[10px] text-text-placeholder">{index + 1}</span>
								<div class="min-w-0 truncate text-text-secondary" title={`${row.provider}/${row.model}`}>{row.model}</div>
								<div class="whitespace-nowrap text-right font-mono text-text-secondary">{formatCompact(row.requestCount, locale)} · {formatCost(row.costTotal, locale)}</div>
							</li>
						{/each}
					</ol>
				{:else}<p class="text-[12px] text-text-placeholder">{m.activity_no_generation_usage({}, { locale })}</p>{/if}
			</section>

			<section class="border-t border-border-subtle pt-7 md:col-span-2 lg:col-span-1 lg:border-0 lg:pt-0">
				<div class="mb-4 flex items-center justify-between"><h2 class="text-[13px] font-medium text-text-primary">{m.activity_apps({}, { locale })}</h2><span class="text-[10px] text-text-placeholder">{m.activity_views({}, { locale })}</span></div>
				{#if displayedRankings.apps.length}
					<ol class="space-y-3">
						{#each displayedRankings.apps as row, index (row.appId)}
							<li class="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 text-[12px]">
								<span class="font-mono text-[10px] text-text-placeholder">{index + 1}</span>
								<div class="min-w-0"><a class="block truncate text-text-secondary transition-colors hover:text-brand" href={`/spaces/${row.spaceId}/apps/${row.appId}`} title={row.title}>{row.title}</a><div class="truncate text-[10px] text-text-placeholder">{row.spaceName}</div></div>
								<span class="font-mono text-text-secondary">{formatCompact(row.viewCount, locale)}</span>
							</li>
						{/each}
					</ol>
				{:else}<p class="text-[12px] text-text-placeholder">{m.activity_no_app_views({}, { locale })}</p>{/if}
			</section>
		</div>

		{#if loadError}<p class="border-t border-border-subtle pt-4 text-[11px] text-text-placeholder">{m.activity_showing_saved({}, { locale })}</p>{/if}
	{/if}
</div>

<style>
	.heat-cell {
		display: inline-block;
		width: 11px;
		height: 11px;
		border-radius: 2px;
		background: var(--bg-hover);
	}
	.heat-cell[data-level="1"] { background: color-mix(in srgb, var(--brand) 24%, var(--bg-primary)); }
	.heat-cell[data-level="2"] { background: color-mix(in srgb, var(--brand) 42%, var(--bg-primary)); }
	.heat-cell[data-level="3"] { background: color-mix(in srgb, var(--brand) 66%, var(--bg-primary)); }
	.heat-cell[data-level="4"] { background: var(--brand); }
	.heat-cell[data-mode="generation"][data-level="1"] { background: color-mix(in srgb, var(--status-running) 24%, var(--bg-primary)); }
	.heat-cell[data-mode="generation"][data-level="2"] { background: color-mix(in srgb, var(--status-running) 42%, var(--bg-primary)); }
	.heat-cell[data-mode="generation"][data-level="3"] { background: color-mix(in srgb, var(--status-running) 66%, var(--bg-primary)); }
	.heat-cell[data-mode="generation"][data-level="4"] { background: var(--status-running); }
</style>
