<script lang="ts">
import type {
	BoardPatch,
	BoardPlaybackCommand,
	BoardPlaybackSnapshot,
} from "@cohub/protocol";
import {
	type BoardCameraState,
	type BoardLaunch,
	type BoardMediaItemKind,
	type BoardSceneItem,
	boardItemOrigin,
	boardModelFormat,
	boardOriginKey,
	boardTaskCardSize,
	createMediaBoardItem,
	createTaskResultItems,
	featuredTaskArtifact,
	formatBoardLaunch,
	inferBoardMediaKind,
	isBoardModelItem,
	normalizeBoardRemoteUrl,
	parseBoardDocument,
	parseBoardMediaSource,
	taskRunArtifacts,
	type WorldPoint,
	worldPoint,
} from "@neta-art/cohub/board";
import {
	type BoardKeyCommand,
	defaultBoardTool,
	handleBoardKeyDown,
	handleBoardKeyUp,
} from "@neta-art/cohub/board/editor";
import {
	nextLocalPlayback,
	playbackClockAt,
} from "@neta-art/cohub/board/player";
import {
	BOARD_PRESENT_BACKDROP,
	type BoardBackdropStatus,
	type BoardContextMenuRequest,
	type BoardStage as BoardStageController,
	boardDeviceBudget,
	createBoardAssetManager,
	readBoardDeviceSignals,
} from "@neta-art/cohub/board/stage";
import {
	AppWindow,
	ExternalLink,
	Play,
	RotateCcw,
	Settings2,
	Square,
	TriangleAlert,
} from "lucide-svelte";
import { onDestroy, onMount, untrack } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import {
	boardAppMeta,
	boardAppOpenUrl,
	createBoardAppDetailLoader,
} from "$lib/board/board-app";
import { createBoardAppItemView } from "$lib/board/board-app-view.svelte";
import { createSpaceBoardAssetSource } from "$lib/board/board-asset-source";
import {
	type BoardAwarenessController,
	boardAwarenessViewportFromCamera,
	createBoardAwarenessController,
	isBoardScriptLeader,
} from "$lib/board/board-awareness";
import {
	generationPromptFromContent,
	pendingGenerationTaskSnapshot,
	pendingTaskPosition,
	regenerationRequestFromTaskRun,
} from "$lib/board/board-generation";
import type { BoardStageExportBridge } from "$lib/board/board-image-export";
import {
	boardReceivesKeys,
	registerBoardPanel,
} from "$lib/board/board-keyboard";
import { opensInPlace } from "$lib/board/board-media-playback";
import { createBoardModelPreviews } from "$lib/board/board-model";
import {
	enterPresentationFullscreen,
	holdPresentation,
} from "$lib/board/board-present";
import {
	type BoardScriptStatus,
	watchBoardScriptStatus,
} from "$lib/board/board-script-status";
import { createBoardSessionActions } from "$lib/board/board-session-actions.svelte";
import {
	boardViewKey,
	readBoardView,
	writeBoardView,
} from "$lib/board/board-view-preferences";
import { createBoardEditor } from "$lib/board/editor.svelte";
import type { BoardRuntimeProps } from "$lib/board/runtime/board-runtime";
import { canUseUserScopedCache, getCacheUserKey } from "$lib/cache/keys";
import { copyTextToClipboard } from "$lib/clipboard";
import BoardAnimationDock from "$lib/components/board/BoardAnimationDock.svelte";
import BoardAppearancePopover from "$lib/components/board/BoardAppearancePopover.svelte";
import BoardArrowToolbar from "$lib/components/board/BoardArrowToolbar.svelte";
import BoardCollaboratorOverlay from "$lib/components/board/BoardCollaboratorOverlay.svelte";
import BoardContextMenu, {
	type BoardMenuAction,
} from "$lib/components/board/BoardContextMenu.svelte";
import BoardEmptyState from "$lib/components/board/BoardEmptyState.svelte";
import BoardExportDialog from "$lib/components/board/BoardExportDialog.svelte";
import BoardFloatingToolbar from "$lib/components/board/BoardFloatingToolbar.svelte";
import BoardFrameNav from "$lib/components/board/BoardFrameNav.svelte";
import BoardGenerationComposer from "$lib/components/board/BoardGenerationComposer.svelte";
import BoardLinkPopover from "$lib/components/board/BoardLinkPopover.svelte";
import BoardMediaPlayer from "$lib/components/board/BoardMediaPlayer.svelte";
import BoardMobileChrome from "$lib/components/board/BoardMobileChrome.svelte";
import BoardModelViewer from "$lib/components/board/BoardModelViewer.svelte";
import BoardPlaybackBar from "$lib/components/board/BoardPlaybackBar.svelte";
import BoardScriptPanel from "$lib/components/board/BoardScriptPanel.svelte";
import BoardSelectionToolbar from "$lib/components/board/BoardSelectionToolbar.svelte";
import BoardSessionReply from "$lib/components/board/BoardSessionReply.svelte";
import BoardStage from "$lib/components/board/BoardStage.svelte";
import BoardTextEditor from "$lib/components/board/BoardTextEditor.svelte";
import BoardZoomMenu from "$lib/components/board/BoardZoomMenu.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { mergeCachedTaskRun } from "$lib/stores/task-runs-cache";

