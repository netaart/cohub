<script lang="ts">
import {
	AppWindow,
	ChevronDown,
	Download,
	File as FileIcon,
	Loader2,
	MoreHorizontal,
	Pencil,
	Rocket,
	TextCursorInput,
	Trash2,
	Upload,
} from "lucide-svelte";
import FsTreeItem from "$lib/components/FsTreeItem.svelte";
import { useFileTreeMarks } from "$lib/components/file-tree-marks";
import {
	COHUB_PATH_MIME,
	getCohubResourceDragData,
	hasCohubResourceDragData,
	setCohubResourceDragData,
} from "$lib/drag/cohub-resource-drag";
import type { PointerDragPayload } from "$lib/drag/pointer-drag.svelte";
import {
	pointerDrag,
	pointerDragSource,
	pointerDropZone,
} from "$lib/drag/pointer-drag.svelte";
import { resolveFsMoveDestination } from "$lib/features/space/modules/file-workspace-utils";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import type { SpaceFsNode } from "$lib/space-fs";
import {
	entriesFromDataTransfer,
	entriesFromFiles,
	type LocalUploadEntry,
} from "$lib/upload-entries";

const {
	node,
	depth,
	selectedPath,
	onToggle,
	onSelect,
	onCreateFile,
	onCreateBoard,
	onCreateDir,
	onRename,
	onMove,
	onDelete,
	onDownload,
	onUpload,
	onInsertReference,
	onPublishDirectory,
	onOpenWith,
	draggable = true,
	touchDraggable = false,
	showItemActions = true,
	canWrite = true,
}: {
	node: SpaceFsNode;
	depth: number;
	selectedPath: string;
	onToggle: (node: SpaceFsNode) => void;
	onSelect: (node: SpaceFsNode) => void;
	onCreateFile: (parentPath: string) => void;
	onCreateBoard?: (parentPath: string) => void;
	onCreateDir: (parentPath: string) => void;
	onRename: (node: SpaceFsNode) => void;
	onMove?: (node: SpaceFsNode, targetDir: string) => void;
	onDelete: (node: SpaceFsNode) => void;
	onDownload?: (node: SpaceFsNode) => void;
	onUpload?: (files: File[] | LocalUploadEntry[], targetDir: string) => void;
	onInsertReference?: (path: string) => void;
	onPublishDirectory?: (path: string) => void;
	onOpenWith?: (node: SpaceFsNode) => void;
	draggable?: boolean;
	/** Enable the long-press drag gesture for touch and pen. */
	touchDraggable?: boolean;
	showItemActions?: boolean;
	canWrite?: boolean;
} = $props();

const locale = $derived(getLocale());
const fileTreeMarks = useFileTreeMarks();
const indent = $derived(6 + depth * 14);
const markLabel = $derived.by(() => {
	const marks = fileTreeMarks();
	return marks?.paths.has(node.path) ? marks.label : null;
});
const isActive = $derived(selectedPath === node.path);
const isDir = $derived(node.type === "dir");
let isDragOver = $state(false);
let isMoveTarget = $state(false);
let rowEl: HTMLDivElement | null = $state(null);

/** The row is the drop target of the current touch drag. */
const isPointerDropTarget = $derived(pointerDrag.isTarget(rowEl));
/** The row is the source being held, so it recedes while the ghost leads. */
const isPointerDragSource = $derived(
	pointerDrag.active &&
		pointerDrag.payload?.items.some((item) => item.path === node.path) === true,
);

function buildPointerDragPayload(): PointerDragPayload | null {
	if (!touchDraggable) return null;
	return {
		origin: "space-file-tree",
		items: [
			{
				type: node.type === "dir" ? "dir" : "file",
				path: node.path,
				name: node.name,
				mimeType: node.mimeType,
				size: node.size,
				mtimeMs: node.mtimeMs,
			},
		],
	};
}

