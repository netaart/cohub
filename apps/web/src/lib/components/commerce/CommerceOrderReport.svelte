<script lang="ts">
import { onMount } from "svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import { sdk } from "#lib/sdk.ts";
import CommerceReportShop from "./CommerceReportShop.svelte";

const { spaceId }: { spaceId: string } = $props();
const locale = $derived(getLocale());
let shops = $state<{ id: string; name: string }[]>([]);
let failed = $state(false);

async function load() {
	failed = false;
	try {
		shops = (await sdk.space(spaceId).commerce.listReportShops()).shops;
	} catch {
		failed = true;
	}
}
onMount(() => {
	void load();
});
</script>

{#if shops.length || failed}
	<section class="rounded-[8px] border border-border-subtle bg-bg-content px-4 py-3 sm:px-5">
		<h2 class="text-[15px] font-medium text-text-primary">{m.commerce_order_report({}, { locale })}</h2>
		{#if failed}
			<button type="button" class="secondary-key mt-2 min-h-9 px-3" onclick={load}>{m.commerce_report_retry({}, { locale })}</button>
		{:else}
			{#each shops as shop (shop.id)}
				<CommerceReportShop {spaceId} {shop} />
			{/each}
		{/if}
	</section>
{/if}
