<script lang="ts">
import "../../app.css";
import { onMount } from "svelte";
import { page } from "$app/state";
import { markHostReady } from "$lib/host-bridge";
import "$lib/theme.svelte";

const { children } = $props();

// The home page reports for itself once it picks marketing or the app.
onMount(() => {
	if (!isHomePath(page.url.pathname)) markHostReady();
});

function isHomePath(pathname: string) {
	return pathname === "/" || pathname === "/zh";
}

/** Public App routes set icons via AppPageHead; others use shell defaults. */
const isPublicAppPath = $derived.by(() => {
	const segments = page.url.pathname.split("/").filter(Boolean);
	return segments.length === 4 && segments[2] === "w";
});
</script>

<svelte:head>
	{#if !isPublicAppPath}
		<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
		<link rel="apple-touch-icon" href="/pwa/icon-192x192.png" />
	{/if}
</svelte:head>

{#if isPublicAppPath}
	<!--
		An App page owns the whole viewport: its chrome and the App share one
		column, so the page itself never scrolls. Height comes from the documented
		`html, body { height: 100% }` chain — never `dvh`, which lags in a
		standalone PWA. `overflow-x-clip` on document pages is dropped here.
	-->
	<div class="safe-area-top h-full overflow-hidden bg-bg-primary text-text-primary">
		{@render children?.()}
	</div>
{:else}
	<div class="min-h-screen overflow-x-clip bg-bg-primary text-text-primary">
		{@render children?.()}
	</div>
{/if}
