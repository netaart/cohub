<script lang="ts">
import type { BoardPlaybackSnapshot } from "@cohub/protocol";
import type {
	BoardFileSnapshotFacts,
	BoardItem,
	BoardScene,
	BoardSceneItem,
	WorldPoint,
} from "@neta-art/cohub/board";
import {
	boardTextureEdge,
	createMediaBoardItem,
	isBoardModelItem,
	parseBoardMediaSource,
	resolveBoardMediaUrl,
	sceneItemToItem,
	worldPoint,
} from "@neta-art/cohub/board";
import type { BoardPointerEvent } from "@neta-art/cohub/board/editor";
import {
	BOARD_PLAY_MEDIA,
	type BoardLod,
	type BoardRenderLabels,
	resolveBoardBackdrop,
	traceCardOutline,
} from "@neta-art/cohub/board/render";
import {
	type BoardAssetManager,
	type BoardBackdropStatus,
	type BoardContextMenuRequest,
	type BoardFeedback,
	type BoardItemView,
	type BoardLiveStroke,
	type BoardStage,
	mountBoardStage,
} from "@neta-art/cohub/board/stage";
import type { Graphics } from "pixi.js";
import { onDestroy, onMount, untrack } from "svelte";
import { boardAppFace, boardAppMeta } from "$lib/board/board-app";
import type { BoardAssetSource } from "$lib/board/board-asset-source";
import type { BoardAwarenessController } from "$lib/board/board-awareness";
import { drawAwarenessOverlay } from "$lib/board/board-awareness-overlay";
import { readBoardResourceDrop } from "$lib/board/board-drop";
import {
	fileAvailability,
	filePreviewVersion,
	isFilePreviewStale,
	loadFilePreview,
	subscribeFilePreviews,
} from "$lib/board/board-file-preview-source";
import type { BoardStageExportBridge } from "$lib/board/board-image-export";
import { createBoardLiveSessions } from "$lib/board/board-live-sessions.svelte";
import { createBoardLiveTasks } from "$lib/board/board-live-tasks";
import { opensInPlace } from "$lib/board/board-media-playback";
import { boardSessionDropSnapshot } from "$lib/board/board-session";
import {
	type BoardThemeSnapshot,
	boardThemeKey,
	resolveBoardTheme,
} from "$lib/board/board-theme";
import type { BoardEditor } from "$lib/board/editor.svelte";
import {
	CUSTOM_THEME_CHANGED_EVENT,
	type CustomThemeChangedDetail,
} from "$lib/custom-theme/events";
import { pointerDropZone } from "$lib/drag/pointer-drag.svelte";
import {
	type BoardDropItem,
	toBoardDropItems,
} from "$lib/drag/pointer-drag-core";
import { haptic } from "$lib/haptics";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sessionStore } from "$lib/stores/session-store";
import { getResolvedTheme } from "$lib/theme.svelte";

const {
	editor,
	playback = null,
	assets,
	space,
	assetSource,
	editable = true,
	active = true,
	awareness,
	awarenessVersion,
	views = [],
	onPointerPresence,
	onSurfaceChange,
	onOpenFile,
	onAddLinks,
	onOpenInPlace,
	onExportReady,
	onStageReady,
	onBackdropChange,
	onContextMenu,
	onActivate,
	relatedIds,
	lod,
	prefetch,
	drawViews,
	scriptLeader,
}: {
	editor: BoardEditor;
	playback?: BoardPlaybackSnapshot | null;
	assets: BoardAssetManager;
	space: string | null;
	assetSource: BoardAssetSource;
	editable?: boolean;
	active?: boolean;
	awareness: BoardAwarenessController;
	awarenessVersion: number;
	views?: readonly BoardItemView[];
	onPointerPresence?: (
		cursor: {
			x: number;
			y: number;
			pointerType: "mouse" | "pen" | "touch";
		} | null,
	) => void;
	onSurfaceChange?: (size: { width: number; height: number }) => void;
	onOpenFile?: (path: string) => void | Promise<void>;
	onAddLinks?: (urls: string[], at: WorldPoint) => void;
	onOpenInPlace?: (itemId: string) => void;
	onExportReady?: (bridge: BoardStageExportBridge | null) => void;
	onStageReady?: (stage: BoardStage | null) => void;
	onBackdropChange?: (status: BoardBackdropStatus | null) => void;
	onContextMenu?: (request: BoardContextMenuRequest) => boolean;
	onActivate?: (item: BoardSceneItem) => boolean;
	relatedIds?: readonly string[];
	lod?: BoardLod;
	prefetch?: number;
	drawViews?: boolean;
	scriptLeader?: () => boolean;
} = $props();

