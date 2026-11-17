<script lang="ts">
import type { Snippet } from "svelte";
import { floatNear } from "#lib/actions/portal.ts";
import type { PreviewIcon } from "./preview-header.ts";

/**
 * Adaptive header control.
 *
 * Renders rich `inline` content when the header has room, and a single icon
 * trigger + popover when it does not. The switch is CSS-driven via the
 * `preview-header` container query so no JS width measurement is needed.
 */
const {
	icon: Icon,
	label,
	inline,
	menu,
	menuWidth = 176,
}: {
	icon: PreviewIcon;
	label: string;
	inline: Snippet;
	/** Popover body; call `close()` after choosing an option. */
	menu: Snippet<[{ close: () => void }]>;
	menuWidth?: number;
} = $props();

let open = $state(false);
let triggerEl = $state<HTMLButtonElement | null>(null);

function close() {
	open = false;
}

$effect(() => {
	if (!open) return;
	const onPointerDown = (event: PointerEvent) => {
		const target = event.target;
		if (
			target instanceof Node &&
			(triggerEl?.contains(target) ||
				(target instanceof Element &&
					target.closest(".preview-control-popover")))
		) {
			return;
		}
		open = false;
	};
	const onKeydown = (event: KeyboardEvent) => {
		if (event.key === "Escape") open = false;
	};
	document.addEventListener("pointerdown", onPointerDown, true);
	document.addEventListener("keydown", onKeydown);
	return () => {
		document.removeEventListener("pointerdown", onPointerDown, true);
		document.removeEventListener("keydown", onKeydown);
	};
});
</script>

<div class="preview-control">
	<div class="preview-control-inline">{@render inline()}</div>
	<div class="preview-control-compact">
		<button
			bind:this={triggerEl}
			type="button"
			class="preview-control-trigger"
			title={label}
			aria-label={label}
			aria-haspopup="menu"
			aria-expanded={open}
			onclick={() => (open = !open)}
		>
			<Icon class="h-4 w-4" />
		</button>
		{#if open}
			<div
				class="preview-control-popover menu-surface"
				role="menu"
				use:floatNear={{
					getAnchor: () => triggerEl,
					placement: "bottom-end",
					gap: 6,
					width: menuWidth,
					zIndex: 120,
				}}
			>
				{@render menu({ close })}
			</div>
		{/if}
	</div>
</div>

<style>
	.preview-control {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
	}

	.preview-control-inline {
		display: inline-flex;
		align-items: center;
	}

	.preview-control-compact {
		display: none;
		position: relative;
		align-items: center;
	}

	@container preview-header (max-width: 460px) {
		.preview-control-inline {
			display: none;
		}
		.preview-control-compact {
			display: inline-flex;
		}
	}

	.preview-control-trigger {
		display: inline-flex;
		height: 1.75rem;
		width: 1.75rem;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-tertiary);
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.preview-control-trigger:hover {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	.preview-control-popover {
		overflow: hidden;
		padding: 4px;
	}

	@media (pointer: coarse) {
		.preview-control-trigger {
			height: 2rem;
			width: 2rem;
		}
	}
</style>
