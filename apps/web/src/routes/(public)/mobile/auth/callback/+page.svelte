<script lang="ts">
import { Smartphone } from "lucide-svelte";
import { m } from "$lib/paraglide/messages.js";
import type { PageProps } from "./$types";

const { data }: PageProps = $props();
const locale = $derived(data.locale);
</script>

<svelte:head>
	<title>{m.mobile_auth_callback_seo_title({}, { locale })}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main lang={locale} class="flex min-h-screen items-center justify-center px-6">
	<div class="flex max-w-sm flex-col items-center gap-3 text-center">
		<div
			class="inline-flex h-10 w-10 items-center justify-center rounded-[10px] border border-brand-border bg-brand-muted text-brand-muted-fg"
		>
			<Smartphone class="h-5 w-5" aria-hidden="true" />
		</div>
		<h1 class="text-[15px] font-semibold text-text-primary">
			{m.mobile_auth_callback_title({}, { locale })}
		</h1>
		<p class="text-[13px] leading-relaxed text-text-secondary">
			{m.mobile_auth_callback_description({}, { locale })}
		</p>
		<a
			href={data.appHref}
			class="mt-2 inline-flex min-h-10 items-center justify-center rounded-lg bg-brand px-5 text-[13px] font-semibold text-brand-contrast-fg transition-colors hover:bg-brand-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand/50"
		>
			{m.mobile_auth_callback_open_app({}, { locale })}
		</a>
		<a href="/" class="text-xs text-text-tertiary underline hover:text-text-secondary">
			{m.callback_back_home({}, { locale })}
		</a>
	</div>
</main>