const {
	path,
	boardId,
	document: initialDocument,
	playback = null,
	scope,
	shell,
	onNavigationOpen,
	mode = "edit",
	launch = null,
	shareUrl,
	active = true,
	keysWhenUsed = false,
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
	onOpenApp,
	onOpenSession,
	lod,
	deviceTier,
	onStageReady,
}: BoardRuntimeProps & {
	onOpenTask?: (taskRunId: string) => void;
} = $props();

const locale = $derived(getLocale());

let scriptStage = $state.raw<BoardStageController | null>(null);
// Mode and scope are fixed for a Board's lifetime: writes need `edit`, Space services need a Space.
const editable = untrack(() => mode === "edit");
const spaceId = untrack(() => (scope.kind === "space" ? scope.spaceId : null));
const resolvedAssetSource = untrack(() =>
	scope.kind === "app"
		? scope.assetSource
		: createSpaceBoardAssetSource(scope.spaceId),
);

const signals = readBoardDeviceSignals();
const saveData = signals.saveData;
const forced = untrack(
	() => deviceTier && boardDeviceBudget(signals, deviceTier),
);
const assets = createBoardAssetManager({
	loadVideoPreviews: !saveData,
	concurrency: forced?.concurrency,
	lruBudget: forced?.lru,
	resolveFile: (path, options) =>
		resolvedAssetSource.resolveFile(path, options),
	subscribe: resolvedAssetSource.subscribe,
	modelPreviews: saveData
		? undefined
		: createBoardModelPreviews(() => resolvedAssetSource, {
				isMobile: untrack(() => isMobile),
			}),
});
const boardLod = $derived(lod ?? forced?.lod);
const appDetails = createBoardAppDetailLoader();
const liveApps = new SvelteSet<string>();
const itemViews = [
	createBoardAppItemView({
		details: appDetails,
		isLive: (id) => liveApps.has(id),
		onRun: runApp,
		shell: () => shell,
		onNavigationOpen: () => onNavigationOpen,
	}),
];

function runApp(id: string) {
	liveApps.add(id);
	editor.setSelection([id]);
	editor.enteredId = id;
}

function stopApp(id: string) {
	liveApps.delete(id);
	if (editor.enteredId === id) editor.enteredId = null;
}

const appActions = $derived.by<BoardMenuAction[]>(() => {
	const [item] = editor.selectedItems;
	const app =
		editor.selectedItems.length === 1 && item ? boardAppMeta(item) : null;
	if (!item || !app) return [];
	const live = liveApps.has(item.id);
	const actions: BoardMenuAction[] = [
		live
			? {
					id: "app-stop",
					label: m.board_app_stop({}, { locale }),
					icon: Square,
					run: () => stopApp(item.id),
				}
			: {
					id: "app-run",
					label: m.board_app_run({}, { locale }),
					icon: Play,
					run: () => runApp(item.id),
				},
		{
			id: "app-open-tab",
			label: m.board_app_open_tab({}, { locale }),
			icon: ExternalLink,
			run: () => {
				const url = boardAppOpenUrl(app, appDetails.peek(app.appId));
				if (url) window.open(url, "_blank", "noopener,noreferrer");
			},
		},
	];
	if (onOpenApp && !isMobile)
		actions.push({
			id: "app-open-window",
			label: m.board_app_open_window({}, { locale }),
			icon: AppWindow,
			run: () => onOpenApp({ appId: app.appId, name: app.name }),
		});
	return actions;
});

const scriptItemId = $derived.by(() => {
	const [item] = editor.selectedItems;
	return editor.selectedItems.length === 1 && item?.script ? item.id : null;
});
let scriptStatus = $state.raw<BoardScriptStatus | null>(null);
let scriptPanelOpen = $state(false);

$effect(() => {
	const stage = scriptStage;
	const id = scriptItemId;
	scriptPanelOpen = false;
	scriptStatus = null;
	if (!stage || !id) return;
	return untrack(() =>
		watchBoardScriptStatus(stage, id, (status) => {
			scriptStatus = status;
		}),
	);
});

function restartScript(id: string) {
	scriptStage?.resetScripts(id);
}

const scriptSettingsAction = $derived.by<BoardMenuAction | null>(() => {
	if (!editable || !scriptItemId) return null;
	const failed = scriptStatus?.state === "error";
	return {
		id: "script-settings",
		label: m.board_script_settings({}, { locale }),
		icon: failed ? TriangleAlert : Settings2,
		warning: failed,
		expanded: scriptPanelOpen,
		run: () => {
			scriptPanelOpen = !scriptPanelOpen;
		},
	};
});

let contextMenu = $state<{ x: number; y: number } | null>(null);
let exportBridge = $state<BoardStageExportBridge | null>(null);
let exportOpen = $state(false);
let generationOpen = $state(false);
let appearanceOpen = $state(false);
let linkRequest = $state<{ url: string; at: WorldPoint } | null>(null);

function openLink(url = "", at = editor.viewCenter()) {
	contextMenu = null;
	generationOpen = false;
	appearanceOpen = false;
	linkRequest = { url, at };
}

function toggleGeneration() {
	linkRequest = null;
	generationOpen = !generationOpen;
	appearanceOpen = false;
}

function toggleAppearance() {
	linkRequest = null;
	appearanceOpen = !appearanceOpen;
	generationOpen = false;
}

function toggleAnimation() {
	linkRequest = null;
	if (animationOpen) closeAnimation();
	else animationOpen = true;
}

function closeAnimation() {
	animationOpen = false;
	editor.setPlayhead(null);
}

