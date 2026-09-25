<script lang="ts">
import type { SpacePublicEndpoints } from "@cohub/protocol/ports";
import { Files, Images, MessageSquare, PanelsTopLeft } from "lucide-svelte";
import FileUploadPane from "$lib/components/FileUploadPane.svelte";
import { provideFileTreeMarks } from "$lib/components/file-tree-marks";
import MobileRightDrawer from "$lib/components/MobileRightDrawer.svelte";
import SpaceFileSidebar from "$lib/components/SpaceFileSidebar.svelte";
import { createDeferredMount } from "$lib/deferred-mount.svelte";
import { pointerDrag } from "$lib/drag/pointer-drag.svelte";
import AppsSidebarPanel from "$lib/features/space/modules/AppsSidebarPanel.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { DURATION_PANEL } from "$lib/motion.svelte";
import { m } from "$lib/paraglide/messages.js";
import type { SpaceFsNode } from "$lib/space-fs";
import { uiState } from "$lib/stores/ui.svelte";
import type { LocalUploadEntry } from "$lib/upload-entries";
import MediaPanel from "./MediaPanel.svelte";
import SessionOutputsPanel from "./SessionOutputsPanel.svelte";
import {
	readSidePanelTab,
	type SidePanelTab,
	writeSidePanelTab,
} from "./side-panel-tabs";
import type { WorkspaceSidePanelController } from "./workspace-side-panel-controller.svelte";

type Props = {
	spaceId: string;
	sidePanel: WorkspaceSidePanelController;
	hasSession: boolean;
	canViewTasks: boolean;
	nodes: SpaceFsNode[];
	selectedPath: string;
	loading: boolean;
	error: string | null;
	subtitle: string;
	activePort: string | null;
	canWrite: boolean;
	showItemActions: boolean;
	draggable: boolean;
	previewEndpoints: SpacePublicEndpoints;
	desktopCollapsed: boolean;
	desktopFloating: boolean;
	desktopWidth: number;
	rightDragOffsetPx: number;
	rightIsDragging: boolean;
	isDrawerVisible: boolean;
	uploadPaneVisible: boolean;
	uploadPaneTargetDir: string;
	pendingUploadFiles: File[];
	pendingUploadEntries: LocalUploadEntry[];
	onToggle: (node: SpaceFsNode) => void | Promise<void>;
	onOpenPath: (path: string, options: { mobile: boolean }) => void;
	onRevealPath: (
		path: string,
		options: { mobile: boolean },
	) => void | Promise<void>;
	onOpenTask: (taskRunId: string, options: { mobile: boolean }) => void;
	onJumpToTurn?: (sequence: number, options: { mobile: boolean }) => void;
	onOpenTaskBrowser?: () => void;
	onRefresh: () => void | Promise<void>;
	onCreateFile: (parentPath: string) => void | Promise<void>;
	onCreateBoard: (parentPath: string) => void | Promise<void>;
	onCreateDir: (parentPath: string) => void | Promise<void>;
	onRename: (node: SpaceFsNode) => void | Promise<void>;
	onMove?: (node: SpaceFsNode, targetDir: string) => void | Promise<void>;
	onDelete: (node: SpaceFsNode) => void | Promise<void>;
	onDownload: (node: SpaceFsNode) => void | Promise<void>;
	onUpload: (files: File[] | LocalUploadEntry[], targetDir: string) => void;
	onInsertReference: (path: string) => void;
	onPublishDirectory: (path: string, options: { mobile: boolean }) => void;
	onOpenWith: (node: SpaceFsNode, options: { mobile: boolean }) => void;
	onOpenPort: (port: string, url: string, options: { mobile: boolean }) => void;
	onUploadPaneClose: () => void;
	onUploadComplete: () => void | Promise<void>;
	onResizeStart: (event: PointerEvent) => void;
	onOpenMarketplace: () => void;
	onOpenInstalledApp: (app: import("@cohub/protocol").InstalledApp) => void;
};

