<script lang="ts">
import {
	parseBoardDocument,
	screenToWorld,
	shapeCapabilities,
	taskRunToBoardTaskSnapshot as taskBoardSnapshot,
	worldPoint,
} from "@neta-art/cohub/board";
import { onDestroy, onMount, untrack } from "svelte";
import { createBoardAssetManager } from "$lib/board/board-asset-manager";
import { createSpaceBoardAssetSource } from "$lib/board/board-asset-source";
import {
	type BoardAwarenessController,
	boardAwarenessViewportFromCamera,
	createBoardAwarenessController,
} from "$lib/board/board-awareness";
import {
	generationPromptFromContent,
	pendingGenerationTaskSnapshot,
	regeneratedTaskPosition,
	regenerationRequestFromTaskRun,
} from "$lib/board/board-generation";
import type { BoardStageExportBridge } from "$lib/board/board-image-export";
import { playableBoardMedia } from "$lib/board/board-media-playback";
import type { BoardBackgroundLoadState } from "$lib/board/board-theme";
import { defaultBoardTool } from "$lib/board/board-tool";
import {
	type BoardViewPreference,
	boardViewPreferenceFromCamera,
	cameraFromBoardViewPreference,
	readBoardViewPreference,
	writeBoardViewPreference,
} from "$lib/board/board-view-preferences";
import { createBoardEditor } from "$lib/board/editor.svelte";
import type { BoardPlaybackCommand, BoardPlaybackSnapshot } from "@cohub/protocol";
import { nextLocalPlayback } from "$lib/board/runtime/board-player";
import type { BoardRuntimeProps } from "$lib/board/runtime/board-runtime";
import { canUseUserScopedCache, getCacheUserKey } from "$lib/cache/keys";
import BoardAppearancePopover from "$lib/components/board/BoardAppearancePopover.svelte";
import BoardAppOverlay from "$lib/components/board/BoardAppOverlay.svelte";
import BoardCollaboratorOverlay from "$lib/components/board/BoardCollaboratorOverlay.svelte";
import BoardArrowToolbar from "$lib/components/board/BoardArrowToolbar.svelte";
import BoardContextMenu from "$lib/components/board/BoardContextMenu.svelte";
import BoardEmptyState from "$lib/components/board/BoardEmptyState.svelte";
import BoardExportDialog from "$lib/components/board/BoardExportDialog.svelte";
import BoardFloatingToolbar from "$lib/components/board/BoardFloatingToolbar.svelte";
import BoardGenerationComposer from "$lib/components/board/BoardGenerationComposer.svelte";
import BoardMediaPlayer from "$lib/components/board/BoardMediaPlayer.svelte";
import BoardSelectionToolbar from "$lib/components/board/BoardSelectionToolbar.svelte";
import BoardStage from "$lib/components/board/BoardStage.svelte";
import BoardTextEditor from "$lib/components/board/BoardTextEditor.svelte";
import BoardTimeline from "$lib/components/board/BoardTimeline.svelte";
import BoardZoomMenu from "$lib/components/board/BoardZoomMenu.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { watchGenerationTask } from "$lib/stores/generation-task-watch";
import {
	getCachedTaskRuns,
	onTaskRunsCacheUpdated,
} from "$lib/stores/task-runs-cache";

const {
	path,
	boardId,
	document: initialDocument,
	playback = null,
	spaceId,
	shell,
	onNavigationOpen,
	mode = "edit",
	assetSource,
	active = true,
	immersive = false,
	syncError = null,
	isMobile = false,
	collaborators = new Map(),
	activities = [],
	onOpenActivity,
	onCommit,
	onPlayback,
	onRetrySync,
	onViewStateChange,
	onOpenFile,
	onOpenTask,
}: BoardRuntimeProps & {
	onOpenTask?: (taskRunId: string) => void;
} = $props();

const locale = $derived(getLocale());

const readonly = $derived(mode === "view");
const resolvedAssetSource = $derived(
	assetSource ?? createSpaceBoardAssetSource(spaceId),
);

const assets = createBoardAssetManager({
	spaceId: untrack(() => spaceId),
	loadVideoPreviews:
		typeof navigator === "undefined" ||
		!(navigator as Navigator & { connection?: { saveData?: boolean } })
			.connection?.saveData,
	resolveSpaceFileUrl: (_spaceId, path) =>
		untrack(() => resolvedAssetSource).resolveFileUrl(path),
});