function addLink(url: string, kind: BoardMediaItemKind) {
	const at = linkRequest?.at ?? editor.viewCenter();
	editor.setSelection([editor.addMedia(url, at, { kind })]);
	linkRequest = null;
}

function addLinks(urls: string[], at = editor.viewCenter()) {
	if (urls.length === 1) {
		const url = urls[0] as string;
		const kind = inferBoardMediaKind(url);
		if ((kind === "file" || kind === "text") && !boardModelFormat(url)) {
			openLink(url, at);
			return;
		}
	}
	editor.addItems(
		urls.map((url, index) =>
			createMediaBoardItem(url, at.x + index * 36, at.y),
		),
		{ select: true },
	);
}

function pasteText(text: string) {
	const url = normalizeBoardRemoteUrl(text);
	if (url) addLinks([url]);
	else editor.pasteClipboard(text);
}

function handlePaste(event: ClipboardEvent) {
	if (
		!receivesKeys() ||
		!editable ||
		presenting ||
		generationOpen ||
		replayOpen ||
		linkRequest ||
		editor.editingId ||
		isEditableTarget(event.target)
	)
		return;
	const text = event.clipboardData?.getData("text/plain");
	if (!text) return;
	event.preventDefault();
	pasteText(text);
}

const checkedTasks = new Set<string>();
$effect(() => {
	if (!editable || !spaceId) return;
	const unsettled = new Map<string, string[]>();
	for (const item of editor.items) {
		if (item.type !== "task" || checkedTasks.has(item.id)) continue;
		const { status } = item.props.snapshot;
		if (status !== "pending" && status !== "running") continue;
		checkedTasks.add(item.id);
		const ids = unsettled.get(item.props.taskRunId) ?? [];
		unsettled.set(item.props.taskRunId, [...ids, item.id]);
	}
	if (unsettled.size) untrack(() => void recheckTasks(unsettled));
});

async function recheckTasks(cards: ReadonlyMap<string, readonly string[]>) {
	if (!spaceId || !boardClient) return;
	const runIds = [...cards.keys()];
	for (let start = 0; start < runIds.length; start += 100) {
		const { runs } = await sdk.tasks
			.getMany(runIds.slice(start, start + 100), { spaceId })
			.catch(() => ({ runs: [] }));
		const items: NonNullable<BoardPatch["items"]> = {};
		for (const run of runs) {
			mergeCachedTaskRun(spaceId, run);
			if (run.status !== "completed" && run.status !== "failed") continue;
			for (const id of cards.get(run.id) ?? [])
				items[id] = { props: { taskRunId: run.id } };
		}
		if (Object.keys(items).length)
			await boardClient.apply({ items }).catch(() => undefined);
	}
}

async function addTaskResults(itemId: string) {
	const task = editor.itemById(itemId);
	if (task?.type !== "task") return;
	const { taskRunId, snapshot } = task.props;
	let artifacts = snapshot.artifacts;
	if (snapshot.artifactCount > artifacts.length) {
		try {
			artifacts = taskRunArtifacts((await sdk.tasks.get(taskRunId)).run);
		} catch {}
	}
	const current = editor.itemById(itemId);
	if (current?.type !== "task") return;
	const existing = new Map<string, string>();
	for (const item of editor.items) {
		const origin = boardItemOrigin(item);
		if (origin?.taskRunId === taskRunId)
			existing.set(boardOriginKey(origin), item.id);
	}
	const entries = createTaskResultItems({
		taskRunId,
		frame: current.frame,
		artifacts,
		existing: new Set(existing.keys()),
	});
	if (entries.length) editor.addItems(entries, { select: false });
	const ids = [...existing.values(), ...entries.map((entry) => entry.id)];
	if (!ids.length) return;
	editor.setSelection(ids);
	editor.focusItems(ids);
}

function showSource(itemId: string) {
	const item = editor.itemById(itemId);
	const origin = item ? boardItemOrigin(item) : null;
	if (!origin) return;
	const card = editor.items.find(
		(candidate) =>
			candidate.type === "task" &&
			candidate.props.taskRunId === origin.taskRunId,
	);
	if (!card) {
		void onOpenTask?.(origin.taskRunId);
		return;
	}
	editor.setSelection([card.id]);
	editor.focusItems([card.id]);
}

const relatedIds = $derived.by(() => {
	const selected = editor.selectedItems;
	if (selected.length !== 1 || !selected[0]) return [];
	const item = selected[0];
	const taskRunId =
		item.type === "task"
			? item.props.taskRunId
			: boardItemOrigin(item)?.taskRunId;
	if (!taskRunId) return [];
	return editor.items.flatMap((other) =>
		other.id !== item.id &&
		(other.type === "task"
			? other.props.taskRunId === taskRunId
			: boardItemOrigin(other)?.taskRunId === taskRunId)
			? [other.id]
			: [],
	);
});

function openMediaSource(src: string) {
	const source = parseBoardMediaSource(src);
	if (source?.kind === "url")
		window.open(source.value, "_blank", "noopener,noreferrer");
	else if (source?.kind === "file") void openFile(source.value);
}

async function openFile(path: string) {
	if (onOpenFile) return onOpenFile(path);
	const url = (await resolvedAssetSource.resolveFile(path))?.url;
	if (url) window.open(url, "_blank", "noopener,noreferrer");
	else showNotice(m.board_file_not_published({}, { locale }));
}

