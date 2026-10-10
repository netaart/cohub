<script lang="ts">
import { Loader2 } from "lucide-svelte";
import type { Snippet } from "svelte";
import { fade } from "svelte/transition";
import { getLocale } from "$lib/i18n/locale.svelte";
import { DURATION_FAST, svelteEaseOut } from "$lib/motion.svelte";
import { m } from "$lib/paraglide/messages.js";
import { uiState } from "$lib/stores/ui.svelte";
import { syncStatus } from "$lib/sync/sync-status.svelte";

const {
	title,
	brand = true,
	actions,
	children,
}: {
	title: string;
	brand?: boolean;
	actions?: Snippet;
	children?: Snippet;
} = $props();

const locale = $derived(getLocale());
const status = $derived.by(() => {
	switch (syncStatus.phase) {
		case "offline":
			return m.sync_waiting_network({}, { locale });
		case "connecting":
			return m.sync_connecting({}, { locale });
		case "updating":
			return m.sync_updating({}, { locale });
		default:
			return null;
	}
});
</script>

<header class="flex h-11 shrink-0 items-center gap-1 pl-[calc(var(--list-content-x)-5px)] pr-[calc(var(--list-content-x)-10px)] lg:h-10 lg:pl-[var(--list-content-x)] lg:pr-[calc(var(--list-content-x)-6px)]">
	{#if brand}
		<button
			type="button"
			class="group mr-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 lg:hidden"
			aria-label={m.sessions_open_nav({}, { locale })}
			onclick={() => {
				uiState.mobileDrawerOpen = !uiState.mobileDrawerOpen;
			}}
		>
			<span class="flex size-7.5 items-center justify-center rounded-[8px] bg-brand text-[12px] font-bold text-brand-contrast-fg transition-colors duration-100 group-hover:bg-brand-hover">C</span>
		</button>
	{/if}
	<div class="flex min-w-0 flex-1 items-center gap-1.5 {brand ? 'lg:pl-0' : 'pl-1.25 lg:pl-0'}">
		{#if children}
			{@render children()}
		{:else if status}
			<h1 class="sr-only">{title}</h1>
			<span
				class="flex min-w-0 items-center gap-1.5 text-[15px] font-semibold tracking-tight text-text-secondary lg:text-[13px]"
				role="status"
				in:fade={{ duration: DURATION_FAST, easing: svelteEaseOut }}
			>
				<Loader2 class="h-3.5 w-3.5 shrink-0 animate-spin text-text-tertiary lg:h-3 lg:w-3" aria-hidden="true" />
				<span class="truncate">{status}</span>
			</span>
		{:else}
			<h1 class="truncate text-[15px] font-semibold tracking-tight text-text-primary lg:text-[13px]" in:fade={{ duration: DURATION_FAST, easing: svelteEaseOut }}>{title}</h1>
		{/if}
	</div>
	{#if actions}
		<div class="flex shrink-0 items-center gap-0.5">
			{@render actions()}
		</div>
	{/if}
</header>
