<script lang="ts">
import { holdContentThroughTweens } from "#lib/layout/hold-through-tweens.ts";

const {
	ariaLabel = "Workspace preview",
	open = true,
	children,
}: {
	ariaLabel?: string;
	open?: boolean;
	children: import("svelte").Snippet;
} = $props();
</script>

<section
	class="workspace-preview-pane flex min-w-0 flex-col border-border-subtle bg-bg-content"
	class:workspace-preview-pane--closed={!open}
	aria-label={ariaLabel}
	aria-hidden={!open}
	inert={!open ? true : undefined}
	{@attach holdContentThroughTweens}
>
	<div class="workspace-preview-pane-inner flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
		{@render children()}
	</div>
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
			flex: 1 1 0;
			width: auto;
			padding-top: 0;
			border-left-width: 1px;
			overflow: hidden;
			contain: inline-size;
		}

		.workspace-preview-pane:global([data-hold-edge]) .workspace-preview-pane-inner {
			flex: none;
			width: var(--held-content-width);
			height: 100%;
		}

		.workspace-preview-pane:global([data-hold-edge="end"]) .workspace-preview-pane-inner {
			align-self: flex-end;
		}

		.workspace-preview-pane--closed {
			display: flex;
			border-left-width: 0;
			pointer-events: none;
		}
	}
</style>