/**
 * Move a dragged tree node into this directory.
 *
 * Shared by the native drop and the touch drop so both paths apply the same
 * validation (no move into self or a descendant, no same-parent no-op).
 */
function moveIntoThisDir(dragged: {
	path: string;
	type: SpaceFsNode["type"];
}): boolean {
	if (!canWrite || !onMove) return false;
	const destination = resolveFsMoveDestination(dragged.path, node.path);
	if (!destination) return false;
	onMove(
		{
			name: destination.name,
			path: destination.fromPath,
			type: dragged.type,
			size: 0,
			mimeType: null,
			mtimeMs: Date.now(),
			children: [],
			isOpen: false,
			isLoaded: false,
			isLoading: false,
		},
		node.path,
	);
	return true;
}

// Inline dropdown state
let menuOpen = $state(false);
let menuEl: HTMLDivElement | null = $state(null);

function openMenu() {
	menuOpen = true;
}

function closeMenu() {
	menuOpen = false;
}

function stop(handler: () => void) {
	return (e: MouseEvent) => {
		e.stopPropagation();
		handler();
	};
}

function stopAndCloseMenu(handler: () => void) {
	return (e: MouseEvent) => {
		e.stopPropagation();
		handler();
		menuOpen = false;
	};
}

function handleClick() {
	if (node.type === "dir") {
		onToggle(node);
	} else {
		onSelect(node);
	}
}

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Enter" || e.key === " ") {
		e.preventDefault();
		handleClick();
	}
}

function hasInternalTreeDrag(dataTransfer: DataTransfer | null) {
	// File-tree items always set the path MIME; other Cohub resources (sessions, labels)
	// must not light up folder move targets.
	return Boolean(dataTransfer?.types.includes(COHUB_PATH_MIME));
}

function resolveDraggedTreeNodeMeta(
	dataTransfer: DataTransfer | null,
): { path: string; type: SpaceFsNode["type"] } | null {
	if (!dataTransfer) return null;
	const rawPath = dataTransfer.getData(COHUB_PATH_MIME);
	if (rawPath) {
		const isDir = rawPath.endsWith("/");
		return {
			path: rawPath.replace(/\/$/, ""),
			type: isDir ? "dir" : "file",
		};
	}
	const payload = getCohubResourceDragData(dataTransfer);
	const resource = payload?.resources[0];
	if (
		payload?.origin?.kind === "space-file-tree" &&
		resource?.type === "file" &&
		resource.path
	) {
		return { path: resource.path, type: "file" };
	}
	return null;
}

function canAcceptExternalUpload(dataTransfer: DataTransfer | null) {
	return Boolean(isDir && onUpload && canWrite && dataTransfer);
}

function canAcceptInternalMove(dataTransfer: DataTransfer | null) {
	return Boolean(
		isDir && onMove && canWrite && hasInternalTreeDrag(dataTransfer),
	);
}

function handleDragOver(e: DragEvent) {
	if (!isDir) return;
	const internal = canAcceptInternalMove(e.dataTransfer);
	const external =
		canAcceptExternalUpload(e.dataTransfer) &&
		!hasInternalTreeDrag(e.dataTransfer);
	if (!internal && !external) return;
	e.preventDefault();
	e.stopPropagation();
	if (e.dataTransfer) e.dataTransfer.dropEffect = internal ? "move" : "copy";
	isDragOver = true;
	isMoveTarget = internal;
}

function handleDragLeave(e: DragEvent) {
	if (!isDir) return;
	const related = e.relatedTarget as Node | null;
	if (
		related &&
		e.currentTarget instanceof Node &&
		e.currentTarget.contains(related)
	) {
		return;
	}
	const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
	const x = e.clientX;
	const y = e.clientY;
	if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
		isDragOver = false;
		isMoveTarget = false;
	}
}