let stageWrap: HTMLDivElement | null = $state(null);
let contextMenu = $state<{ x: number; y: number } | null>(null);
let exportBridge = $state<BoardStageExportBridge | null>(null);
let exportOpen = $state(false);
let generationOpen = $state(false);
let appearanceOpen = $state(false);
let replayOpen = $state(false);
let timelineOpen = $state(false);
let localPlayback = $state<BoardPlaybackSnapshot | null>(null);
const activePlayback = $derived(onPlayback ? playback : localPlayback);

function sendPlayback(command: BoardPlaybackCommand) {
	if (onPlayback) return onPlayback(command);
	localPlayback = nextLocalPlayback(localPlayback, command, editor.document);
}
let liveVersion = $state(0);
let backgroundLoadState = $state<BoardBackgroundLoadState | null>(null);
let generationSelectionRequest = $state(0);
let playingId = $state<string | null>(null);
let regeneratingItemId = $state<string | null>(null);
let regenerationError = $state<string | null>(null);
let regenerationErrorTimer: ReturnType<typeof setTimeout> | null = null;
let awarenessVersion = $state(0);
let surfaceSize = $state<{ width: number; height: number }>({
	width: 0,
	height: 0,
});
let unsubscribeAwareness: (() => void) | null = null;
const viewPreferenceUserKey = untrack(() => getCacheUserKey());
const viewPreferenceEnabled = untrack(
	() => mode === "edit" && canUseUserScopedCache(viewPreferenceUserKey),
);
const restoredViewPreference = viewPreferenceEnabled
	? untrack(() =>
			readBoardViewPreference(viewPreferenceUserKey, spaceId, boardId),
		)
	: null;
let viewPreferenceRestored = false;
let pendingViewPreference: BoardViewPreference | null = null;
let viewPreferenceTimer: ReturnType<typeof setTimeout> | null = null;

function addSelectionToGeneration() {
	generationOpen = true;
	generationSelectionRequest += 1;
}

function playMedia(itemId: string) {
	const item = editor.itemById(itemId);
	if (!playableBoardMedia(item, resolvedAssetSource)) return;
	playingId = itemId;
}

function closeMedia() {
	playingId = null;
}

function openExport() {
	if (!exportBridge) return;
	contextMenu = null;
	exportOpen = true;
}

function showRegenerationError(message: string) {
	regenerationError = message;
	if (regenerationErrorTimer) clearTimeout(regenerationErrorTimer);
	regenerationErrorTimer = setTimeout(() => {
		regenerationError = null;
		regenerationErrorTimer = null;
	}, 6000);
}

async function regenerateTask(itemId: string) {
	if (regeneratingItemId) return;
	const source = editor.itemById(itemId);
	if (source?.type !== "task" || source.props.snapshot.taskType !== "generation")
		return;
	const sourceFrame = { ...source.frame };
	const submittingUserKey = getCacheUserKey();
	let createdTaskRunId: string | null = null;
	regeneratingItemId = itemId;
	regenerationError = null;
	try {
		const detail = await sdk.tasks.get(source.props.taskRunId);
		const request = regenerationRequestFromTaskRun(detail.run, spaceId);
		const created = await sdk.generations.create(request);
		createdTaskRunId = created.taskRunId;
		if (getCacheUserKey() !== submittingUserKey) {
			showRegenerationError(m.board_task_created({}, { locale }));
			return;
		}

		watchGenerationTask(spaceId, created.taskRunId, submittingUserKey);
		const snapshot = pendingGenerationTaskSnapshot({
			prompt: generationPromptFromContent(request.content),
			model: request.model,
		});
		const position = regeneratedTaskPosition(sourceFrame);
		editor.addTaskWithSources(
			created.taskRunId,
			snapshot,
			worldPoint(position.x, position.y),
			[{ itemId: source.id, sourcePortId: "artifacts", targetPortId: "input" }],
			{
				regeneration: {
					sourceTaskRunId: source.props.taskRunId,
					sourceItemId: source.id,
				},
			},
		);
	} catch (cause) {
		showRegenerationError(
			createdTaskRunId
				? m.board_generation_started_detail({}, { locale })
				: cause instanceof Error
					? cause.message
					: m.board_generation_start_failed({}, { locale }),
		);
	} finally {
		regeneratingItemId = null;
	}
}

