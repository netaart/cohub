<script lang="ts">
import type { SpaceCommerceOrder } from "@neta-art/cohub";
import UserAvatar from "#lib/components/UserAvatar.svelte";
import { formatCurrency, formatDateTime } from "#lib/i18n/format.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";

const { orders }: { orders: SpaceCommerceOrder[] } = $props();
const locale = $derived(getLocale());

function orderAmount(order: SpaceCommerceOrder): string {
	const amount =
		order.paidAmountSnapshot > 0
			? order.paidAmountSnapshot
			: order.amountSnapshot;
	return formatCurrency(amount / 100, "USD", {
		locale,
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
}

function formatDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return formatDateTime(date, locale, {
		year: undefined,
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}
</script>

<div class="grid gap-2">
	{#each orders as order (order.id)}
		<div class="flex flex-wrap items-center justify-between gap-3 rounded-[7px] bg-bg-primary px-3 py-2">
			<div class="flex min-w-0 items-center gap-2.5">
				{#if order.buyerProfile}
					<UserAvatar
						name={order.buyerProfile.displayName}
						avatarUrl={order.buyerProfile.avatarUrl}
						size="xs"
						class="border-0"
					/>
				{/if}
				<div class="min-w-0">
					<div class="truncate text-[12px] font-medium text-text-primary">{order.productNameSnapshot}</div>
					<div class="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-text-tertiary">
						{#if order.buyerProfile}
							<span class="truncate text-text-secondary">{order.buyerProfile.displayName}</span>
						{/if}
						<span class="truncate font-mono text-text-placeholder">{order.productKeySnapshot}</span>
						<span>{formatDate(order.createdAt)}</span>
					</div>
				</div>
			</div>
			<div class="text-right">
				<div class="font-mono text-[12px] text-text-primary">{orderAmount(order)}</div>
				<div class="text-[10px] uppercase tracking-wide text-text-tertiary">{order.status}</div>
			</div>
		</div>
	{/each}
</div>