const locale = $derived(getLocale());

const spaceId = untrack(() => space);
const syncsFiles = untrack(() => editable) && spaceId !== null;

let host: HTMLDivElement | null = $state(null);
let stage: BoardStage | null = null;
let dropActive = $state(false);
let liveIds = $state.raw<ReadonlySet<string> | null>(null);
let customThemeVersion = $state(0);
let previewVersion = $state(filePreviewVersion());
let themeCache: BoardThemeSnapshot | null = null;

function resolveTheme(): BoardThemeSnapshot {
	const key = boardThemeKey(host, customThemeVersion);
	if (themeCache?.key !== key)
		themeCache = resolveBoardTheme(host, customThemeVersion, key);
	return themeCache;
}

const backdropColor = $derived.by(() => {
	getResolvedTheme();
	customThemeVersion;
	const { color } = resolveBoardBackdrop(editor.settings, resolveTheme());
	return `#${color.toString(16).padStart(6, "0")}`;
});

function handleCustomThemeChanged(event: Event) {
	const { detail } = event as CustomEvent<CustomThemeChangedDetail>;
	if (detail.spaceId !== null && detail.spaceId !== spaceId) return;
	customThemeVersion += 1;
	themeCache = null;
}

const liveTasks = spaceId
	? createBoardLiveTasks({
			spaceId,
			onChange: (taskRunIds) => {
				const items = editor.items.flatMap((item) =>
					item.type === "task" && taskRunIds.has(item.props.taskRunId)
						? [item.id]
						: [],
				);
				if (items.length) stage?.invalidate({ items });
			},
		})
	: null;

const liveSessions = spaceId
	? createBoardLiveSessions({
			spaceId,
			sessionIds: () => [
				...new Set(
					Object.values(editor.document.items).flatMap((item) =>
						item.type === "session" ? [item.props.sessionId] : [],
					),
				),
			],
			onChange: (sessionIds) => {
				const items = editor.items.flatMap((item) =>
					item.type === "session" && sessionIds.has(item.props.sessionId)
						? [item.id]
						: [],
				);
				if (items.length) stage?.invalidate({ items });
			},
		})
	: null;

const reducedMotion =
	typeof window === "undefined"
		? null
		: window.matchMedia("(prefers-reduced-motion: reduce)");

function renderLabels(): BoardRenderLabels {
	return {
		queued: m.board_task_queued({}, { locale }),
		generating: m.board_task_generating({}, { locale }),
		failed: m.board_task_failed({}, { locale }),
		previewUnavailable: m.board_task_preview_unavailable({}, { locale }),
		noPreview: m.board_task_no_preview({}, { locale }),
		sessionUntitled: m.sidebar_new_chat({}, { locale }),
		sessionLost: m.session_activity_run_lost({}, { locale }),
		sessionUnavailable: m.board_session_unavailable({}, { locale }),
	};
}

const unsubscribePreviews = subscribeFilePreviews((event) => {
	previewVersion = filePreviewVersion();
	if (!syncsFiles || !event || event.spaceId !== spaceId) return;
	stage?.invalidateScript(event.path);
	editor.applyMediaFileChange(event.path, event.meta);
});

$effect(() => {
	if (!syncsFiles || !spaceId) return;
	previewVersion;
	const targets: Array<{ id: string; path: string }> = [];
	for (const id of liveIds ?? []) {
		const item = untrack(() => editor.itemById(id));
		if (item?.type !== "file") continue;
		const path = item.props.src;
		if (parseBoardMediaSource(path)?.kind !== "file") continue;
		const stale = isFilePreviewStale(spaceId, path);
		const unenriched = item.props.snapshot?.mtimeMs === undefined;
		if (stale || unenriched) targets.push({ id: item.id, path });
	}
	if (targets.length > 0) enrichFileCards(targets);
});

