<script lang="ts">
import type { SpaceCommerceOrder } from "@neta-art/cohub";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import { sdk } from "#lib/sdk.ts";
import CommerceOrderRows from "./CommerceOrderRows.svelte";

const {
	spaceId,
	shop,
}: { spaceId: string; shop: { id: string; name: string } } = $props();
const locale = $derived(getLocale());
let orders = $state<SpaceCommerceOrder[]>([]);
let nextPage = $state<number | null>(1);
let busy = $state(false);
let failed = $state(false);

async function load() {
	if (busy || nextPage === null) return;
	busy = true;
	failed = false;
	try {
		const page = await sdk
			.space(spaceId)
			.commerce.listReportOrders(shop.id, { page: nextPage, limit: 20 });
		const seen = new Set(orders.map((order) => order.id));
		orders = [...orders, ...page.orders.filter((order) => !seen.has(order.id))];
		nextPage = page.pagination.nextPage;
	} catch {
		failed = true;
	} finally {
		busy = false;
	}
}
</script>

<details class="mt-2 border-t border-border-subtle" ontoggle={(event) => { if (event.currentTarget.open && nextPage === 1) void load(); }}>
	<summary class="cursor-pointer break-words py-2 text-[13px] font-medium text-text-primary">{shop.name}</summary>
	<div class="space-y-2 pb-2" aria-busy={busy}>
		{#if orders.length}<CommerceOrderRows {orders} />
		{:else if nextPage === null}<p class="text-[12px] text-text-tertiary">{m.commerce_no_orders({}, { locale })}</p>{/if}
		{#if nextPage !== null}
			<button type="button" class="secondary-key min-h-9 px-3 text-[12px]" disabled={busy} onclick={load}>
				{busy ? m.commerce_loading_orders({}, { locale }) : failed ? m.commerce_report_retry({}, { locale }) : m.commerce_load_more({}, { locale })}
			</button>
		{/if}
	</div>
</details>