function openTask(item: Extract<BoardSceneItem, { type: "task" }>) {
	if (onOpenTask) {
		void onOpenTask(item.props.taskRunId);
		return true;
	}
	const result = featuredTaskArtifact(item.props.snapshot.artifacts);
	if (!result || !("url" in result)) return false;
	openMediaSource(result.url);
	return true;
}
let replayOpen = $state(false);
let animationOpen = $state(false);
let localPlayback = $state<BoardPlaybackSnapshot | null>(null);
const activePlayback = $derived(onPlayback ? playback : localPlayback);

function sendPlayback(command: BoardPlaybackCommand) {
	if (command.type === "play" || command.type === "resume") {
		editor.setCameraPolicy("follow");
	}
	if (onPlayback) return onPlayback(command);
	localPlayback = nextLocalPlayback(localPlayback, command, editor.document);
}
let liveVersion = $state(0);
let backdropStatus = $state<BoardBackdropStatus | null>(null);
let generationSelectionRequest = $state(0);
let playingId = $state<string | null>(null);
let modelId = $state<string | null>(null);
let regeneratingItemId = $state<string | null>(null);
let notice = $state<{ text: string; error: boolean } | null>(null);
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let awarenessVersion = $state(0);
let pageVisible = $state(true);
let surfaceSize = $state<{ width: number; height: number }>({
	width: 0,
	height: 0,
});
let unsubscribeAwareness: (() => void) | null = null;
const viewUserKey = untrack(() => getCacheUserKey());
const viewKey = untrack(() => boardViewKey(scope, boardId));
const remembersView = canUseUserScopedCache(viewUserKey);
let opened = false;
let pendingView: BoardCameraState | null = null;
let viewTimer: ReturnType<typeof setTimeout> | null = null;

function addSelectionToGeneration() {
	generationOpen = true;
	generationSelectionRequest += 1;
}

function openInPlace(itemId: string) {
	const item = editor.itemById(itemId);
	if (!opensInPlace(item, resolvedAssetSource)) return;
	const model = isBoardModelItem(item);
	modelId = model ? itemId : null;
	playingId = model ? null : itemId;
}

function closeInPlace() {
	playingId = null;
	modelId = null;
}

function openExport() {
	if (!exportBridge) return;
	contextMenu = null;
	exportOpen = true;
}

function showNotice(text: string, error = false) {
	notice = { text, error };
	if (noticeTimer) clearTimeout(noticeTimer);
	noticeTimer = setTimeout(
		() => {
			notice = null;
			noticeTimer = null;
		},
		error ? 6000 : 2400,
	);
}

async function regenerateTask(itemId: string) {
	if (regeneratingItemId || !spaceId) return;
	const source = editor.itemById(itemId);
	if (
		source?.type !== "task" ||
		source.props.snapshot.taskType !== "generation"
	)
		return;
	const sourceFrame = { ...source.frame };
	const submittingUserKey = getCacheUserKey();
	let createdTaskRunId: string | null = null;
	regeneratingItemId = itemId;
	notice = null;
	try {
		const detail = await sdk.tasks.get(source.props.taskRunId);
		const request = regenerationRequestFromTaskRun(detail.run, spaceId);
		const created = await sdk.generations.create(request);
		createdTaskRunId = created.taskRunId;
		if (getCacheUserKey() !== submittingUserKey) {
			showNotice(m.board_task_created({}, { locale }), true);
			return;
		}

		const snapshot = pendingGenerationTaskSnapshot({
			prompt: generationPromptFromContent(request.content),
			model: request.model,
		});
		const aspect = sourceFrame.width / sourceFrame.height;
		const position = pendingTaskPosition(
			sourceFrame,
			boardTaskCardSize(snapshot, aspect),
		);
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
			aspect,
		);
	} catch (cause) {
		showNotice(
			createdTaskRunId
				? m.board_generation_started_detail({}, { locale })
				: cause instanceof Error
					? cause.message
					: m.board_generation_start_failed({}, { locale }),
			true,
		);
	} finally {
		regeneratingItemId = null;
	}
}

const boardClient = spaceId
	? sdk.space(spaceId).board(untrack(() => boardId))
	: null;
const history = boardClient && {
	fetchHistory: boardClient.history.bind(boardClient),
	async fetchDocument() {
		const result = await boardClient.get();
		const parsed = parseBoardDocument({
			board: result.board,
			items: result.items ?? {},
			animations: result.animations ?? {},
		});
		if (!parsed.ok) throw new Error(m.board_replay_failed({}, { locale }));
		return { version: result.version, document: parsed.document };
	},
};
const presence = editable ? boardClient : null;
const generates = editable && spaceId !== null;
const awareness: BoardAwarenessController = createBoardAwarenessController({
	send: (seq, update) =>
		presence ? presence.updateAwareness(seq, update) : Promise.resolve(),
	onChange: () => {
		awarenessVersion += 1;
	},
});

const editor = createBoardEditor({
	document: untrack(() => initialDocument),
	initialTool: editable ? untrack(() => defaultBoardTool(isMobile)) : "hand",
	key: untrack(() => path),
	readonly: !editable,
	onCommit: (patch) => onCommit?.(patch),
	onViewStateChange: (state) => {
		onViewStateChange?.({ path, ...state });
	},
});

