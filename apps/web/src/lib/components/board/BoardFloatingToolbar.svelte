<script lang="ts">
import {
	BOARD_COLORS,
	BOARD_STROKE_MAX_SIZE,
	BOARD_STROKE_MIN_SIZE,
	boardColorCssVar,
	DEFAULT_BOARD_TOOL_STYLES,
	SHAPE_KINDS,
	type ShapeKind,
} from "@neta-art/cohub/board";
import {
	ArrowUpRight,
	Blend,
	Circle,
	Diamond,
	Frame,
	GanttChart,
	Hand,
	Link,
	MousePointer2,
	Pencil,
	Redo2,
	SlidersHorizontal,
	Square,
	SquareRoundCorner,
	Triangle,
	Type,
	Undo2,
} from "lucide-svelte";
import type { BoardEditor, BoardToolId } from "#lib/board/editor.svelte.ts";
import BoardNumberControl from "#lib/components/board/BoardNumberControl.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

const {
	editor,
	generationOpen = false,
	onToggleGeneration,
	appearanceOpen = false,
	onToggleAppearance,
	timelineOpen = false,
	onToggleTimeline,
	onAddLink,
}: {
	editor: BoardEditor;
	generationOpen?: boolean;
	onToggleGeneration?: () => void;
	appearanceOpen?: boolean;
	onToggleAppearance?: () => void;
	timelineOpen?: boolean;
	onToggleTimeline?: () => void;
	onAddLink?: () => void;
} = $props();

const locale = $derived(getLocale());

let styleOpen = $state(false);
let previousTool = $state<BoardToolId | null>(null);

type ToolDef = {
	id: BoardToolId;
	label: string;
	shortcut: string;
	icon: typeof MousePointer2;
	hasStyle: boolean;
};

const TOOLS = $derived<ToolDef[]>([
	{
		id: "select",
		label: m.board_select({}, { locale }),
		shortcut: "V",
		icon: MousePointer2,
		hasStyle: false,
	},
	{
		id: "hand",
		label: m.board_hand({}, { locale }),
		shortcut: "H",
		icon: Hand,
		hasStyle: false,
	},
	{
		id: "draw",
		label: m.board_draw({}, { locale }),
		shortcut: "D",
		icon: Pencil,
		hasStyle: true,
	},
	{
		id: "arrow",
		label: m.board_arrow({}, { locale }),
		shortcut: "A",
		icon: ArrowUpRight,
		hasStyle: true,
	},
	{
		id: "text",
		label: m.board_text_tool({}, { locale }),
		shortcut: "T",
		icon: Type,
		hasStyle: true,
	},
	{
		id: "shape",
		label: m.board_shape({}, { locale }),
		shortcut: "G",
		icon: Square,
		hasStyle: true,
	},
	{
		id: "frame",
		label: m.board_frame({}, { locale }),
		shortcut: "F",
		icon: Frame,
		hasStyle: true,
	},
]);

const activeTool = $derived(
	TOOLS.find((candidate) => candidate.id === editor.tool),
);
const showStyles = $derived(Boolean(activeTool?.hasStyle && styleOpen));

$effect(() => {
	const current = editor.tool;
	if (current === previousTool) return;
	previousTool = current;
	styleOpen = Boolean(
		TOOLS.find((candidate) => candidate.id === current)?.hasStyle,
	);
});

const GEO_OPTIONS = $derived<
	Record<ShapeKind, { label: string; icon: typeof Square }>
>({
	rectangle: { label: m.board_rectangle({}, { locale }), icon: Square },
	rounded: {
		label: m.board_rounded_rect({}, { locale }),
		icon: SquareRoundCorner,
	},
	ellipse: { label: m.board_ellipse({}, { locale }), icon: Circle },
	diamond: { label: m.board_diamond({}, { locale }), icon: Diamond },
	triangle: { label: m.board_triangle({}, { locale }), icon: Triangle },
});

function selectTool(id: BoardToolId) {
	const tool = TOOLS.find((candidate) => candidate.id === id);
	const styleWasOpen = editor.tool === id && styleOpen;
	editor.tool = id;
	styleOpen = Boolean(tool?.hasStyle && !styleWasOpen);
}

function toolTitle(tool: ToolDef) {
	const stay = tool.id === "draw" ? " · stay active" : "";
	return `${tool.label} (${tool.shortcut})${stay}`;
}
</script>