const boardClient = sdk
	.space(untrack(() => spaceId))
	.board(untrack(() => boardId));
const fetchHistory = boardClient.history.bind(boardClient);
async function fetchDocument() {
	const result = await boardClient.get();
	const parsed = parseBoardDocument({ board: result.board, items: result.items ?? {}, animations: result.animations ?? {} });
	if (!parsed.ok) throw new Error(m.board_replay_failed({}, { locale }));
	return { version: result.version, document: parsed.document };
}
const awareness: BoardAwarenessController = createBoardAwarenessController({
	send: (seq, update) => boardClient.updateAwareness(seq, update),
	onChange: () => {
		awarenessVersion += 1;
	},
});

const editor = createBoardEditor({
	document: untrack(() => initialDocument),
	initialTool: untrack(() =>
		mode === "view" ? "hand" : defaultBoardTool(isMobile),
	),
	key: untrack(() => path),
	readonly: untrack(() => mode === "view"),
	onCommit: (patch) => onCommit?.(patch),
	onViewStateChange: (state) => {
		onViewStateChange?.({ path, ...state });
	},
});

function flushViewPreference() {
	if (viewPreferenceTimer) clearTimeout(viewPreferenceTimer);
	viewPreferenceTimer = null;
	if (!viewPreferenceEnabled || !pendingViewPreference) return;
	writeBoardViewPreference(
		viewPreferenceUserKey,
		spaceId,
		boardId,
		pendingViewPreference,
	);
	pendingViewPreference = null;
}

function scheduleViewPreference(preference: BoardViewPreference) {
	pendingViewPreference = preference;
	if (viewPreferenceTimer) clearTimeout(viewPreferenceTimer);
	viewPreferenceTimer = setTimeout(flushViewPreference, 300);
}

function handleSurfaceChange(size: { width: number; height: number }) {
	editor.surfaceSize = size;
	surfaceSize = size;
	if (viewPreferenceRestored || size.width <= 0 || size.height <= 0) return;
	viewPreferenceRestored = true;
	const camera = restoredViewPreference ? cameraFromBoardViewPreference(restoredViewPreference, size) : null;
	if (camera) editor.setCamera(camera);
	else editor.fitView({ animate: false, maxZoom: 1 });
}

$effect(() => {
	const camera = editor.camera;
	const surface = surfaceSize;
	if (!viewPreferenceEnabled || !viewPreferenceRestored) return;
	const preference = boardViewPreferenceFromCamera(camera, surface);
	if (preference) untrack(() => scheduleViewPreference(preference));
});

$effect(() => {
	const doc = initialDocument;
	const k = path;
	untrack(() => editor.loadDocument(doc, k));
});

$effect(() => {
	if (readonly) return;
	const viewport = boardAwarenessViewportFromCamera(editor.camera, surfaceSize);
	untrack(() => awareness.setViewport(viewport));
});

$effect(() => {
	if (readonly) return;
	const tool = editor.tool;
	const selection = editor.selection;
	const bounds = editor.bounds;
	const editingId = editor.editingId;
	const formFactor = isMobile ? ("mobile" as const) : ("desktop" as const);
	untrack(() =>
		awareness.updateLocalState({
			client: { formFactor },
			tool,
			selection,
			bounds,
			editingId,
		}),
	);
});

$effect(() => {
	if (readonly) return;
	editor.interaction;
	editor.geometryVersion;
	untrack(() => awareness.syncGesture(editor));
});

$effect(() => {
	if (readonly) return;
	awarenessVersion;
	const items = editor.items;
	untrack(() => awareness.reconcile(items));
});

const boardActivities = $derived(
	activities.filter((activity) => activity.boardId === boardId),
);

const peers = $derived.by(() => {
	awarenessVersion;
	return awareness.peers;
});

function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	return (
		tag === "INPUT" ||
		tag === "TEXTAREA" ||
		tag === "SELECT" ||
		tag === "AUDIO" ||
		tag === "VIDEO" ||
		target.isContentEditable
	);
}

