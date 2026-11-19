<script lang="ts">
import geistLatin from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url";

let { children } = $props();
</script>

<svelte:head>
	<link rel="preload" href={geistLatin} as="font" type="font/woff2" crossorigin="anonymous" />
</svelte:head>

{@render children()}
