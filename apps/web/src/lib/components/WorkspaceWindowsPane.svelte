<script lang="ts">
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const locale = $derived(getLocale());

const {
	width = 480,
	ariaLabel = "Workspace preview",
	onResizeStart,
	immersive = false,
	open = true,
	children,
}: {
	width?: number;
	ariaLabel?: string;
	onResizeStart?: (event: PointerEvent) => void;
	immersive?: boolean;
	open?: boolean;
	children: import("svelte").Snippet;
} = $props();

let paneEl: HTMLElement | null = $state(null);

// Imperative CSS var (not a full style= binding) so layout drag can paint
// intermediate widths without Svelte wiping them on unrelated re-renders.
$effect(() => {
	const el = paneEl;
	if (!el) return;
	el.style.setProperty("--workspace-preview-width", `${width}px`);
	el.style.setProperty("--workspace-preview-inner-width", `${width}px`);
});
</script>

<section
	bind:this={paneEl}
	class="workspace-preview-pane flex min-w-0 flex-col border-border-subtle bg-bg-content"
	class:workspace-preview-pane--closed={!open}
	class:workspace-preview-pane--immersive={immersive}
	aria-label={ariaLabel}
	aria-hidden={!open}
	inert={!open ? true : undefined}
>
	<div
		class="workspace-preview-pane-inner flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
	>
		{@render children()}
	</div>
	{#if open && onResizeStart && !immersive}
		<button
			type="button"
			class="preview-resize-handle hidden lg:block"
			aria-label={m.window_resize_panel({}, { locale })}
			title={m.window_resize_panel({}, { locale })}
			onpointerdown={onResizeStart}
		></button>
	{/if}
</section>

<style>
	.workspace-preview-pane {
		position: fixed;
		inset: 0;
		z-index: 50;
		width: 100%;
		height: 100%;
		padding-top: env(safe-area-inset-top, 0px);
		--safe-area-top: 0px;
	}

	.workspace-preview-pane--closed {
		display: none;
	}

	@media (min-width: 960px) {
		.workspace-preview-pane {
			position: relative;
			z-index: auto;
			padding-top: 0;
			width: var(--workspace-preview-width, 480px);
			flex-shrink: 0;
			border-left-width: 1px;
			overflow: hidden;
			transition: width var(--motion-panel-duration) var(--motion-panel-ease);
		}

		.workspace-preview-pane--closed {
			display: flex;
			width: 0;
			border-left-width: 0;
			pointer-events: none;
		}

		@starting-style {
			.workspace-preview-pane:not(.workspace-preview-pane--closed):not(
				.workspace-preview-pane--immersive
			) {
				width: 0;
				border-left-width: 0;
			}
		}

		.workspace-preview-pane-inner {
			width: var(--workspace-preview-inner-width, 480px);
			max-width: 100%;
			flex-shrink: 0;
		}

		.workspace-preview-pane--immersive {
			position: absolute;
			inset: 0;
			z-index: 0;
			width: 100%;
			height: 100%;
			border-left-width: 0;
			transition: none;
		}

		.workspace-preview-pane--immersive .workspace-preview-pane-inner {
			width: 100%;
			max-width: none;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.workspace-preview-pane {
			transition: none;
		}
	}

	:global(body.sidebar-resizing) .workspace-preview-pane {
		transition: none;
	}

	.preview-resize-handle {
		position: absolute;
		top: 0;
		left: -4px;
		width: 8px;
		height: 100%;
		cursor: col-resize;
		border: 0;
		padding: 0;
		background: transparent;
		touch-action: none;
		z-index: 10;
	}

	.preview-resize-handle::after {
		content: "";
		position: absolute;
		left: 3px;
		top: 0;
		width: 2px;
		height: 100%;
		background: transparent;
		transition: background 120ms ease;
	}

	.preview-resize-handle:hover::after,
	:global(body.sidebar-resizing) .preview-resize-handle::after {
		background: var(--border-subtle);
	}
</style>
