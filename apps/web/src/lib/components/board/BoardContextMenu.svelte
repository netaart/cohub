<script lang="ts" module>
import type { MenuIcon, MenuItem } from "#lib/context-menu/menu.ts";

export type BoardMenuAction = MenuItem & {
	icon: MenuIcon;
	expanded?: boolean;
};
</script>

<script lang="ts">
import { BOARD_REACTIONS, type BoardReaction } from "@cohub/protocol/realtime";
import { boardItemOrigin, parseBoardMediaSource } from "@neta-art/cohub/board";
import {
	ArrowDownToLine,
	ArrowUpToLine,
	BoxSelect,
	Clapperboard,
	ClipboardCopy,
	Copy,
	Crosshair,
	Heart,
	ExternalLink,
	History,
	Download,
	LayoutDashboard,
	LayoutGrid,
	Link,
	Link2,
	LocateFixed,
	Maximize,
	MonitorPlay,
	PartyPopper,
	Pencil,
	Presentation,
	RefreshCw,
	Sparkles,
	Star,
	Trash2,
} from "lucide-svelte";
import type { BoardEditor } from "#lib/board/editor.svelte.ts";
import ContextMenu from "#lib/components/context-menu/ContextMenu.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

const {
	editor,
	editable = true,
	position,
	onClose,
	onOpenFile,
	onAddLink,
	onAddTaskResults,
	onShowSource,
	onOpenTask,
	onRegenerateTask,
	onAddToGeneration,
	regeneratingItemId = null,
	onExport,
	onReplay,
	onAnimate,
	onCopy,
	onCopyLink,
	onPresent,
	onReact,
	itemActions = [],
	sheet = false,
}: {
	editor: BoardEditor;
	editable?: boolean;
	position: { x: number; y: number };
	onClose: () => void;
	onOpenFile?: (path: string) => void | Promise<void>;
	onAddLink?: () => void;
	onAddTaskResults?: (itemId: string) => void;
	onShowSource?: (itemId: string) => void;
	onOpenTask?: (taskRunId: string) => void;
	onRegenerateTask?: (itemId: string) => void;
	onAddToGeneration?: () => void;
	regeneratingItemId?: string | null;
	onExport?: () => void;
	onReplay?: () => void;
	onAnimate?: () => void;
	onCopy?: () => void;
	onCopyLink?: () => void;
	onPresent?: (frameId: string) => void;
	onReact?: (reaction: BoardReaction) => void;
	itemActions?: BoardMenuAction[];
	sheet?: boolean;
} = $props();

const locale = $derived(getLocale());

const REACTION_ICONS = { heart: Heart, star: Star, spark: Sparkles, confetti: PartyPopper } satisfies Record<BoardReaction, typeof Heart>;
const REACTION_LABELS = {
	heart: m.board_reaction_heart,
	star: m.board_reaction_star,
	spark: m.board_reaction_spark,
	confetti: m.board_reaction_confetti,
} satisfies Record<BoardReaction, unknown>;

const hasSelection = $derived(editor.selection.length > 0);
const canGenerate = $derived(
	editor.selectedItems.some(
		(item) =>
			item.type === "image" || item.type === "video" || item.type === "audio",
	),
);
const singleFrame = $derived.by(() => {
	const [only] = editor.selection;
	return editor.selection.length === 1 && only && editor.frames.some((frame) => frame.id === only)
		? only
		: null;
});
const singleText = $derived(
	editor.selectedItems.length === 1 && editor.selectedItems[0]?.type === "text",
);
const singleFile = $derived.by(() => {
	if (editor.selectedItems.length !== 1) return null;
	const item = editor.selectedItems[0];
	return item && ["file", "image", "video", "audio"].includes(item.type)
		? (item.props as { src: string })
		: null;
});

const singleTask = $derived.by(() => {
	if (editor.selectedItems.length !== 1) return null;
	const item = editor.selectedItems[0];
	if (item?.type !== "task") return null;
	const props = item.props;
	return {
		hasResults: props.snapshot.artifactCount > 0,
		id: item.id,
		taskRunId: props.taskRunId,
		taskType: props.snapshot.taskType,
	};
});
const singleOrigin = $derived.by(() => {
	if (editor.selectedItems.length !== 1) return null;
	const item = editor.selectedItems[0];
	const origin = item ? boardItemOrigin(item) : null;
	return item && origin ? { id: item.id, taskRunId: origin.taskRunId } : null;
});

