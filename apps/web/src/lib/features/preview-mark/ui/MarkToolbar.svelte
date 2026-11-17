<script lang="ts">
import {
	ArrowUpRight,
	Check,
	Copy,
	Crop,
	Loader2,
	Pencil,
	RefreshCw,
	RotateCcw,
	Square,
	Trash2,
	Undo2,
	X,
} from "lucide-svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import type { MarkColor, MarkTool } from "../types.ts";
import { MARK_COLOR_HEX } from "../types.ts";

type Props = {
	tool: MarkTool;
	color: MarkColor;
	canUndo: boolean;
	canClear: boolean;
	canCropApply: boolean;
	canResetCrop: boolean;
	canRecapture: boolean;
	busy: boolean;
	copying: boolean;
	copied: boolean;
	attaching: boolean;
	onTool: (tool: MarkTool) => void;
	onColor: (color: MarkColor) => void;
	onUndo: () => void;
	onClear: () => void;
	onApplyCrop: () => void;
	onResetCrop: () => void;
	onRecapture?: () => void;
	onCopy: () => void;
	onAttach: () => void;
	onClose: () => void;
};

let {
	tool,
	color,
	canUndo,
	canClear,
	canCropApply,
	canResetCrop,
	canRecapture,
	busy,
	copying,
	copied,
	attaching,
	onTool,
	onColor,
	onUndo,
	onClear,
	onApplyCrop,
	onResetCrop,
	onRecapture,
	onCopy,
	onAttach,
	onClose,
}: Props = $props();

const locale = $derived(getLocale());

const tools: Array<{ id: MarkTool; label: string; icon: typeof Pencil }> = [
	{ id: "pen", label: "Pen", icon: Pencil },
	{ id: "arrow", label: "Arrow", icon: ArrowUpRight },
	{ id: "rect", label: "Rect", icon: Square },
	{ id: "crop", label: "Crop", icon: Crop },
];

const colors: MarkColor[] = ["brand", "red", "yellow", "white"];
const cropMode = $derived(tool === "crop");
</script>

