<script lang="ts">
import SpaceFundPanel from "$lib/features/billing/SpaceFundPanel.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const props = $props<{ params: { id: string } }>();
const locale = $derived(getLocale());
</script>

<svelte:head><title>{m.wallet_fund({}, { locale })} — Cohub</title></svelte:head>

<div class="safe-area-top min-h-screen bg-bg-primary">
	<header class="mx-auto flex h-14 w-full max-w-[440px] items-center px-4 sm:h-16">
		<a href="/" class="flex items-center gap-1.5 transition-opacity hover:opacity-80">
			<img src="/favicon.svg" alt="" class="h-5 w-5 rounded-[5px]" />
			<span class="text-[13px] font-semibold tracking-tight text-text-primary">Cohub</span>
		</a>
	</header>
	<main class="mx-auto w-full max-w-[440px] px-4 pt-6 pb-10 sm:pt-[10vh]">
		{#key props.params.id}<SpaceFundPanel spaceId={props.params.id} identity="heading" />{/key}
	</main>
</div>