type FileSnapshotUpdate = {
	id: string;
	snapshot: BoardFileSnapshotFacts;
	replace: boolean;
};
let snapshotUpdates: FileSnapshotUpdate[] = [];
let snapshotFrame = 0;

function queueFileSnapshot(update: FileSnapshotUpdate) {
	snapshotUpdates.push(update);
	snapshotFrame ||= requestAnimationFrame(() => {
		snapshotFrame = 0;
		const updates = snapshotUpdates;
		snapshotUpdates = [];
		editor.applyFileSnapshots(updates);
	});
}

const enriching = new Set<string>();

function enrichFileCards(targets: Array<{ id: string; path: string }>) {
	if (!spaceId) return;
	for (const { id, path } of targets) {
		const item = editor.itemById(id);
		if (item?.type !== "file" || item.props.src !== path) continue;
		const key = `${id}\u0000${path}`;
		if (enriching.has(key)) continue;
		enriching.add(key);
		const snapshot = (item.props as { snapshot?: BoardFileSnapshotFacts })
			.snapshot;
		void loadFilePreview(spaceId, {
			path,
			mimeType: snapshot?.mimeType,
			size: snapshot?.size,
			mtimeMs: snapshot?.mtimeMs,
		})
			.then((result) => {
				const current = editor.itemById(id);
				if (current?.type !== "file" || current.props.src !== path) return;
				queueFileSnapshot({
					id,
					snapshot: result.facts,
					replace: result.complete,
				});
			})
			.finally(() => enriching.delete(key));
	}
}

function remotePreviews(): Map<string, BoardItem> {
	const previews = new Map<string, BoardItem>();
	const peers = [...awareness.peers].sort(
		(a, b) => a.lastSeenAt - b.lastSeenAt,
	);
	for (const peer of peers) {
		if (peer.gesture?.kind !== "transform") continue;
		for (const preview of peer.gesture.items) {
			const item = editor.itemById(preview.itemId);
			if (item)
				previews.set(
					preview.itemId,
					sceneItemToItem(
						{ ...item, frame: preview.frame },
						editor.scene.layout,
					),
				);
		}
	}
	return previews;
}

function remoteStrokes(): BoardLiveStroke[] {
	const strokes: BoardLiveStroke[] = [];
	for (const peer of awareness.peers) {
		const gesture = peer.gesture;
		if (gesture?.kind !== "draw") continue;
		strokes.push({
			id: gesture.itemId,
			points: gesture.points,
			color: gesture.color,
			size: gesture.size,
		});
	}
	return strokes;
}

function drawOverlay(
	overlay: Graphics,
	frame: { zoom: number; scene: BoardScene },
) {
	drawAwarenessOverlay(overlay, awareness.peers, resolveTheme(), frame.zoom);
	const inv = 1 / Math.max(frame.zoom, 0.0001);
	const { palette, style } = resolveTheme();
	for (const id of relatedIds ?? []) {
		const item = frame.scene.get(id);
		if (!item) continue;
		traceCardOutline(
			overlay,
			item.frame,
			style,
			(style.selection.outset + 3) * inv,
		).stroke({
			color: palette.muted,
			width: 1.5 * inv,
			alpha: 0.55,
		});
	}
}

const FEEDBACK: Record<BoardFeedback, Parameters<typeof haptic>[0]> = {
	pickup: "longPress",
	menu: "longPress",
	drop: "tick",
	undo: "tick",
	redo: "tick",
};

function handlesHit(item: BoardSceneItem, action: string): boolean {
	return action === BOARD_PLAY_MEDIA && opensInPlace(item, assetSource);
}

function handleHit(item: BoardSceneItem): boolean {
	editor.setSelection([item.id]);
	onOpenInPlace?.(item.id);
	return true;
}

function presence(event: PointerEvent, input: BoardPointerEvent | null) {
	const pointerType =
		event.pointerType === "pen" || event.pointerType === "touch"
			? event.pointerType
			: "mouse";
	onPointerPresence?.(
		input ? { x: input.world.x, y: input.world.y, pointerType } : null,
	);
}

function handlePointer(
	phase: "down" | "move" | "up" | "leave",
	event: PointerEvent,
	input: BoardPointerEvent,
): undefined {
	const gone =
		phase === "leave" ||
		(phase === "up" &&
			(event.type === "pointercancel" || event.pointerType !== "mouse"));
	presence(event, gone ? null : input);
}