const sessionActions = createBoardSessionActions({
	editor,
	spaceId,
	isMobile: () => isMobile,
	fetchHistory: history ? history.fetchHistory : undefined,
	onOpen: () => onOpenSession,
	notice: showNotice,
});
const toolbarActions = $derived([
	...appActions,
	...sessionActions.toolbar,
	...(scriptSettingsAction ? [scriptSettingsAction] : []),
]);

const menuActions = $derived.by<BoardMenuAction[]>(() => {
	const id = scriptItemId;
	if (!id) return [...appActions, ...sessionActions.menu];
	const restart: BoardMenuAction = {
		id: "script-restart",
		label: m.board_script_restart({}, { locale }),
		icon: RotateCcw,
		run: () => restartScript(id),
	};
	return [
		...appActions,
		...sessionActions.menu,
		...(scriptSettingsAction ? [scriptSettingsAction] : []),
		restart,
	];
});

const hasAnimations = $derived(Object.keys(editor.animations).length > 0);
const hasFrames = $derived(editor.frames.length > 0);
const presenting = $derived(editor.frameView?.present ?? false);
let panel: HTMLDivElement | null = $state(null);

$effect(() => (panel ? registerBoardPanel(panel) : undefined));

function receivesKeys() {
	return active && boardReceivesKeys(panel, keysWhenUsed);
}
const presentBackdrop = `#${BOARD_PRESENT_BACKDROP.toString(16).padStart(6, "0")}`;

$effect(() => {
	editor.frameInset = isMobile ? { bottom: 112 } : { top: 52, bottom: 60 };
});

function navigableFrame(id: string | null | undefined): string | null {
	return id && editor.frames.some((frame) => frame.id === id) ? id : null;
}

function present(id?: string) {
	const [selected] = editor.selection;
	const start =
		navigableFrame(id) ??
		(editor.selection.length === 1 ? navigableFrame(selected) : null) ??
		editor.frameView?.id ??
		editor.frames[0]?.id;
	if (!start) return;
	contextMenu = null;
	generationOpen = false;
	appearanceOpen = false;
	linkRequest = null;
	closeInPlace();
	if (panel) enterPresentationFullscreen(panel);
	editor.goToFrame(start, { present: true });
}

$effect(() => {
	if (!presenting || !panel) return;
	const element = panel;
	return untrack(() => holdPresentation(element, () => editor.exitFrameView()));
});

const presentedId = $derived(presenting ? editor.frameView?.id : undefined);

$effect(() => {
	if (!presentedId || matchMedia("(prefers-reduced-motion: reduce)").matches)
		return;
	untrack(() => panel?.querySelector(".board-stage-host"))?.animate(
		{ opacity: [0, 1] },
		{ duration: 180, easing: "ease-out" },
	);
});

function flushView() {
	if (viewTimer) clearTimeout(viewTimer);
	viewTimer = null;
	if (!pendingView) return;
	writeBoardView(viewUserKey, viewKey, pendingView);
	pendingView = null;
}

function scheduleView(view: BoardCameraState) {
	pendingView = view;
	if (viewTimer) clearTimeout(viewTimer);
	viewTimer = setTimeout(flushView, 300);
}

function openFrame(target: BoardLaunch | null, focus: string | null): boolean {
	const present = target?.present ?? false;
	const frame =
		navigableFrame(focus) ?? (present ? (editor.frames[0]?.id ?? null) : null);
	if (!frame) return false;
	editor.fitView({ animate: false, maxZoom: 1 });
	return editor.goToFrame(frame, { present, animate: false });
}

function openAt(target: BoardLaunch | null) {
	const focus =
		target?.focus && editor.itemById(target.focus) ? target.focus : null;
	const framed = openFrame(target, focus);
	if (!framed && focus) {
		editor.setSelection([focus]);
		editor.focusItems([focus], { animate: false, padding: 48, maxZoom: 1 });
	} else if (!framed) {
		editor.restoreCameraState(
			target?.view ??
				(remembersView ? readBoardView(viewUserKey, viewKey) : null),
		);
	}
	const play = target?.play;
	if (!play || !editor.animations[play.animationId]) return;
	animationOpen = true;
	if (onPlayback)
		editor.setPlayhead({ animationId: play.animationId, time: play.at });
	else
		void sendPlayback({
			type: "play",
			animationId: play.animationId,
			position: play.at,
			commandId: crypto.randomUUID(),
		});
}

let openedLaunch = "";

function handleSurfaceChange(size: { width: number; height: number }) {
	surfaceSize = size;
	if (opened || size.width <= 0 || size.height <= 0) return;
	opened = true;
	openedLaunch = formatBoardLaunch(untrack(() => launch));
	openAt(untrack(() => launch));
}

$effect(() => {
	const key = formatBoardLaunch(launch);
	if (!opened || !key || key === openedLaunch) return;
	openedLaunch = key;
	untrack(() => openAt(launch));
});

$effect(() => {
	surfaceSize;
	const view = editor.cameraState();
	if (!remembersView || !opened || !view) return;
	untrack(() => scheduleView(view));
});

function copySelection() {
	const payload = editor.copySelection();
	if (payload) void writeClipboard(payload);
	return payload !== null;
}

