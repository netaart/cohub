<script lang="ts">
import type { SpacePublicEndpoints } from "@cohub/protocol/ports";
import {
	AlertCircle,
	Loader2,
	Lock,
	Plus,
	RefreshCw,
	Upload,
} from "lucide-svelte";
import { tick } from "svelte";
import { floatNear } from "$lib/actions/portal";
import ColumnHeader from "$lib/components/ColumnHeader.svelte";
import FsTreeItem from "$lib/components/FsTreeItem.svelte";
import SpacePreviewPorts from "$lib/components/SpacePreviewPorts.svelte";
import {
	COHUB_PATH_MIME,
	getCohubResourceDragData,
	hasCohubResourceDragData,
} from "$lib/drag/cohub-resource-drag";
import { pointerDrag, pointerDropZone } from "$lib/drag/pointer-drag.svelte";
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
	nodes,
	selectedPath,
	loading,
	error,
	onToggle,
	onSelect,
	onRefresh,
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
	onOpenPort,
	activePort = null,
	draggable = true,
	touchDraggable = false,
	showItemActions = true,
	canWrite = true,
	previewEndpoints = {},
	title = "",
	subtitle = "",
}: {
	nodes: SpaceFsNode[];
	selectedPath: string;
	loading: boolean;
	error: string | null;
	onToggle: (node: SpaceFsNode) => void;
	onSelect: (node: SpaceFsNode) => void;
	onRefresh: () => void;
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
	onOpenPort?: (port: string, url: string) => void;
	activePort?: string | null;
	draggable?: boolean;
	/** Enable the long-press drag gesture for touch and pen. */
	touchDraggable?: boolean;
	showItemActions?: boolean;
	canWrite?: boolean;
	previewEndpoints?: SpacePublicEndpoints;
	title?: string;
	subtitle?: string;
} = $props();

const locale = $derived(getLocale());
const resolvedTitle = $derived(title || m.files_title({}, { locale }));
const resolvedSubtitle = $derived(subtitle || m.files_subtitle({}, { locale }));

let treeScrollContainer: HTMLDivElement | null = $state(null);
let rootDragOver = $state(false);
let rootMoveDragOver = $state(false);

/** The tree background is the drop target of the current touch drag. */
const isPointerRootTarget = $derived(pointerDrag.isTarget(treeScrollContainer));

