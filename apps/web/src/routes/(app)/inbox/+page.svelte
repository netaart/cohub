<script lang="ts">
import ListHeader from "#lib/components/list-page/ListHeader.svelte";
import NotificationList from "#lib/components/notifications/NotificationList.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

const locale = $derived(getLocale());
</script>

<svelte:head>
	<title>{m.inbox_title({}, { locale })} — Cohub</title>
</svelte:head>

<div class="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-bg-primary">
	<div class="shrink-0 lg:hidden">
		<ListHeader title={m.inbox_title({}, { locale })} />
	</div>
	<div class="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col">
		<NotificationList />
	</div>
</div>
