<script lang="ts">
import { BOARD_COLORS, boardColorCssVar } from "@neta-art/cohub/board";
import {
	AlignCenterHorizontal,
	AlignCenterVertical,
	AlignEndHorizontal,
	AlignEndVertical,
	AlignHorizontalDistributeCenter,
	AlignStartHorizontal,
	AlignStartVertical,
	AlignVerticalDistributeCenter,
	ArrowDownToLine,
	ArrowUpToLine,
	Copy,
	LoaderCircle,
	Lock,
	LockOpen,
	RefreshCw,
	Sparkles,
	Trash2,
} from "lucide-svelte";
import { canTapSelectWithHand } from "$lib/board/board-tool";
import type { BoardEditor } from "$lib/board/editor.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	editor,
	onRegenerateTask,
	onAddToGeneration,
	regeneratingItemId = null,
}: {
	editor: BoardEditor;
	onRegenerateTask?: (itemId: string) => void;
	onAddToGeneration?: () => void;
	regeneratingItemId?: string | null;
} = $props();

const locale = $derived(getLocale());

const visible = $derived(
	editor.selection.length > 0 &&
		editor.selection.some((id) => editor.itemById(id) !== null) &&
		(editor.tool === "select" ||
			(editor.tool === "hand" && canTapSelectWithHand(editor.pointerType))) &&
		editor.interaction.type !== "brushing" &&
		editor.interaction.type !== "drawing" &&
		editor.interaction.type !== "creatingArrow" &&
		!editor.editingId,
);

const canAlign = $derived(editor.selection.length >= 2);
const canDistribute = $derived(editor.selection.length >= 3);
const canGenerate = $derived(
	editor.selectedItems.some(
		(item) =>
			item.type === "image" || item.type === "video" || item.type === "audio",
	),
);
const generationTask = $derived.by(() => {
	if (editor.selectedItems.length !== 1) return null;
	const item = editor.selectedItems[0];
	return item?.type === "task" && (item.props as { snapshot: { taskType: string } }).snapshot.taskType === "generation"
		? item
		: null;
});

const position = $derived.by(() => {
	const bounds = editor.bounds;
	if (!bounds) return null;
	const camera = editor.camera;
	const left = (bounds.x + bounds.width / 2) * camera.zoom + camera.x;
	const top = Math.max(36, bounds.y * camera.zoom + camera.y);
	return { left, top };
});

const currentColor = $derived.by<string | null | undefined>(() => {
	const colors = editor.selectedItems.flatMap((item) => {
		const { fill, stroke } = item.style;
		const id = (value: unknown, fallback: string) => (typeof value === "string" ? value : value === undefined ? fallback : null);
		if (item.type === "text" || item.type === "effect") return [id(fill, "neutral")];
		if (item.type === "shape") return [id(stroke ?? fill, "brand")];
		if (item.type === "draw" || item.type === "arrow") return [id(stroke, "brand")];
		if (item.type === "frame") return [id(stroke ?? fill, "neutral")];
		return [];
	});
	if (colors.length === 0) return undefined;
	return colors.every((color) => color === colors[0])
		? (colors[0] ?? null)
		: null;
});
</script>

