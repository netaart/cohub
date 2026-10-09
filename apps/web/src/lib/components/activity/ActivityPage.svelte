<script lang="ts" generics="T">
import { Loader2 } from "lucide-svelte";
import type { Snippet } from "svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import {
	ACTIVITY_RANGES,
	type ActivityController,
	type ActivityRange,
} from "./activity-controller.svelte";

type Props = {
	controller: ActivityController<T>;
	title: string;
	subtitle: string;
	subtitleTitle?: string;
	children: Snippet<[T]>;
};

const { controller, title, subtitle, subtitleTitle, children }: Props =
	$props();

const RANGE_LABELS: Record<ActivityRange, string> = {
	7: "7D",
	30: "30D",
	365: "1Y",
};

const locale = $derived(getLocale());

function rangeLabel(days: ActivityRange) {
	return days === 365
		? m.activity_last_year({}, { locale })
		: m.activity_last_days({ days }, { locale });
}
</script>

<div class="w-full max-w-5xl px-4 py-7 sm:px-6 lg:px-8">
	<header class="flex flex-wrap items-end justify-between gap-4 border-b border-border-subtle pb-5">
		<div class="min-w-0">
			<p class="text-[11px] font-semibold text-brand">Cohub</p>
			<h1 class="mt-1 truncate text-[20px] font-semibold text-text-primary">{title}</h1>
			<p class="mt-1 text-[12px] text-text-tertiary" title={subtitleTitle}>{subtitle}</p>
		</div>
		<div class="flex rounded-md bg-bg-surface p-0.5" aria-label={m.activity_range_aria({}, { locale })}>
			{#each ACTIVITY_RANGES as range (range)}
				<button
					type="button"
					class="min-w-11 rounded-[4px] px-2.5 py-1.5 text-[11px] font-medium transition-colors {controller.selectedDays === range ? 'bg-bg-active text-text-primary' : 'text-text-placeholder hover:text-text-secondary'}"
					aria-pressed={controller.selectedDays === range}
					title={rangeLabel(range)}
					onclick={() => controller.selectRange(range)}
				>{RANGE_LABELS[range]}</button>
			{/each}
		</div>
	</header>

	{#if controller.loading}
		<div class="flex min-h-72 items-center justify-center">
			<Loader2 class="h-5 w-5 animate-spin text-text-placeholder" />
		</div>
	{:else if !controller.activity}
		<div class="py-16 text-center">
			<p class="text-[13px] text-text-secondary">{m.activity_unavailable({}, { locale })}</p>
			{#if controller.loadError}
				<p class="mt-2 text-[12px] text-error-soft">{controller.loadError}</p>
			{/if}
			<button type="button" class="mt-4 text-[12px] font-medium text-brand hover:underline" onclick={() => void controller.load({ force: true })}>
				{m.activity_try_again({}, { locale })}
			</button>
		</div>
	{:else}
		{@render children(controller.activity)}

		{#if controller.loadError}
			<p class="border-t border-border-subtle pt-4 text-[11px] text-text-placeholder">{m.activity_showing_saved({}, { locale })}</p>
		{/if}
		{#if controller.refreshing}
			<p class="pt-3 text-right text-[10px] text-text-placeholder">{m.activity_refreshing({}, { locale })}</p>
		{/if}
	{/if}
</div>