<div class="mark-toolbar" role="toolbar" aria-label={m.mark_tools({}, { locale })}>
	<div class="mark-toolbar-main">
		<div class="mark-segment" role="group" aria-label={m.mark_drawing_tools({}, { locale })}>
			{#each tools as item (item.id)}
				{@const Icon = item.icon}
				<button
					type="button"
					class="mark-seg-btn"
					class:active={tool === item.id}
					title={item.label}
					aria-label={item.label}
					aria-pressed={tool === item.id}
					onclick={() => onTool(item.id)}
				>
					<Icon class="h-3.5 w-3.5" />
				</button>
			{/each}
		</div>

		{#if cropMode}
			<div class="mark-cluster">
				{#if canCropApply}
					<button
						type="button"
						class="mark-chip primary"
						onclick={onApplyCrop}
						title="Apply crop (Enter)"
					>
						<Check class="h-3.5 w-3.5" />
						<span>Apply</span>
					</button>
				{:else}
					<span class="mark-hint">Drag a region</span>
				{/if}
				{#if canResetCrop}
					<button
						type="button"
						class="mark-chip"
						onclick={onResetCrop}
						title="Reset crop"
					>
						<RotateCcw class="h-3.5 w-3.5" />
						<span class="mark-chip-label">Reset</span>
					</button>
				{/if}
			</div>
		{:else}
			<div class="mark-cluster" role="group" aria-label={m.mark_stroke_color({}, { locale })}>
				{#each colors as c (c)}
					<button
						type="button"
						class="mark-swatch"
						class:active={color === c}
						style={`--swatch:${MARK_COLOR_HEX[c]}`}
						title={c}
						aria-label={`Color ${c}`}
						aria-pressed={color === c}
						onclick={() => onColor(c)}
					></button>
				{/each}
			</div>
			{#if canResetCrop}
				<button
					type="button"
					class="mark-chip"
					onclick={onResetCrop}
					title="Reset crop"
				>
					<RotateCcw class="h-3.5 w-3.5" />
					<span class="mark-chip-label">{m.mark_reset_crop({}, { locale })}</span>
				</button>
			{/if}
		{/if}

		<div class="mark-cluster quiet">
			<button
				type="button"
				class="mark-icon"
				title={m.common_undo({}, { locale })}
				aria-label={m.common_undo({}, { locale })}
				disabled={!canUndo}
				onclick={onUndo}
			>
				<Undo2 class="h-3.5 w-3.5" />
			</button>
			<button
				type="button"
				class="mark-icon"
				title={m.mark_clear_marks({}, { locale })}
				aria-label={m.mark_clear_marks({}, { locale })}
				disabled={!canClear}
				onclick={onClear}
			>
				<Trash2 class="h-3.5 w-3.5" />
			</button>
			{#if canRecapture && onRecapture}
				<button
					type="button"
					class="mark-icon"
					title={m.mark_recapture({}, { locale })}
					aria-label={m.mark_recapture({}, { locale })}
					onclick={onRecapture}
				>
					<RefreshCw class="h-3.5 w-3.5" />
				</button>
			{/if}
		</div>
	</div>

	<div class="mark-toolbar-end">
		<button
			type="button"
			class="mark-chip"
			disabled={busy}
			onclick={onCopy}
			title={copied ? "Copied" : "Copy image"}
			aria-label={copied ? "Copied" : "Copy image"}
		>
			{#if copying}
				<Loader2 class="h-3.5 w-3.5 animate-spin" />
			{:else if copied}
				<Check class="h-3.5 w-3.5" />
			{:else}
				<Copy class="h-3.5 w-3.5" />
			{/if}
			<span class="mark-chip-label">{copied ? "Copied" : "Copy"}</span>
		</button>
		<button
			type="button"
			class="mark-attach"
			disabled={busy}
			onclick={onAttach}
			title={m.mark_attach_chat({}, { locale })}
		>
			{#if attaching}
				<Loader2 class="h-3.5 w-3.5 animate-spin" />
			{:else}
				<Check class="h-3.5 w-3.5" />
			{/if}
			<span>Attach</span>
		</button>
		<button
			type="button"
			class="mark-icon"
			title={m.common_close({}, { locale })}
			aria-label={m.mark_close({}, { locale })}
			disabled={busy}
			onclick={onClose}
		>
			<X class="h-3.5 w-3.5" />
		</button>
	</div>
</div>

<style>
	.mark-toolbar {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
		padding: 6px 8px;
		border-bottom: 1px solid var(--border-subtle);
		background: var(--bg-surface);
	}
	.mark-toolbar-main {
		display: flex;
		min-width: 0;
		flex: 1;
		align-items: center;
		gap: 8px;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.mark-toolbar-main::-webkit-scrollbar {
		display: none;
	}
	.mark-toolbar-end {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 4px;
	}
	.mark-segment {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		padding: 2px;
		border: 1px solid var(--border-subtle);
		border-radius: 7px;
		background: var(--bg-primary);
	}
	.mark-seg-btn {
		display: inline-flex;
		width: 30px;
		height: 28px;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: var(--text-tertiary);
		cursor: pointer;
	}
	.mark-seg-btn:hover {
		color: var(--text-secondary);
		background: var(--bg-hover);
	}
	.mark-seg-btn.active {
		background: var(--bg-content);
		color: var(--text-primary);
		box-shadow: 0 0 0 1px var(--border-subtle);
	}
	.mark-seg-btn:focus-visible,
	.mark-icon:focus-visible,
	.mark-chip:focus-visible,
	.mark-attach:focus-visible,
	.mark-swatch:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 1px;
	}
	.mark-cluster {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		gap: 6px;
	}
	.mark-cluster.quiet {
		gap: 2px;
		padding-left: 6px;
		border-left: 1px solid var(--border-subtle);
	}
	.mark-icon,
	.mark-chip,
	.mark-attach {
		display: inline-flex;
		height: 30px;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		gap: 4px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-tertiary);
		cursor: pointer;
	}
	.mark-icon {
		width: 30px;
	}
	.mark-icon:hover,
	.mark-chip:hover {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}
	.mark-icon:disabled,
	.mark-chip:disabled,
	.mark-attach:disabled {
		opacity: 0.35;
		pointer-events: none;
	}
	.mark-toolbar-end .mark-chip {
		border: 1px solid var(--border-subtle);
		background: var(--bg-primary);
		color: var(--text-secondary);
	}
	.mark-toolbar-end .mark-chip:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-primary);
	}
	.mark-chip {
		padding: 0 8px;
		font-size: 11px;
		font-weight: 500;
	}
	.mark-chip.primary {
		background: var(--brand);
		color: var(--brand-contrast-fg);
	}
	.mark-chip.primary:hover {
		color: var(--brand-contrast-fg);
		background: var(--brand);
		filter: brightness(1.05);
	}
	.mark-chip-label {
		display: none;
	}
	@media (min-width: 720px) {
		.mark-chip-label {
			display: inline;
		}
	}
	.mark-hint {
		color: var(--text-placeholder);
		font-size: 11px;
		font-weight: 500;
		white-space: nowrap;
	}
	.mark-attach {
		padding: 0 10px;
		background: var(--brand);
		color: var(--brand-contrast-fg);
		font-size: 12px;
		font-weight: 600;
	}
	.mark-attach:hover {
		filter: brightness(1.05);
	}
	.mark-swatch {
		width: 16px;
		height: 16px;
		flex-shrink: 0;
		border: 2px solid transparent;
		border-radius: 999px;
		background: var(--swatch);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, #000 20%, transparent);
		cursor: pointer;
	}
	.mark-swatch.active {
		border-color: var(--text-primary);
	}
</style>