let {
	spaceId,
	sidePanel,
	hasSession,
	canViewTasks,
	nodes,
	selectedPath,
	loading,
	error,
	subtitle,
	activePort,
	canWrite,
	showItemActions,
	draggable,
	previewEndpoints,
	desktopCollapsed,
	desktopFloating,
	desktopWidth,
	rightDragOffsetPx,
	rightIsDragging,
	isDrawerVisible,
	uploadPaneVisible,
	uploadPaneTargetDir,
	pendingUploadFiles,
	pendingUploadEntries,
	onToggle,
	onOpenPath,
	onRevealPath,
	onOpenTask,
	onJumpToTurn = undefined,
	onOpenTaskBrowser = undefined,
	onRefresh,
	onCreateFile,
	onCreateBoard,
	onCreateDir,
	onRename,
	onMove = undefined,
	onDelete,
	onDownload,
	onUpload,
	onInsertReference,
	onPublishDirectory,
	onOpenWith,
	onOpenPort,
	onUploadPaneClose,
	onUploadComplete,
	onResizeStart,
	onOpenMarketplace,
	onOpenInstalledApp,
}: Props = $props();

type TabDefinition = { id: SidePanelTab; label: string; icon: typeof Files };

const locale = $derived(getLocale());
const tabs = $derived<TabDefinition[]>([
	{
		id: "session",
		label: m.side_panel_tab_session({}, { locale }),
		icon: MessageSquare,
	},
	{ id: "files", label: m.files_title({}, { locale }), icon: Files },
	...(canViewTasks
		? [
				{
					id: "media" as const,
					label: m.side_panel_tab_media({}, { locale }),
					icon: Images,
				},
			]
		: []),
	{ id: "apps", label: m.sidebar_apps({}, { locale }), icon: PanelsTopLeft },
]);

let preferredTab = $state<SidePanelTab>(readSidePanelTab());
const activeTab = $derived(
	tabs.some((tab) => tab.id === preferredTab) ? preferredTab : "session",
);

function selectTab(tab: SidePanelTab) {
	preferredTab = tab;
	writeSidePanelTab(tab);
}

async function revealPath(path: string, mobile: boolean) {
	selectTab("files");
	await onRevealPath(path, { mobile });
}

provideFileTreeMarks(() => {
	const paths = sidePanel.sessionFiles?.markedPaths;
	return paths?.size
		? { paths, label: m.session_file_marked({}, { locale }) }
		: null;
});

// Stay mounted through the collapse tween; floating mode has none.
const panelMount = createDeferredMount(
	() => !desktopCollapsed,
	() => (desktopFloating ? 0 : DURATION_PANEL),
);
const desktopMounted = $derived(panelMount.mounted);
const desktopShellWidth = $derived(desktopCollapsed ? 0 : desktopWidth);

// The drawer owns its visibility; mirror the drag retract signal onto it.
$effect(() => {
	uiState.mobileRightDrawerRetracted = pointerDrag.retracted;
});

// A drop outside the retracted drawer (onto a board) closes it.
let handledCommit = $state(0);
$effect(() => {
	const version = pointerDrag.commitVersion;
	if (version === handledCommit) return;
	handledCommit = version;
	if (pointerDrag.committedOutsideSurface) {
		uiState.mobileRightDrawerOpen = false;
	}
});
</script>

