<script lang="ts">
import { Search } from "lucide-svelte";
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { openAreaSearch } from "$lib/command-palette/open";
import FilterBar from "$lib/components/list-page/FilterBar.svelte";
import FilterChip from "$lib/components/list-page/FilterChip.svelte";
import HeaderAction from "$lib/components/list-page/HeaderAction.svelte";
import ListHeader from "$lib/components/list-page/ListHeader.svelte";
import SwipePager from "$lib/components/list-page/SwipePager.svelte";
import { SwipeTabs } from "$lib/components/list-page/swipe-tabs.svelte";
import {
	settingsSectionLabel,
	settingsSectionTitle,
} from "$lib/components/settings-section";
import SettingsSection from "$lib/features/settings/SettingsSection.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { useCompactShell } from "$lib/layout/compact-shell.svelte";
import { onListScrollTop } from "$lib/layout/list-scroll-top";
import { m } from "$lib/paraglide/messages.js";
import {
	resolveSettingsSection,
	resolveSettingsSectionRoot,
	settingsSectionHref,
	visibleSettingsSections,
} from "$lib/settings-nav";
import { authStore } from "$lib/stores/auth.svelte";
import { billingCatalogStore } from "$lib/stores/billing-catalog.svelte";

const { children } = $props();

const locale = $derived(getLocale());
const compact = $derived(useCompactShell());
const activeSection = $derived(resolveSettingsSection(page.url.pathname));
const rootSection = $derived(resolveSettingsSectionRoot(page.url.pathname));
const paged = $derived(compact && rootSection !== null);
const sections = $derived(
	visibleSettingsSections(billingCatalogStore.available),
);
const tabs = new SwipeTabs(() => ({
	index: Math.max(0, sections.indexOf(activeSection ?? "general")),
	enabled: paged,
}));

function open(index: number) {
	const section = sections[index];
	if (!section) return;
	void goto(settingsSectionHref(section), {
		replaceState: true,
		keepFocus: true,
		noScroll: true,
	});
}

function select(event: MouseEvent, index: number) {
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
		return;
	event.preventDefault();
	if (paged && index === tabs.index) tabs.scrollToTop();
	else open(index);
}

onMount(() => {
	if (authStore.isAuthenticated)
		void billingCatalogStore.load({ silent: true }).catch(() => undefined);
	return onListScrollTop(() => tabs.scrollToTop());
});
</script>

<svelte:head>
	{#if rootSection}
		<title>{settingsSectionTitle(rootSection, locale)} — Cohub</title>
	{/if}
</svelte:head>

<div class="flex min-h-0 flex-1 flex-col overflow-hidden">
	<div class="shrink-0 border-b border-border-subtle bg-bg-primary lg:hidden">
		<ListHeader title={m.nav_tab_account({}, { locale })}>
			{#snippet actions()}
				<HeaderAction
					label={m.list_search({}, { locale })}
					icon={Search}
					onclick={() => openAreaSearch("account")}
				/>
			{/snippet}
		</ListHeader>
		<FilterBar
			label={m.nav_settings({}, { locale })}
			role="navigation"
			activeKey={sections[tabs.shown] ?? null}
			position={activeSection ? tabs.position : null}
			glide={tabs.glide}
		>
			{#each sections as section, index (section)}
				<FilterChip
					label={settingsSectionLabel(section, locale)}
					href={settingsSectionHref(section)}
					active={activeSection !== null && tabs.shown === index}
					onclick={(event) => select(event, index)}
				/>
			{/each}
		</FilterBar>
	</div>

	{#if paged}
		<SwipePager keys={sections} index={tabs.index} onChange={open} onPosition={tabs.track}>
			{#snippet page(index, active)}
				<SettingsSection
					bind:this={() => tabs.panes[index], (pane) => (tabs.panes[index] = pane)}
					section={sections[index] ?? "general"}
					{active}
				/>
			{/snippet}
		</SwipePager>
	{:else}
		{@render children?.()}
	{/if}
</div>
