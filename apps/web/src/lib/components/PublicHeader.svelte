<script lang="ts">
import { ChevronRight, Menu, X } from "lucide-svelte";
import { page } from "$app/state";
import { resolvePublicLocale } from "$lib/i18n/public-locale";
import { m } from "$lib/paraglide/messages.js";

type Cta = "start" | "open-app" | "none";

const {
	sticky = true,
	cta = "open-app",
	onStart,
}: {
	sticky?: boolean;
	cta?: Cta;
	onStart?: () => void | Promise<void>;
} = $props();

const path = $derived(page.url.pathname);
const zh = $derived(resolvePublicLocale(path) === "zh-CN");
// Changelog stays English-only; everything else is localized under /zh.
const docsHref = $derived(zh ? "/zh/docs" : "/docs");
const pricingHref = $derived(zh ? "/zh/pricing" : "/pricing");
const changelogHref = "/changelog";
const isDocs = $derived(path === docsHref || path.startsWith(`${docsHref}/`));
const isPricing = $derived(
	path === pricingHref || path.startsWith(`${pricingHref}/`),
);
const isChangelog = $derived(
	path === changelogHref || path.startsWith(`${changelogHref}/`),
);

let mobileMenuOpen = $state(false);

// Close menu on navigation
$effect(() => {
	path;
	mobileMenuOpen = false;
});

function navClass(active: boolean): string {
	return active
		? "rounded-full px-2.5 py-2 text-text-primary sm:px-3"
		: "rounded-full px-2.5 py-2 text-text-secondary transition-colors hover:text-text-primary sm:px-3";
}
</script>

<header
	class={sticky
		? "safe-area-top sticky top-0 z-30 h-[var(--public-header-height)] border-b border-border-subtle bg-bg-primary/80 backdrop-blur-md"
		: "safe-area-top h-[var(--public-header-height)] border-b border-border-subtle"}
>
	<div class="flex h-full w-full items-center justify-between gap-3 px-3">
		<a href={zh ? "/zh" : "/"} class="group inline-flex shrink-0 items-center gap-2" aria-label={m.head_home_aria({}, { locale: zh ? "zh-CN" : "en" })}>
			<div
				class="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-brand text-[11px] font-bold text-brand-contrast-fg transition-colors group-hover:bg-brand-hover"
			>
				C
			</div>
			<span class="text-[13px] font-semibold tracking-tight text-text-primary"
				>Cohub</span
			>
		</a>

		<!-- Desktop nav -->
		<nav class="hidden items-center gap-2 text-[13px] sm:flex">
			<a href={docsHref} class={navClass(isDocs)} aria-current={isDocs ? "page" : undefined}>{m.head_docs({}, { locale: zh ? "zh-CN" : "en" })}</a>
			<a href={pricingHref} class={navClass(isPricing)} aria-current={isPricing ? "page" : undefined}
				>{m.head_pricing({}, { locale: zh ? "zh-CN" : "en" })}</a
			>
			<a
				href={changelogHref}
				class={navClass(isChangelog)}
				aria-current={isChangelog ? "page" : undefined}>{m.head_changelog({}, { locale: zh ? "zh-CN" : "en" })}</a
			>

			{#if cta === "start"}
				<button
					type="button"
					onclick={() => void onStart?.()}
					class="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-brand px-4 py-2 font-medium text-brand-contrast-fg transition-colors hover:bg-brand-hover"
				>
					{m.head_start({}, { locale: zh ? "zh-CN" : "en" })}
				</button>
			{:else if cta === "open-app"}
				<a
					href="/"
					class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-[5px] border border-border-subtle bg-bg-input px-2.5 py-1.5 text-[12px] font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
				>
					{m.head_open_app({}, { locale: zh ? "zh-CN" : "en" })}
					<ChevronRight class="h-3.5 w-3.5" />
				</a>
			{/if}
		</nav>

		<!-- Mobile nav -->
		<div class="flex items-center gap-2 sm:hidden">
			{#if cta === "start"}
				<button
					type="button"
					onclick={() => void onStart?.()}
					class="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-brand px-3 py-1.5 text-[12px] font-medium text-brand-contrast-fg transition-colors hover:bg-brand-hover"
				>
					{m.head_start({}, { locale: zh ? "zh-CN" : "en" })}
				</button>
			{:else if cta === "open-app"}
				<a
					href="/"
					class="inline-flex items-center gap-1 whitespace-nowrap rounded-[5px] border border-border-subtle bg-bg-input px-2 py-1.5 text-[12px] font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
				>
					{m.head_open_app({}, { locale: zh ? "zh-CN" : "en" })}
					<ChevronRight class="h-3 w-3" />
				</a>
			{/if}
			<button
				type="button"
				class="inline-flex h-8 w-8 items-center justify-center rounded-[6px] border border-border-subtle bg-bg-input text-text-secondary transition-colors hover:text-text-primary"
				onclick={() => (mobileMenuOpen = !mobileMenuOpen)}
				aria-expanded={mobileMenuOpen}
				aria-label={mobileMenuOpen
					? m.head_close_menu({}, { locale: zh ? "zh-CN" : "en" })
					: m.head_open_menu({}, { locale: zh ? "zh-CN" : "en" })}
			>
				{#if mobileMenuOpen}
					<X class="h-4 w-4" />
				{:else}
					<Menu class="h-4 w-4" />
				{/if}
			</button>
		</div>
	</div>

	<!-- Mobile dropdown -->
	{#if mobileMenuOpen}
		<nav class="border-t border-border-subtle bg-bg-primary px-4 py-3 sm:hidden">
			<ul class="space-y-0.5">
				<li>
					<a
						href={docsHref}
						class="block rounded-[6px] px-3 py-2 text-[13px] font-medium transition-colors {isDocs ? 'bg-brand/10 text-brand' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'}"
						aria-current={isDocs ? "page" : undefined}
					>{m.head_docs({}, { locale: zh ? "zh-CN" : "en" })}</a
					>
				</li>
				<li>
					<a
						href={pricingHref}
						class="block rounded-[6px] px-3 py-2 text-[13px] font-medium transition-colors {isPricing ? 'bg-brand/10 text-brand' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'}"
						aria-current={isPricing ? "page" : undefined}
					>{m.head_pricing({}, { locale: zh ? "zh-CN" : "en" })}</a
					>
				</li>
				<li>
					<a
						href={changelogHref}
						class="block rounded-[6px] px-3 py-2 text-[13px] font-medium transition-colors {isChangelog ? 'bg-brand/10 text-brand' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'}"
						aria-current={isChangelog ? "page" : undefined}
					>{m.head_changelog({}, { locale: zh ? "zh-CN" : "en" })}</a
					>
				</li>
			</ul>
		</nav>
	{/if}
</header>
