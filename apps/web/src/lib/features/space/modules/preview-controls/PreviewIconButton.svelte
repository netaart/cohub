<script lang="ts">
import type { PreviewIcon } from "../preview-header.ts";

/**
 * Shared icon button for header controls. One size and one icon scale across
 * view mode, zoom and page controls so the header speaks a single language.
 */
const {
	icon: Icon,
	label,
	onclick,
	active = false,
	disabled = false,
}: {
	icon: PreviewIcon;
	label: string;
	onclick: (event: MouseEvent) => void;
	active?: boolean;
	disabled?: boolean;
} = $props();
</script>

<button
	type="button"
	class="preview-control-button"
	class:active
	title={label}
	aria-label={label}
	aria-pressed={active}
	{disabled}
	{onclick}
>
	<Icon class="h-4 w-4" />
</button>

<style>
	.preview-control-button {
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

	.preview-control-button:hover {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	.preview-control-button.active {
		background: var(--bg-elevated);
		color: var(--text-primary);
		box-shadow: 0 1px 2px color-mix(in srgb, var(--overlay-scrim-strong) 10%, transparent);
	}

	.preview-control-button:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
</style>