async function copyViewLink() {
	if (!shareUrl) return;
	const [single] = editor.selectedItems;
	const view = editor.cameraState();
	const shown = editor.frameView;
	const target: BoardLaunch = shown
		? { focus: shown.id }
		: editor.selection.length === 1 && single
			? { focus: single.id }
			: view
				? { view }
				: {};
	if (activePlayback && activePlayback.status !== "stopped") {
		const at = playbackClockAt(
			activePlayback,
			editor.document,
			Date.now(),
		).time;
		target.play = { animationId: activePlayback.animationId, at: at ?? 0 };
	}
	const url = new URL(shareUrl());
	url.hash = formatBoardLaunch(target);
	try {
		await copyTextToClipboard(url.href);
		showNotice(m.board_view_link_copied({}, { locale }));
	} catch {}
}

$effect(() => {
	const doc = initialDocument;
	const k = path;
	untrack(() => editor.loadDocument(doc, k));
});

$effect(() => {
	if (!presence) return;
	const viewport = boardAwarenessViewportFromCamera(editor.camera, surfaceSize);
	untrack(() => awareness.setViewport(viewport));
});

$effect(() => {
	if (!presence) return;
	const tool = editor.tool;
	const selection = editor.selection;
	const bounds = editor.bounds;
	const editingId = editor.editingId;
	const formFactor = isMobile ? ("mobile" as const) : ("desktop" as const);
	const scripts = active && pageVisible && editor.hasScripts;
	untrack(() =>
		awareness.updateLocalState({
			client: { formFactor, scripts },
			tool,
			selection,
			bounds,
			editingId,
		}),
	);
});

$effect(() => {
	if (!presence) return;
	editor.interaction;
	editor.geometryVersion;
	untrack(() => awareness.syncGesture(editor));
});

$effect(() => {
	if (!boardClient) return;
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
	} catch {}
}

async function readClipboardText(): Promise<string | null> {
	try {
		if (navigator.clipboard?.readText)
			return await navigator.clipboard.readText();
	} catch {}
	return null;
}

function openItem(item: BoardSceneItem): boolean {
	if (boardAppMeta(item)) {
		runApp(item.id);
		return true;
	}
	if (opensInPlace(item, resolvedAssetSource)) {
		openInPlace(item.id);
		return true;
	}
	if (item.type === "file") {
		openMediaSource(item.props.src);
		return true;
	}
	if (item.type === "task") return openTask(item);
	if (item.type === "session") return sessionActions.open(item);
	return false;
}

function runHostCommand(command: BoardKeyCommand): boolean {
	switch (command.type) {
		case "copy":
			return copySelection();
		case "cut": {
			const payload = editor.cutSelection();
			if (payload) void writeClipboard(payload);
			return payload !== null;
		}
		case "paste":
			void (async () => {
				const text = await readClipboardText();
				if (text) pasteText(text);
				else editor.pasteClipboard();
			})();
			return true;
		case "export":
			openExport();
			return true;
		case "open": {
			const [single] = editor.selectedItems;
			return editor.selection.length === 1 && single ? openItem(single) : false;
		}
		case "escape":
			if (!contextMenu) return false;
			contextMenu = null;
			return true;
		default:
			return false;
	}
}

function handleKeydown(event: KeyboardEvent) {
	if (!receivesKeys() || generationOpen || replayOpen) return;
	if (linkRequest) {
		if (event.key === "Escape") {
			event.preventDefault();
			linkRequest = null;
		}
		return;
	}
	if (event.key === "Escape" && (playingId || modelId)) {
		event.preventDefault();
		closeInPlace();
		return;
	}
	if (isEditableTarget(event.target)) return;
	if (
		editable &&
		!presenting &&
		event.shiftKey &&
		event.code === "KeyA" &&
		!event.metaKey &&
		!event.ctrlKey &&
		!event.altKey
	) {
		event.preventDefault();
		toggleAnimation();
		return;
	}
	handleBoardKeyDown(editor, event, runHostCommand);
}

function handleKeyup(event: KeyboardEvent) {
	if (active) handleBoardKeyUp(editor, event);
}

function clearSpaceHeld() {
	editor.spaceHeld = false;
	awareness.setCursor(null);
}

function handleVisibilityChange() {
	pageVisible = document.visibilityState !== "hidden";
	clearSpaceHeld();
	if (document.visibilityState === "hidden") flushView();
}

function retrySync() {
	if (editor.saveError) {
		editor.retrySave();
		return;
	}
	void onRetrySync?.();
}

function handleContextMenu(request: BoardContextMenuRequest): boolean {
	if (!active || presenting) return false;
	contextMenu = { x: request.clientX, y: request.clientY };
	return true;
}

function blockPageZoom(node: HTMLElement) {
	const block = (event: Event) => {
		if (
			event.type !== "wheel" ||
			(event as WheelEvent).ctrlKey ||
			(event as WheelEvent).metaKey
		)
			event.preventDefault();
	};
	const types = ["wheel", "gesturestart", "gesturechange"];
	for (const type of types)
		node.addEventListener(type, block, { passive: false });
	return {
		destroy() {
			for (const type of types) node.removeEventListener(type, block);
		},
	};
}

