<script lang="ts">
import { onMount } from "svelte";
import { page } from "$app/state";
import {
	type ChangelogEntry,
	changelogDescription,
	entries,
	latestEntry,
} from "$lib/changelog";
import PublicContentShell from "$lib/components/PublicContentShell.svelte";
import PublicHeader from "$lib/components/PublicHeader.svelte";
import { canonicalUrl } from "$lib/seo";

const description = changelogDescription();
const pageTitle = latestEntry
	? `Changelog · v${latestEntry.version} · Cohub`
	: "Changelog · Cohub";
const canonical = $derived(canonicalUrl(page.url.origin, "/changelog"));
const jsonLd = $derived(
	JSON.stringify({
		"@context": "https://schema.org",
		"@type": "ItemList",
		name: "Cohub Changelog",
		description,
		url: canonical,
		numberOfItems: Math.min(entries.length, 20),
		itemListElement: entries.slice(0, 20).map((entry, index) => ({
			"@type": "ListItem",
			position: index + 1,
			name: `v${entry.version}`,
			url: `${canonical}#v${entry.version}`,
			datePublished: entry.date,
		})),
	}),
);

/** Render trusted inline markdown (bold + code) from our own changelog data. */
function renderInline(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/`([^`]+)`/g, "<code>$1</code>");
}

function formatDate(iso: string): string {
	return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});
}

function formatShortDate(iso: string): string {
	return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});
}

type YearGroup = { year: string; entries: ChangelogEntry[] };

const yearGroups = $derived.by((): YearGroup[] => {
	const map = new Map<string, ChangelogEntry[]>();
	for (const entry of entries) {
		const year = entry.date.slice(0, 4) || "Unknown";
		const list = map.get(year);
		if (list) list.push(entry);
		else map.set(year, [entry]);
	}
	return [...map.entries()].map(([year, groupEntries]) => ({
		year,
		entries: groupEntries,
	}));
});

let activeVersion = $state(entries[0]?.version ?? "");
let desktopNavEl = $state<HTMLElement | null>(null);
let mobileJumpOpen = $state(false);
let mobileJumpListEl = $state<HTMLElement | null>(null);

const activeEntry = $derived(
	entries.find((entry) => entry.version === activeVersion) ??
		entries[0] ??
		null,
);

function prefersReducedMotion(): boolean {
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function scrollToVersion(version: string, behavior?: ScrollBehavior) {
	const el = document.getElementById(`v${version}`);
	if (!el) return;
	el.scrollIntoView({
		behavior: behavior ?? (prefersReducedMotion() ? "auto" : "smooth"),
		block: "start",
	});
}

function selectVersion(
	version: string,
	options?: { closeJump?: boolean; smooth?: boolean },
) {
	activeVersion = version;
	if (typeof history !== "undefined") {
		history.replaceState(null, "", `#v${version}`);
	}
	scrollToVersion(version, options?.smooth === false ? "auto" : undefined);
	scrollDesktopNavIntoView(version);
	if (options?.closeJump) mobileJumpOpen = false;
}

function onNavClick(
	event: MouseEvent,
	version: string,
	options?: { closeJump?: boolean },
) {
	// Keep hash for shareable deep links while controlling scroll behavior.
	if (
		event.defaultPrevented ||
		event.button !== 0 ||
		event.metaKey ||
		event.ctrlKey ||
		event.shiftKey ||
		event.altKey
	) {
		return;
	}
	event.preventDefault();
	selectVersion(version, { closeJump: options?.closeJump });
}

/** Scroll only the given container so the item is visible — never the page. */
function scrollContainerToItem(
	container: HTMLElement,
	item: HTMLElement,
	options?: { align?: "nearest" | "center"; behavior?: ScrollBehavior },
) {
	const align = options?.align ?? "nearest";
	const behavior =
		options?.behavior ?? (prefersReducedMotion() ? "auto" : "smooth");
	const containerRect = container.getBoundingClientRect();
	const itemRect = item.getBoundingClientRect();

	let delta = 0;
	if (align === "center") {
		delta =
			itemRect.top +
			itemRect.height / 2 -
			(containerRect.top + containerRect.height / 2);
	} else if (itemRect.top < containerRect.top) {
		delta = itemRect.top - containerRect.top;
	} else if (itemRect.bottom > containerRect.bottom) {
		delta = itemRect.bottom - containerRect.bottom;
	}

	if (delta !== 0) {
		container.scrollBy({ top: delta, behavior });
	}
}

