<script lang="ts">
import {
	type ResizeStart,
	stepResize,
	trackPointerResize,
} from "$lib/layout/pointer-resize";

const {
	label,
	resize,
	layer = "shell",
	step = 16,
}: {
	label: string;
	resize: ResizeStart;
	layer?: "shell" | "workspace";
	step?: number;
} = $props();

let dragging = $state(false);
let cancel: (() => void) | null = null;

function onpointerdown(event: PointerEvent) {
	cancel = trackPointerResize(event, () => {
		const session = resize();
		if (!session) return null;
		dragging = true;
		return {
			move: session.move,
			end: (completed) => {
				dragging = false;
				cancel = null;
				session.end(completed);
			},
		};
	});
}

function onkeydown(event: KeyboardEvent) {
	const direction =
		event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
	if (!direction) return;
	event.preventDefault();
	stepResize(resize, direction * step * (event.shiftKey ? 4 : 1));
}

$effect(() => () => cancel?.());
</script>

<div class="resize-gutter resize-gutter--{layer}">
	<button
		type="button"
		class="resize-handle"
		class:resize-handle--active={dragging}
		aria-label={label}
		title={label}
		{onpointerdown}
		{onkeydown}
	>
		<span class="resize-handle-line" aria-hidden="true"></span>
		<span class="resize-handle-grip" aria-hidden="true"></span>
	</button>
</div>

<style>
	.resize-gutter {
		position: relative;
		display: none;
		flex: none;
		align-self: stretch;
		width: 0;
	}

	.resize-gutter--shell {
		z-index: var(--z-workspace-overlay);
	}

	.resize-gutter--workspace {
		z-index: var(--z-workspace-chrome);
	}

	@media (min-width: 960px) {
		.resize-gutter {
			display: block;
		}
	}

	.resize-handle {
		--hit: 12px;
		position: absolute;
		top: 0;
		bottom: 0;
		left: calc(var(--hit) / -2);
		width: var(--hit);
		border: 0;
		padding: 0;
		background: transparent;
		cursor: col-resize;
		touch-action: none;
	}

	.resize-handle:focus-visible {
		outline: none;
	}

	.resize-handle-line,
	.resize-handle-grip {
		position: absolute;
		left: 50%;
		opacity: 0;
		pointer-events: none;
		transition:
			opacity 150ms ease,
			transform 220ms var(--ease-out),
			background-color 150ms ease;
	}

	.resize-handle-line {
		top: 0;
		bottom: 0;
		width: 1px;
		transform: translateX(-50%);
		background: linear-gradient(
			to bottom,
			transparent,
			var(--border-strong) 64px,
			var(--border-strong) calc(100% - 64px),
			transparent
		);
	}

	.resize-handle-grip {
		top: 50%;
		width: 4px;
		height: 32px;
		border-radius: 999px;
		background: var(--text-tertiary);
		transform: translate(-50%, -50%) scaleY(0.5);
	}

	.resize-handle:hover .resize-handle-line,
	.resize-handle:hover .resize-handle-grip {
		opacity: 0.6;
		transition-delay: 80ms;
	}

	.resize-handle:hover .resize-handle-grip,
	.resize-handle:focus-visible .resize-handle-grip,
	.resize-handle--active .resize-handle-grip {
		transform: translate(-50%, -50%) scaleY(1);
	}

	.resize-handle:focus-visible .resize-handle-line,
	.resize-handle:focus-visible .resize-handle-grip,
	.resize-handle--active .resize-handle-line,
	.resize-handle--active .resize-handle-grip {
		opacity: 1;
		transition-delay: 0ms;
	}

	.resize-handle--active .resize-handle-grip,
	.resize-handle:focus-visible .resize-handle-grip {
		background: var(--text-secondary);
	}

	@media (pointer: coarse) {
		.resize-handle {
			--hit: 20px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.resize-handle-line,
		.resize-handle-grip {
			transition: opacity 150ms ease;
		}
	}
</style>
