<script lang="ts">
import type { Snippet } from "svelte";
import { onDestroy } from "svelte";
import { floatNear } from "$lib/actions/portal";

const {
	label,
	active = false,
	disabled = false,
	onTriggerClick,
	trigger,
	headerAction,
	children,
}: {
	label: string;
	active?: boolean;
	disabled?: boolean;
	onTriggerClick?: () => void;
	trigger: Snippet<[{ open: boolean; active: boolean }]>;
	headerAction?: Snippet;
	children: Snippet;
} = $props();

const flyoutId = $derived(
	`sidebar-flyout-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
);

let open = $state(false);
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let anchorElement: HTMLDivElement | null = $state(null);
let pointerInside = $state(false);

function clearCloseTimer() {
	if (!closeTimer) return;
	clearTimeout(closeTimer);
	closeTimer = null;
}

function openFlyout() {
	if (disabled) return;
	pointerInside = true;
	clearCloseTimer();
	open = true;
}

function closeFlyout() {
	clearCloseTimer();
	open = false;
}

function scheduleClose() {
	pointerInside = false;
	clearCloseTimer();
	closeTimer = setTimeout(() => {
		open = false;
		closeTimer = null;
	}, 120);
}

function handleFocusOut(event: FocusEvent) {
	const nextTarget = event.relatedTarget;
	if (
		pointerInside ||
		(nextTarget instanceof Node && anchorElement?.contains(nextTarget))
	) {
		return;
	}
	scheduleClose();
}

function handleKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") {
		event.stopPropagation();
		closeFlyout();
	}
}

onDestroy(clearCloseTimer);
</script>

<div
	bind:this={anchorElement}
	class="sidebar-flyout-anchor relative flex h-8 w-8 shrink-0 items-center justify-center"
	role="presentation"
	onmouseenter={openFlyout}
	onmouseleave={scheduleClose}
	onfocusin={openFlyout}
	onfocusout={handleFocusOut}
	onkeydown={handleKeydown}
>
	<button
		type="button"
		class="flex h-8 w-8 items-center justify-center rounded-[6px] transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:ring-offset-1 focus-visible:ring-offset-bg-primary {active || open ? 'bg-bg-active text-text-primary' : 'text-text-tertiary'}"
		disabled={disabled}
		onclick={onTriggerClick}
		aria-label={label}
		aria-expanded={open}
		aria-haspopup="dialog"
		aria-controls={open ? flyoutId : undefined}
		title={label}
	>
		{@render trigger({ open, active })}
	</button>

	{#if open && !disabled}
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<div
			id={flyoutId}
			role="dialog"
			tabindex="-1"
			aria-label={label}
			class="sidebar-flyout-panel flex w-[304px] max-w-[calc(100vw-72px)] flex-col overflow-hidden rounded-lg border border-border-subtle bg-bg-primary shadow-xl shadow-bg-primary/20"
			use:floatNear={{
				getAnchor: () => anchorElement,
				placement: "right-start",
				gap: 8,
				width: 304,
				zIndex: 80,
			}}
			onmouseenter={openFlyout}
			onmouseleave={scheduleClose}
		>
			<div class="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-surface/40 px-3">
				<div class="min-w-0 flex-1 truncate text-[12px] font-medium tracking-[-0.01em] text-text-secondary">{label}</div>
				{#if headerAction}
					<div class="shrink-0">
						{@render headerAction()}
					</div>
				{/if}
			</div>
			<div class="max-h-[min(560px,calc(100vh-64px))] overflow-y-auto overscroll-contain px-2 py-2">
				{@render children()}
			</div>
		</div>
	{/if}
</div>

<style>
	.sidebar-flyout-anchor::after {
		content: "";
		position: absolute;
		left: 2rem;
		top: -0.25rem;
		width: 0.5rem;
		height: calc(100% + 0.5rem);
	}

	@media (prefers-reduced-motion: no-preference) {
		.sidebar-flyout-panel {
			animation: sidebar-flyout-enter 120ms var(--ease-out);
			transform-origin: left top;
		}

		.sidebar-flyout-anchor :global(.sidebar-flyout-item) {
			transition:
				background-color 100ms ease,
				color 100ms ease,
				padding-right 100ms ease;
		}
	}

	@keyframes sidebar-flyout-enter {
		from {
			opacity: 0;
			transform: translate3d(-4px, 0, 0) scale(0.985);
		}

		to {
			opacity: 1;
			transform: translate3d(0, 0, 0) scale(1);
		}
	}
</style>