async function writeClipboard(payload: unknown) {
	const text = JSON.stringify(payload);
	try {
		if (navigator.clipboard?.writeText)
			await navigator.clipboard.writeText(text);
	} catch {
	}
}

async function readClipboardText(): Promise<string | null> {
	try {
		if (navigator.clipboard?.readText)
			return await navigator.clipboard.readText();
	} catch {
	}
	return null;
}

function handleReadonlyKeydown(
	event: KeyboardEvent,
	input: { mod: boolean; key: string },
) {
	const { mod, key } = input;
	if (mod && key === "a") {
		event.preventDefault();
		editor.selectAll();
		return;
	}
	if (mod && key === "c") {
		const payload = editor.copySelection();
		if (payload) {
			event.preventDefault();
			void writeClipboard(payload);
		}
		return;
	}
	if (mod && event.shiftKey && key === "e") {
		event.preventDefault();
		openExport();
		return;
	}
	if ((mod && event.key === "0") || event.key === "/") {
		event.preventDefault();
		editor.fitView();
		return;
	}
	switch (event.key) {
		case "Enter": {
			const single =
				editor.selectedItems.length === 1 ? editor.selectedItems[0] : null;
			if (!single) return;
			if (playableBoardMedia(single, resolvedAssetSource)) {
				event.preventDefault();
				playMedia(single.id);
				return;
			}
			if (single.type !== "file") return;
			event.preventDefault();
			void onOpenFile?.((single.props as { src: string }).src);
			return;
		}
		case "Escape":
			editor.clearSelection();
			return;
		case "v":
		case "V":
			editor.tool = "select";
			return;
		case "h":
		case "H":
			editor.tool = "hand";
			return;
	}
}

function handleKeydown(event: KeyboardEvent) {
	if (!active || generationOpen || replayOpen) return;
	if (event.key === "Escape" && playingId) {
		event.preventDefault();
		closeMedia();
		return;
	}
	if (editor.editingId || isEditableTarget(event.target)) return;
	const mod = event.metaKey || event.ctrlKey;
	const key = event.key.toLowerCase();

	if (event.code === "Space" && !event.repeat) {
		event.preventDefault();
		editor.spaceHeld = true;
		return;
	}

	if (readonly) {
		handleReadonlyKeydown(event, { mod, key });
		return;
	}

	if (mod && key === "z") {
		event.preventDefault();
		if (event.shiftKey) editor.redo();
		else editor.undo();
		return;
	}
	if (mod && key === "y") {
		event.preventDefault();
		editor.redo();
		return;
	}
	if (mod && key === "d") {
		event.preventDefault();
		editor.duplicateSelection();
		return;
	}
	if (mod && key === "a") {
		event.preventDefault();
		editor.selectAll();
		return;
	}
	if (mod && key === "c") {
		const payload = editor.copySelection();
		if (payload) {
			event.preventDefault();
			void writeClipboard(payload);
		}
		return;
	}
	if (mod && key === "x") {
		const payload = editor.cutSelection();
		if (payload) {
			event.preventDefault();
			void writeClipboard(payload);
		}
		return;
	}
	if (mod && key === "v") {
		event.preventDefault();
		void (async () => {
			const text = await readClipboardText();
			if (text) {
				editor.pasteClipboard(text);
				return;
			}
			editor.pasteClipboard();
		})();
		return;
	}
	if (mod && event.key === "0") {
		event.preventDefault();
		editor.fitView();
		return;
	}
	if (mod && key === "l") {
		event.preventDefault();
		editor.toggleSelectionLock();
		return;
	}
	if (mod && event.shiftKey && key === "e") {
		event.preventDefault();
		openExport();
		return;
	}

	switch (event.key) {
		case "Enter": {
			const single =
				editor.selectedItems.length === 1 ? editor.selectedItems[0] : null;
			if (!single) return;
			event.preventDefault();
			if (playableBoardMedia(single, resolvedAssetSource)) {
				playMedia(single.id);
				return;
			}
			if (single.type === "file") {
				void onOpenFile?.((single.props as { src: string }).src);
				return;
			}
			if (single.type === "task") {
				void onOpenTask?.((single.props as { taskRunId: string }).taskRunId);
				return;
			}
			if (!single.locked && shapeCapabilities(single).canEdit)
				editor.editingId = single.id;
			return;
		}
		case "Delete":
		case "Backspace":
			event.preventDefault();
			editor.deleteSelection();
			return;
		case "Escape":
			if (contextMenu) contextMenu = null;
			else {
				editor.clearSelection();
				if (editor.tool !== "select" && editor.tool !== "hand")
					editor.tool = "select";
			}
			return;
		case "ArrowUp":
			event.preventDefault();
			editor.nudgeSelection(0, -1, event.shiftKey);
			return;
		case "ArrowDown":
			event.preventDefault();
			editor.nudgeSelection(0, 1, event.shiftKey);
			return;
		case "ArrowLeft":
			event.preventDefault();
			editor.nudgeSelection(-1, 0, event.shiftKey);
			return;
		case "ArrowRight":
			event.preventDefault();
			editor.nudgeSelection(1, 0, event.shiftKey);
			return;
		case "v":
		case "V":
			editor.tool = "select";
			return;
		case "h":
		case "H":
			editor.tool = "hand";
			return;
		case "t":
		case "T":
			editor.tool = "text";
			return;
		case "s":
		case "S":
			editor.tool = "shape";
			return;
		case "d":
		case "D":
			editor.tool = "draw";
			return;
		case "a":
		case "A":
			editor.tool = "arrow";
			return;
		case "f":
		case "F":
			editor.tool = "frame";
			return;
		case "/":
			event.preventDefault();
			editor.fitView();
			return;
	}
}

