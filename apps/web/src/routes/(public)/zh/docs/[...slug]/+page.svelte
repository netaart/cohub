<script lang="ts">
import DocsArticle from "#lib/components/docs/DocsArticle.svelte";
import type { DocsPage } from "#lib/docs/index.ts";
import { docsSeo } from "#lib/docs/seo.ts";

const {
	data,
}: {
	data: { doc: DocsPage };
} = $props();

const seo = $derived(docsSeo(data.doc));
</script>

<svelte:head>
	<title>{seo.title}</title>
	<meta name="description" content={seo.description} />
	<link rel="canonical" href={seo.canonical} />
	<link rel="alternate" hreflang="en" href={seo.enHref} />
	<link rel="alternate" hreflang="zh-CN" href={seo.zhHref} />
	<link rel="alternate" hreflang="x-default" href={seo.enHref} />
	<meta property="og:title" content={seo.title} />
	<meta property="og:description" content={seo.description} />
	<meta property="og:url" content={seo.canonical} />
	<meta property="og:type" content="article" />
	<meta property="og:site_name" content="Cohub" />
	<meta property="og:locale" content={seo.ogLocale} />
	<meta property="og:locale:alternate" content={seo.altLocale} />
	<meta property="og:image" content={seo.ogImage} />
	<meta name="twitter:card" content="summary" />
	<meta name="twitter:title" content={seo.title} />
	<meta name="twitter:description" content={seo.description} />
	<meta name="twitter:image" content={seo.ogImage} />
</svelte:head>

<DocsArticle doc={data.doc} />