function scrollDesktopNavIntoView(
	version: string,
	options?: { behavior?: ScrollBehavior },
) {
	const nav = desktopNavEl;
	if (!nav) return;
	const desktopItem = nav.querySelector<HTMLElement>(
		`[data-version="${version}"]`,
	);
	if (!desktopItem) return;
	const scrollContainer = nav.closest<HTMLElement>("aside") ?? nav;
	// Must not use Element.scrollIntoView — browsers also scroll the document,
	// which fights user wheel scrolling and causes the page to jump back up.
	scrollContainerToItem(scrollContainer, desktopItem, {
		behavior: options?.behavior,
	});
}

function scrollMobileJumpActiveIntoView() {
	const list = mobileJumpListEl;
	if (!list || !activeVersion) return;
	const item = list.querySelector<HTMLElement>(
		`[data-version="${activeVersion}"]`,
	);
	if (!item) return;
	scrollContainerToItem(list, item, { align: "center", behavior: "auto" });
}

function toggleMobileJump() {
	mobileJumpOpen = !mobileJumpOpen;
	if (mobileJumpOpen) {
		// Wait for panel paint before centering the active row.
		requestAnimationFrame(() => scrollMobileJumpActiveIntoView());
	}
}

onMount(() => {
	const hash = window.location.hash.replace(/^#v?/, "");
	if (hash && entries.some((entry) => entry.version === hash)) {
		// Wait a frame so layout (sticky headers) settles before scrolling.
		requestAnimationFrame(() => {
			selectVersion(hash, { smooth: false });
		});
	}

	const observed = new Map<string, number>();
	const observer = new IntersectionObserver(
		(ioEntries) => {
			for (const io of ioEntries) {
				const id = io.target.id.replace(/^v/, "");
				if (!id) continue;
				if (io.isIntersecting) observed.set(id, io.intersectionRatio);
				else observed.delete(id);
			}
			if (observed.size === 0) return;
			// Prefer the version closest to the top of the viewport among visible ones.
			let best: string | null = null;
			let bestTop = Number.POSITIVE_INFINITY;
			for (const version of observed.keys()) {
				const el = document.getElementById(`v${version}`);
				if (!el) continue;
				const top = Math.abs(el.getBoundingClientRect().top - 96);
				if (top < bestTop) {
					bestTop = top;
					best = version;
				}
			}
			if (best && best !== activeVersion) {
				activeVersion = best;
				// Instant follow while the user is scrolling the page.
				scrollDesktopNavIntoView(best, { behavior: "auto" });
			}
		},
		{
			rootMargin: "-88px 0px -55% 0px",
			threshold: [0, 0.1, 0.25, 0.5],
		},
	);

	for (const entry of entries) {
		const el = document.getElementById(`v${entry.version}`);
		if (el) observer.observe(el);
	}

	return () => observer.disconnect();
});
</script>

{#snippet desktopSidebar()}
	<div class="mb-5 px-2">
		<div class="text-[12px] font-semibold tracking-tight text-text-primary">
			Changelog
		</div>
		<p class="mt-1 text-[12px] text-text-tertiary">What's new in Cohub</p>
	</div>

	<nav bind:this={desktopNavEl} class="space-y-5" aria-label="Version navigation">
		{#each yearGroups as group (group.year)}
			<div>
				<div
					class="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-placeholder"
				>
					{group.year}
				</div>
				<ul class="space-y-0.5">
					{#each group.entries as entry (entry.version)}
						<li>
							<a
								href="#v{entry.version}"
								data-version={entry.version}
								class="group flex items-baseline justify-between gap-2 rounded-[6px] border-l-2 px-2 py-1.5 transition-colors {activeVersion ===
								entry.version
									? 'border-brand bg-brand/10 font-medium text-brand'
									: 'border-transparent text-text-secondary hover:bg-bg-hover hover:text-text-primary'}"
								aria-current={activeVersion === entry.version ? "true" : undefined}
								onclick={(event) => onNavClick(event, entry.version)}
							>
								<span class="font-mono text-[12px] tabular-nums">v{entry.version}</span>
								<span
									class="text-[11px] font-normal tabular-nums text-text-placeholder group-hover:text-text-tertiary"
									>{formatShortDate(entry.date)}</span
								>
							</a>
						</li>
					{/each}
				</ul>
			</div>
		{/each}
	</nav>
{/snippet}

<svelte:head>
	<title>{pageTitle}</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={canonical} />
	<meta property="og:type" content="website" />
	<meta property="og:site_name" content="Cohub" />
	<meta property="og:title" content={pageTitle} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={canonical} />
	<meta name="twitter:card" content="summary" />
	<meta name="twitter:title" content={pageTitle} />
	<meta name="twitter:description" content={description} />
	{@html `<script type="application/ld+json">${jsonLd.replace(/</g, "\\u003c")}</script>`}
</svelte:head>

<div class="min-h-screen bg-bg-primary text-text-primary">
	<PublicHeader cta="open-app" />

	<PublicContentShell sidebarLabel="Changelog" sidebar={desktopSidebar}>
		<main class="px-5 pb-20 pt-6 sm:px-8 sm:pt-10 lg:px-0 lg:py-10">
			<header class="mb-8 sm:mb-10">
				<p
					class="text-[11px] font-medium uppercase tracking-[0.14em] text-text-placeholder"
				>
					Product
				</p>
				<h1
					class="mt-2 text-[clamp(1.75rem,4vw,2.25rem)] font-semibold tracking-tight text-text-primary"
				>
					Changelog
				</h1>
				<p class="mt-2 max-w-xl text-[15px] leading-relaxed text-text-secondary">
					What's new in Cohub
				</p>
			</header>

			{#if entries.length === 0}
				<p class="text-text-tertiary">No entries yet.</p>
			{:else}
				<!-- Mobile: compact jump control (100+ versions can't be a chip strip) -->
				<div
					class="sticky top-[var(--public-header-height)] z-20 -mx-5 mb-8 border-b border-border-subtle bg-bg-primary/90 backdrop-blur-md lg:hidden"
				>
					<button
						type="button"
						class="flex w-full items-center justify-between gap-3 px-5 py-2.5 text-left transition-colors active:bg-bg-subtle"
						aria-expanded={mobileJumpOpen}
						aria-controls="changelog-mobile-jump"
						onclick={toggleMobileJump}
					>
						<span class="min-w-0">
							<span class="block text-[10px] font-medium uppercase tracking-[0.12em] text-text-placeholder">
								Version
							</span>
							<span class="mt-0.5 flex items-baseline gap-2">
								<span class="font-mono text-[13px] tabular-nums text-text-primary">
									v{activeEntry?.version ?? "—"}
								</span>
								{#if activeEntry}
									<span class="text-[12px] text-text-tertiary">
										{formatShortDate(activeEntry.date)}
									</span>
								{/if}
							</span>
						</span>
						<span class="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-text-tertiary">
							Jump
							<span
								class="inline-block text-[10px] transition-transform {mobileJumpOpen
									? 'rotate-90'
									: ''}"
								aria-hidden="true">▸</span
							>
						</span>
					</button>

					{#if mobileJumpOpen}
						<div
							id="changelog-mobile-jump"
							class="border-t border-border-subtle bg-bg-primary"
							role="region"
							aria-label="Jump to version"
						>
							<div
								bind:this={mobileJumpListEl}
								class="max-h-[min(58vh,22rem)] overflow-y-auto overscroll-contain px-2 py-2 [scrollbar-width:thin]"
							>
								{#each yearGroups as group (group.year)}
									<div class="mb-2 last:mb-0">
										<div
											class="sticky top-0 z-[1] bg-bg-primary/95 px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-text-placeholder backdrop-blur-sm"
										>
											{group.year}
											<span class="ml-1.5 font-normal normal-case tracking-normal text-text-placeholder/80">
												{group.entries.length}
											</span>
										</div>
										<ul>
											{#each group.entries as entry (entry.version)}
												<li>
													<a
														href="#v{entry.version}"
														data-version={entry.version}
														class="flex min-h-10 items-center justify-between gap-3 rounded-[6px] px-2.5 py-2 transition-colors {activeVersion ===
														entry.version
															? 'bg-bg-hover text-text-primary'
															: 'text-text-secondary active:bg-bg-subtle'}"
														aria-current={activeVersion === entry.version
															? "true"
															: undefined}
														onclick={(event) =>
															onNavClick(event, entry.version, { closeJump: true })}
													>
														<span
															class="font-mono text-[13px] tabular-nums {activeVersion ===
															entry.version
																? 'text-brand'
																: ''}">v{entry.version}</span
														>
														<span class="text-[12px] tabular-nums text-text-placeholder">
															{formatShortDate(entry.date)}
														</span>
													</a>
												</li>
											{/each}
										</ul>
									</div>
								{/each}
							</div>
						</div>
					{/if}
				</div>

				<div class="relative max-w-3xl">
					<div
						aria-hidden="true"
						class="pointer-events-none absolute bottom-2 left-[5px] top-2 w-px bg-border-subtle max-sm:left-[4px]"
					></div>

					<div class="space-y-12 sm:space-y-14">
						{#each entries as entry (entry.version)}
							<article id="v{entry.version}" class="relative scroll-mt-24 pl-7 sm:pl-8">
								<span
									aria-hidden="true"
									class="absolute left-0 top-[0.55rem] flex h-[11px] w-[11px] items-center justify-center rounded-full border border-border-subtle bg-bg-primary transition-colors {activeVersion ===
									entry.version
										? 'border-brand/50'
										: ''}"
								>
									<span
										class="h-[5px] w-[5px] rounded-full transition-colors {activeVersion ===
										entry.version
											? 'bg-brand'
											: 'bg-text-placeholder'}"
									></span>
								</span>

								<div class="mb-3.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
									<h2 class="text-[18px] font-semibold tracking-tight text-text-primary sm:text-[20px]">
										<a
											href="#v{entry.version}"
											class="transition-colors hover:text-brand"
											onclick={(event) => onNavClick(event, entry.version)}
										>
											v{entry.version}
										</a>
									</h2>
									<time
										class="font-mono text-[12px] tabular-nums text-text-tertiary"
										datetime={entry.date}>{formatDate(entry.date)}</time
									>
								</div>

								<ul class="space-y-2.5 text-[14px] leading-relaxed">
									{#each entry.highlights as highlight}
										<li class="changelog-item flex gap-2.5">
											<span class="mt-[0.55em] h-1 w-1 shrink-0 rounded-full bg-text-placeholder" aria-hidden="true"></span>
											<span class="min-w-0 text-text-secondary"
												>{@html renderInline(highlight)}</span
											>
										</li>
									{/each}
								</ul>

								{#if entry.fixes?.length}
									<details class="group mt-4">
										<summary
											class="cursor-pointer list-none text-[13px] text-text-tertiary transition-colors hover:text-text-secondary [&::-webkit-details-marker]:hidden"
										>
											<span class="inline-flex items-center gap-1.5">
												<span
													class="inline-block text-[10px] transition-transform group-open:rotate-90"
													aria-hidden="true">▸</span
												>
												Fixes ({entry.fixes.length})
											</span>
										</summary>
										<ul class="mt-2.5 space-y-1.5 text-[13px]">
											{#each entry.fixes as fix}
												<li class="changelog-item flex gap-2.5">
													<span class="mt-px select-none text-text-placeholder"
														>•</span
													>
													<span class="min-w-0 text-text-secondary"
														>{@html renderInline(fix)}</span
													>
												</li>
											{/each}
										</ul>
									</details>
								{/if}
							</article>
						{/each}
					</div>
				</div>
			{/if}
		</main>
	</PublicContentShell>
</div>

<style>
	.changelog-item :global(strong) {
		font-weight: 700;
		color: var(--text-primary);
	}
	.changelog-item :global(code) {
		border-radius: 4px;
		background: var(--bg-input, rgba(128, 128, 128, 0.12));
		padding: 0.1em 0.35em;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.9em;
		color: var(--text-primary);
	}
</style>