function handleDoubleClick(item: BoardSceneItem | null): boolean {
	if (item && boardAppMeta(item)) return onActivate?.(item) ?? false;
	if (item?.type === "video" || item?.type === "audio") {
		onOpenInPlace?.(item.id);
		return true;
	}
	if (item?.type === "file") {
		if (isBoardModelItem(item)) onOpenInPlace?.(item.id);
		else void onOpenFile?.(item.props.src);
		return true;
	}
	if (item?.type === "task" || item?.type === "session")
		return onActivate?.(item) ?? false;
	return false;
}

function spread(clientX: number, clientY: number, index: number): WorldPoint {
	const origin = stage?.toWorld(clientX, clientY) ?? worldPoint(0, 0);
	return worldPoint(origin.x + index * 36, origin.y);
}

function dropFiles(clientX: number, clientY: number, files: BoardDropItem[]) {
	const created = files.map((entry, index) => {
		const at = spread(clientX, clientY, index);
		return createMediaBoardItem(entry.path, at.x, at.y, entry.snapshot);
	});
	if (created.length === 0) return;
	editor.addItems(created, { select: true });
	void enrichFileCards(
		created.flatMap(({ id, item }) =>
			item.type === "file" ? [{ id, path: item.props.src }] : [],
		),
	);
}

function dropApps(
	clientX: number,
	clientY: number,
	apps: Parameters<BoardEditor["addApp"]>[0][],
) {
	if (apps.length === 0) return;
	editor.setSelection(
		apps.map((app, index) =>
			editor.addApp(app, spread(clientX, clientY, index)),
		),
	);
}

function dropSessions(
	clientX: number,
	clientY: number,
	sessions: Array<{ sessionId: string; title?: string }>,
) {
	const ids = sessions.flatMap(({ sessionId, title }, index) => {
		const record = sessionStore.get(sessionId);
		if (record && record.spaceId !== spaceId) return [];
		return [
			editor.addSession(
				sessionId,
				boardSessionDropSnapshot(record, title),
				spread(clientX, clientY, index),
			),
		];
	});
	if (ids.length) editor.setSelection(ids);
}

function handleDrop(event: DragEvent) {
	event.preventDefault();
	dropActive = false;
	if (!editable) return;
	const { files, tasks, sessions, apps, urls } = readBoardResourceDrop(
		event.dataTransfer,
	);
	const { clientX, clientY } = event;
	dropSessions(clientX, clientY, sessions);
	if (tasks.length > 0)
		editor.setSelection(
			tasks.map((task, index) =>
				editor.addTask(
					task.taskRunId,
					task.snapshot,
					spread(clientX, clientY, index),
				),
			),
		);
	dropFiles(clientX, clientY, files);
	dropApps(clientX, clientY, apps);
	if (urls.length) onAddLinks?.(urls, spread(clientX, clientY, 0));
}