function handleKeyup(event: KeyboardEvent) {
	if (!active) return;
	if (event.code === "Space") {
		editor.spaceHeld = false;
	}
}

function clearSpaceHeld() {
	editor.spaceHeld = false;
	awareness.setCursor(null);
}

function handleVisibilityChange() {
	clearSpaceHeld();
	if (document.visibilityState === "hidden") flushViewPreference();
}

function retrySync() {
	if (editor.saveError) {
		editor.retrySave();
		return;
	}
	void onRetrySync?.();
}

function handleContextMenu(event: MouseEvent) {
	if (!active || readonly) return;
	event.preventDefault();
	if (!stageWrap) return;
	const rect = stageWrap.getBoundingClientRect();
	const worldPoint = screenToWorld(
		event.clientX,
		event.clientY,
		rect,
		editor.camera,
	);
	const item = editor.itemAt(worldPoint);
	if (item && !editor.selection.includes(item.id))
		editor.setSelection([item.id]);
	if (!item && editor.selection.length > 0) editor.clearSelection();
	contextMenu = { x: event.clientX, y: event.clientY };
}

onMount(() => {
	if (!readonly) {
		unsubscribeAwareness = boardClient.subscribe({
			awareness: (event) => awareness.receive(event),
			changed: (event) => {
				liveVersion = Math.max(liveVersion, event.payload.version);
			},
		});
	}
	const unsubscribeTaskCache = onTaskRunsCacheUpdated((event) => {
		if (event.spaceId !== spaceId) return;
		const taskRunIds = new Set(editor.items.flatMap((item) => (item.type === "task" ? [(item.props as { taskRunId: string }).taskRunId] : [])));
		if (taskRunIds.size === 0) return;
		const updatedRuns = event.runs.filter((run) => taskRunIds.has(run.id));
		if (updatedRuns.length === 0) return;
		const snapshots = new Map(
			updatedRuns.map((run) => [run.id, taskBoardSnapshot(run)]),
		);
		editor.applyTaskSnapshots(snapshots);
	});
	window.addEventListener("keydown", handleKeydown);
	window.addEventListener("keyup", handleKeyup);
	window.addEventListener("blur", clearSpaceHeld);
	window.addEventListener("pagehide", flushViewPreference);
	document.addEventListener("visibilitychange", handleVisibilityChange);
	return () => {
		unsubscribeTaskCache();
		window.removeEventListener("keydown", handleKeydown);
		window.removeEventListener("keyup", handleKeyup);
		window.removeEventListener("blur", clearSpaceHeld);
		window.removeEventListener("pagehide", flushViewPreference);
		document.removeEventListener("visibilitychange", handleVisibilityChange);
		const unsubscribe = unsubscribeAwareness;
		unsubscribeAwareness = null;
		void awareness.destroy().finally(() => unsubscribe?.());
	};
});

