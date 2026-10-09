<script lang="ts">
import { Menu, Search, X } from "lucide-svelte";
import type { Snippet } from "svelte";
import { onMount } from "svelte";
import { page } from "$app/state";
import DocsLangSwitch from "$lib/components/docs/DocsLangSwitch.svelte";
import DocsSearch from "$lib/components/docs/DocsSearch.svelte";
import DocsSidebar from "$lib/components/docs/DocsSidebar.svelte";
import PublicContentShell from "$lib/components/PublicContentShell.svelte";
import PublicHeader from "$lib/components/PublicHeader.svelte";
import {
	alternateDocsHref,
	type DocsLocale,
	type DocsSearchEntry,
	type DocsSection,
	getDocsUi,
} from "$lib/docs";

type Props = {
	data: {
		locale: DocsLocale;
		currentSlug: string;
		sections: DocsSection[];
		searchEntries: DocsSearchEntry[];
	};
	children: Snippet;
};

let { data, children }: Props = $props();

let mobileNavOpen = $state(false);
let searchOpen = $state(false);

const locale = $derived(data.locale);
const currentSlug = $derived(data.currentSlug);
const ui = $derived(getDocsUi(locale));
const alternateHref = $derived(alternateDocsHref(currentSlug, locale));
const htmlLang = $derived(locale === "zh" ? "zh-CN" : "en");

$effect(() => {
	page.url.pathname;
	mobileNavOpen = false;
	searchOpen = false;
});

// Keep <html lang> in sync on client navigations (SSR/prerender handled by hooks.server).
$effect(() => {
	if (typeof document === "undefined") return;
	document.documentElement.lang = htmlLang;
});

onMount(() => {
	const onKeydown = (event: KeyboardEvent) => {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
			event.preventDefault();
			searchOpen = !searchOpen;
		}
	};
	window.addEventListener("keydown", onKeydown);
	return () => window.removeEventListener("keydown", onKeydown);
});
</script>

{#snippet desktopSidebar()}
	<div class="mb-4 flex items-start justify-between gap-2 px-2">
		<div class="min-w-0">
			<div class="text-[12px] font-semibold tracking-tight text-text-primary">
				{ui.docsLabel}
			</div>
			<p class="mt-1 text-[12px] text-text-tertiary">
				{ui.docsTagline}
			</p>
		</div>
		<DocsLangSwitch {locale} {alternateHref} />
	</div>
	<div class="mb-5 px-2">
		<button
			type="button"
			class="inline-flex h-8 w-full items-center gap-2 rounded-[6px] border border-border-subtle bg-bg-input px-2.5 text-left text-[12px] text-text-tertiary transition-colors hover:border-border-strong hover:text-text-secondary"
			onclick={() => {
				searchOpen = true;
			}}
		>
			<Search class="h-3.5 w-3.5 shrink-0" />
			<span class="min-w-0 flex-1 truncate">{ui.searchButton}</span>
			<kbd
				class="rounded-[4px] border border-border-subtle bg-bg-surface px-1.5 py-0.5 font-mono text-[10px] text-text-placeholder"
				>⌘K</kbd
			>
		</button>
	</div>
	<DocsSidebar sections={data.sections} {currentSlug} />
{/snippet}

<div class="min-h-screen bg-bg-primary text-text-primary">
	<PublicHeader cta="open-app" />

	<PublicContentShell sidebarLabel={ui.docsLabel} sidebar={desktopSidebar}>
		<div class="min-w-0 flex-1">
			<div
				class="sticky top-[var(--public-header-height)] z-20 flex items-center gap-2 border-b border-border-subtle bg-bg-primary/90 px-4 py-2 backdrop-blur-md lg:hidden"
			>
				<button
					type="button"
					class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] border border-border-subtle bg-bg-input text-text-secondary"
					onclick={() => {
						mobileNavOpen = !mobileNavOpen;
					}}
					aria-expanded={mobileNavOpen}
					aria-controls="docs-mobile-nav"
					aria-label={mobileNavOpen ? ui.closeMenu : ui.menu}
				>
					{#if mobileNavOpen}
						<X class="h-3.5 w-3.5" />
					{:else}
						<Menu class="h-3.5 w-3.5" />
					{/if}
				</button>
				<button
					type="button"
					class="inline-flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[6px] border border-border-subtle bg-bg-input px-2.5 text-left text-[12px] text-text-tertiary transition-colors hover:border-border-strong hover:text-text-secondary"
					onclick={() => {
						searchOpen = true;
					}}
				>
					<Search class="h-3.5 w-3.5 shrink-0" />
					<span class="min-w-0 flex-1 truncate">{ui.searchButton}</span>
				</button>
				<DocsLangSwitch {locale} {alternateHref} />
			</div>

			{#if mobileNavOpen}
				<nav
					id="docs-mobile-nav"
					class="border-b border-border-subtle bg-bg-content px-4 py-4 lg:hidden"
					aria-label={ui.docsLabel}
				>
					<DocsSidebar
						sections={data.sections}
						{currentSlug}
						onNavigate={() => {
							mobileNavOpen = false;
						}}
					/>
				</nav>
			{/if}

			<main class="px-4 py-8 sm:px-6 lg:px-0 lg:py-10">
				{@render children()}
			</main>
		</div>
	</PublicContentShell>

	<!-- One dialog host for mobile + desktop triggers and layout ⌘K. -->
	<DocsSearch
		entries={data.searchEntries}
		{locale}
		showTrigger={false}
		listenHotkey={false}
		bind:open={searchOpen}
	/>
</div>