onMount(() => {
	if (!host) return;
	const mounted = mountBoardStage(host, {
		editor,
		assets,
		source: assetSource,
		views,
		theme: () => {
			const theme = resolveTheme();
			return {
				key: theme.key,
				palette: theme.palette,
				colors: theme.colors,
				colorScheme: theme.colorScheme,
				style: theme.style,
				backdrop: theme.backdrop,
			};
		},
		playback: () => playback,
		labels: renderLabels,
		taskRun: (taskRunId) => liveTasks?.get(taskRunId) ?? null,
		session: (sessionId) => liveSessions?.get(sessionId) ?? null,
		reducedMotion: () => reducedMotion?.matches ?? false,
		fileState: (path) => (spaceId ? fileAvailability(spaceId, path) : "ok"),
		previews: remotePreviews,
		strokes: remoteStrokes,
		drawOverlay,
		onPointer: handlePointer,
		onHit: handleHit,
		handlesHit,
		onActivate: (item) => onActivate?.(item) ?? false,
		onContextMenu: (request) => onContextMenu?.(request) ?? false,
		onFeedback: (kind) => haptic(FEEDBACK[kind]),
		onDoubleClick: handleDoubleClick,
		onSurfaceChange: (size) => onSurfaceChange?.(size),
		onBackdropChange: (status) => onBackdropChange?.(status),
		onLiveChange: (ids) => {
			liveIds = ids;
		},
		lod: () => lod,
		prefetch,
		drawViews,
		scriptLeader: () => scriptLeader?.() ?? true,
	});
	stage = mounted;
	onStageReady?.(mounted);
	void mounted.ready.then((ready) => {
		if (!ready || stage !== mounted) return;
		onExportReady?.({
			snapshotScripts: () => mounted.snapshotScripts(),
			readModule: async (path) => {
				const url = (await assetSource.resolveFile(path))?.url;
				if (!url) throw new Error("Script module is unavailable.");
				const response = await fetch(url, {
					signal: AbortSignal.timeout(15_000),
				});
				if (!response.ok) throw new Error(`Could not read ${path}.`);
				return response.text();
			},
			resolveMedia: (src) => resolveBoardMediaUrl(src, assetSource),
			renderer: () => mounted.renderer,
			viewTextures: () => mounted.viewTextures,
			theme: () => {
				const { palette, colors, colorScheme, style } = mounted.theme;
				return { palette, colors, colorScheme, style };
			},
			assetKey: assets.assetKey,
			withTextures: (items, scale, use) =>
				assets.withTextures(items, use, {
					edge: (item) => boardTextureEdge(item, scale),
				}),
		});
	});
	window.addEventListener(CUSTOM_THEME_CHANGED_EVENT, handleCustomThemeChanged);
});

$effect(() => {
	const next = active;
	untrack(() => stage?.setActive(next));
});

$effect(() => {
	playback;
	relatedIds;
	lod;
	awarenessVersion;
	getResolvedTheme();
	customThemeVersion;
	untrack(() => stage?.invalidate());
});

$effect(() => {
	previewVersion;
	locale;
	untrack(() => stage?.invalidate({ cards: true }));
});

onDestroy(() => {
	window.removeEventListener(
		CUSTOM_THEME_CHANGED_EVENT,
		handleCustomThemeChanged,
	);
	unsubscribePreviews();
	cancelAnimationFrame(snapshotFrame);
	liveTasks?.destroy();
	liveSessions?.destroy();
	stage?.destroy();
	stage = null;
	onStageReady?.(null);
	onExportReady?.(null);
	onBackdropChange?.(null);
});
</script>

<div
	bind:this={host}
	class="board-stage-host relative isolate h-full w-full overflow-hidden {dropActive ? 'board-drop-active' : ''}"
	role="application"
	aria-label={m.board_stage_aria({}, { locale })}
	data-drawer-swipe-ignore
	style:touch-action="none"
	style:background-color={backdropColor}
	use:pointerDropZone={{
		resolve: (payload) => {
			if (!editable) return null;
			const apps = payload.items.filter((item) => item.type === "app" && item.appId && item.appRef && item.appUrl);
			if (apps.length > 0) return { label: "Add App to Board", effect: "copy" };
			const items = toBoardDropItems(payload);
			if (items.length === 0) return null;
			return { label: m.board_add_to_board({}, { locale }), effect: "copy" };
		},
		drop: (payload, point) => {
			if (!editable) return;
			const apps = payload.items
				.filter((item) => item.type === "app" && item.appId && item.appRef && item.appUrl)
				.map((item) => ({ appId: item.appId as string, ref: item.appRef as string, url: item.appUrl as string, name: item.name, icon: item.icon, ...boardAppFace(item) }));
			dropApps(point.clientX, point.clientY, apps);
			dropFiles(point.clientX, point.clientY, toBoardDropItems(payload));
		},
	}}
	ondragover={(event) => {
		if (!editable) return;
		const types = event.dataTransfer?.types;
		if (!types) return;
		if (types.includes("text/cohub-path") || types.includes("application/x-cohub-resource") || types.includes("text/uri-list") || types.includes("text/plain")) {
			event.preventDefault();
			dropActive = true;
		}
	}}
	ondragleave={() => { dropActive = false; }}
	ondrop={handleDrop}
></div>

<style>
	.board-drop-active::after {
		content: "";
		position: absolute;
		inset: 0.75rem;
		z-index: 2;
		pointer-events: none;
		border: 1px solid var(--brand-border);
		border-radius: 0.75rem;
		background: color-mix(in srgb, var(--brand-bg) 40%, transparent);
	}
</style>