<div class="board-toolbar-wrap">
	{#if showStyles}
		<div class="board-style-row toolbar-surface" role="toolbar" aria-label="{activeTool?.label ?? 'Tool'} style">
			{#if editor.tool === "draw" || editor.tool === "arrow"}
				<span class="style-kind" title={m.board_stroke_width({}, { locale })} aria-hidden="true">
					{#if editor.tool === "draw"}
						<Pencil class="h-3.5 w-3.5" />
					{:else}
						<ArrowUpRight class="h-3.5 w-3.5" />
					{/if}
				</span>
				<BoardNumberControl
					value={editor.activeStrokeSize}
					fallback={editor.tool === "draw"
						? DEFAULT_BOARD_TOOL_STYLES.draw.size
						: DEFAULT_BOARD_TOOL_STYLES.arrow.size}
					min={BOARD_STROKE_MIN_SIZE}
					max={BOARD_STROKE_MAX_SIZE}
					step={editor.tool === "draw" ? 1 : 0.5}
					label={m.board_stroke_width({}, { locale })}
					onChange={(value) => { editor.activeStrokeSize = value; }}
				/>
				<div class="toolbar-divider"></div>
			{/if}

			<div class="color-list" role="group" aria-label={m.board_color({}, { locale })}>
				{#each BOARD_COLORS as color (color.id)}
					<button
						type="button"
						class="color-chip"
						title={color.label}
						aria-label="Use {color.label}"
						aria-pressed={editor.activeColor === color.id}
						style:--chip-color="var({boardColorCssVar(color.id, 'stroke')})"
						onclick={() => { editor.activeColor = color.id; }}
					></button>
				{/each}
			</div>

			{#if editor.tool === "shape"}
				<div class="toolbar-divider"></div>
				{#each SHAPE_KINDS as geo (geo)}
					{@const option = GEO_OPTIONS[geo]}
					<button
						type="button"
						class="tool-key geo-key"
						title={option.label}
						aria-label="Use {option.label}"
						aria-pressed={editor.activeShape === geo}
						onclick={() => { editor.activeShape = geo; }}
					>
						<option.icon class="h-3.5 w-3.5" />
					</button>
				{/each}
			{/if}
		</div>
	{/if}

	<div class="board-floating-toolbar toolbar-surface" role="toolbar" aria-label={m.board_tools({}, { locale })}>
		{#each TOOLS as tool (tool.id)}
			<button
				type="button"
				class="tool-key"
				title={toolTitle(tool)}
				aria-label="{tool.label} tool"
				aria-pressed={editor.tool === tool.id}
				aria-expanded={tool.hasStyle
					? editor.tool === tool.id && showStyles
					: undefined}
				onclick={() => selectTool(tool.id)}
			>
				<tool.icon class="h-4 w-4" />
			</button>
		{/each}

		{#if onAddLink}
			<button type="button" class="tool-key" title={m.board_add_link({}, { locale })} aria-label={m.board_add_link({}, { locale })} onclick={onAddLink}><Link class="h-4 w-4" /></button>
		{/if}

		<div class="toolbar-divider"></div>

		{#if onToggleGeneration}
			<button
				type="button"
				class="tool-key"
				title={m.board_generate_media({}, { locale })}
				aria-label={m.board_generate_media({}, { locale })}
				aria-pressed={generationOpen}
				onclick={onToggleGeneration}
			>
				<Blend class="h-4 w-4" />
			</button>
		{/if}
		<button
			type="button"
			class="tool-key"
			title={m.board_appearance({}, { locale })}
			aria-label={m.board_appearance({}, { locale })}
			aria-pressed={appearanceOpen}
			onclick={onToggleAppearance}
		>
			<SlidersHorizontal class="h-4 w-4" />
		</button>
		{#if onToggleTimeline}
			<button
				type="button"
				class="tool-key"
				title="{m.board_timeline({}, { locale })} (⇧A)"
				aria-label={m.board_timeline({}, { locale })}
				aria-pressed={timelineOpen}
				onclick={onToggleTimeline}
			>
				<GanttChart class="h-4 w-4" />
			</button>
		{/if}

		<div class="toolbar-divider"></div>

		<button
			type="button"
			class="tool-key"
			title={m.common_undo({}, { locale })}
			aria-label={m.common_undo({}, { locale })}
			disabled={!editor.canUndo}
			onclick={() => editor.undo()}
		>
			<Undo2 class="h-4 w-4" />
		</button>
		<button
			type="button"
			class="tool-key"
			title={m.board_redo({}, { locale })}
			aria-label={m.board_redo({}, { locale })}
			disabled={!editor.canRedo}
			onclick={() => editor.redo()}
		>
			<Redo2 class="h-4 w-4" />
		</button>
	</div>
</div>

<style>
	.board-toolbar-wrap {
		position: absolute;
		bottom: 14px;
		left: 50%;
		z-index: 25;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		width: max-content;
		max-width: calc(100% - 20px);
		transform: translateX(-50%);
	}

	.board-style-row {
		--tool-key-size: 24px;
		gap: 4px;
		max-width: 100%;
		overflow-x: auto;
		padding: 4px 6px;
		scrollbar-width: none;
	}
	.board-style-row::-webkit-scrollbar { display: none; }

	.style-kind {
		display: inline-flex;
		width: 18px;
		height: 24px;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		color: var(--text-tertiary);
	}

	.color-list {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.board-floating-toolbar {
		--tool-key-size: 30px;
	}

	@media (pointer: coarse) {
		.board-toolbar-wrap {
			bottom: calc(10px + env(safe-area-inset-bottom, 0px));
			width: calc(100% - 16px);
			max-width: calc(100vw - 16px);
		}
		.tool-key,
		.color-chip,
		.style-kind { position: relative; }
		.tool-key::after,
		.color-chip::after,
		.style-kind::after {
			content: "";
			position: absolute;
			left: 50%;
			top: 50%;
			translate: -50% -50%;
			min-width: 44px;
			min-height: 44px;
			width: 100%;
			height: 100%;
		}
		.board-floating-toolbar {
			--tool-key-size: 40px;
			max-width: 100%;
			overflow-x: auto;
			scrollbar-width: none;
			-webkit-overflow-scrolling: touch;
			padding: 5px;
			gap: 3px;
		}
		.board-floating-toolbar::-webkit-scrollbar { display: none; }
		.board-style-row { --tool-key-size: 32px; }
		.style-kind { width: 24px; height: 32px; }
		.color-list { gap: 6px; --color-chip-size: 26px; }
	}

	@media (pointer: coarse) and (max-width: 480px) {
		.board-toolbar-wrap {
			bottom: calc(8px + env(safe-area-inset-bottom, 0px));
		}
		.board-floating-toolbar { --tool-key-size: 38px; }
	}
</style>
