<script lang="ts">
import { Check, ChevronDown, Copy } from "lucide-svelte";
import { onDestroy } from "svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import type { MarkdownFrontmatterEntry } from "#lib/markdown-frontmatter.ts";
import { m } from "#lib/paraglide/messages.js";

type Props = {
	raw: string;
	entries?: MarkdownFrontmatterEntry[];
};

const { raw, entries = [] }: Props = $props();

const locale = $derived(getLocale());

let expanded = $state(false);
let copied = $state(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

const visibleEntries = $derived(expanded ? entries : entries.slice(0, 6));
const hiddenCount = $derived(
	Math.max(entries.length - visibleEntries.length, 0),
);

async function copyRaw() {
	if (!raw) return;
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(raw);
	} else {
		const textArea = document.createElement("textarea");
		textArea.value = raw;
		textArea.style.position = "fixed";
		textArea.style.opacity = "0";
		document.body.appendChild(textArea);
		textArea.select();
		document.execCommand("copy");
		textArea.remove();
	}
	copied = true;
	if (copyTimer) clearTimeout(copyTimer);
	copyTimer = setTimeout(() => {
		copied = false;
	}, 1400);
}

onDestroy(() => {
	if (copyTimer) clearTimeout(copyTimer);
});
</script>

<section class="frontmatter-panel" aria-label={m.md_frontmatter_aria({}, { locale })}>
	<div class="frontmatter-bar">
		<div class="frontmatter-title">Frontmatter</div>
		<div class="frontmatter-actions">
			{#if entries.length > 6}
				<button
					type="button"
					class="frontmatter-action frontmatter-toggle"
					aria-expanded={expanded}
					onclick={() => expanded = !expanded}
				>
					<span>{expanded ? "Less" : `+${hiddenCount}`}</span>
					<ChevronDown class={expanded ? "size-3 rotate-180" : "size-3"} />
				</button>
			{/if}
			<button
				type="button"
				class="frontmatter-action frontmatter-copy"
				onclick={() => void copyRaw()}
				aria-label={m.md_frontmatter_copy({}, { locale })}
				title="Copy frontmatter"
			>
				{#if copied}
					<Check class="size-3.5" />
				{:else}
					<Copy class="size-3.5" />
				{/if}
			</button>
		</div>
	</div>

	{#if visibleEntries.length > 0}
		<dl class="frontmatter-grid">
			{#each visibleEntries as entry}
				<div class="frontmatter-item">
					<dt>{entry.key}</dt>
					<dd>{entry.value}</dd>
				</div>
			{/each}
		</dl>
	{/if}
</section>

<style>
.frontmatter-panel {
	container-type: inline-size;
	max-width: 860px;
	margin: 0 auto;
	padding: 12px 28px 0;
	color: var(--text-secondary);
}

.frontmatter-bar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	min-height: 28px;
	border-bottom: 1px solid color-mix(in srgb, var(--border-subtle) 64%, transparent);
}

.frontmatter-title {
	display: inline-flex;
	min-width: 0;
	align-items: center;
	gap: 7px;
	color: var(--brand-muted-fg);
	font-family: var(--font-mono, monospace);
	font-size: 10px;
	font-weight: 650;
	letter-spacing: 0.1em;
	line-height: 1;
	text-transform: uppercase;
}

.frontmatter-actions {
	display: inline-flex;
	flex: 0 0 auto;
	align-items: center;
	gap: 4px;
}

.frontmatter-action {
	display: inline-flex;
	height: 26px;
	align-items: center;
	justify-content: center;
	border: 1px solid transparent;
	border-radius: 0.4rem;
	background: transparent;
	color: var(--text-tertiary);
	cursor: pointer;
	transition:
		background-color 140ms ease,
		border-color 140ms ease,
		color 140ms ease,
		transform 140ms ease;
}

.frontmatter-copy {
	width: 26px;
	padding: 0;
}

.frontmatter-toggle {
	gap: 4px;
	padding: 0 7px;
	font-size: 11px;
	font-weight: 550;
}

.frontmatter-toggle :global(svg) {
	transition: transform 140ms ease;
}

.frontmatter-action:hover,
.frontmatter-action:focus-visible {
	border-color: var(--brand-border);
	background: var(--brand-muted);
	color: var(--text-primary);
	outline: none;
}

.frontmatter-action:active {
	transform: translateY(1px);
}

.frontmatter-grid {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 2px 16px;
	margin: 8px 0 0;
	font-size: 12px;
}

.frontmatter-item {
	display: grid;
	grid-template-columns: minmax(4.75rem, 0.42fr) minmax(0, 1fr);
	align-items: baseline;
	gap: 8px;
	min-width: 0;
	padding: 3px 0;
}

.frontmatter-item dt {
	min-width: 0;
	color: var(--text-tertiary);
	font-family: var(--font-mono, monospace);
	font-size: 11px;
	line-height: 1.45;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.frontmatter-item dd {
	min-width: 0;
	margin: 0;
	color: var(--text-secondary);
	line-height: 1.45;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

@container (max-width: 560px) {
	.frontmatter-panel {
		padding: 10px 16px 0;
	}

	.frontmatter-grid {
		grid-template-columns: 1fr;
		gap: 1px;
	}

	.frontmatter-item {
		grid-template-columns: 1fr;
		gap: 1px;
		padding: 4px 0;
	}

	.frontmatter-item dd {
		white-space: normal;
	}
}

@media (prefers-reduced-motion: reduce) {
	.frontmatter-action,
	.frontmatter-toggle :global(svg) {
		transition: none;
	}
}
</style>
