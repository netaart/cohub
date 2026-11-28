<script lang="ts">
import ListHeader from "#lib/components/list-page/ListHeader.svelte";
import NotificationList from "#lib/components/notifications/NotificationList.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { useCompactShell } from "#lib/layout/compact-shell.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import { uiState } from "#lib/stores/ui.svelte.ts";
import LibraryTabs from "./LibraryTabs.svelte";

const locale = $derived(getLocale());
const showHeader = $derived(useCompactShell() || uiState.leftSidebarCollapsed);
</script>

<svelte:head>
	<title>{m.inbox_title({}, { locale })} · Cohub</title>
</svelte:head>

<section class="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-bg-primary">
	{#if showHeader}
		<div class="shrink-0">
			<ListHeader title={m.nav_tab_library({}, { locale })}>
				<LibraryTabs variant="header" />
			</ListHeader>
		</div>
	{/if}
	<div class="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col">
		<NotificationList />
	</div>
</section>
