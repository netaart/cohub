<script lang="ts">
import type { Snippet } from "svelte";
import { fade, fly, scale } from "svelte/transition";
import { floatNear, portal } from "$lib/actions/portal";
import { useCompactShell } from "$lib/layout/compact-shell.svelte";
import {
	DURATION_MODAL_IN,
	DURATION_MODAL_OUT,
	svelteEaseIn,
	svelteEaseOut,
} from "$lib/motion.svelte";

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
const IN = { duration: DURATION_MODAL_IN, easing: svelteEaseOut };
const OUT = { duration: DURATION_MODAL_OUT, easing: svelteEaseIn };

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

{#if open}
	{#if compact}
		<div use:portal class="fixed inset-0 z-[var(--z-dialog)] flex items-end justify-center" role="presentation">
			<div class="absolute inset-0 bg-overlay-scrim" aria-hidden="true" onclick={onClose} in:fade={IN} out:fade={OUT}></div>
			<div
				bind:this={panel}
				class="relative flex max-h-[80vh] w-full max-w-[480px] flex-col overflow-hidden rounded-t-[14px] border-t border-border-subtle bg-bg-primary pb-[env(safe-area-inset-bottom)] shadow-2xl"
				role="dialog"
				aria-modal="true"
				aria-label={label}
				in:fly={{ y: 32, ...IN }}
				out:fly={{ y: 32, ...OUT }}
			>
				<div class="flex shrink-0 justify-center pb-1 pt-2" aria-hidden="true">
					<div class="h-1 w-9 rounded-full bg-border-subtle"></div>
				</div>
				<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
					{@render children()}
				</div>
			</div>
		</div>
	{:else}
		<div
			bind:this={panel}
			class="flex max-h-[min(420px,70vh)] flex-col overflow-y-auto rounded-[8px] border border-border-subtle bg-bg-elevated p-1 shadow-lg"
			use:floatNear={{ getAnchor: () => anchor, placement, gap: 6, width, zIndex: 120 }}
			role="dialog"
			aria-label={label}
			in:scale={{ start: 0.97, ...IN }}
			out:fade={OUT}
		>
			{@render children()}
		</div>
	{/if}
{/if}
