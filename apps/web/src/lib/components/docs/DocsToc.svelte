<script lang="ts">
import {
	type DocsLocale,
	type DocsTocItem,
	getDocsUi,
} from "#lib/docs/index.ts";

const {
	items,
	locale = "en",
}: {
	items: DocsTocItem[];
	locale?: DocsLocale;
} = $props();

const ui = $derived(getDocsUi(locale));
let activeId = $state("");

$effect(() => {
	activeId = items[0]?.id ?? "";
});

$effect(() => {
	if (typeof window === "undefined" || items.length === 0) return;

	const headings = items
		.map((item) => document.getElementById(item.id))
		.filter((el): el is HTMLElement => Boolean(el));

	if (headings.length === 0) return;

	const observer = new IntersectionObserver(
		(entries) => {
			const visible = entries
				.filter((entry) => entry.isIntersecting)
				.sort((a, b) => b.intersectionRatio - a.intersectionRatio);
			const top = visible[0]?.target;
			if (top?.id) activeId = top.id;
		},
		{
			rootMargin: "-20% 0px -70% 0px",
			threshold: [0, 0.25, 0.5, 1],
		},
	);

	for (const heading of headings) observer.observe(heading);
	return () => observer.disconnect();
});
</script>

{#if items.length > 0}
	<nav aria-label={ui.onThisPage}>
		<div
			class="mb-2 text-[11px] font-semibold tracking-[0.04em] text-text-placeholder uppercase"
		>
			{ui.onThisPage}
		</div>
		<ul class="space-y-1 border-l border-border-subtle">
			{#each items as item (item.id)}
				<li>
					<a
						href={`#${item.id}`}
						class="block border-l -ml-px py-1 text-[12px] transition-colors duration-200 {item.level ===
						3
							? 'pl-4'
							: 'pl-3'} {activeId === item.id
							? 'border-brand text-text-primary'
							: 'border-transparent text-text-tertiary hover:text-text-secondary'}"
					>
						{item.text}
					</a>
				</li>
			{/each}
		</ul>
	</nav>
{/if}
