<script lang="ts">
import type { Search } from "lucide-svelte";

let {
	label,
	icon: Icon,
	href,
	onclick,
	tone = "default",
	disabled = false,
	shortcut,
	ref = $bindable(null),
}: {
	label: string;
	icon: typeof Search;
	href?: string;
	onclick?: (event: MouseEvent) => void;
	tone?: "default" | "brand";
	disabled?: boolean;
	shortcut?: string;
	ref?: HTMLElement | null;
} = $props();

const className = $derived(
	`flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 disabled:pointer-events-none disabled:opacity-50 lg:h-7 lg:w-7 lg:rounded-[6px] ${
		tone === "brand"
			? "text-brand hover:bg-brand-muted"
			: "text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
	}`,
);
const title = $derived(shortcut ? `${label} (${shortcut})` : label);
</script>

{#if href && !disabled}
	<a bind:this={ref} {href} class={className} aria-label={label} {title} {onclick}>
		<Icon class="h-[18px] w-[18px] lg:h-4 lg:w-4" strokeWidth={1.9} />
	</a>
{:else}
	<button bind:this={ref} type="button" class={className} aria-label={label} {title} {disabled} {onclick}>
		<Icon class="h-[18px] w-[18px] lg:h-4 lg:w-4" strokeWidth={1.9} />
	</button>
{/if}