onMount(() => {
	if (boardClient) {
		unsubscribeAwareness = boardClient.subscribe({
			awareness: (event) => awareness.receive(event),
			changed: (event) => {
				liveVersion = Math.max(liveVersion, event.payload.version);
			},
		});
	}
	window.addEventListener("paste", handlePaste);
	window.addEventListener("keydown", handleKeydown);
	window.addEventListener("keyup", handleKeyup);
	window.addEventListener("blur", clearSpaceHeld);
	window.addEventListener("pagehide", flushView);
	document.addEventListener("visibilitychange", handleVisibilityChange);
	return () => {
		window.removeEventListener("paste", handlePaste);
		window.removeEventListener("keydown", handleKeydown);
		window.removeEventListener("keyup", handleKeyup);
		window.removeEventListener("blur", clearSpaceHeld);
		window.removeEventListener("pagehide", flushView);
		document.removeEventListener("visibilitychange", handleVisibilityChange);
		const unsubscribe = unsubscribeAwareness;
		unsubscribeAwareness = null;
		void awareness.destroy().finally(() => unsubscribe?.());
	};
});

$effect(() => {
	if (active) return;
	contextMenu = null;
	closeInPlace();
	exportOpen = false;
	generationOpen = false;
	replayOpen = false;
	linkRequest = null;
	clearSpaceHeld();
});

