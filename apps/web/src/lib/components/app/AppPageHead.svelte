<script lang="ts">
import type { AppPageMeta } from "#lib/app-page-meta.ts";

const {
	meta,
}: {
	meta: AppPageMeta;
} = $props();
</script>

<svelte:head>
	<!-- hooks.server.ts reads this to set <html lang> for app public pages. -->
	{#if meta.lang}
		<meta name="cohub-app-lang" content={meta.lang} />
	{/if}
	<title>{meta.documentTitle}</title>
	<meta name="description" content={meta.description} />
	<meta name="robots" content={meta.robots} />
	<link rel="canonical" href={meta.canonical} />
	{#if meta.framePreconnectOrigin}
		<link rel="preconnect" href={meta.framePreconnectOrigin} crossorigin="anonymous" />
	{/if}
	<!-- Always emit icons on app routes so app.html/public defaults never win. -->
	<link
		rel="icon"
		href={meta.iconUrl ?? "/favicon.svg"}
		type={meta.iconUrl ? undefined : "image/svg+xml"}
	/>
	<link
		rel="apple-touch-icon"
		href={meta.iconUrl ?? "/pwa/icon-192x192.png"}
	/>
	<meta name="application-name" content={meta.shortName} />
	<meta name="apple-mobile-web-app-title" content={meta.shortName} />
	{#if meta.themeColor}
		<meta name="theme-color" content={meta.themeColor} />
	{/if}
	<meta property="og:type" content="website" />
	<meta property="og:site_name" content={meta.siteName} />
	<meta property="og:title" content={meta.documentTitle} />
	<meta property="og:description" content={meta.description} />
	<meta property="og:url" content={meta.canonical} />
	{#if meta.ogLocale}
		<meta property="og:locale" content={meta.ogLocale} />
	{/if}
	{#if meta.imageUrl}
		<meta property="og:image" content={meta.imageUrl} />
		<meta property="og:image:alt" content={meta.documentTitle} />
	{/if}
	<meta name="twitter:card" content={meta.twitterCard} />
	<meta name="twitter:title" content={meta.documentTitle} />
	<meta name="twitter:description" content={meta.description} />
	{#if meta.imageUrl}
		<meta name="twitter:image" content={meta.imageUrl} />
	{/if}
	{@html `<script type="application/ld+json">${meta.jsonLd.replace(/</g, "\\u003c")}</script>`}
</svelte:head>
