<script lang="ts">
import type { ContentBlock } from "@cohub/protocol/core";
import StreamingWords from "$lib/components/StreamingWords.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

type Props = {
	blocks: Extract<ContentBlock, { type: "thinking" }>[];
	expanded: boolean;
	isStreaming?: boolean;
	onToggle?: () => void;
};

const { blocks, expanded, isStreaming = false, onToggle }: Props = $props();
const locale = $derived(getLocale());
const content = $derived(
	blocks
		.map((block) => block.thinking)
		.join("\n\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim(),
);
const preview = $derived(content.slice(0, 320).replace(/\s+/g, " "));
</script>

{#if content}
	{#if isStreaming || expanded}
		<div class="text-[13px] leading-snug text-text-disabled break-words font-sans whitespace-pre-wrap">
			{#if isStreaming}
				<StreamingWords text={content} active tone="muted" />
			{:else}
				{content}
			{/if}
		</div>
		{#if !isStreaming && onToggle}
			<button
				type="button"
				class="mt-1 text-[11px] text-text-placeholder hover:text-text-tertiary cursor-pointer"
				aria-expanded="true"
				onclick={onToggle}
			>{m.common_collapse({}, { locale })}</button>
		{/if}
	{:else}
		<button
			type="button"
			class="block w-full min-w-0 truncate text-left text-[13px] leading-snug text-text-disabled transition-colors hover:text-text-tertiary cursor-pointer"
			aria-expanded="false"
			onclick={onToggle}
		>{preview}</button>
	{/if}
{/if}
