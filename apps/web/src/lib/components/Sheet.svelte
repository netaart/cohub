<script lang="ts">
import { useCompactShell } from "$lib/layout/compact-shell.svelte";
import { overlay } from "$lib/motion";

function portal(node: HTMLElement) {
	if (typeof document === "undefined") return {};
	document.body.appendChild(node);
	return {
		destroy() {
			node.remove();
		},
	};
}

const {
	open,
	onClose,
	maxWidth = "480px",
	mobile = true,
	children,
}: {
	open: boolean;
	onClose: () => void;
	maxWidth?: string;
	mobile?: boolean;
	children: import("svelte").Snippet;
} = $props();

const sheet = $derived(mobile && useCompactShell());

function onKeydown(event: KeyboardEvent) {
	if (event.key === "Escape" && !event.defaultPrevented) {
		event.preventDefault();
		onClose();
	}
}
</script>

{#if open}
	<div
		use:portal
		class="fixed inset-0 z-[var(--z-dialog)] flex justify-center {sheet ? 'items-end' : 'items-center p-4'}"
		role="dialog"
		aria-modal="true"
		tabindex="-1"
		onkeydown={onKeydown}
	>
		<div
			class="dialog-backdrop absolute inset-0"
			onclick={onClose}
			aria-hidden="true"
			transition:overlay={{ drawer: sheet }}
		></div>
		<div
			class="dialog-surface relative w-full"
			class:is-sheet={sheet}
			class:flex={!sheet}
			class:flex-col={!sheet}
			style={sheet ? "max-width: 480px" : `max-width: ${maxWidth}; max-height: 88vh`}
			transition:overlay={{ kind: sheet ? "sheet" : "pop" }}
		>
			{#if sheet}
				<div class="flex justify-center pt-2.5" aria-hidden="true">
					<div class="h-1 w-9 rounded-full bg-border-subtle"></div>
				</div>
			{/if}
			{@render children()}
		</div>
	</div>
{/if}