const actions = $derived.by<BoardMenuAction[]>(() => {
	const list: BoardMenuAction[] = [...itemActions];
	const file = singleFile;
	const task = singleTask;
	const frame = singleFrame;
	if (frame && onPresent)
		list.push({
			id: "present",
			label: m.board_present_from_here({}, { locale }),
			icon: Presentation,
			run: () => onPresent(frame),
		});
	if (onAddLink)
		list.push({
			id: "add-link",
			label: m.board_add_link({}, { locale }),
			icon: Link,
			run: onAddLink,
		});
	if (canGenerate && onAddToGeneration)
		list.push({
			id: "add-to-generation",
			label: m.board_add_to_generation({}, { locale }),
			icon: Sparkles,
			run: onAddToGeneration,
		});
	if (task?.hasResults && onAddTaskResults)
		list.push({
			id: "add-results",
			label: m.board_add_results({}, { locale }),
			icon: LayoutGrid,
			run: () => onAddTaskResults(task.id),
		});
	const origin = singleOrigin;
	if (origin && onShowSource)
		list.push({
			id: "show-source",
			label: m.board_show_source({}, { locale }),
			icon: Crosshair,
			run: () => onShowSource(origin.id),
		});
	const taskRunId = origin?.taskRunId ?? task?.taskRunId;
	if (taskRunId && onOpenTask)
		list.push({
			id: "open-task",
			label: m.board_open_task({}, { locale }),
			icon: LayoutDashboard,
			run: () => onOpenTask(taskRunId),
		});
	if (task?.taskType === "generation" && onRegenerateTask)
		list.push({
			id: "regenerate",
			label:
				regeneratingItemId === task.id
					? m.board_regenerating_ellipsis({}, { locale })
					: m.board_regenerate({}, { locale }),
			icon: RefreshCw,
			disabled: regeneratingItemId !== null,
			run: () => onRegenerateTask(task.id),
		});
	if (file && onOpenFile)
		list.push({
			id: "open-file",
			label:
				parseBoardMediaSource(file.src)?.kind === "url"
					? m.board_open_source({}, { locale })
					: m.board_open_file({}, { locale }),
			icon: ExternalLink,
			run: () => {
				void onOpenFile(file.src);
			},
		});
	if (singleText && editable)
		list.push({
			id: "edit-text",
			label: m.board_edit_text({}, { locale }),
			icon: Pencil,
			run: () => {
				editor.editingId = editor.selectedItems[0]?.id ?? null;
			},
		});
	const autoplay = editable ? editor.selectionAutoplay : null;
	if (autoplay !== null)
		list.push({
			id: "autoplay",
			label: m.board_autoplay({}, { locale }),
			icon: MonitorPlay,
			checked: autoplay,
			run: () => editor.setSelectionAutoplay(!autoplay),
		});
	if (hasSelection && onCopy)
		list.push({
			id: "copy",
			label: m.board_copy({}, { locale }),
			icon: ClipboardCopy,
			run: onCopy,
		});
	if (hasSelection && editable) {
		list.push(
			{
				id: "duplicate",
				label: m.board_duplicate({}, { locale }),
				icon: Copy,
				run: () => editor.duplicateSelection(),
			},
			...(editor.canFillFrame
				? [
						{
							id: "fill-frame",
							label: m.board_fill_frame({}, { locale }),
							icon: Maximize,
							run: () => editor.fillFrame(),
						},
					]
				: []),
			{
				id: "bring-front",
				label: m.board_bring_front({}, { locale }),
				icon: ArrowUpToLine,
				run: () => editor.bringToFront(),
			},
			{
				id: "send-back",
				label: m.board_send_back({}, { locale }),
				icon: ArrowDownToLine,
				run: () => editor.sendToBack(),
			},
			{
				id: "delete",
				label: m.board_delete({}, { locale }),
				icon: Trash2,
				danger: true,
				run: () => editor.deleteSelection(),
			},
		);
	}
	list.push(
		{
			id: "select-all",
			label: m.board_select_all({}, { locale }),
			icon: BoxSelect,
			run: () => editor.selectAll(),
		},
		{
			id: "zoom-fit",
			label: m.board_zoom_fit({}, { locale }),
			icon: LocateFixed,
			run: () => editor.fitView(),
		},
	);
	if (onExport)
		list.push({
			id: "export",
			label: m.board_export_ellipsis({}, { locale }),
			icon: Download,
			run: onExport,
		});
	if (onCopyLink)
		list.push({
			id: "copy-view-link",
			label: m.board_copy_view_link({}, { locale }),
			icon: Link2,
			run: onCopyLink,
		});
	if (onAnimate)
		list.push({
			id: "animate",
			label: m.board_animate({}, { locale }),
			icon: Clapperboard,
			run: onAnimate,
		});
	if (onReplay)
		list.push({
			id: "replay",
			label: m.board_replay({}, { locale }),
			icon: History,
			run: onReplay,
		});
	return list;
});
</script>

{#snippet reactions()}
	{#if onReact}
		<div class="ctx-reactions" role="group" aria-label={m.board_react({}, { locale })}>
			{#each BOARD_REACTIONS as reaction (reaction)}
				{@const Icon = REACTION_ICONS[reaction]}
				{@const label = REACTION_LABELS[reaction]({}, { locale })}
				<button
					type="button"
					class="ctx-reaction"
					title={label}
					aria-label={label}
					onclick={() => { onReact(reaction); onClose(); }}
				>
					<Icon class="h-4 w-4" />
				</button>
			{/each}
		</div>
	{/if}
{/snippet}

<ContextMenu open point={position} {sheet} items={actions} header={reactions} {onClose} />

<style>
	.ctx-reactions {
		display: flex;
		justify-content: space-between;
		gap: 2px;
		margin-bottom: 4px;
		border-bottom: 1px solid var(--border-subtle);
		padding: 0 2px 4px;
	}

	.ctx-reaction {
		display: grid;
		width: 32px;
		height: 32px;
		place-items: center;
		border-radius: 8px;
		color: var(--text-secondary);
		transition:
			background-color 100ms ease,
			color 100ms ease,
			scale 120ms var(--ease-out);
	}

	.ctx-reaction:active {
		scale: 0.9;
	}

	@media (hover: hover) {
		.ctx-reaction:hover {
			background: var(--bg-hover);
			color: var(--text-primary);
		}
	}

	:global([data-sheet]) .ctx-reaction {
		width: 44px;
		height: 44px;
	}
</style>
