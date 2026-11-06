<script lang="ts">
import SpaceFundPanel from "$lib/features/billing/SpaceFundPanel.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const props = $props<{ params: { id: string } }>();
const locale = $derived(getLocale());
</script>

<svelte:head><title>{m.wallet_fund({}, { locale })} — Cohub</title></svelte:head>

<div class="flex min-h-screen items-center justify-center bg-bg-primary px-4 py-10">
	<main class="w-full max-w-[440px]">
		<a href="/" class="mb-8 inline-flex h-9 w-9 items-center justify-center rounded-[7px] bg-brand text-[12px] font-bold text-brand-contrast-fg" aria-label="Cohub">C</a>
		<div class="border-t border-border-subtle pt-7">
			{#key props.params.id}<SpaceFundPanel spaceId={props.params.id} identity="heading" />{/key}
		</div>
	</main>
</div>
