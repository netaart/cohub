<script lang="ts">
import { Search } from "lucide-svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { openAreaSearch } from "$lib/command-palette/open";
import FilterBar from "$lib/components/list-page/FilterBar.svelte";
import FilterChip from "$lib/components/list-page/FilterChip.svelte";
import HeaderAction from "$lib/components/list-page/HeaderAction.svelte";
import ListHeader from "$lib/components/list-page/ListHeader.svelte";
import { settingsSectionLabel } from "$lib/components/settings-section";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import {
	resolveSettingsSection,
	SETTINGS_SECTIONS,
	settingsSectionHref,
} from "$lib/settings-nav";

const locale = $derived(getLocale());
const activeSection = $derived(resolveSettingsSection(page.url.pathname));

const { children } = $props();

function openSection(event: MouseEvent, href: string) {
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
		return;
	event.preventDefault();
	void goto(href, { replaceState: true, keepFocus: true, noScroll: true });
}
</script>

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
		<FilterBar label={m.nav_settings({}, { locale })} role="navigation" activeKey={activeSection}>
			{#each SETTINGS_SECTIONS as section (section)}
				{@const href = settingsSectionHref(section)}
				<FilterChip
					label={settingsSectionLabel(section, locale)}
					{href}
					active={activeSection === section}
					onclick={(event) => openSection(event, href)}
				/>
			{/each}
		</FilterBar>
	</div>

	{@render children?.()}
</div>
