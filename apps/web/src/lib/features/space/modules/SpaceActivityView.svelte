<script lang="ts">
import type { SpaceActivityResponse } from "@neta-art/cohub";
import { onMount, untrack } from "svelte";
import { page } from "$app/state";
import { buildActivityDays } from "$lib/activity";
import { ensureAuth } from "$lib/auth";
import ActivityContributors from "$lib/components/activity/ActivityContributors.svelte";
import ActivityHeatmap from "$lib/components/activity/ActivityHeatmap.svelte";
import ActivityPage from "$lib/components/activity/ActivityPage.svelte";
import ActivityRankings from "$lib/components/activity/ActivityRankings.svelte";
import ActivityStatStrip from "$lib/components/activity/ActivityStatStrip.svelte";
import { createActivityController } from "$lib/components/activity/activity-controller.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { getCachedSpaceRecord } from "$lib/stores/space-record-cache";

const { data }: { data: { spaceId: string } } = $props();
const spaceId = untrack(() => data.spaceId);

const locale = $derived(getLocale());
const controller = createActivityController<SpaceActivityResponse>({
	scope: spaceId,
	initialDays: 30,
	fetch: (days) => sdk.space(spaceId).activity.get(days),
});

let spaceName = $state<string | null>(null);
let canViewCost = $state(false);

onMount(async () => {
	if (!(await ensureAuth({ redirectPath: page.url.pathname }))) return;
	void controller.load();
	const record = (await getCachedSpaceRecord(spaceId))?.space;
	if (!record) return;
	spaceName = record.name || record.title || spaceId;
	canViewCost =
		record.access?.role === "host" || record.access?.role === "builder";
});
</script>

<svelte:head>
	<title>{spaceName ? `${spaceName} · ` : ""}{m.page_title_activity({}, { locale })} — Cohub</title>
</svelte:head>

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
	<ActivityPage
		{controller}
		title={spaceName ?? m.nav_activity({}, { locale })}
		subtitle={m.nav_activity({}, { locale })}
	>
		{#snippet children(activity)}
			{@const days = buildActivityDays(activity, controller.selectedDays)}
			<ActivityStatStrip {days} totals={activity.totals} showCost={canViewCost} />
			<ActivityHeatmap {days} />
			<ActivityContributors
				items={activity.contributors.items}
				memberCount={activity.contributors.memberCount}
				showCost={canViewCost}
			/>
			<ActivityRankings {spaceId} rankings={activity.rankings} showCost={canViewCost} />
		{/snippet}
	</ActivityPage>
</div>