$effect(() => {
	if (active) return;
	contextMenu = null;
	playingId = null;
	exportOpen = false;
	generationOpen = false;
	replayOpen = false;
	clearSpaceHeld();
});

onDestroy(() => {
	if (regenerationErrorTimer) clearTimeout(regenerationErrorTimer);
	flushViewPreference();
	window.removeEventListener("keydown", handleKeydown);
	window.removeEventListener("keyup", handleKeyup);
	window.removeEventListener("blur", clearSpaceHeld);
	window.removeEventListener("pagehide", flushViewPreference);
	document.removeEventListener("visibilitychange", handleVisibilityChange);
	editor.spaceHeld = false;
	const unsubscribe = unsubscribeAwareness;
	unsubscribeAwareness = null;
	void awareness.destroy().finally(() => unsubscribe?.());
	editor.destroy();
	assets.destroy();
});
</script>

<div
	class="board-panel flex h-full min-w-0 flex-col bg-bg-primary"
	class:board-panel--immersive={immersive}
	data-drawer-swipe-ignore
>
	{#if syncError || editor.saveError}
		<div
			class="board-sync-notice flex shrink-0 items-center gap-2 border-b border-error-soft/20 bg-error-bg px-3 py-1.5 text-[11px] text-error-soft"
			class:board-sync-notice--immersive={immersive}
		>
			<span class="min-w-0 flex-1 truncate">{m.board_sync_paused({}, { locale })}</span>
			<button type="button" class="action-btn" onclick={retrySync}>{m.common_retry({}, { locale })}</button>
		</div>
	{/if}

	<div
		bind:this={stageWrap}
		class="relative min-h-0 flex-1 bg-bg-primary"
		role="application"
		oncontextmenu={handleContextMenu}
	>
		{#if regenerationError}
			<div class="board-regeneration-notice" role="status" aria-live="polite">
				{regenerationError}
			</div>
		{/if}

		<BoardStage
			{editor}
			playback={activePlayback}
			{assets}
			{active}
			{awareness}
			{awarenessVersion}
			{spaceId}
			{readonly}
			assetSource={resolvedAssetSource}
			{onOpenFile}
			onPlayMedia={playMedia}
			onPointerPresence={(cursor) => { if (!readonly) awareness.setCursor(cursor); }}
			onSurfaceChange={handleSurfaceChange}
			onExportReady={(bridge) => { exportBridge = bridge; }}
			onBackgroundLoadStateChange={(state) => { backgroundLoadState = state; }}
		/>
		<BoardAppOverlay
			{editor}
			{spaceId}
			{readonly}
			surface={surfaceSize}
			{shell}
			onNavigationOpen={onNavigationOpen}
		/>

		{#if !readonly}
			<BoardCollaboratorOverlay
				peers={peers}
				activities={boardActivities}
				profiles={collaborators}
				camera={editor.camera}
				surface={surfaceSize}
				cursorVisibleMs={awareness.cursorVisibleMs}
				{isMobile}
				onOpenActivity={(activity) => { void onOpenActivity?.(activity); }}
			/>
		{/if}

		{#if !editor.hasContent && !readonly}
			<BoardEmptyState
				onAddText={() => editor.beginTextDraft(editor.viewCenter())}
				onAddShape={() => editor.addShape(editor.viewCenter())}
			/>
		{/if}

		{#if !readonly}
			<BoardTextEditor {editor} />
		{/if}
		<BoardMediaPlayer
			{editor}
			assetSource={resolvedAssetSource}
			{playingId}
			{active}
			surface={surfaceSize}
			onClose={closeMedia}
		/>
		{#if !readonly}
			<BoardSelectionToolbar
				{editor}
				onRegenerateTask={regenerateTask}
				onAddToGeneration={addSelectionToGeneration}
				{regeneratingItemId}
			/>
			<BoardArrowToolbar {editor} />
			{#if generationOpen}
				<BoardGenerationComposer
					{editor}
					{spaceId}
					{boardId}
					assetSource={resolvedAssetSource}
					{immersive}
					selectionAddRequest={generationSelectionRequest}
					onClose={() => { generationOpen = false; }}
				/>
			{/if}
			<BoardFloatingToolbar
				{editor}
				{immersive}
				{generationOpen}
				{appearanceOpen}
				{timelineOpen}
				onToggleGeneration={() => { generationOpen = !generationOpen; appearanceOpen = false; }}
				onToggleAppearance={() => { appearanceOpen = !appearanceOpen; generationOpen = false; }}
				onToggleTimeline={() => {
					timelineOpen = !timelineOpen;
					if (!timelineOpen) editor.setPlayhead(null);
				}}
			/>
			{#if appearanceOpen}
				<div class="board-appearance-anchor">
					<BoardAppearancePopover
						{editor}
						loadState={backgroundLoadState}
						onClose={() => { appearanceOpen = false; }}
					/>
				</div>
			{/if}
		{/if}
		<BoardZoomMenu
			{editor} {immersive} {timelineOpen}
			onToggleTimeline={readonly && Object.keys(editor.animations).length ? () => {
				timelineOpen = !timelineOpen;
				if (!timelineOpen) editor.setPlayhead(null);
			} : undefined}
		/>
		{#if timelineOpen}
			<BoardTimeline
				{editor}
				playback={activePlayback}
				{readonly}
				onPlayback={sendPlayback}
				onClose={() => { timelineOpen = false; editor.setPlayhead(null); }}
			/>
		{/if}

		{#if replayOpen}
			{#await import("$lib/components/board/BoardReplayView.svelte") then { default: BoardReplayView }}
				<BoardReplayView
					{boardId}
					{path}
					{spaceId}
					{assets}
					assetSource={resolvedAssetSource}
					initialDocument={editor.document}
					initialCamera={editor.camera}
					profiles={collaborators}
					{isMobile}
					{fetchHistory}
					{fetchDocument}
					{liveVersion}
					onClose={() => { replayOpen = false; }}
				/>
			{/await}
		{/if}

		{#if contextMenu}
			<BoardContextMenu
				{editor}
				{onOpenFile}
				{onOpenTask}
				onRegenerateTask={regenerateTask}
				{regeneratingItemId}
				onAddToGeneration={addSelectionToGeneration}
				position={contextMenu}
				onExport={exportBridge ? openExport : undefined}
				onReplay={!readonly ? () => { contextMenu = null; replayOpen = true; } : undefined}
				onAnimate={!readonly ? () => { contextMenu = null; timelineOpen = true; } : undefined}
				onClose={() => { contextMenu = null; }}
			/>
		{/if}
	</div>
</div>

<BoardExportDialog
	open={exportOpen}
	onClose={() => { exportOpen = false; }}
	document={editor.document}
	bridge={exportBridge}
	title={path}
	selection={editor.selection}
/>

<style>
	.board-panel--immersive {
		position: relative;
	}

	.board-appearance-anchor {
		position: absolute;
		left: 50%;
		bottom: 68px;
		z-index: 30;
		transform: translateX(-50%);
	}

	@media (pointer: coarse) {
		.board-appearance-anchor {
			left: 12px;
			right: 12px;
			bottom: 74px;
			transform: none;
		}
		.board-appearance-anchor :global(.appearance-popover) {
			width: min(360px, 100%);
			margin-inline: auto;
		}
	}

	.board-regeneration-notice {
		position: absolute;
		top: 12px;
		left: 50%;
		z-index: 32;
		max-width: min(420px, calc(100% - 24px));
		transform: translateX(-50%);
		border: 1px solid var(--error-soft);
		border-radius: 7px;
		background: var(--error-bg);
		padding: 7px 10px;
		color: var(--error-soft);
		font-size: 11px;
		box-shadow: 0 8px 20px color-mix(in srgb, var(--overlay-scrim-strong) 12%, transparent);
	}

	.board-sync-notice--immersive {
		position: absolute;
		top: 58px;
		right: var(--preview-safe-right, 10px);
		z-index: 30;
		max-width: min(420px, calc(100% - var(--preview-safe-left, 10px) - var(--preview-safe-right, 10px)));
		border: 1px solid var(--error-soft);
		border-radius: 7px;
		box-shadow: 0 8px 20px color-mix(in srgb, var(--overlay-scrim-strong) 12%, transparent);
	}
</style>
