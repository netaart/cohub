<script lang="ts">
import {
	ArrowDownToLine,
	ArrowUpToLine,
	BoxSelect,
	Clapperboard,
	Copy,
	ExternalLink,
	History,
	ImageDown,
	LayoutDashboard,
	LocateFixed,
	Pencil,
	RefreshCw,
	Sparkles,
	Trash2,
} from "lucide-svelte";
import { onDestroy, onMount, untrack } from "svelte";
import { portal } from "$lib/actions/portal";
import type { BoardEditor } from "$lib/board/editor.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	editor,
	position,
	onClose,
	onOpenFile,
	onOpenTask,
	onRegenerateTask,
	onAddToGeneration,
	regeneratingItemId = null,
	onExport,
	onReplay,
	onAnimate,
	sheet = false,
}: {
	editor: BoardEditor;
	position: { x: number; y: number };
	onClose: () => void;
	onOpenFile?: (path: string) => void | Promise<void>;
	onOpenTask?: (taskRunId: string) => void;
	onRegenerateTask?: (itemId: string) => void;
	onAddToGeneration?: () => void;
	regeneratingItemId?: string | null;
	onExport?: () => void;
	onReplay?: () => void;
	onAnimate?: () => void;
	sheet?: boolean;
} = $props();

const locale = $derived(getLocale());

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
const singleText = $derived(
	editor.selectedItems.length === 1 && editor.selectedItems[0]?.type === "text",
);
const singleFile = $derived.by(() => {
	if (editor.selectedItems.length !== 1) return null;
	const item = editor.selectedItems[0];
	return item?.type === "file" ? (item.props as { src: string }) : null;
});

const singleTask = $derived.by(() => {
	if (editor.selectedItems.length !== 1) return null;
	const item = editor.selectedItems[0];
	if (item?.type !== "task") return null;
	const props = item.props as {
		taskRunId: string;
		snapshot: { taskType: string };
	};
	return {
		id: item.id,
		taskRunId: props.taskRunId,
		taskType: props.snapshot.taskType,
	};
});

type MenuAction = {
	label: string;
	icon: typeof Pencil;
	danger?: boolean;
	disabled?: boolean;
	run: () => void;
};

const actions = $derived.by<MenuAction[]>(() => {
	const list: MenuAction[] = [];
	const file = singleFile;
	const task = singleTask;
	if (canGenerate && onAddToGeneration)
		list.push({
			label: m.board_add_to_generation({}, { locale }),
			icon: Sparkles,
			run: onAddToGeneration,
		});
	if (task && onOpenTask)
		list.push({
			label: m.board_open_task({}, { locale }),
			icon: LayoutDashboard,
			run: () => onOpenTask(task.taskRunId),
		});
	if (task?.taskType === "generation" && onRegenerateTask)
		list.push({
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
			label: m.board_open_file({}, { locale }),
			icon: ExternalLink,
			run: () => {
				void onOpenFile(file.src);
			},
		});
	if (singleText)
		list.push({
			label: m.board_edit_text({}, { locale }),
			icon: Pencil,
			run: () => {
				editor.editingId = editor.selectedItems[0]?.id ?? null;
			},
		});
	if (hasSelection) {
		list.push(
			{
				label: m.board_duplicate({}, { locale }),
				icon: Copy,
				run: () => editor.duplicateSelection(),
			},
			{
				label: m.board_bring_front({}, { locale }),
				icon: ArrowUpToLine,
				run: () => editor.bringToFront(),
			},
			{
				label: m.board_send_back({}, { locale }),
				icon: ArrowDownToLine,
				run: () => editor.sendToBack(),
			},
			{
				label: m.board_delete({}, { locale }),
				icon: Trash2,
				danger: true,
				run: () => editor.deleteSelection(),
			},
		);
	}
	list.push(
		{
			label: m.board_select_all({}, { locale }),
			icon: BoxSelect,
			run: () => editor.selectAll(),
		},
		{
			label: m.board_zoom_fit({}, { locale }),
			icon: LocateFixed,
			run: () => editor.fitView(),
		},
	);
	if (onExport)
		list.push({
			label: hasSelection ? "Export selection…" : "Export image…",
			icon: ImageDown,
			run: onExport,
		});
	if (onAnimate)
		list.push({
			label: m.board_animate({}, { locale }),
			icon: Clapperboard,
			run: onAnimate,
		});
	if (onReplay)
		list.push({
			label: m.board_replay({}, { locale }),
			icon: History,
			run: onReplay,
		});
	return list;
});

function run(action: MenuAction) {
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
	class="board-context-menu"
	class:board-context-menu--sheet={sheet}
	style:left={sheet ? undefined : `${left}px`}
	style:top={sheet ? undefined : `${top}px`}
	role="menu"
	tabindex="-1"
	oncontextmenu={(event) => event.preventDefault()}
>
	{#each actions as action (action.label)}
		<button
			type="button"
			class="ctx-item"
			class:ctx-item--danger={action.danger}
			disabled={action.disabled}
			role="menuitem"
			onclick={() => run(action)}
		>
			<action.icon class="h-3.5 w-3.5" />
			<span>{action.label}</span>
		</button>
	{/each}
</div>

<style>
	.board-context-menu {
		position: fixed;
		z-index: 130;
		min-width: 168px;
		border-radius: 9px;
		border: 1px solid var(--border-subtle);
		background: var(--bg-elevated);
		padding: 4px;
		box-shadow: 0 12px 28px color-mix(in srgb, var(--overlay-scrim-strong) 18%, transparent);
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
	.ctx-item--danger:hover { background: var(--error-bg); color: var(--error-700); }
</style>
