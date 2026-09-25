<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLImgAttributes } from "svelte/elements";
import { SvelteSet } from "svelte/reactivity";

type Props = Omit<HTMLImgAttributes, "src" | "onerror"> & {
	/** Sources in priority order; each failure falls through to the next. */
	candidates: readonly string[];
	/** Rendered once every candidate has failed (or there are none). */
	fallback?: Snippet;
};

const {
	candidates,
	alt = "",
	loading = "lazy",
	fallback,
	...rest
}: Props = $props();

// Failures are per URL, so a refined candidate list never retries one.
const failed = new SvelteSet<string>();
const src = $derived(candidates.find((url) => !failed.has(url)));
</script>

{#if src}
	<img
		{...rest}
		{src}
		{alt}
		{loading}
		decoding="async"
		draggable="false"
		onerror={(event) => {
			const url = event.currentTarget.getAttribute("src");
			if (url) failed.add(url);
		}}
	/>
{:else}
	{@render fallback?.()}
{/if}
