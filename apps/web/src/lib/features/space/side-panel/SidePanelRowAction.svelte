<script lang="ts">
import type { Settings2 } from "lucide-svelte";

type Props = {
	icon: typeof Settings2;
	label: string;
	itemName?: string;
	tone?: "default" | "danger";
	disabled?: boolean;
} & ({ href: string; onclick?: never } | { href?: never; onclick: () => void });

const {
	icon: Icon,
	label,
	itemName,
	tone = "default",
	disabled = false,
	href,
	onclick,
}: Props = $props();

const className = $derived(
	`inline-flex h-7 w-7 items-center justify-center rounded-[5px] text-text-placeholder opacity-0 transition-[opacity,color,background-color] hover:bg-bg-hover-strong focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-0 [@media(hover:none)]:opacity-100 ${tone === "danger" ? "hover:text-error-soft" : "hover:text-text-primary"}`,
);
const ariaLabel = $derived(itemName ? `${label} ${itemName}` : label);
</script>

{#if href}
	<a class={className} {href} target="_blank" rel="noopener" title={label} aria-label={ariaLabel} draggable="false">
		<Icon class="h-3.5 w-3.5" />
	</a>
{:else}
	<button type="button" class={className} title={label} aria-label={ariaLabel} {disabled} {onclick}>
		<Icon class="h-3.5 w-3.5" />
	</button>
{/if}