{#snippet tabBar(mobile: boolean)}
	<div
		class="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border-subtle px-2 [scrollbar-width:none] {mobile ? 'bg-bg-primary' : ''}"
		role="tablist"
		aria-label={m.side_panel_label({}, { locale })}
	>
		{#each tabs as tab (tab.id)}
			{@const selected = activeTab === tab.id}
			{#if tab.id === "files"}
				<span class="mx-1 h-3.5 w-px shrink-0 bg-border-subtle" aria-hidden="true"></span>
			{/if}
			<button
				type="button"
				role="tab"
				aria-selected={selected}
				class="relative inline-flex shrink-0 items-center gap-1.5 rounded-[5px] px-2 text-[11px] font-medium transition-colors {mobile ? 'h-8' : 'h-7'} {selected ? 'bg-bg-elevated text-text-primary' : 'text-text-tertiary hover:text-text-secondary'}"
				onclick={() => selectTab(tab.id)}
			>
				<tab.icon class="h-3.5 w-3.5" />
				{tab.label}
				{#if tab.id === "session" && sidePanel.sessionBusy}
					<span
						class="h-1.5 w-1.5 rounded-full bg-brand"
						role="img"
						aria-label={m.side_panel_session_busy({}, { locale })}
						title={m.side_panel_session_busy({}, { locale })}
					></span>
				{/if}
			</button>
		{/each}
	</div>
{/snippet}

{#snippet panelBody(mobile: boolean)}
	{#if activeTab === "session"}
		<SessionOutputsPanel
			{hasSession}
			generations={sidePanel.sessionGenerations}
			files={sidePanel.sessionFiles}
			draggable={draggable && !mobile}
			touchDraggable={draggable}
			onOpenTask={(id) => onOpenTask(id, { mobile })}
			onOpenFile={(path) => onOpenPath(path, { mobile })}
			onShowInFiles={(path) => void revealPath(path, mobile)}
			onInsertReference={canWrite ? onInsertReference : undefined}
			onJumpToTurn={onJumpToTurn
				? (sequence) => onJumpToTurn(sequence, { mobile })
				: undefined}
		/>
	{:else if activeTab === "media"}
		<MediaPanel
			feed={sidePanel.spaceGenerations}
			draggable={draggable && !mobile}
			onVisible={sidePanel.requestSpaceMedia}
			onOpenTask={(id) => onOpenTask(id, { mobile })}
			{onOpenTaskBrowser}
		/>
	{:else if activeTab === "apps"}
		<AppsSidebarPanel {spaceId} {canWrite} {onOpenMarketplace} onOpenInstalled={onOpenInstalledApp} />
	{/if}
	<div class="h-full min-h-0" hidden={activeTab !== "files"}>
		<SpaceFileSidebar
			{nodes}
			{selectedPath}
			{loading}
			{error}
			{subtitle}
			{onToggle}
			onSelect={(node) => {
				if (node.type === "file") onOpenPath(node.path, { mobile });
			}}
			{onRefresh}
			{onCreateFile}
			{onCreateBoard}
			{onCreateDir}
			{onRename}
			{onMove}
			{onDelete}
			{onDownload}
			{onUpload}
			{onInsertReference}
			onPublishDirectory={(path) => onPublishDirectory(path, { mobile })}
			onOpenWith={(node) => onOpenWith(node, { mobile })}
			onOpenPort={(port, url) => onOpenPort(port, url, { mobile })}
			{activePort}
			draggable={draggable && !mobile}
			touchDraggable={draggable}
			showItemActions={showItemActions && !mobile}
			{canWrite}
			{previewEndpoints}
		/>
		<FileUploadPane
			{spaceId}
			targetDir={uploadPaneTargetDir}
			files={pendingUploadFiles}
			entries={pendingUploadEntries}
			open={uploadPaneVisible}
			onClose={onUploadPaneClose}
			onComplete={onUploadComplete}
		/>
	</div>
{/snippet}

<div
	class="panel-shell side-panel-shell hidden lg:flex border-l border-border-subtle"
	class:panel-shell--collapsed={desktopCollapsed}
	class:side-panel-shell--floating={desktopFloating}
	style={`width: ${desktopShellWidth}px; --side-panel-width: ${desktopWidth}px`}
	aria-hidden={desktopCollapsed}
	inert={desktopCollapsed ? true : undefined}
>
	{#if desktopMounted}
		<div class="panel-shell-inner relative flex flex-col" style={`width: ${desktopWidth}px`}>
			{@render tabBar(false)}
			<div class="panel-shell-fade relative min-h-0 flex-1">
				{@render panelBody(false)}
			</div>
			{#if !desktopCollapsed}
				<button
					type="button"
					class="right-sidebar-resize-handle"
					aria-label={m.side_panel_resize({}, { locale })}
					title={m.side_panel_resize({}, { locale })}
					onpointerdown={onResizeStart}
				></button>
			{/if}
		</div>
	{/if}
</div>

<MobileRightDrawer
	dragOffsetPx={rightDragOffsetPx}
	isDragging={rightIsDragging}
	{isDrawerVisible}
>
	<!-- Retract surface: dragging an item out of here slides the drawer away
	     so the board behind it can receive the drop. -->
	<div class="flex h-full min-h-0 flex-col" data-pointer-drag-surface>
		{@render tabBar(true)}
		<div class="relative min-h-0 flex-1">
			{@render panelBody(true)}
		</div>
	</div>
</MobileRightDrawer>

<style>
	@media (min-width: 960px) {
		.side-panel-shell--floating {
			position: absolute;
			top: 10px;
			right: 10px;
			bottom: 10px;
			z-index: 30;
			width: var(--side-panel-width);
			overflow: hidden;
			border: 1px solid var(--border-subtle);
			border-radius: 10px;
			background: var(--bg-elevated);
			box-shadow: 0 10px 26px
				color-mix(in srgb, var(--overlay-scrim-strong) 14%, transparent);
			/* Floating mode is a free card, not a flex clip target. */
			transition: none;
			pointer-events: auto;
			opacity: 1;
		}

		.side-panel-shell--floating.panel-shell--collapsed {
			/* When immersive + panel collapsed, hide the floating card. */
			width: 0;
			pointer-events: none;
			opacity: 0;
		}
	}
</style>
