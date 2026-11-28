<script lang="ts">
import { harnessLabel, resolveHarness } from "@cohub/protocol/runtime";
import type {
	SpaceActivityAppRanking,
	UserActivityRankings,
} from "@neta-art/cohub";
import { formatCompact, formatCost } from "#lib/activity.ts";
import HarnessIcon from "#lib/components/composer/HarnessIcon.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import { buildSpaceAppRoute } from "#lib/space-routes.ts";

type AppRanking = SpaceActivityAppRanking & {
	spaceId?: string;
	spaceName?: string;
};

type Props = {
	spaceId?: string;
	rankings: Pick<UserActivityRankings, "llmModels" | "generationModels"> & {
		apps: AppRanking[];
	};
	showCost: boolean;
};

const { spaceId, rankings, showCost }: Props = $props();

const locale = $derived(getLocale());
const withCost = (value: number, cost: number) =>
	showCost
		? `${formatCompact(value, locale)} · ${formatCost(cost, locale)}`
		: formatCompact(value, locale);

const llmSource = ({
	provider,
	host,
}: UserActivityRankings["llmModels"][number]) =>
	host && host !== provider ? `${provider} · ${host}` : provider;
</script>

<div class="grid gap-8 py-7 md:grid-cols-2 md:gap-x-10 lg:grid-cols-3">
	<section>
		<div class="mb-4 flex items-center justify-between">
			<h2 class="text-[13px] font-medium text-text-primary">{m.activity_llm_models({}, { locale })}</h2>
			<span class="text-[10px] text-text-placeholder">{showCost ? m.activity_tokens_cost({}, { locale }) : m.activity_tokens({}, { locale })}</span>
		</div>
		{#if rankings.llmModels.length}
			<ol class="space-y-3">
				{#each rankings.llmModels as row, index (`${row.harness}:${row.credential}:${row.provider}:${row.host}:${row.model}`)}
					{@const harness = resolveHarness(row)}
					{@const source = llmSource(row)}
					<li class="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 text-[12px]">
						<span class="font-mono text-[10px] text-text-placeholder">{index + 1}</span>
						<div class="min-w-0" title={`${source}/${row.model}`}>
							<div class="truncate text-text-secondary">{row.model}</div>
							<div class="flex min-w-0 items-center gap-1 text-[10px] text-text-placeholder">
								{#if harness !== "cohub"}
									<HarnessIcon {harness} size={10} />
									<span class="shrink-0">{harnessLabel(harness)} ·</span>
								{:else if row.credential === "user"}
									<span class="shrink-0 rounded-[3px] border border-border-subtle px-1 leading-[14px]">{m.activity_own_key({}, { locale })}</span>
								{/if}
								<span class="truncate">{source}</span>
							</div>
						</div>
						<div class="whitespace-nowrap text-right font-mono text-text-secondary">{withCost(row.totalTokens, row.costTotal)}</div>
					</li>
				{/each}
			</ol>
		{:else}
			<p class="text-[12px] text-text-placeholder">{m.activity_no_llm_usage({}, { locale })}</p>
		{/if}
	</section>

	<section class="border-t border-border-subtle pt-7 md:border-0 md:pt-0">
		<div class="mb-4 flex items-center justify-between">
			<h2 class="text-[13px] font-medium text-text-primary">{m.activity_generation_models({}, { locale })}</h2>
			<span class="text-[10px] text-text-placeholder">{showCost ? m.activity_calls_cost({}, { locale }) : m.activity_calls({}, { locale })}</span>
		</div>
		{#if rankings.generationModels.length}
			<ol class="space-y-3">
				{#each rankings.generationModels as row, index (`${row.provider}:${row.model}`)}
					<li class="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 text-[12px]">
						<span class="font-mono text-[10px] text-text-placeholder">{index + 1}</span>
						<div class="min-w-0 truncate text-text-secondary" title={`${row.provider}/${row.model}`}>{row.model}</div>
						<div class="whitespace-nowrap text-right font-mono text-text-secondary">{withCost(row.requestCount, row.costTotal)}</div>
					</li>
				{/each}
			</ol>
		{:else}
			<p class="text-[12px] text-text-placeholder">{m.activity_no_generation_usage({}, { locale })}</p>
		{/if}
	</section>

	<section class="border-t border-border-subtle pt-7 md:col-span-2 lg:col-span-1 lg:border-0 lg:pt-0">
		<div class="mb-4 flex items-center justify-between">
			<h2 class="text-[13px] font-medium text-text-primary">{m.activity_apps({}, { locale })}</h2>
			<span class="text-[10px] text-text-placeholder">{m.activity_views({}, { locale })}</span>
		</div>
		{#if rankings.apps.length}
			<ol class="space-y-3">
				{#each rankings.apps as row, index (row.appId)}
					<li class="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 text-[12px]">
						<span class="font-mono text-[10px] text-text-placeholder">{index + 1}</span>
						<div class="min-w-0">
							<a class="block truncate text-text-secondary transition-colors hover:text-brand" href={buildSpaceAppRoute(row.spaceId ?? spaceId ?? "", row.appId)} title={row.title}>{row.title}</a>
							{#if row.spaceName}
								<div class="truncate text-[10px] text-text-placeholder">{row.spaceName}</div>
							{/if}
						</div>
						<span class="font-mono text-text-secondary">{formatCompact(row.viewCount, locale)}</span>
					</li>
				{/each}
			</ol>
		{:else}
			<p class="text-[12px] text-text-placeholder">{m.activity_no_app_views({}, { locale })}</p>
		{/if}
	</section>
</div>