{#if visible && position}
	<div
		class="board-selection-toolbar"
		style:left="{position.left}px"
		style:top="{position.top}px"
		role="toolbar"
		aria-label={m.board_selection_actions({}, { locale })}
	>
		{#if currentColor !== undefined}
			<div class="flex items-center gap-1 px-1">
				{#each BOARD_COLORS as color (color.id)}
					<button
						type="button"
						class="swatch"
						class:swatch--active={currentColor === color.id}
						title={color.label}
						aria-label="Set {color.label} color"
						style:--swatch-color="var({boardColorCssVar(color.id, 'stroke')})"
						onclick={() => editor.setSelectionColor(color.id)}
					></button>
				{/each}
			</div>
			<div class="divider"></div>
		{/if}

		{#if canGenerate && onAddToGeneration}
			<button
				type="button"
				class="sel-btn"
				title={m.board_add_to_generation({}, { locale })}
				aria-label={m.board_add_selected_to_generation({}, { locale })}
				onclick={onAddToGeneration}
			>
				<Sparkles class="h-3.5 w-3.5" />
			</button>
			<div class="divider"></div>
		{/if}

		{#if generationTask && onRegenerateTask}
			<button
				type="button"
				class="sel-btn"
				title={regeneratingItemId === generationTask.id ? m.board_regenerating({}, { locale }) : m.board_regenerate({}, { locale })}
				aria-label={regeneratingItemId === generationTask.id ? m.board_regenerating({}, { locale }) : m.board_regenerate_task({}, { locale })}
				disabled={regeneratingItemId !== null}
				onclick={() => onRegenerateTask(generationTask.id)}
			>
				{#if regeneratingItemId === generationTask.id}
					<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
				{:else}
					<RefreshCw class="h-3.5 w-3.5" />
				{/if}
			</button>
			<div class="divider"></div>
		{/if}

		{#if canAlign}
			<button type="button" class="sel-btn" title={m.board_align_left({}, { locale })} aria-label={m.board_align_left({}, { locale })} onclick={() => editor.alignSelection("left")}>
				<AlignStartVertical class="h-3.5 w-3.5" />
			</button>
			<button type="button" class="sel-btn" title={m.board_align_center({}, { locale })} aria-label={m.board_align_hcenter({}, { locale })} onclick={() => editor.alignSelection("center-x")}>
				<AlignCenterVertical class="h-3.5 w-3.5" />
			</button>
			<button type="button" class="sel-btn" title={m.board_align_right({}, { locale })} aria-label={m.board_align_right({}, { locale })} onclick={() => editor.alignSelection("right")}>
				<AlignEndVertical class="h-3.5 w-3.5" />
			</button>
			<button type="button" class="sel-btn" title={m.board_align_top({}, { locale })} aria-label={m.board_align_top({}, { locale })} onclick={() => editor.alignSelection("top")}>
				<AlignStartHorizontal class="h-3.5 w-3.5" />
			</button>
			<button type="button" class="sel-btn" title={m.board_align_middle({}, { locale })} aria-label={m.board_align_vcenter({}, { locale })} onclick={() => editor.alignSelection("center-y")}>
				<AlignCenterHorizontal class="h-3.5 w-3.5" />
			</button>
			<button type="button" class="sel-btn" title={m.board_align_bottom({}, { locale })} aria-label={m.board_align_bottom({}, { locale })} onclick={() => editor.alignSelection("bottom")}>
				<AlignEndHorizontal class="h-3.5 w-3.5" />
			</button>
			{#if canDistribute}
				<button type="button" class="sel-btn" title={m.board_distribute_h({}, { locale })} aria-label={m.board_distribute_h({}, { locale })} onclick={() => editor.distributeSelection("horizontal")}>
					<AlignHorizontalDistributeCenter class="h-3.5 w-3.5" />
				</button>
				<button type="button" class="sel-btn" title={m.board_distribute_v({}, { locale })} aria-label={m.board_distribute_v({}, { locale })} onclick={() => editor.distributeSelection("vertical")}>
					<AlignVerticalDistributeCenter class="h-3.5 w-3.5" />
				</button>
			{/if}
			<div class="divider"></div>
		{/if}

		<button type="button" class="sel-btn" title={m.board_bring_front({}, { locale })} aria-label={m.board_bring_front({}, { locale })} onclick={() => editor.bringToFront()}>
			<ArrowUpToLine class="h-3.5 w-3.5" />
		</button>
		<button type="button" class="sel-btn" title={m.board_send_back({}, { locale })} aria-label={m.board_send_back({}, { locale })} onclick={() => editor.sendToBack()}>
			<ArrowDownToLine class="h-3.5 w-3.5" />
		</button>

		<div class="divider"></div>

		<button
			type="button"
			class="sel-btn"
			title={editor.selectionLocked ? m.board_unlock({}, { locale }) : m.board_lock({}, { locale })}
			aria-label={editor.selectionLocked ? m.board_unlock_selection({}, { locale }) : m.board_lock_selection({}, { locale })}
			onclick={() => editor.toggleSelectionLock()}
		>
			{#if editor.selectionLocked}
				<Lock class="h-3.5 w-3.5" />
			{:else}
				<LockOpen class="h-3.5 w-3.5" />
			{/if}
		</button>
		<button type="button" class="sel-btn" title={m.board_duplicate({}, { locale })} aria-label={m.board_duplicate({}, { locale })} onclick={() => editor.duplicateSelection()}>
			<Copy class="h-3.5 w-3.5" />
		</button>
		<button type="button" class="sel-btn sel-btn--danger" title={m.board_delete({}, { locale })} aria-label={m.board_delete({}, { locale })} onclick={() => editor.deleteSelection()}>
			<Trash2 class="h-3.5 w-3.5" />
		</button>
	</div>
{/if}

<style>
	.board-selection-toolbar {
		position: absolute;
		z-index: 24;
		display: flex;
		align-items: center;
		gap: 2px;
		max-width: calc(100% - 16px);
		overflow-x: auto;
		transform: translate(-50%, calc(-100% - 12px));
		border-radius: 9px;
		border: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);
		padding: 4px;
		box-shadow: 0 8px 20px color-mix(in srgb, var(--overlay-scrim-strong) 14%, transparent);
		backdrop-filter: blur(12px);
		white-space: nowrap;
		scrollbar-width: none;
	}
	.board-selection-toolbar::-webkit-scrollbar { display: none; }

	.swatch {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		border: 1.5px solid var(--border-subtle);
		background: var(--swatch-color);
		cursor: pointer;
		transition: transform 100ms ease, border-color 100ms ease;
		flex-shrink: 0;
	}
	.swatch:hover { transform: scale(1.15); }
	.swatch--active {
		border-color: var(--text-primary);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--swatch-color) 40%, transparent);
	}

	.sel-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border-radius: 6px;
		color: var(--text-secondary);
		cursor: pointer;
		transition: background-color 100ms ease, color 100ms ease;
		flex-shrink: 0;
	}
	.sel-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
	.sel-btn:disabled { cursor: default; opacity: 0.55; }
	.sel-btn--danger:hover { background: var(--error-bg); color: var(--error-700); }

	.divider {
		width: 1px;
		height: 16px;
		margin: 0 3px;
		background: var(--border-subtle);
		flex-shrink: 0;
	}

	@media (pointer: coarse) {
		.board-selection-toolbar {
			max-width: calc(100% - 20px);
		}
		.sel-btn { width: 36px; height: 36px; }
		.swatch { width: 22px; height: 22px; }
	}
</style>
