<script lang="ts">
import {
	BOARD_COLORS,
	boardColorCssVar,
	boardItemOrigin,
} from "@neta-art/cohub/board";
import { isTouchLikePointer } from "@neta-art/cohub/board/editor";
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
	Crosshair,
	LayoutGrid,
	LoaderCircle,
	Lock,
	LockOpen,
	RefreshCw,
	Sparkles,
	SquareDashed,
	Trash2,
} from "lucide-svelte";
import { boardSelectionColor } from "#lib/board/board-selection-color.ts";
import type { BoardEditor } from "#lib/board/editor.svelte.ts";
import type { BoardMenuAction } from "#lib/components/board/BoardContextMenu.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

const {
	editor,
	onAddTaskResults,
	onShowSource,
	onRegenerateTask,
	onAddToGeneration,
	regeneratingItemId = null,
	itemActions = [],
}: {
	editor: BoardEditor;
	onAddTaskResults?: (itemId: string) => void;
	onShowSource?: (itemId: string) => void;
	onRegenerateTask?: (itemId: string) => void;
	onAddToGeneration?: () => void;
	regeneratingItemId?: string | null;
	itemActions?: BoardMenuAction[];
} = $props();

const locale = $derived(getLocale());

const settled = $derived.by(() => {
	const interaction = editor.interaction;
	return (
		interaction.type === "idle" ||
		interaction.type === "panning" ||
		(interaction.type === "translating" &&
			!interaction.moved &&
			!interaction.held)
	);
});

const visible = $derived(
	editor.selection.length > 0 &&
		editor.selection.some((id) => editor.itemById(id) !== null) &&
		(editor.tool === "select" ||
			(editor.tool === "hand" && isTouchLikePointer(editor.pointerType))) &&
		settled &&
		!editor.editingId,
);

const canAlign = $derived(editor.selection.length >= 2);
const bare = $derived(editor.selectionBare);
const canDistribute = $derived(editor.selection.length >= 3);
const canGenerate = $derived(
	editor.selectedItems.some(
		(item) =>
			item.type === "image" || item.type === "video" || item.type === "audio",
	),
);
const single = $derived(
	editor.selectedItems.length === 1 ? (editor.selectedItems[0] ?? null) : null,
);
const generationTask = $derived(
	single?.type === "task" && single.props.snapshot.taskType === "generation"
		? single
		: null,
);
const taskWithResults = $derived(
	single?.type === "task" && single.props.snapshot.artifactCount > 0
		? single
		: null,
);
const resultWithSource = $derived(
	single && boardItemOrigin(single) ? single : null,
);

const position = $derived.by(() => {
	const bounds = editor.visualBounds;
	if (!bounds) return null;
	const camera = editor.camera;
	const left = (bounds.x + bounds.width / 2) * camera.zoom + camera.x;
	const top = Math.max(36, bounds.y * camera.zoom + camera.y);
	return { left, top };
});

const currentColor = $derived(boardSelectionColor(editor.selectedItems));
</script>

