<script lang="ts">
import { Search, X } from "lucide-svelte";
import { onMount } from "svelte";
import type { DocsSearchEntry } from "#lib/docs/index.ts";
import { type DocsLocale, getDocsUi } from "#lib/docs/index.ts";
import { goto } from "$app/navigation";

let {
	entries,
	locale = "en",
	/** When false, parent owns ⌘K (e.g. layout hosts a single instance). */
	listenHotkey = true,
	/** Hide the built-in trigger when layout provides its own buttons. */
	showTrigger = true,
	open = $bindable(false),
}: {
	entries: DocsSearchEntry[];
	locale?: DocsLocale;
	listenHotkey?: boolean;
	showTrigger?: boolean;
	open?: boolean;
} = $props();

const ui = $derived(getDocsUi(locale));

/** Quick-access pages shown when search is empty. */
const popularPages = $derived(
	entries.slice(0, 4).map((e) => ({ title: e.title, href: e.href })),
);

let query = $state("");
let inputEl = $state<HTMLInputElement | null>(null);
let activeIndex = $state(0);

const results = $derived.by(() => {
	const q = query.trim().toLowerCase();
	if (!q) return [] as DocsSearchEntry[];
	const terms = q.split(/\s+/).filter(Boolean);
	const scored: { entry: DocsSearchEntry; score: number }[] = [];

	for (const entry of entries) {
		let score = 0;
		const title = entry.title.toLowerCase();
		const description = entry.description.toLowerCase();
		let matched = true;
		for (const term of terms) {
			if (title.includes(term)) score += 8;
			else if (description.includes(term)) score += 4;
			else if (entry.text.includes(term)) score += 1;
			else {
				matched = false;
				break;
			}
		}
		if (matched && score > 0) scored.push({ entry, score });
	}

	return scored
		.sort(
			(a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title),
		)
		.slice(0, 8)
		.map((item) => item.entry);
});

$effect(() => {
	query;
	activeIndex = 0;
});

$effect(() => {
	if (open) queueMicrotask(() => inputEl?.focus());
});

function openSearch() {
	open = true;
}

function closeSearch() {
	open = false;
	query = "";
	activeIndex = 0;
}

async function navigateTo(href: string) {
	closeSearch();
	await goto(href);
}

function onKeydown(event: KeyboardEvent) {
	if (
		listenHotkey &&
		(event.metaKey || event.ctrlKey) &&
		event.key.toLowerCase() === "k"
	) {
		event.preventDefault();
		if (open) closeSearch();
		else openSearch();
		return;
	}

	if (!open) return;

	if (event.key === "Escape") {
		event.preventDefault();
		closeSearch();
		return;
	}

	if (event.key === "ArrowDown") {
		event.preventDefault();
		if (results.length === 0) return;
		activeIndex = (activeIndex + 1) % results.length;
		return;
	}

	if (event.key === "ArrowUp") {
		event.preventDefault();
		if (results.length === 0) return;
		activeIndex = (activeIndex - 1 + results.length) % results.length;
		return;
	}

	if (event.key === "Enter") {
		const target = results[activeIndex];
		if (!target) return;
		event.preventDefault();
		void navigateTo(target.href);
	}
}

onMount(() => {
	window.addEventListener("keydown", onKeydown);
	return () => window.removeEventListener("keydown", onKeydown);
});
</script>

{#if showTrigger}
	<button
		type="button"
		class="inline-flex h-8 w-full max-w-[220px] items-center gap-2 rounded-[6px] border border-border-subtle bg-bg-input px-2.5 text-left text-[12px] text-text-tertiary transition-colors hover:border-border-strong hover:text-text-secondary"
		onclick={openSearch}
	>
		<Search class="h-3.5 w-3.5 shrink-0" />
		<span class="min-w-0 flex-1 truncate">{ui.searchButton}</span>
		<kbd
			class="hidden rounded-[4px] border border-border-subtle bg-bg-surface px-1.5 py-0.5 font-mono text-[10px] text-text-placeholder sm:inline"
			>⌘K</kbd
		>
	</button>
{/if}

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-start justify-center bg-overlay-scrim/70 px-4 pt-[12vh] backdrop-blur-[2px]"
		role="presentation"
		onclick={closeSearch}
	>
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div
			class="w-full max-w-lg overflow-hidden rounded-[10px] border border-border-subtle bg-bg-content shadow-2xl"
			role="dialog"
			tabindex="-1"
			aria-modal="true"
			aria-label={ui.searchAria}
			onclick={(event) => event.stopPropagation()}
		>
			<div class="flex items-center gap-2 border-b border-border-subtle px-3">
				<Search class="h-4 w-4 shrink-0 text-text-tertiary" />
				<input
					bind:this={inputEl}
					bind:value={query}
					type="search"
					placeholder={ui.searchPlaceholder}
					class="h-11 w-full bg-transparent text-[14px] text-text-primary outline-none placeholder:text-text-placeholder"
					autocomplete="off"
					autocapitalize="off"
					spellcheck="false"
				/>
				<button
					type="button"
					class="rounded-[5px] p-1 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
					onclick={closeSearch}
					aria-label={ui.closeSearch}
				>
					<X class="h-4 w-4" />
				</button>
			</div>

			<div class="max-h-[50vh] overflow-y-auto p-2">
				{#if !query.trim()}
					<div class="px-2 py-3">
						<p class="mb-2 text-[11px] font-medium tracking-wide text-text-placeholder uppercase">
							{ui.searchPopular}
						</p>
						<ul class="space-y-0.5">
							{#each popularPages as entry (entry.href)}
								<li>
									<a
										href={entry.href}
										class="block rounded-[6px] px-3 py-2 text-[13px] font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
										onclick={(event) => {
											event.preventDefault();
											void navigateTo(entry.href);
										}}
									>
										{entry.title}
									</a>
								</li>
							{/each}
						</ul>
					</div>
				{:else if results.length === 0}
					<p class="px-2 py-6 text-center text-[12px] text-text-tertiary">
						{ui.searchNoResults(query.trim())}
					</p>
				{:else}
					<ul class="space-y-0.5">
						{#each results as entry, index (entry.slug)}
							<li>
								<a
									href={entry.href}
									class="block rounded-[6px] px-3 py-2.5 transition-colors {index ===
									activeIndex
										? 'bg-bg-hover'
										: 'hover:bg-bg-hover/70'}"
									onmouseenter={() => {
										activeIndex = index;
									}}
									onclick={(event) => {
										event.preventDefault();
										void navigateTo(entry.href);
									}}
								>
									<div class="flex items-center justify-between gap-3">
										<span class="text-[13px] font-medium text-text-primary"
											>{entry.title}</span
										>
										<span class="text-[11px] text-text-placeholder"
											>{entry.sectionTitle}</span
										>
									</div>
									{#if entry.description}
										<p
											class="mt-0.5 line-clamp-1 text-[12px] text-text-tertiary"
										>
											{entry.description}
										</p>
									{/if}
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	</div>
{/if}
