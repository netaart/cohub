<script lang="ts">
import { ArrowUp, Square } from "lucide-svelte";
import Spinner from "$lib/components/Spinner.svelte";

const {
	label,
	disabled = false,
	loading = false,
	stop = false,
	buttonType = "submit",
	onclick,
}: {
	label: string;
	disabled?: boolean;
	loading?: boolean;
	stop?: boolean;
	buttonType?: "button" | "submit";
	onclick?: () => void;
} = $props();
</script>

<button
	type={stop ? "button" : buttonType}
	{disabled}
	class={`primary-key flex h-9 w-9 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:bg-bg-hover-strong disabled:text-text-disabled ${stop ? "bg-text-primary text-bg-primary hover:bg-text-secondary" : "bg-brand text-brand-contrast-fg hover:bg-brand-hover"}`}
	title={label}
	aria-label={label}
	{onclick}
>
	{#if loading}
		<Spinner class="h-4 w-4" />
	{:else if stop}
		<Square class="h-3.5 w-3.5 fill-current" />
	{:else}
		<ArrowUp class="h-4 w-4" />
	{/if}
</button>
