<script lang="ts" module>
import type { Pencil as BoardMenuIcon } from "lucide-svelte";

export type BoardMenuAction = {
	id: string;
	label: string;
	icon: typeof BoardMenuIcon;
	danger?: boolean;
	warning?: boolean;
	expanded?: boolean;
	disabled?: boolean;
	run: () => void;
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
	ImageDown,
	LayoutDashboard,
	LayoutGrid,
	Link,
	Link2,
	LocateFixed,
	PartyPopper,
	Pencil,
	Play,
	RefreshCw,
	Sparkles,
	Star,
	Trash2,
} from "lucide-svelte";
import { onDestroy, onMount, untrack } from "svelte";
import { portal } from "$lib/actions/portal";
import type { BoardEditor } from "$lib/board/editor.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

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

let menu: HTMLDivElement | null = $state(null);
let left = $state(untrack(() => position.x));
let top = $state(untrack(() => position.y));

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
			icon: Play,
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
			label: hasSelection
				? m.board_export_selection({}, { locale })
				: m.board_export_image({}, { locale }),
			icon: ImageDown,
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

function run(action: BoardMenuAction) {
	if (action.disabled) return;
	action.run();
	onClose();
}

function handlePointerDown(event: PointerEvent) {
	if (menu && !menu.contains(event.target as Node)) onClose();
}

function handleKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") onClose();
}

onMount(() => {
	document.addEventListener("pointerdown", handlePointerDown, true);
	document.addEventListener("keydown", handleKeydown);
	if (!sheet && menu) {
		const rect = menu.getBoundingClientRect();
		left = Math.min(position.x, window.innerWidth - rect.width - 8);
		top = Math.min(position.y, window.innerHeight - rect.height - 8);
	}
});

onDestroy(() => {
	document.removeEventListener("pointerdown", handlePointerDown, true);
	document.removeEventListener("keydown", handleKeydown);
});
</script>

{#if sheet}
	<div class="ctx-scrim" role="presentation" onclick={onClose}></div>
{/if}

<div
	bind:this={menu}
	use:portal
	class="board-context-menu menu-surface"
	class:board-context-menu--sheet={sheet}
	style:left={sheet ? undefined : `${left}px`}
	style:top={sheet ? undefined : `${top}px`}
	role="menu"
	tabindex="-1"
	oncontextmenu={(event) => event.preventDefault()}
>
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
	{#each actions as action (action.id)}
		<button
			type="button"
			class="ctx-item"
			class:ctx-item--danger={action.danger}
			disabled={action.disabled}
			role="menuitem"
			onclick={() => run(action)}
		>
			<action.icon class={action.warning ? "h-3.5 w-3.5 text-error" : "h-3.5 w-3.5"} />
			<span>{action.label}</span>
		</button>
	{/each}
</div>

<style>
	.board-context-menu {
		position: fixed;
		z-index: 130;
		min-width: 168px;
		padding: 4px;
	}

	.ctx-scrim {
		position: fixed;
		inset: 0;
		z-index: 129;
		background: color-mix(in srgb, var(--overlay-scrim-strong) 32%, transparent);
	}

	.board-context-menu--sheet {
		right: 8px;
		bottom: calc(8px + env(safe-area-inset-bottom, 0px));
		left: 8px;
		min-width: 0;
		border-radius: 14px;
		padding: 6px;
	}
	.board-context-menu--sheet .ctx-item {
		min-height: 46px;
		border-radius: 10px;
		padding: 10px 12px;
		font-size: 14px;
	}
	.board-context-menu--sheet .ctx-item :global(svg) {
		width: 16px;
		height: 16px;
	}

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
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		transition: background-color 100ms ease, color 100ms ease, transform 120ms ease;
	}
	.ctx-reaction:hover { background: var(--bg-hover); color: var(--text-primary); }
	.ctx-reaction:active { transform: scale(0.9); }
	.board-context-menu--sheet .ctx-reaction { width: 44px; height: 44px; }

	.ctx-item {
		display: flex;
		width: 100%;
		align-items: center;
		gap: 8px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		padding: 7px 8px;
		color: var(--text-secondary);
		font-size: 12px;
		font-weight: 500;
		text-align: left;
		cursor: pointer;
		transition: background-color 100ms ease, color 100ms ease;
	}
	.ctx-item:hover { background: var(--bg-hover); color: var(--text-primary); }
	.ctx-item:disabled { cursor: default; opacity: 0.55; }
	.ctx-item--danger:hover { background: var(--color-error-bg); color: var(--error-700); }
</style>
