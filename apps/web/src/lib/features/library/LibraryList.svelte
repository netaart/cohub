<script lang="ts">
import {
	USER_APP_FILTERS,
	USER_CRONJOB_FILTERS,
	type UserAppFilter,
	type UserCronJobFilter,
} from "@neta-art/cohub";
import { onMount, untrack } from "svelte";
import { page } from "$app/state";
import FilterBar from "$lib/components/list-page/FilterBar.svelte";
import FilterChip from "$lib/components/list-page/FilterChip.svelte";
import ListHeader from "$lib/components/list-page/ListHeader.svelte";
import SwipePager from "$lib/components/list-page/SwipePager.svelte";
import { SwipeTabs } from "$lib/components/list-page/swipe-tabs.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { useCompactShell } from "$lib/layout/compact-shell.svelte";
import { onListScrollTop } from "$lib/layout/list-scroll-top";
import {
	type LibraryItemEntity,
	librarySelectionAt,
} from "$lib/library-routes";
import { m } from "$lib/paraglide/messages.js";
import LibraryListPane from "./LibraryListPane.svelte";
import LibraryTabs from "./LibraryTabs.svelte";
import { appFilterLabel, cronJobFilterLabel } from "./library-copy";
import { libraryInbox } from "./library-inbox.svelte";

const {
	entity,
	variant,
}: { entity: LibraryItemEntity; variant: "sidebar" | "page" } = $props();

const locale = $derived(getLocale());
const isPage = $derived(variant === "page");
const compact = $derived(useCompactShell());
const swipeable = $derived(isPage && compact);
const isApps = $derived(entity === "apps");
const filter = $derived<string>(libraryInbox.filters[entity]);
const filters = $derived<readonly string[]>(
	isApps ? USER_APP_FILTERS : USER_CRONJOB_FILTERS,
);
const filterIndex = $derived(Math.max(0, filters.indexOf(filter)));
const tabs = new SwipeTabs(() => ({ index: filterIndex, enabled: swipeable }));
const selectedId = $derived(librarySelectionAt(page.url)?.target.id ?? null);

function filterLabel(value: string) {
	return isApps
		? appFilterLabel(value as UserAppFilter, locale)
		: cronJobFilterLabel(value as UserCronJobFilter, locale);
}

function selectFilter(value: string) {
	if (value === filter) {
		tabs.scrollToTop();
		return;
	}
	if (isApps) libraryInbox.filters.apps = value as UserAppFilter;
	else libraryInbox.filters.scheduled = value as UserCronJobFilter;
}

$effect(() => {
	const current = entity;
	const value = filter;
	return untrack(() => libraryInbox.watch(current, value));
});

$effect(() => {
	if (!swipeable) return;
	const current = entity;
	const values = [filters[filterIndex - 1], filters[filterIndex + 1]].filter(
		(value) => value !== undefined,
	);
	untrack(() => {
		for (const value of values) void libraryInbox.open(current, value);
	});
});

onMount(() => onListScrollTop(() => tabs.scrollToTop()));
</script>

<section class="flex h-full min-h-0 flex-col {isPage ? 'bg-bg-primary' : 'list-compact'}">
	{#if isPage}
		<div class="shrink-0">
			<ListHeader title={m.nav_tab_library({}, { locale })}>
				<LibraryTabs variant="header" />
			</ListHeader>
		</div>
	{/if}
	<div class="shrink-0 border-b border-border-subtle">
		<FilterBar
			label={m.nav_tab_library({}, { locale })}
			role="tablist"
			activeKey={filters[tabs.shown] ?? null}
			position={tabs.position}
			glide={tabs.glide}
		>
			{#each filters as value, index (value)}
				<FilterChip label={filterLabel(value)} active={tabs.shown === index} onclick={() => selectFilter(value)} />
			{/each}
		</FilterBar>
	</div>

	{#key entity}
		<SwipePager
			keys={filters}
			index={filterIndex}
			enabled={swipeable}
			onChange={(index) => selectFilter(filters[index] ?? filter)}
			onPosition={tabs.track}
		>
			{#snippet page(index, active)}
				<LibraryListPane
					bind:this={() => tabs.panes[index], (pane) => (tabs.panes[index] = pane)}
					{entity}
					filter={filters[index] ?? filter}
					{variant}
					split={!compact}
					{active}
					{selectedId}
				/>
			{/snippet}
		</SwipePager>
	{/key}
</section>
