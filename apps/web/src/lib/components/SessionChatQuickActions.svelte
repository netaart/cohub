<script lang="ts">
/**
 * Quick action buttons rendered above the chat composer.
 * Backed by prompt templates whose frontmatter opts in via `quick-action: true`.
 * Clicking sends `/name` directly (or prefills the composer when the prompt
 * declares an argument hint).
 */
import type { PromptQuickAction } from "#lib/features/space/modules/prompt-template-controller.svelte.ts";

let {
	actions,
	disabled = false,
	onsend,
}: {
	actions: PromptQuickAction[];
	disabled?: boolean;
	onsend: (action: PromptQuickAction) => void;
} = $props();
</script>

<div
	class="flex items-center gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
	data-testid="session-quick-actions"
>
	{#each actions as action (action.name)}
		<button
			type="button"
			class="shrink-0 whitespace-nowrap rounded-full border border-chat-panel-border/70 bg-bg-surface px-3 py-1 text-[12px] font-medium text-text-secondary transition-colors hover:border-chat-panel-border hover:bg-bg-hover/70 hover:text-text-primary disabled:cursor-default disabled:opacity-50"
			title={action.description}
			aria-label={action.argumentHint
				? action.description
				: action.description}
			disabled={disabled}
			onclick={() => {
				onsend(action);
			}}>{action.label}</button
		>
	{/each}
</div>