onDestroy(() => {
	if (noticeTimer) clearTimeout(noticeTimer);
	flushView();
	window.removeEventListener("paste", handlePaste);
	window.removeEventListener("keydown", handleKeydown);
	window.removeEventListener("keyup", handleKeyup);
	window.removeEventListener("blur", clearSpaceHeld);
	window.removeEventListener("pagehide", flushView);
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
	bind:this={panel}
	class="board-panel flex h-full min-w-0 flex-col bg-bg-primary"
	class:board-panel--presenting={presenting}
	style:--board-present-backdrop={presenting ? presentBackdrop : undefined}
	data-drawer-swipe-ignore
>
	{#if (syncError || editor.saveError) && !presenting}
		<div
			class="board-sync-notice flex shrink-0 items-center gap-2 border-b border-error-soft/20 bg-error-bg px-3 py-1.5 text-[11px] text-error-soft"
		>
			<span class="min-w-0 flex-1 truncate">{m.board_sync_paused({}, { locale })}</span>
			<button type="button" class="action-btn" onclick={retrySync}>{m.common_retry({}, { locale })}</button>
		</div>
	{/if}

	<div
		class="board-surface relative min-h-0 flex-1 bg-bg-primary"
		class:board-surface--animating={animationOpen && editable && !presenting}
		class:board-surface--recording={editor.recording}
		role="application"
		use:blockPageZoom
	>
		{#if notice}
			<div class="board-notice" class:board-notice--error={notice.error} role="status" aria-live="polite">
				{notice.text}
			</div>
		{/if}

		<BoardStage
			onStageReady={(stage) => {
				scriptStage = stage;
				onStageReady?.(stage);
			}}
			lod={boardLod}
			prefetch={forced?.prefetch}
			{editor}
			playback={activePlayback}
			{assets}
			{active}
			{awareness}
			{awarenessVersion}
			space={spaceId}
			editable={editable && !presenting}
			assetSource={resolvedAssetSource}
			onOpenFile={openMediaSource}
			onAddLinks={addLinks}
			onOpenInPlace={openInPlace}
			onPointerPresence={(cursor) => { if (presence) awareness.setCursor(cursor); }}
			views={itemViews}
			onSurfaceChange={handleSurfaceChange}
			onExportReady={(bridge) => { exportBridge = bridge; }}
			onBackdropChange={(status) => { backdropStatus = status; }}
			onContextMenu={handleContextMenu}
			onActivate={openItem}
			{relatedIds}
			scriptLeader={() => !boardClient || (active && pageVisible && isBoardScriptLeader(boardClient.connectionId, awareness.peers))}
		/>

		{#if boardClient && !presenting}
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

		{#if !editor.hasContent && editable}
			<BoardEmptyState
				onAddText={() => editor.beginTextDraft(editor.viewCenter())}
				onAddShape={() => editor.addShape(editor.viewCenter())}
			/>
		{/if}

		{#if editable}
			<BoardTextEditor {editor} stage={scriptStage} />
		{/if}
		<BoardMediaPlayer
			{editor}
			assetSource={resolvedAssetSource}
			{playingId}
			{active}
			surface={surfaceSize}
			onClose={closeInPlace}
		/>
		{#if modelId}
			<BoardModelViewer
				{editor}
				assetSource={resolvedAssetSource}
				itemId={modelId}
				{isMobile}
				onOpenFile={openMediaSource}
				onClose={closeInPlace}
			/>
		{/if}
		<BoardFrameNav
			{editor}
			{isMobile}
			onPresent={() => present()}
		/>
		{#if !presenting}
			{#if editable && !isMobile}
				<BoardSelectionToolbar
					{editor}
					itemActions={toolbarActions}
					onAddTaskResults={addTaskResults}
					onShowSource={showSource}
					onRegenerateTask={generates ? regenerateTask : undefined}
					onAddToGeneration={generates ? addSelectionToGeneration : undefined}
					{regeneratingItemId}
				/>
				<BoardArrowToolbar {editor} />
				<BoardFloatingToolbar
					onAddLink={() => openLink()}
					{editor}
					{generationOpen}
					{appearanceOpen}
					timelineOpen={animationOpen}
					onToggleGeneration={generates ? toggleGeneration : undefined}
					onToggleAppearance={toggleAppearance}
					onToggleTimeline={toggleAnimation}
				/>
			{/if}
			{#if spaceId && sessionActions.replyItem}
				{#key sessionActions.replyItem.id}
					<BoardSessionReply
						{editor}
						{spaceId}
						sessionId={sessionActions.replyItem.props.sessionId}
						onClose={sessionActions.closeReply}
					/>
				{/key}
			{/if}
			{#if isMobile}
				<BoardMobileChrome
					onAddLink={() => openLink()}
					{editor}
					readonly={!editable}
					{appearanceOpen}
					{generationOpen}
					timelineOpen={animationOpen}
					onToggleAppearance={toggleAppearance}
					onToggleGeneration={generates ? toggleGeneration : undefined}
					onToggleTimeline={editable || hasAnimations ? toggleAnimation : undefined}
					onExport={exportBridge ? openExport : undefined}
					onReplay={history ? () => { replayOpen = true; } : undefined}
					onPresent={hasFrames ? () => present() : undefined}
					contextMenuOpen={contextMenu !== null}
				/>
			{/if}
			{#if scriptPanelOpen && scriptItemId && scriptStatus}
				<BoardScriptPanel
					{editor}
					itemId={scriptItemId}
					status={scriptStatus}
					sheet={isMobile}
					onOpenSource={openFile}
					onRestart={() => { if (scriptItemId) restartScript(scriptItemId); }}
					onClose={() => { scriptPanelOpen = false; }}
				/>
			{/if}
			{#if editable && linkRequest}
				{#key linkRequest}
					<BoardLinkPopover initialUrl={linkRequest.url} onAdd={addLink} onClose={() => { linkRequest = null; }} />
				{/key}
			{/if}
			{#if generates && spaceId && generationOpen}
				<BoardGenerationComposer
					{editor}
					{spaceId}
					{boardId}
					assetSource={resolvedAssetSource}
					selectionAddRequest={generationSelectionRequest}
					onClose={() => { generationOpen = false; }}
				/>
			{/if}
			{#if editable && appearanceOpen}
				<div class="board-appearance-anchor">
					<BoardAppearancePopover
						{editor}
						{backdropStatus}
						onClose={() => { appearanceOpen = false; }}
					/>
				</div>
			{/if}
			{#if !isMobile}
				<BoardZoomMenu
					{editor} timelineOpen={animationOpen}
					onToggleTimeline={!editable && hasAnimations ? toggleAnimation : undefined}
					onPresent={hasFrames ? () => present() : undefined}
				/>
			{/if}
			{#if animationOpen && !editable && hasAnimations}
				<BoardPlaybackBar
					{editor}
					playback={activePlayback}
					onPlayback={sendPlayback}
					onClose={closeAnimation}
				/>
			{/if}
		{/if}

		{#if replayOpen && history && spaceId}
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
					fetchHistory={history.fetchHistory}
					fetchDocument={history.fetchDocument}
					{liveVersion}
					onClose={() => { replayOpen = false; }}
				/>
			{/await}
		{/if}

		{#if contextMenu}
			<BoardContextMenu
				{editor}
				{editable}
				itemActions={menuActions}
				onOpenFile={openMediaSource}
				onAddLink={editable ? () => openLink() : undefined}
				onAddTaskResults={editable ? addTaskResults : undefined}
				onShowSource={showSource}
				{onOpenTask}
				onRegenerateTask={generates ? regenerateTask : undefined}
				{regeneratingItemId}
				onAddToGeneration={generates ? addSelectionToGeneration : undefined}
				position={contextMenu}
				sheet={isMobile}
				onCopy={() => { copySelection(); }}
				onCopyLink={shareUrl ? () => void copyViewLink() : undefined}
				onPresent={present}
				onExport={exportBridge ? openExport : undefined}
				onReplay={history ? () => { contextMenu = null; replayOpen = true; } : undefined}
				onAnimate={editable ? () => { contextMenu = null; animationOpen = true; } : undefined}
				onClose={() => { contextMenu = null; }}
			/>
		{/if}
	</div>

	{#if animationOpen && editable && !presenting}
		<BoardAnimationDock
			{editor}
			{isMobile}
			playback={activePlayback}
			onPlayback={sendPlayback}
			onClose={closeAnimation}
		/>
	{/if}
</div>

<BoardExportDialog
	open={exportOpen}
	onClose={() => { exportOpen = false; }}
	document={editor.document}
	bridge={exportBridge}
	title={path}
	selection={editor.selection}
	onLocate={(id) => { editor.setSelection([id]); editor.focusItems([id]); }}
/>

<style>
	.board-panel--presenting,
	.board-panel--presenting .board-surface {
		background: var(--board-present-backdrop);
	}

	.board-surface--animating::after {
		content: "";
		position: absolute;
		inset: 0;
		z-index: 20;
		box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--brand) 35%, transparent);
		pointer-events: none;
		transition: box-shadow 150ms ease;
	}

	.board-surface--animating.board-surface--recording::after {
		box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--error-500) 70%, transparent);
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

	.board-notice {
		position: absolute;
		top: 12px;
		left: 50%;
		z-index: 32;
		max-width: min(420px, calc(100% - 24px));
		transform: translateX(-50%);
		border: 1px solid var(--border-subtle);
		border-radius: 7px;
		background: var(--bg-elevated);
		padding: 7px 10px;
		color: var(--text-secondary);
		font-size: 11px;
		box-shadow: 0 8px 20px color-mix(in srgb, var(--overlay-scrim-strong) 12%, transparent);
	}

	.board-notice--error {
		border-color: var(--color-error-soft);
		background: var(--color-error-bg);
		color: var(--color-error-soft);
	}
</style>
