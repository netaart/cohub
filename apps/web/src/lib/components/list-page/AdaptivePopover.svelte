<script lang="ts">
import type { Snippet } from "svelte";
import { floatNear, portal } from "$lib/actions/portal";
import { useCompactShell } from "$lib/layout/compact-shell.svelte";
import { overlay } from "$lib/motion";

const {
	open,
	anchor,
	label,
	onClose,
	width = 240,
	placement = "bottom-start",
	children,
}: {
	open: boolean;
	anchor: HTMLElement | null;
	label: string;
	onClose: () => void;
	width?: number;
	placement?: "bottom-start" | "bottom-end";
	children: Snippet;
} = $props();

const compact = $derived(useCompactShell());

let panel = $state<HTMLElement | null>(null);

$effect(() => {
	if (!open) return;
	const onKeydown = (event: KeyboardEvent) => {
		if (event.key !== "Escape" || event.defaultPrevented) return;
		event.preventDefault();
		onClose();
	};
	const onPointerDown = (event: PointerEvent) => {
		if (compact) return;
		const target = event.target as Node | null;
		if (panel?.contains(target) || anchor?.contains(target)) return;
		onClose();
	};
	window.addEventListener("keydown", onKeydown);
	window.addEventListener("pointerdown", onPointerDown, true);
	return () => {
		window.removeEventListener("keydown", onKeydown);
		window.removeEventListener("pointerdown", onPointerDown, true);
	};
});
</script>

{#if open && compact}
	<div use:portal class="fixed inset-0 z-[var(--z-dialog)] flex items-end justify-center" role="presentation">
		<div class="absolute inset-0 bg-overlay-scrim" aria-hidden="true" onclick={onClose} transition:overlay={{ drawer: true }}></div>
		<div
			bind:this={panel}
			class="relative flex max-h-[80vh] w-full max-w-[480px] flex-col overflow-hidden rounded-t-[14px] border-t border-border-subtle bg-bg-primary pb-[env(safe-area-inset-bottom)] shadow-2xl"
			role="dialog"
			aria-modal="true"
			aria-label={label}
			transition:overlay={{ kind: "sheet" }}
		>
			<div class="flex shrink-0 justify-center pb-1 pt-2" aria-hidden="true">
				<div class="h-1 w-9 rounded-full bg-border-subtle"></div>
			</div>
			<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
				{@render children()}
			</div>
		</div>
	</div>
{:else if open}
	<div
		bind:this={panel}
		class="menu-surface flex max-h-[min(420px,70vh)] flex-col overflow-y-auto p-1"
		style:transform-origin={placement === "bottom-end" ? "top right" : "top left"}
		use:floatNear={{ getAnchor: () => anchor, placement, gap: 6, width, zIndex: 120 }}
		role="dialog"
		aria-label={label}
		transition:overlay={{ kind: "pop" }}
	>
		{@render children()}
	</div>
{/if}
