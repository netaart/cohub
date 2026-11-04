<script lang="ts">
import type { ShapeKind } from "@neta-art/cohub/board";
import {
	BOARD_COLORS,
	boardColorCssVar,
	SHAPE_KINDS,
} from "@neta-art/cohub/board";
import {
	ArrowUpRight,
	Blend,
	ChevronDown,
	Circle,
	Clapperboard,
	Copy,
	Diamond,
	Frame,
	GanttChart,
	Hand,
	History,
	ImageDown,
	Layers,
	Link,
	LocateFixed,
	Lock,
	LockOpen,
	Minus,
	MousePointer2,
	Palette,
	Pencil,
	Play,
	Plus,
	Square,
	SquareRoundCorner,
	Trash2,
	Triangle,
	Type,
} from "lucide-svelte";
import type { Snippet } from "svelte";
import { boardSelectionColor } from "$lib/board/board-selection-color";
import type { BoardEditor, BoardToolId } from "$lib/board/editor.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	editor,
	readonly = false,
	appearanceOpen = false,
	onToggleAppearance,
	generationOpen = false,
	onToggleGeneration,
	timelineOpen = false,
	onToggleTimeline,
	onExport,
	onReplay,
	onPresent,
	onAddLink,
	contextMenuOpen = false,
	lead,
}: {
	editor: BoardEditor;
	readonly?: boolean;
	appearanceOpen?: boolean;
	onToggleAppearance?: () => void;
	generationOpen?: boolean;
	onToggleGeneration?: () => void;
	timelineOpen?: boolean;
	onToggleTimeline?: () => void;
	onExport?: () => void;
	onReplay?: () => void;
	onPresent?: () => void;
	onAddLink?: () => void;
	contextMenuOpen?: boolean;
	lead?: Snippet;
} = $props();

const locale = $derived(getLocale());

const zoomPercent = $derived(Math.round(editor.camera.zoom * 100));
const hasSelection = $derived(
	editor.selection.length > 0 &&
		editor.selection.some((id) => editor.itemById(id) !== null),
);
const currentSelectionColor = $derived(
	boardSelectionColor(editor.selectedItems),
);
const canColor = $derived(currentSelectionColor !== undefined);

let insertOpen = $state(false);
let moreOpen = $state(false);

const activeTool = $derived(editor.tool === "hand" ? "hand" : "select");

const GEOMETRY_ICONS: Record<ShapeKind, typeof Square> = {
	rectangle: Square,
	rounded: SquareRoundCorner,
	ellipse: Circle,
	diamond: Diamond,
	triangle: Triangle,
};

function setTool(tool: BoardToolId) {
	insertOpen = false;
	editor.tool = tool;
}

function addText() {
	insertOpen = false;
	editor.beginTextDraft(editor.viewCenter());
}

function addShape(geometry: ShapeKind) {
	insertOpen = false;
	editor.addShape(editor.viewCenter(), geometry);
}

function addFrame() {
	insertOpen = false;
	editor.addFrame(editor.viewCenter());
}

function focusContent() {
	if (editor.hasFocusableSelection) editor.focusSelection({ padding: 48 });
	else editor.fitView();
}
</script>