async function handleDrop(e: DragEvent) {
	if (!isDir) return;
	e.preventDefault();
	e.stopPropagation();
	isDragOver = false;
	isMoveTarget = false;
	if (!e.dataTransfer) return;

	if (hasInternalTreeDrag(e.dataTransfer)) {
		const dragged = resolveDraggedTreeNodeMeta(e.dataTransfer);
		if (dragged) moveIntoThisDir(dragged);
		return;
	}

	if (!onUpload || !canWrite) return;
	const entries = await entriesFromDataTransfer(e.dataTransfer);
	if (entries.length > 0) onUpload(entries, node.path);
}

function openUploadPicker(folder = false) {
	if (!onUpload) return;
	const input = document.createElement("input");
	input.type = "file";
	input.multiple = true;
	if (folder) input.setAttribute("webkitdirectory", "");
	input.onchange = () => {
		if (input.files?.length)
			onUpload(entriesFromFiles(Array.from(input.files)), node.path);
	};
	input.click();
}

function handleUploadClick() {
	openUploadPicker(false);
}

function handleFolderUploadClick() {
	openUploadPicker(true);
}

// Close menu on outside click
$effect(() => {
	if (!menuOpen) return;
	function onClick(e: MouseEvent) {
		if (menuEl && !menuEl.contains(e.target as Node)) {
			menuOpen = false;
		}
	}
	document.addEventListener("click", onClick, true);
	return () => document.removeEventListener("click", onClick, true);
});
</script>

<div
  bind:this={rowEl}
  class:selected={isActive}
  data-space-file-path={node.path}
  class="tree-item"
  class:menu-open={menuOpen}
  class:drop-target={isDragOver || isPointerDropTarget}
  class:move-target={isMoveTarget || isPointerDropTarget}
  class:drag-source={isPointerDragSource}
  role="button"
  tabindex="0"
  draggable={draggable}
  style={`padding-left: ${indent}px`}
  use:pointerDragSource={{
    enabled: touchDraggable,
    getPayload: buildPointerDragPayload,
  }}
  use:pointerDropZone={{
    priority: 2,
    resolve: (payload) => {
      if (!isDir || !canWrite || !onMove) return null;
      const [item] = payload.items;
      if (!item || payload.items.length !== 1) return null;
      if (!resolveFsMoveDestination(item.path, node.path)) return null;
      return { label: m.file_move_to({ name: node.name }, { locale }), effect: "move" };
    },
    drop: (payload) => {
      const [item] = payload.items;
      if (!item) return;
      moveIntoThisDir({ path: item.path, type: item.type === "dir" ? "dir" : "file" });
    },
  }}
  onclick={handleClick}
  onkeydown={handleKeydown}
  ondragstart={(e) => {
    if (!draggable) {
      e.preventDefault();
      return;
    }
    const path = node.type === "dir" ? `${node.path}/` : node.path;
    if (node.type === "file") {
      setCohubResourceDragData(
        e.dataTransfer,
        {
          version: 1,
          resources: [{
            type: "file",
            ref: node.path,
            title: node.name,
            path: node.path,
            mimeType: node.mimeType ?? undefined,
            size: node.size,
            mtimeMs: node.mtimeMs,
          }],
          origin: { kind: "space-file-tree" },
          createdAt: Date.now(),
        },
        { cohubPath: path, plainText: path, effectAllowed: "copyMove" },
      );
      return;
    }
    // Directories: path only (resource payload is file-scoped today).
    e.dataTransfer?.setData(COHUB_PATH_MIME, path);
    e.dataTransfer?.setData("text/plain", path);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
  }}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
