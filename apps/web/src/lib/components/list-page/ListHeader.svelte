<script lang="ts">
import { Loader2 } from "lucide-svelte";
import type { Snippet } from "svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { uiState } from "$lib/stores/ui.svelte";

const {
	title,
	busy = false,
	brand = true,
	actions,
	children,
}: {
	title: string;
	busy?: boolean;
	brand?: boolean;
	actions?: Snippet;
	children?: Snippet;
} = $props();

const locale = $derived(getLocale());
</script>

<header class="flex h-11 shrink-0 items-center gap-1 pl-[calc(var(--list-content-x)-4px)] pr-[calc(var(--list-content-x)-9px)] lg:h-10 lg:pl-[var(--list-content-x)] lg:pr-[calc(var(--list-content-x)-6px)]">
	{#if brand}
		<button
			type="button"
			class="group mr-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 lg:hidden"
			aria-label={m.sessions_open_nav({}, { locale })}
			onclick={() => {
				uiState.mobileDrawerOpen = !uiState.mobileDrawerOpen;
			}}
		>
			<span class="flex h-7 w-7 items-center justify-center rounded-[7px] bg-brand text-[11px] font-bold text-brand-contrast-fg transition-colors duration-100 group-hover:bg-brand-hover">C</span>
		</button>
	{/if}
	<div class="flex min-w-0 flex-1 items-center gap-1.5 {brand ? 'lg:pl-0' : 'pl-1 lg:pl-0'}">
		{#if children}
			{@render children()}
		{:else}
			<h1 class="truncate text-[15px] font-semibold tracking-tight text-text-primary lg:text-[13px]">{title}</h1>
			{#if busy}
				<Loader2 class="h-3 w-3 shrink-0 animate-spin text-text-placeholder" aria-hidden="true" />
			{/if}
		{/if}
	</div>
	{#if actions}
		<div class="flex shrink-0 items-center gap-0.5">
			{@render actions()}
		</div>
	{/if}
</header>