{#if !readonly}
	{#if insertOpen}
		<div class="sheet" role="menu" aria-label={m.board_add({}, { locale })}>
			<div class="sheet-row">
				<button type="button" class="sheet-item" onclick={addText}>
					<Type class="h-4 w-4" />
					<span>{m.board_text({}, { locale })}</span>
				</button>
				{#each SHAPE_KINDS as geometry (geometry)}
					{@const Icon = GEOMETRY_ICONS[geometry]}
					<button
						type="button"
						class="sheet-item"
						class:sheet-item--on={editor.tool === "shape" && editor.activeShape === geometry}
						onclick={() => { setTool("shape"); addShape(geometry); }}
					>
						<Icon class="h-4 w-4" />
					</button>
				{/each}
				<button type="button" class="sheet-item" onclick={addFrame}>
					<Frame class="h-4 w-4" />
				</button>
			</div>
			<div class="sheet-row">
				{#if onAddLink}
					<button type="button" class="sheet-item" onclick={() => { insertOpen = false; onAddLink(); }}><Link class="h-4 w-4" /><span>{m.board_add_link({}, { locale })}</span></button>
				{/if}
				<button type="button" class="sheet-item" class:sheet-item--on={editor.tool === "draw"} onclick={() => setTool("draw")}>
					<Pencil class="h-4 w-4" />
					<span>{m.board_draw({}, { locale })}</span>
				</button>
				<button type="button" class="sheet-item" class:sheet-item--on={editor.tool === "arrow"} onclick={() => setTool("arrow")}>
					<ArrowUpRight class="h-4 w-4" />
					<span>{m.board_arrow({}, { locale })}</span>
				</button>
			</div>
		</div>
	{/if}

	{#if hasSelection && !contextMenuOpen}
		<div class="sheet sheet--selection" role="toolbar" aria-label={m.board_selection_actions({}, { locale })}>
			{#if canColor}
				<div class="swatches">
					{#each BOARD_COLORS as color (color.id)}
						<button
							type="button"
							class="color-chip"
							title={color.label}
							aria-label={m.board_use_color_aria({ color: color.label }, { locale })}
							aria-pressed={currentSelectionColor === color.id}
							style:--chip-color="var({boardColorCssVar(color.id, 'stroke')})"
							onclick={() => editor.setSelectionColor(color.id)}
						></button>
					{/each}
				</div>
			{/if}
			<div class="sheet-row">
				<button type="button" class="sheet-item" title={m.board_bring_front({}, { locale })} aria-label={m.board_bring_front({}, { locale })} onclick={() => editor.bringToFront()}>
					<Layers class="h-4 w-4" />
				</button>
				<button type="button" class="sheet-item" title={m.board_duplicate({}, { locale })} aria-label={m.board_duplicate({}, { locale })} onclick={() => editor.duplicateSelection()}>
					<Copy class="h-4 w-4" />
				</button>
				<button type="button" class="sheet-item" title={editor.selectionLocked ? m.board_unlock({}, { locale }) : m.board_lock({}, { locale })} aria-label={editor.selectionLocked ? m.board_unlock_selection({}, { locale }) : m.board_lock_selection({}, { locale })} onclick={() => editor.toggleSelectionLock()}>
					{#if editor.selectionLocked}<Lock class="h-4 w-4" />{:else}<LockOpen class="h-4 w-4" />{/if}
				</button>
				<button type="button" class="sheet-item sheet-item--danger" title={m.board_delete({}, { locale })} aria-label={m.board_delete({}, { locale })} onclick={() => editor.deleteSelection()}>
					<Trash2 class="h-4 w-4" />
				</button>
			</div>
		</div>
	{/if}

	{#if moreOpen}
		<div class="sheet" role="menu" aria-label={m.board_more({}, { locale })}>
			<button type="button" class="sheet-item sheet-item--wide" class:sheet-item--on={appearanceOpen} onclick={() => { moreOpen = false; onToggleAppearance?.(); }}>
				<Palette class="h-4 w-4" />
				<span>{m.board_appearance({}, { locale })}</span>
			</button>
			{#if onToggleGeneration}
				<button type="button" class="sheet-item sheet-item--wide" class:sheet-item--on={generationOpen} onclick={() => { moreOpen = false; onToggleGeneration(); }}>
					<Blend class="h-4 w-4" />
					<span>{m.board_generate_media({}, { locale })}</span>
				</button>
			{/if}
			{#if onToggleTimeline}
				<button type="button" class="sheet-item sheet-item--wide" class:sheet-item--on={timelineOpen} onclick={() => { moreOpen = false; onToggleTimeline?.(); }}>
					<GanttChart class="h-4 w-4" />
					<span>{m.board_timeline({}, { locale })}</span>
				</button>
			{/if}
			{#if onExport}
				<button type="button" class="sheet-item sheet-item--wide" onclick={() => { moreOpen = false; onExport?.(); }}>
					<ImageDown class="h-4 w-4" />
					<span>{m.board_export_image({}, { locale })}</span>
				</button>
			{/if}
			{#if onReplay}
				<button type="button" class="sheet-item sheet-item--wide" onclick={() => { moreOpen = false; onReplay?.(); }}>
					<History class="h-4 w-4" />
					<span>{m.board_replay({}, { locale })}</span>
				</button>
			{/if}
			{#if onPresent}
				<button type="button" class="sheet-item sheet-item--wide" onclick={() => { moreOpen = false; onPresent(); }}>
					<Play class="h-4 w-4" />
					<span>{m.board_present({}, { locale })}</span>
				</button>
			{/if}
		</div>
	{/if}
{/if}

<div class="board-mobile-bar toolbar-surface" role="toolbar" aria-label={m.board_tools({}, { locale })}>
	{@render lead?.()}
	{#if !readonly || !lead}
		<button
			type="button"
			class="tool-key"
			title={m.board_hand({}, { locale })}
			aria-label={m.board_hand({}, { locale })}
			aria-pressed={activeTool === "hand"}
			onclick={() => setTool("hand")}
		>
			<Hand class="h-4 w-4" />
		</button>
		<button
			type="button"
			class="tool-key"
			title={m.board_select({}, { locale })}
			aria-label={m.board_select({}, { locale })}
			aria-pressed={activeTool === "select"}
			onclick={() => setTool("select")}
		>
			<MousePointer2 class="h-4 w-4" />
		</button>
	{/if}

	{#if !readonly}
		<button
			type="button"
			class="tool-key"
			title={m.board_add({}, { locale })}
			aria-label={m.board_add({}, { locale })}
			aria-expanded={insertOpen}
			onclick={() => { insertOpen = !insertOpen; moreOpen = false; }}
		>
			{#if insertOpen}<ChevronDown class="h-4 w-4" />{:else}<Plus class="h-4 w-4" />{/if}
		</button>
	{/if}

	<div class="bar-spacer"></div>

	<button type="button" class="tool-key" title={m.board_zoom_out({}, { locale })} aria-label={m.board_zoom_out({}, { locale })} onclick={() => editor.zoomOut()}>
		<Minus class="h-4 w-4" />
	</button>
	<button type="button" class="tool-key bar-zoom" title={m.board_zoom_reset({}, { locale })} aria-label={m.board_zoom_reset({}, { locale })} onclick={() => editor.resetZoom()}>
		{zoomPercent}%
	</button>
	<button type="button" class="tool-key" title={m.board_zoom_in({}, { locale })} aria-label={m.board_zoom_in({}, { locale })} onclick={() => editor.zoomIn()}>
		<Plus class="h-4 w-4" />
	</button>
	<button type="button" class="tool-key" title={m.board_zoom_fit({}, { locale })} aria-label={m.board_zoom_fit({}, { locale })} onclick={focusContent}>
		<LocateFixed class="h-4 w-4" />
	</button>

	{#if readonly && onPresent}
		<button
			type="button"
			class="tool-key"
			title={m.board_present({}, { locale })}
			aria-label={m.board_present({}, { locale })}
			onclick={onPresent}
		>
			<Play class="h-4 w-4" />
		</button>
	{/if}

	{#if readonly && onToggleTimeline}
		<button
			type="button"
			class="tool-key"
			title={m.board_play_animation({}, { locale })}
			aria-label={m.board_play_animation({}, { locale })}
			aria-expanded={timelineOpen}
			onclick={onToggleTimeline}
		>
			<Clapperboard class="h-4 w-4" />
		</button>
	{/if}

	{#if !readonly}
		<div class="bar-spacer"></div>
		<button
			type="button"
			class="tool-key"
			title={m.board_more({}, { locale })}
			aria-label={m.board_more({}, { locale })}
			aria-expanded={moreOpen}
			onclick={() => { moreOpen = !moreOpen; insertOpen = false; }}
		>
			<Diamond class="h-4 w-4" />
		</button>
	{/if}
</div>

<style>
	.board-mobile-bar {
		--tool-key-size: 40px;
		position: absolute;
		right: 8px;
		bottom: calc(8px + env(safe-area-inset-bottom, 0px));
		left: 8px;
		z-index: 25;
		gap: 2px;
		border-radius: 12px;
		padding: 4px;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.board-mobile-bar::-webkit-scrollbar { display: none; }

	.bar-zoom {
		min-width: 50px;
		color: var(--text-tertiary);
		font-size: 12px;
		font-variant-numeric: tabular-nums;
	}

	.bar-spacer { flex: 1; }

	.sheet {
		position: absolute;
		right: 8px;
		bottom: calc(64px + env(safe-area-inset-bottom, 0px));
		left: 8px;
		z-index: 24;
		display: flex;
		flex-direction: column;
		gap: 4px;
		border-radius: 14px;
		border: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--bg-elevated) 96%, transparent);
		padding: 6px;
		box-shadow: var(--toolbar-shadow);
		backdrop-filter: blur(12px);
	}

	.sheet--selection {
		right: auto;
		left: 50%;
		width: max-content;
		max-width: calc(100% - 16px);
		transform: translateX(-50%);
	}

	.sheet-row {
		display: flex;
		align-items: center;
		gap: 3px;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.sheet-row::-webkit-scrollbar { display: none; }

	.sheet-item {
		display: inline-flex;
		flex: 1;
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-width: 40px;
		min-height: 44px;
		border: 1px solid transparent;
		border-radius: 10px;
		color: var(--text-secondary);
		font-size: 13px;
		white-space: nowrap;
		cursor: pointer;
	}
	.sheet-item--wide { justify-content: flex-start; padding: 0 12px; }
	.sheet-item--on {
		border-color: var(--brand-border);
		background: var(--brand-bg);
		color: var(--brand-muted-fg);
	}
	.sheet-item--danger { color: var(--color-error-soft); }

	.swatches {
		display: flex;
		justify-content: center;
		--color-chip-size: 26px;
		gap: 8px;
		padding: 4px 2px;
	}
</style>
