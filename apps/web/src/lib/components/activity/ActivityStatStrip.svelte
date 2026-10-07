<script lang="ts">
import type { UsageTotals } from "@neta-art/cohub";
import { type ActivityDay, formatCompact, formatCost } from "$lib/activity";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

type Props = {
	days: ActivityDay[];
	totals: UsageTotals;
	/** Cost reads as commercial data — hide it for non space managers. */
	showCost: boolean;
};

const { days, totals, showCost }: Props = $props();

const locale = $derived(getLocale());
const activeDays = $derived(days.filter((day) => day.requests > 0).length);
</script>

<section
	class="grid grid-cols-2 border-b border-border-subtle py-6 sm:grid-cols-4"
	aria-label={m.activity_summary_aria({}, { locale })}
>
	<div class="border-r border-border-subtle pr-3 sm:pr-5">
		<div class="font-mono text-[20px] text-text-primary sm:text-[22px]">{formatCompact(totals.totalTokens, locale)}</div>
		<div class="mt-1 text-[11px] text-text-placeholder">{m.activity_tokens({}, { locale })}</div>
	</div>
	<div class="pl-3 sm:border-r sm:border-border-subtle sm:px-5">
		<div class="font-mono text-[20px] text-text-primary sm:text-[22px]">{formatCompact(totals.requestCount, locale)}</div>
		<div class="mt-1 text-[11px] text-text-placeholder">{m.activity_requests({}, { locale })}</div>
	</div>
	<div class="mt-5 pr-3 sm:mt-0 sm:px-5" class:border-r={showCost} class:border-border-subtle={showCost}>
		<div class="font-mono text-[20px] text-text-primary sm:text-[22px]">{activeDays}</div>
		<div class="mt-1 text-[11px] text-text-placeholder">{m.activity_active_days({}, { locale })}</div>
	</div>
	{#if showCost}
		<div class="mt-5 pl-3 sm:mt-0 sm:pl-5">
			<div class="font-mono text-[20px] text-text-primary sm:text-[22px]">{formatCost(totals.costTotal, locale)}</div>
			<div class="mt-1 text-[11px] text-text-placeholder">{m.activity_cost({}, { locale })}</div>
		</div>
	{/if}
</section>
