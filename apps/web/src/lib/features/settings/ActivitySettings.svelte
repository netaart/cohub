<script lang="ts">
import type { UserActivityResponse } from "@neta-art/cohub";
import { buildActivityDays } from "$lib/activity";
import { ensureAuth } from "$lib/auth";
import { USER_ACTIVITY_SCOPE } from "$lib/cache/repositories/activity-repo";
import ActivityHeatmap from "$lib/components/activity/ActivityHeatmap.svelte";
import ActivityPage from "$lib/components/activity/ActivityPage.svelte";
import ActivityRankings from "$lib/components/activity/ActivityRankings.svelte";
import ActivityStatStrip from "$lib/components/activity/ActivityStatStrip.svelte";
import { createActivityController } from "$lib/components/activity/activity-controller.svelte";
import { onSettingsPageActive } from "$lib/features/settings/page-context.svelte";
import { formatDateTime } from "$lib/i18n/format";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { authStore } from "$lib/stores/auth.svelte";

function localDayRange(days: number) {
	const to = new Date();
	const from = new Date(to);
	from.setHours(0, 0, 0, 0);
	from.setDate(from.getDate() - (days - 1));
	return { from, to };
}

const controller = createActivityController<UserActivityResponse>({
	scope: USER_ACTIVITY_SCOPE,
	initialDays: 365,
	fetch: (days) => sdk.user.getActivity(localDayRange(days)),
});

const locale = $derived(getLocale());
const identityLabel = $derived(
	authStore.profile?.username
		? `@${authStore.profile.username}`
		: authStore.profile?.displayName || m.activity_your_account({}, { locale }),
);
const rangeLabel = $derived(
	controller.selectedDays === 365
		? m.activity_last_year({}, { locale })
		: m.activity_last_days({ days: controller.selectedDays }, { locale }),
);
const range = $derived(controller.activity?.range);

onSettingsPageActive(async () => {
	if (await ensureAuth()) void controller.load();
});
</script>

<ActivityPage
	{controller}
	title={m.page_title_activity({}, { locale })}
	subtitle={`${identityLabel} · ${rangeLabel}`}
	subtitleTitle={range
		? `${formatDateTime(range.from, locale)} – ${formatDateTime(range.to, locale)}`
		: undefined}
>
	{#snippet children(activity)}
		{@const days = buildActivityDays(activity, controller.selectedDays)}
		<ActivityStatStrip {days} totals={activity.totals} showCost />
		<ActivityHeatmap {days} />
		<ActivityRankings rankings={activity.rankings} showCost />
	{/snippet}
</ActivityPage>