/** Move a dragged node to the tree root; shared by native and touch drops. */
function moveToRoot(dragged: {
	path: string;
	type: SpaceFsNode["type"];
}): boolean {
	if (!canWrite || !onMove) return false;
	const destination = resolveFsMoveDestination(dragged.path, "");
	if (!destination) return false;
	const node = findNodeByPath(dragged.path);
	onMove(
		node ?? {
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
		"",
	);
	return true;
}

// Dropdown state
let newMenuOpen = $state(false);
let uploadMenuOpen = $state(false);
let newMenuAnchorEl: HTMLElement | null = $state(null);
let uploadMenuAnchorEl: HTMLElement | null = $state(null);
let newMenuEl: HTMLDivElement | null = $state(null);
let uploadMenuEl: HTMLDivElement | null = $state(null);

function closeMenus() {
	newMenuOpen = false;
	uploadMenuOpen = false;
}

function toggleNewMenu() {
	newMenuOpen = !newMenuOpen;
	uploadMenuOpen = false;
}

function toggleUploadMenu() {
	uploadMenuOpen = !uploadMenuOpen;
	newMenuOpen = false;
}

function handleCreateFileAtRoot() {
	closeMenus();
	onCreateFile("");
}

function handleCreateDirAtRoot() {
	closeMenus();
	onCreateDir("");
}

function handleCreateBoardAtRoot() {
	closeMenus();
	onCreateBoard?.("");
}

function openUploadPicker(folder = false) {
	closeMenus();
	const input = document.createElement("input");
	input.type = "file";
	input.multiple = true;
	if (folder) input.setAttribute("webkitdirectory", "");
	input.onchange = () => {
		if (input.files?.length && onUpload) {
			onUpload(entriesFromFiles(Array.from(input.files)), "");
		}
	};
	input.click();
}

function handleUploadClick() {
	openUploadPicker(false);
}

function handleFolderUploadClick() {
	openUploadPicker(true);
}

function hasInternalTreeDrag(dataTransfer: DataTransfer | null) {
	// File-tree items always set the path MIME; other Cohub resources (sessions, labels)
	// must not light up folder move targets.
	return Boolean(dataTransfer?.types.includes(COHUB_PATH_MIME));
}

function findNodeByPath(
	path: string,
	list: SpaceFsNode[] = nodes,
): SpaceFsNode | null {
	for (const node of list) {
		if (node.path === path) return node;
		const child = findNodeByPath(path, node.children);
		if (child) return child;
	}
	return null;
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

function canAcceptRootDrop(dataTransfer: DataTransfer | null) {
	if (!dataTransfer) return false;
	if (hasInternalTreeDrag(dataTransfer)) {
		return Boolean(canWrite && onMove);
	}
	return Boolean(onUpload && canWrite);
}

function handleRootDragOver(e: DragEvent) {
	if (!canAcceptRootDrop(e.dataTransfer)) return;
	e.preventDefault();
	e.stopPropagation();
	const internal = hasInternalTreeDrag(e.dataTransfer);
	if (e.dataTransfer) {
		e.dataTransfer.dropEffect = internal ? "move" : "copy";
	}
	if (internal) {
		rootMoveDragOver = true;
		rootDragOver = false;
	} else {
		rootDragOver = true;
		rootMoveDragOver = false;
	}
}

function handleRootDragLeave(e: DragEvent) {
	const related = e.relatedTarget as Node | null;
	if (
		related &&
		e.currentTarget instanceof Node &&
		e.currentTarget.contains(related)
	) {
		return;
	}
	rootDragOver = false;
	rootMoveDragOver = false;
}

async function handleRootDrop(e: DragEvent) {
	e.preventDefault();
	e.stopPropagation();
	rootDragOver = false;
	rootMoveDragOver = false;
	if (!e.dataTransfer) return;

	if (hasInternalTreeDrag(e.dataTransfer)) {
		const dragged = resolveDraggedTreeNodeMeta(e.dataTransfer);
		if (dragged) moveToRoot(dragged);
		return;
	}

	if (!onUpload || !canWrite) return;
	const entries = await entriesFromDataTransfer(e.dataTransfer);
	if (entries.length > 0) onUpload(entries, "");
}

$effect(() => {
	const path = selectedPath;
	const container = treeScrollContainer;
	if (!path || !container || container.clientHeight === 0) return;

	void tick().then(() => {
		if (selectedPath !== path || !treeScrollContainer) return;
		const selectedItem = treeScrollContainer.querySelector<HTMLElement>(
			`[data-space-file-path="${CSS.escape(path)}"]`,
		);
		selectedItem?.scrollIntoView({
			block: "center",
			inline: "nearest",
			behavior: "smooth",
		});
	});
});

// Close menus on outside click
$effect(() => {
	if (!newMenuOpen && !uploadMenuOpen) return;
	function onClick(e: MouseEvent) {
		if (newMenuEl?.contains(e.target as Node)) return;
		if (uploadMenuEl?.contains(e.target as Node)) return;
		closeMenus();
	}
	document.addEventListener("click", onClick, true);
	return () => document.removeEventListener("click", onClick, true);
});
</script>

<div class="flex h-full flex-col bg-bg-primary min-w-0 relative">
  <ColumnHeader class="files-column-header">
    {#snippet left()}
      <div class="min-w-0">
        <div class="truncate text-[13px] font-medium text-text-secondary">{resolvedTitle}</div>
        {#if subtitle}
          <div class="truncate text-[11px] text-text-tertiary">{resolvedSubtitle}</div>
        {/if}
      </div>
    {/snippet}
    {#snippet right()}
      <div class="flex items-center gap-0.5 [&_button]:cursor-pointer">
        {#if canWrite}
          <div class="relative" bind:this={newMenuAnchorEl}>
            <button
              class="icon-btn"
              type="button"
              onclick={(e) => {
                newMenuAnchorEl = e.currentTarget;
                toggleNewMenu();
              }}
              aria-expanded={newMenuOpen}
            >
              <Plus class="w-4 h-4" />
              <span class="sr-only">{m.files_new({}, { locale })}</span>
            </button>
            {#if newMenuOpen && newMenuAnchorEl}
              <div
                class="dropdown"
                bind:this={newMenuEl}
                use:floatNear={{
                  getAnchor: () => newMenuAnchorEl,
                  placement: "bottom-end",
                  gap: 6,
                  width: 160,
                  zIndex: 120,
                }}
              >
                <button type="button" class="dropdown-item" onclick={handleCreateFileAtRoot}>
                  <Plus class="w-3.5 h-3.5" />
                  {m.files_new_file({}, { locale })}
                </button>
                {#if onCreateBoard}
                  <button type="button" class="dropdown-item" onclick={handleCreateBoardAtRoot}>
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="M8 9h8"/><path d="M8 13h5"/></svg>
                    {m.files_new_board({}, { locale })}
                  </button>
                {/if}
                <button type="button" class="dropdown-item" onclick={handleCreateDirAtRoot}>
                  <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="M12 10v6"/><path d="M9 13h6"/></svg>
                  {m.files_new_folder({}, { locale })}
                </button>
              </div>
            {/if}
          </div>
          {#if onUpload}
            <div class="relative" bind:this={uploadMenuAnchorEl}>
              <button
                class="icon-btn"
                type="button"
                onclick={(e) => {
                  uploadMenuAnchorEl = e.currentTarget;
                  toggleUploadMenu();
                }}
                aria-expanded={uploadMenuOpen}
              >
                <Upload class="w-4 h-4" />
                <span class="sr-only">{m.files_upload({}, { locale })}</span>
              </button>
              {#if uploadMenuOpen && uploadMenuAnchorEl}
                <div
                  class="dropdown"
                  bind:this={uploadMenuEl}
                  use:floatNear={{
                    getAnchor: () => uploadMenuAnchorEl,
                    placement: "bottom-end",
                    gap: 6,
                    width: 160,
                    zIndex: 120,
                  }}
                >
                  <button type="button" class="dropdown-item" onclick={handleUploadClick}>
                    <Upload class="w-3.5 h-3.5" />
                    {m.files_upload_files({}, { locale })}
                  </button>
                  <button type="button" class="dropdown-item" onclick={handleFolderUploadClick}>
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="M12 10V16"/><path d="m15 13-3-3-3 3"/></svg>
                    {m.files_upload_folder({}, { locale })}
                  </button>
                </div>
              {/if}
            </div>
          {/if}
        {:else}
          <div class="w-8 h-8 flex items-center justify-center text-text-tertiary" title={m.files_read_only({}, { locale })}>
            <Lock class="w-4 h-4" />
          </div>
        {/if}
        <button class="icon-btn" type="button" title={m.files_refresh({}, { locale })} onclick={onRefresh}>
          <RefreshCw class="w-4 h-4 {loading ? 'animate-spin' : ''}" />
        </button>
      </div>
    {/snippet}
  </ColumnHeader>

  <SpacePreviewPorts endpoints={previewEndpoints} {activePort} onOpen={onOpenPort} />

  {#if error}
    <div class="mx-1.5 mt-2 flex items-start gap-2 rounded-md border border-error-soft/30 bg-error-bg p-2 text-[12px] text-error-soft">
      <AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{error}</span>
    </div>
  {/if}

  <div
    class="min-h-0 flex-1 overflow-auto px-1.5 pb-2 pt-1"
    class:root-drop-target={rootDragOver}
    class:root-move-target={rootMoveDragOver || isPointerRootTarget}
    bind:this={treeScrollContainer}
    role="tree"
    tabindex="0"
    data-pointer-drag-autoscroll
    use:pointerDropZone={{
      priority: 1,
      resolve: (payload) => {
        if (!canWrite || !onMove) return null;
        const [item] = payload.items;
        if (!item || payload.items.length !== 1) return null;
        if (!resolveFsMoveDestination(item.path, "")) return null;
        return { label: m.files_move_to_root({}, { locale }), effect: "move" };
      },
      drop: (payload) => {
        const [item] = payload.items;
        if (!item) return;
        moveToRoot({ path: item.path, type: item.type === "dir" ? "dir" : "file" });
      },
    }}
    ondragover={handleRootDragOver}
    ondragleave={handleRootDragLeave}
    ondrop={handleRootDrop}
  >
    {#if nodes.length === 0 && loading}
      <div class="flex min-h-8 items-center gap-2 rounded-[var(--sidebar-item-radius)] px-1.5 py-2 text-[12px] text-text-placeholder">
        <Loader2 class="h-3 w-3 animate-spin text-text-tertiary" />
        <span>{m.files_loading({}, { locale })}</span>
      </div>
    {:else if nodes.length === 0}
      <div class="flex min-h-8 items-center rounded-[var(--sidebar-item-radius)] px-1.5 py-2 text-[12px] text-text-placeholder">{m.files_empty({}, { locale })}</div>
    {:else}
      <div class="space-y-[1px]">
        {#each nodes as node (node.path)}
          <FsTreeItem
            {node}
            depth={0}
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
      </div>
    {/if}
  </div>
</div>

<style>
  .relative { position: relative; }

  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
  }

  .icon-btn:hover { background: var(--bg-hover); color: var(--text-secondary); }

  .dropdown {
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
    padding: 7px 10px;
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

  .root-drop-target {
    outline: 1px solid color-mix(in srgb, var(--brand) 60%, transparent);
    outline-offset: -2px;
  }

  .root-move-target {
    outline: 1px dashed var(--brand);
    outline-offset: -2px;
    background: color-mix(in srgb, var(--bg-hover-strong) 70%, transparent);
  }
</style>