{#if visible && position}
	<div
		class="board-selection-toolbar toolbar-surface"
		style:left="{position.left}px"
		style:top="{position.top}px"
		role="toolbar"
		aria-label={m.board_selection_actions({}, { locale })}
	>
		{#if itemActions.length > 0}
			{#each itemActions as action (action.id)}
				<button type="button" class="tool-key" title={action.label} aria-label={action.label} aria-expanded={action.expanded} onclick={action.run}>
					<action.icon class={action.warning ? "h-3.5 w-3.5 text-error" : "h-3.5 w-3.5"} />
				</button>
			{/each}
			<div class="toolbar-divider"></div>
		{/if}
		{#if currentColor !== undefined}
			<div class="flex items-center gap-1 px-1">
				{#each BOARD_COLORS as color (color.id)}
					<button
						type="button"
						class="color-chip"
						title={color.label}
						aria-label="Set {color.label} color"
						aria-pressed={currentColor === color.id}
						style:--chip-color="var({boardColorCssVar(color.id, 'stroke')})"
						onclick={() => editor.setSelectionColor(color.id)}
					></button>
				{/each}
			</div>
			<div class="toolbar-divider"></div>
		{/if}

		{#if bare !== null}
			<button type="button" class="tool-key" aria-pressed={bare} title={m.board_decoration_none_hint({}, { locale })} aria-label={m.board_decoration_none({}, { locale })} onclick={() => editor.setSelectionBare(!bare)}>
				<SquareDashed class="h-3.5 w-3.5" />
			</button>
		{/if}
		{#if canGenerate && onAddToGeneration}
			<button
				type="button"
				class="tool-key"
				title={m.board_add_to_generation({}, { locale })}
				aria-label={m.board_add_selected_to_generation({}, { locale })}
				onclick={onAddToGeneration}
			>
				<Sparkles class="h-3.5 w-3.5" />
			</button>
			<div class="toolbar-divider"></div>
		{/if}

		{#if taskWithResults && onAddTaskResults}
			<button
				type="button"
				class="tool-key"
				title={m.board_add_results({}, { locale })}
				aria-label={m.board_add_results({}, { locale })}
				onclick={() => onAddTaskResults(taskWithResults.id)}
			>
				<LayoutGrid class="h-3.5 w-3.5" />
			</button>
		{/if}
		{#if resultWithSource && onShowSource}
			<button
				type="button"
				class="tool-key"
				title={m.board_show_source({}, { locale })}
				aria-label={m.board_show_source({}, { locale })}
				onclick={() => onShowSource(resultWithSource.id)}
			>
				<Crosshair class="h-3.5 w-3.5" />
			</button>
			<div class="toolbar-divider"></div>
		{/if}
		{#if generationTask && onRegenerateTask}
			<button
				type="button"
				class="tool-key"
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
			<div class="toolbar-divider"></div>
		{/if}

		{#if canAlign}
			<button type="button" class="tool-key" title={m.board_align_left({}, { locale })} aria-label={m.board_align_left({}, { locale })} onclick={() => editor.alignSelection("left")}>
				<AlignStartVertical class="h-3.5 w-3.5" />
			</button>
			<button type="button" class="tool-key" title={m.board_align_center({}, { locale })} aria-label={m.board_align_hcenter({}, { locale })} onclick={() => editor.alignSelection("center-x")}>
				<AlignCenterVertical class="h-3.5 w-3.5" />
			</button>
			<button type="button" class="tool-key" title={m.board_align_right({}, { locale })} aria-label={m.board_align_right({}, { locale })} onclick={() => editor.alignSelection("right")}>
				<AlignEndVertical class="h-3.5 w-3.5" />
			</button>
			<button type="button" class="tool-key" title={m.board_align_top({}, { locale })} aria-label={m.board_align_top({}, { locale })} onclick={() => editor.alignSelection("top")}>
				<AlignStartHorizontal class="h-3.5 w-3.5" />
			</button>
			<button type="button" class="tool-key" title={m.board_align_middle({}, { locale })} aria-label={m.board_align_vcenter({}, { locale })} onclick={() => editor.alignSelection("center-y")}>
				<AlignCenterHorizontal class="h-3.5 w-3.5" />
			</button>
			<button type="button" class="tool-key" title={m.board_align_bottom({}, { locale })} aria-label={m.board_align_bottom({}, { locale })} onclick={() => editor.alignSelection("bottom")}>
				<AlignEndHorizontal class="h-3.5 w-3.5" />
			</button>
			{#if canDistribute}
				<button type="button" class="tool-key" title={m.board_distribute_h({}, { locale })} aria-label={m.board_distribute_h({}, { locale })} onclick={() => editor.distributeSelection("horizontal")}>
					<AlignHorizontalDistributeCenter class="h-3.5 w-3.5" />
				</button>
				<button type="button" class="tool-key" title={m.board_distribute_v({}, { locale })} aria-label={m.board_distribute_v({}, { locale })} onclick={() => editor.distributeSelection("vertical")}>
					<AlignVerticalDistributeCenter class="h-3.5 w-3.5" />
				</button>
			{/if}
			<div class="toolbar-divider"></div>
		{/if}

		<button type="button" class="tool-key" title={m.board_bring_front({}, { locale })} aria-label={m.board_bring_front({}, { locale })} onclick={() => editor.bringToFront()}>
			<ArrowUpToLine class="h-3.5 w-3.5" />
		</button>
		<button type="button" class="tool-key" title={m.board_send_back({}, { locale })} aria-label={m.board_send_back({}, { locale })} onclick={() => editor.sendToBack()}>
			<ArrowDownToLine class="h-3.5 w-3.5" />
		</button>

		<div class="toolbar-divider"></div>

		<button
			type="button"
			class="tool-key"
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
		<button type="button" class="tool-key" title={m.board_duplicate({}, { locale })} aria-label={m.board_duplicate({}, { locale })} onclick={() => editor.duplicateSelection()}>
			<Copy class="h-3.5 w-3.5" />
		</button>
		<button type="button" class="tool-key is-danger" title={m.board_delete({}, { locale })} aria-label={m.board_delete({}, { locale })} onclick={() => editor.deleteSelection()}>
			<Trash2 class="h-3.5 w-3.5" />
		</button>
	</div>
{/if}

<style>
	.board-selection-toolbar {
		--tool-key-size: 26px;
		--color-chip-size: 16px;
		position: absolute;
		z-index: 24;
		max-width: calc(100% - 16px);
		overflow-x: auto;
		transform: translate(-50%, calc(-100% - 12px));
		white-space: nowrap;
		scrollbar-width: none;
	}
	.board-selection-toolbar::-webkit-scrollbar { display: none; }

	@media (pointer: coarse) {
		.board-selection-toolbar {
			--tool-key-size: 36px;
			--color-chip-size: 22px;
			max-width: calc(100% - 20px);
		}
	}
</style>
