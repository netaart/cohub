<script lang="ts">
import type { Snippet } from "svelte";
import { floatNear, portal } from "#lib/actions/portal.ts";
import { dismissOnBack } from "#lib/back-layers.svelte.ts";
import { useCompactShell } from "#lib/layout/compact-shell.svelte.ts";
import { overlay } from "#lib/motion.ts";

const {
	open,
	anchor,
	point = null,
	sheet: sheetOverride,
	label,
	onClose,
	width = 240,
	placement = "bottom-start",
	children,
}: {
	open: boolean;
	anchor: HTMLElement | null;
	point?: { x: number; y: number } | null;
	sheet?: boolean;
	label: string;
	onClose: () => void;
	width?: number | null;
	placement?: "bottom-start" | "bottom-end" | "top-start";
	children: Snippet;
} = $props();

const compact = $derived(useCompactShell());
const sheet = $derived(sheetOverride ?? compact);
const floatPlacement = $derived(point ? "bottom-start" : placement);

let panel = $state<HTMLElement | null>(null);

dismissOnBack(
	() => open,
	() => onClose(),
);

$effect(() => {
	if (!open) return;
	const onKeydown = (event: KeyboardEvent) => {
		if (event.key !== "Escape" || event.defaultPrevented) return;
		event.preventDefault();
		onClose();
	};
	const onPointerDown = (event: PointerEvent) => {
		if (sheet) return;
		const target = event.target as Node | null;
		if (panel?.contains(target) || (!point && anchor?.contains(target))) return;
		onClose();
	};
	const onScroll = (event: Event) => {
		if (!point || sheet) return;
		const scroller = event.target;
		if (
			scroller === document ||
			(scroller instanceof Node && anchor && scroller.contains(anchor))
		)
			onClose();
	};
	const onDismiss = () => {
		if (point && !sheet) onClose();
	};
	window.addEventListener("keydown", onKeydown);
	window.addEventListener("pointerdown", onPointerDown, true);
	window.addEventListener("scroll", onScroll, true);
	window.addEventListener("resize", onDismiss);
	window.addEventListener("blur", onDismiss);
	return () => {
		window.removeEventListener("keydown", onKeydown);
		window.removeEventListener("pointerdown", onPointerDown, true);
		window.removeEventListener("scroll", onScroll, true);
		window.removeEventListener("resize", onDismiss);
		window.removeEventListener("blur", onDismiss);
	};
});
</script>

{#if open && sheet}
	<div use:portal class="fixed inset-0 z-[var(--z-dialog)] flex items-end justify-center" role="presentation">
		<div class="absolute inset-0 bg-overlay-scrim" aria-hidden="true" onclick={onClose} transition:overlay={{ drawer: true }}></div>
		<div
			bind:this={panel}
			class="relative flex max-h-[80vh] w-full max-w-[480px] flex-col overflow-hidden rounded-t-[14px] border-t border-border-subtle bg-bg-primary pb-[env(safe-area-inset-bottom)] shadow-2xl"
			role="dialog"
			aria-modal="true"
			aria-label={label}
			tabindex="-1"
			data-sheet
			transition:overlay={{ kind: "sheet" }}
			oncontextmenu={(event) => event.preventDefault()}
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
		class="menu-surface flex max-h-[min(420px,70vh)] flex-col overflow-y-auto p-1 {width === null ? 'min-w-[180px] max-w-[280px]' : ''}"
		style:transform-origin={floatPlacement === "bottom-end" ? "top right" : floatPlacement === "top-start" ? "bottom left" : "top left"}
		use:floatNear={{
			getAnchor: () => (point ? new DOMRect(point.x, point.y, 0, 0) : anchor),
			placement: floatPlacement,
			gap: point ? 2 : 6,
			width: width ?? undefined,
			zIndex: 120,
		}}
		role="dialog"
		aria-label={label}
		tabindex="-1"
		transition:overlay={{ kind: "pop" }}
		oncontextmenu={(event) => event.preventDefault()}
	>
		{@render children()}
	</div>
{/if}
