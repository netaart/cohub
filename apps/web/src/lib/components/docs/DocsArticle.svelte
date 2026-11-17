<script lang="ts">
import { ArrowLeft, ArrowRight, Check, Copy } from "lucide-svelte";
import DocsToc from "#lib/components/docs/DocsToc.svelte";
import { type DocsPage, getDocsUi } from "#lib/docs/index.ts";

const {
	doc,
}: {
	doc: DocsPage;
} = $props();

const ui = $derived(getDocsUi(doc.locale));

let copied = $state(false);
let copyTimer: ReturnType<typeof setTimeout> | undefined;

async function copyMarkdown() {
	try {
		await navigator.clipboard.writeText(doc.body);
		copied = true;
		clearTimeout(copyTimer);
		copyTimer = setTimeout(() => {
			copied = false;
		}, 2000);
	} catch {
		// Fallback for non-secure contexts
		const ta = document.createElement("textarea");
		ta.value = doc.body;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		document.execCommand("copy");
		document.body.removeChild(ta);
		copied = true;
		clearTimeout(copyTimer);
		copyTimer = setTimeout(() => {
			copied = false;
		}, 2000);
	}
}
</script>

<div class="flex items-start gap-12">
	<article class="min-w-0 flex-1">
		<header class="mb-6">
			<div class="flex items-center justify-between gap-3">
				<div
					class="text-[11px] font-semibold tracking-[0.04em] text-text-placeholder uppercase"
				>
					{doc.sectionTitle}
				</div>
				<button
					type="button"
					class="inline-flex items-center gap-1.5 rounded-[5px] px-2 py-1 text-[11px] font-medium text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary"
					onclick={copyMarkdown}
					aria-label={ui.copyMarkdown}
					title={ui.copyMarkdown}
				>
					{#if copied}
						<Check class="h-3.5 w-3.5 text-brand" />
						<span class="text-brand">{ui.copied}</span>
					{:else}
						<Copy class="h-3.5 w-3.5" />
						<span>{ui.copyMarkdown}</span>
					{/if}
				</button>
			</div>
			<h1
				class="mt-2 text-[clamp(1.75rem,2.4vw,2.25rem)] font-semibold tracking-tight text-text-primary"
			>
				{doc.title}
			</h1>
			{#if doc.description}
				<p class="mt-3 max-w-2xl text-[15px] leading-relaxed text-text-secondary">
					{doc.description}
				</p>
			{/if}
		</header>

		<div class="docs-markdown markdown-content" data-variant="document">
			{@html doc.html}
		</div>

		<nav
			class="mt-12 flex flex-col gap-3 border-t border-border-subtle pt-6 sm:flex-row sm:items-stretch sm:justify-between"
			aria-label={ui.pager}
		>
			{#if doc.prev}
				<a
					href={doc.prev.href}
					class="group flex min-w-0 flex-1 flex-col rounded-[8px] border border-border-subtle bg-bg-content px-4 py-3 transition-colors hover:border-border-strong hover:bg-bg-hover/40"
				>
					<span
						class="inline-flex items-center gap-1 text-[11px] text-text-tertiary"
					>
						<ArrowLeft class="h-3 w-3 transition-transform duration-200 group-hover:-translate-x-0.5" />
						{ui.previous}
					</span>
					<span
						class="mt-1 truncate text-[13px] font-medium text-text-primary group-hover:text-brand"
					>
						{doc.prev.title}
					</span>
				</a>
			{:else}
				<div class="hidden flex-1 sm:block"></div>
			{/if}

			{#if doc.next}
				<a
					href={doc.next.href}
					class="group flex min-w-0 flex-1 flex-col rounded-[8px] border border-border-subtle bg-bg-content px-4 py-3 text-right transition-colors hover:border-border-strong hover:bg-bg-hover/40 sm:items-end"
				>
					<span
						class="inline-flex items-center gap-1 text-[11px] text-text-tertiary"
					>
						{ui.next}
						<ArrowRight class="h-3 w-3 transition-transform duration-200 group-hover:translate-x-0.5" />
					</span>
					<span
						class="mt-1 truncate text-[13px] font-medium text-text-primary group-hover:text-brand"
					>
						{doc.next.title}
					</span>
				</a>
			{/if}
		</nav>
	</article>

	<aside
		class="sticky top-[88px] hidden w-48 shrink-0 xl:block"
		aria-label={ui.pageOutline}
	>
		<DocsToc items={doc.toc} locale={doc.locale} />
	</aside>
</div>

<style>
	/* Docs pages already render title outside the markdown body. */
	.docs-markdown :global(h1) {
		display: none;
	}

	.docs-markdown {
		max-width: none;
		padding: 0;
		font-size: 14.5px;
		line-height: 1.75;
	}

	.docs-markdown :global(a) {
		color: var(--brand);
	}
</style>