>
  <span class="icon shrink-0" class:twisty={isDir}>
    {#if isDir}
      <ChevronDown class="h-3 w-3 transition-transform {node.isOpen ? '' : '-rotate-90'}" />
    {:else}
      <FileIcon class="w-3.5 h-3.5" />
    {/if}
  </span>
  <span class="name">{node.name}</span>
  {#if markLabel}
    <span class="tree-mark" role="img" aria-label={markLabel} title={markLabel}></span>
  {/if}
  {#if node.isLoading}
    <Loader2 class="h-3 w-3 shrink-0 animate-spin text-text-placeholder" aria-label={m.file_loading({}, { locale })} />
  {/if}

  {#if showItemActions && (canWrite || (!isDir && (onDownload || onOpenWith)))}
    <span class="actions">
      {#if canWrite && onInsertReference}
        <button type="button" class="action" title={m.file_insert({}, { locale })} onclick={stop(() => onInsertReference(node.path))}><TextCursorInput class="w-3.5 h-3.5" /></button>
      {/if}
      {#if canWrite}
        <button type="button" class="action" title={m.file_rename({}, { locale })} onclick={stop(() => onRename(node))}><Pencil class="w-3.5 h-3.5" /></button>
      {/if}
      {#if isDir}
        {#if onUpload}
          <button type="button" class="action" title={m.files_upload_files({}, { locale })} onclick={stop(handleUploadClick)}><Upload class="w-3.5 h-3.5" /></button>
        {/if}
        <span class="relative">
          <button type="button" class="action" title={m.file_more({}, { locale })} onclick={stop(openMenu)}>
            <MoreHorizontal class="w-3.5 h-3.5" />
          </button>
          {#if menuOpen}
            <div class="dropdown" bind:this={menuEl}>
              {#if onUpload}
                <button type="button" class="dropdown-item" onclick={stopAndCloseMenu(handleFolderUploadClick)}><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="M12 10V16"/><path d="m15 13-3-3-3 3"/></svg> {m.files_upload_folder({}, { locale })}</button>
              {/if}
              <div class="dropdown-sep"></div>
              <button type="button" class="dropdown-item" onclick={stopAndCloseMenu(() => onCreateFile(node.path))}>{m.files_new_file({}, { locale })}</button>
              {#if onCreateBoard}
                <button type="button" class="dropdown-item" onclick={stopAndCloseMenu(() => onCreateBoard(node.path))}>{m.files_new_board({}, { locale })}</button>
              {/if}
              <button type="button" class="dropdown-item" onclick={stopAndCloseMenu(() => onCreateDir(node.path))}>{m.files_new_folder({}, { locale })}</button>
              {#if onPublishDirectory}
                <div class="dropdown-sep"></div>
                <button type="button" class="dropdown-item" onclick={stopAndCloseMenu(() => onPublishDirectory(node.path))}><Rocket class="w-3.5 h-3.5" /> {m.file_publish({}, { locale })}</button>
              {/if}
              <div class="dropdown-sep"></div>
              <button type="button" class="dropdown-item danger" onclick={stopAndCloseMenu(() => onDelete(node))}>{m.file_delete({}, { locale })}</button>
            </div>
          {/if}
        </span>
      {:else}
        <span class="relative">
          <button type="button" class="action" title={m.file_more({}, { locale })} onclick={stop(openMenu)}>
            <MoreHorizontal class="w-3.5 h-3.5" />
          </button>
          {#if menuOpen}
            <div class="dropdown" bind:this={menuEl}>
              {#if onOpenWith}
                <button type="button" class="dropdown-item" onclick={stopAndCloseMenu(() => onOpenWith(node))}><AppWindow class="w-3.5 h-3.5" /> {m.file_open_with({}, { locale })}</button>
                <div class="dropdown-sep"></div>
              {/if}
              {#if onDownload}
                <button type="button" class="dropdown-item" onclick={stopAndCloseMenu(() => onDownload(node))}><Download class="w-3.5 h-3.5" /> {m.file_download({}, { locale })}</button>
                {#if canWrite}
                  <div class="dropdown-sep"></div>
                {/if}
              {/if}
              {#if canWrite}
                <button type="button" class="dropdown-item danger" onclick={stopAndCloseMenu(() => onDelete(node))}><Trash2 class="w-3.5 h-3.5" /> Delete</button>
              {/if}
            </div>
          {/if}
        </span>
      {/if}
    </span>
  {/if}
</div>

{#if isDir && node.isOpen && depth < 50}
  {#each node.children as child (child.path)}
    <FsTreeItem
      node={child}
      depth={depth + 1}
      {selectedPath}
      {onToggle}
      {onSelect}
      {onCreateFile}
      {onCreateBoard}
      {onCreateDir}
      {onRename}
      {onMove}
      {onDelete}
      {onDownload}
      {onUpload}
      {onInsertReference}
      {onPublishDirectory}
      {onOpenWith}
      {draggable}
      {touchDraggable}
      {showItemActions}
      {canWrite}
    />
  {/each}
{/if}

<style>
  .tree-item {
    position: relative;
    width: 100%;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    /* Horizontal right padding only; left indent is set inline for tree depth. */
    padding: 6px 6px 6px 0;
    border: none;
    background: transparent;
    color: var(--text-tertiary);
    border-radius: var(--sidebar-item-radius, 6px);
    cursor: pointer;
    transition:
      background-color 100ms ease,
      color 100ms ease;
  }

  .tree-item:hover {
    background: var(--sidebar-item-hover-bg, var(--bg-hover));
    color: var(--text-secondary);
  }

  .tree-item.selected {
    background: var(--sidebar-item-active-bg, var(--bg-active));
    color: var(--sidebar-item-active-fg, var(--text-primary));
    font-weight: 500;
  }

  .tree-item.selected .icon {
    color: var(--text-secondary);
  }

  .tree-item.menu-open {
    z-index: 20;
  }

  .tree-item.drop-target {
    background: var(--bg-hover-strong);
    outline: 1px dashed var(--brand);
    outline-offset: -1px;
  }

  .tree-item.move-target {
    background: color-mix(in srgb, var(--brand) 12%, var(--bg-hover-strong));
  }

  /* The held row recedes so the ghost card reads as the thing being moved. */
  .tree-item.drag-source {
    opacity: 0.4;
  }

  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    color: var(--text-tertiary);
  }

  .icon.twisty {
    color: var(--text-secondary);
  }

  .tree-item:hover .icon.twisty,
  .tree-item.selected .icon.twisty {
    color: var(--text-primary);
  }

  .name {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    line-height: 1.25;
  }

  .tree-item:hover:not(.menu-open) {
    z-index: 1;
  }

  .tree-item:hover,
  .tree-item:focus-within,
  .tree-item.selected {
    padding-right: 104px;
  }

  .tree-mark {
    width: 5px;
    height: 5px;
    flex-shrink: 0;
    margin-right: 4px;
    border-radius: 999px;
    background: var(--brand);
    opacity: 0.85;
  }

  /* Row actions overlay the trailing edge; they take precedence. */
  .tree-item:hover .tree-mark,
  .tree-item:focus-within .tree-mark,
  .tree-item.selected .tree-mark {
    visibility: hidden;
  }

  .actions {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    display: inline-flex;
    align-items: center;
    gap: 2px;
    opacity: 0;
    pointer-events: none;
    transition: opacity 100ms ease;
  }

  .tree-item:hover .actions,
  .tree-item:focus-within .actions,
  .tree-item.selected .actions {
    opacity: 1;
    pointer-events: auto;
  }

  .action {
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
  }

  .action:hover {
    background: var(--bg-hover-strong);
    color: var(--text-primary);
  }

  /* Inline dropdown */
  .relative { position: relative; }

  .dropdown {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    z-index: 30;
    min-width: 150px;
    padding: 4px;
    background: var(--bg-elevated);
    border: 1px solid var(--border-primary);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  }

  .dropdown-item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
    text-align: left;
  }

  .dropdown-item:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .dropdown-item.danger:hover {
    color: var(--error-soft);
    background: var(--error-bg);
  }

  .dropdown-sep {
    height: 1px;
    margin: 4px 6px;
    background: var(--border-subtle);
  }
</style>
