<script lang="ts">
import type { DocsSection } from "#lib/docs/index.ts";

const {
	sections,
	currentSlug,
	onNavigate,
}: {
	sections: DocsSection[];
	currentSlug: string;
	onNavigate?: () => void;
} = $props();
</script>

<nav class="space-y-5" aria-label="Documentation">
	{#each sections as section (section.id)}
		<div>
			<div
				class="mb-1.5 px-2 text-[11px] font-semibold tracking-[0.04em] text-text-placeholder uppercase"
			>
				{section.title}
			</div>
			<ul class="space-y-0.5">
				{#each section.items as item (item.slug)}
					{@const active = item.slug === currentSlug}
					<li>
						<a
							href={item.href}
							class="block rounded-[6px] border-l-2 px-2 py-1.5 text-[13px] transition-colors {active
								? 'border-brand bg-brand/10 font-medium text-brand'
								: 'border-transparent text-text-secondary hover:bg-bg-hover hover:text-text-primary'}"
							aria-current={active ? "page" : undefined}
							onclick={() => onNavigate?.()}
						>
							{item.title}
						</a>
					</li>
				{/each}
			</ul>
		</div>
	{/each}
</nav>
