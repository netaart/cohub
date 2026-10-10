<script lang="ts">
import type { BoardPlaybackSnapshot } from "@cohub/protocol";
import type {
	BoardFileSnapshotFacts,
	BoardItem,
	BoardScene,
	BoardSceneItem,
	BoardTaskSnapshot,
	WorldPoint,
} from "@neta-art/cohub/board";
import {
	sceneItemToItem,
	taskRunToBoardTaskSnapshot as taskBoardSnapshot,
	worldPoint,
} from "@neta-art/cohub/board";
import type { BoardPointerEvent } from "@neta-art/cohub/board/editor";
import {
	type BoardAssetManager,
	type BoardItemView,
	type BoardLiveStroke,
	type BoardStage,
	mountBoardStage,
} from "@neta-art/cohub/board/stage";
import type { Graphics } from "pixi.js";
import { onDestroy, onMount, untrack } from "svelte";
import { goto } from "$app/navigation";
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
import {
	boardMediaActionAt,
	playableBoardMedia,
} from "$lib/board/board-media-playback";
import {
	type BoardBackgroundLoadState,
	type BoardThemeBackground,
	type BoardThemeSnapshot,
	boardThemeKey,
	resolveBoardBackground,
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
import { withCurrentWindow } from "$lib/features/space/modules/window-route";
import { haptic } from "$lib/haptics";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { buildSpaceTaskRoute } from "$lib/space-routes";
import {
	getCachedTaskRuns,
	mergeCachedTaskRun,
	onTaskRunsCacheUpdated,
	restoreCachedTaskRuns,
} from "$lib/stores/task-runs-cache";
import { getResolvedTheme } from "$lib/theme.svelte";

const {
	editor,
	playback = null,
	assets,
	spaceId,
	assetSource,
	readonly = false,
	active = true,
	awareness,
	awarenessVersion,
	views = [],
	onPointerPresence,
	onSurfaceChange,
	onOpenFile,
	onPlayMedia,
	onExportReady,
	onBackgroundLoadStateChange,
	onLongPress,
	highlightedIds,
}: {
	editor: BoardEditor;
	playback?: BoardPlaybackSnapshot | null;
	assets: BoardAssetManager;
	spaceId: string;
	assetSource: BoardAssetSource;
	readonly?: boolean;
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
	onPlayMedia?: (itemId: string) => void;
	onExportReady?: (bridge: BoardStageExportBridge | null) => void;
	onBackgroundLoadStateChange?: (
		state: BoardBackgroundLoadState | null,
	) => void;
	onLongPress?: (point: { x: number; y: number }) => void;
	highlightedIds?: readonly string[];
} = $props();

const locale = $derived(getLocale());

let host: HTMLDivElement | null = $state(null);
let stage: BoardStage | null = null;
let dropActive = $state(false);
let visibleIds = $state.raw<ReadonlySet<string> | null>(null);
let customThemeVersion = $state(0);
let previewVersion = $state(filePreviewVersion());
let backdropLoadState = $state<BoardBackgroundLoadState | null>(null);
let themeCache: BoardThemeSnapshot | null = null;

function resolveTheme(): BoardThemeSnapshot {
	const key = boardThemeKey(host, customThemeVersion);
	if (themeCache?.key !== key)
		themeCache = resolveBoardTheme(host, customThemeVersion, key);
	return themeCache;
}

const boardBackdrop = $derived.by<BoardThemeBackground | null>(() => {
	getResolvedTheme();
	customThemeVersion;
	return resolveBoardBackground(editor.settings, resolveTheme().background);
});
const backdropReady = $derived(
	Boolean(
		boardBackdrop &&
			backdropLoadState?.url === boardBackdrop.url &&
			backdropLoadState.status === "ready",
	),
);

function handleCustomThemeChanged(event: Event) {
	const { detail } = event as CustomEvent<CustomThemeChangedDetail>;
	if (detail.spaceId !== null && detail.spaceId !== spaceId) return;
	customThemeVersion += 1;
	themeCache = null;
}

const taskDetailRefreshes = new Map<string, string>();
const unsubscribeTaskRuns = onTaskRunsCacheUpdated((event) => {
	if (readonly || event.spaceId !== spaceId) return;
	applyTaskRuns(event.runs);
});

function applyTaskRuns(runs: ReturnType<typeof getCachedTaskRuns>) {
	const wanted = new Set(
		editor.items.flatMap((item) =>
			item.type === "task"
				? [(item.props as { taskRunId: string }).taskRunId]
				: [],
		),
	);
	if (wanted.size === 0) return;
	const snapshots = new Map<string, BoardTaskSnapshot>();
	for (const run of runs) {
		if (wanted.has(run.id)) snapshots.set(run.id, taskBoardSnapshot(run));
	}
	editor.applyTaskSnapshots(snapshots);
	for (const run of runs) {
		if (
			!wanted.has(run.id) ||
			run.taskType !== "generation" ||
			run.status !== "completed" ||
			(snapshots.get(run.id)?.artifacts.length ?? 0) > 0 ||
			taskDetailRefreshes.get(run.id) === run.updatedAt
		)
			continue;
		taskDetailRefreshes.set(run.id, run.updatedAt);
		void sdk.tasks
			.get(run.id)
			.then(({ run: detail }) => {
				if (detail.spaceId !== spaceId) return;
				mergeCachedTaskRun(spaceId, detail);
			})
			.catch(() => undefined);
	}
}

const unsubscribePreviews = subscribeFilePreviews((event) => {
	previewVersion = filePreviewVersion();
	if (readonly || !event || event.spaceId !== spaceId) return;
	assets.invalidatePath(event.path);
	editor.applyMediaFileChange(event.path, event.meta);
});

$effect(() => {
	if (readonly) return;
	previewVersion;
	const targets: Array<{ id: string; path: string }> = [];
	for (const id of visibleIds ?? []) {
		const item = untrack(() => editor.itemById(id));
		if (item?.type !== "file") continue;
		const path = item.props.src;
		const stale = isFilePreviewStale(spaceId, path);
		const unenriched = item.props.snapshot?.mtimeMs === undefined;
		if (stale || unenriched) targets.push({ id: item.id, path });
	}
	if (targets.length > 0) void enrichFileCards(targets);
});

async function enrichFileCards(targets: Array<{ id: string; path: string }>) {
	const resolved = await Promise.all(
		targets.map(async ({ id, path }) => {
			const item = editor.itemById(id);
			if (item?.type !== "file") return null;
			const snapshot = (item.props as { snapshot?: BoardFileSnapshotFacts })
				.snapshot;
			const result = await loadFilePreview(spaceId, {
				path,
				mimeType: snapshot?.mimeType,
				size: snapshot?.size,
				mtimeMs: snapshot?.mtimeMs,
			});
			return { id, snapshot: result.facts, replace: result.complete };
		}),
	);
	const updates = resolved.filter((entry) => entry !== null);
	if (updates.length > 0) editor.applyFileSnapshots(updates);
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
	if (!highlightedIds?.length) return;
	const inv = 1 / Math.max(frame.zoom, 0.0001);
	const brand = resolveTheme().palette.brand;
	const seen = new Set<string>();
	for (const id of highlightedIds) {
		if (!frame.scene.get(id)) continue;
		for (const nodeId of [id, ...frame.scene.descendants(id)]) {
			if (seen.has(nodeId)) continue;
			seen.add(nodeId);
			const item = frame.scene.get(nodeId);
			if (!item) continue;
			const { x, y, width, height } = item.frame;
			overlay
				.roundRect(x, y, width, height, 4 * inv)
				.stroke({ color: brand, width: 1.5 * inv, alpha: 0.75 });
		}
	}
}

const LONG_PRESS_MS = 480;
const LONG_PRESS_SLOP = 10;
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let longPressOrigin: { x: number; y: number } | null = null;

function cancelLongPress() {
	if (longPressTimer) clearTimeout(longPressTimer);
	longPressTimer = null;
	longPressOrigin = null;
}

function scheduleLongPress(event: PointerEvent, input: BoardPointerEvent) {
	cancelLongPress();
	if (!onLongPress || readonly || event.pointerType === "mouse") return;
	if (event.button !== 0 || !editor.itemAt(input.world)) return;
	longPressOrigin = { x: event.clientX, y: event.clientY };
	longPressTimer = setTimeout(() => {
		longPressTimer = null;
		longPressOrigin = null;
		editor.cancelPointerInteraction();
		try {
			host?.releasePointerCapture(event.pointerId);
		} catch {}
		haptic("longPress");
		onLongPress?.({ x: event.clientX, y: event.clientY });
	}, LONG_PRESS_MS);
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
): boolean | undefined {
	switch (phase) {
		case "down": {
			const item = event.button === 0 ? editor.itemAt(input.world) : null;
			const key = item ? assets.assetKey(item) : null;
			if (
				item &&
				playableBoardMedia(item, assetSource) &&
				boardMediaActionAt(item, input.world, stage?.camera.zoom ?? 1, {
					materialized: stage?.isMaterialized(item.id) ?? false,
					hasVideoPreview: Boolean(key && assets.getTexture(key)),
				})
			) {
				event.preventDefault();
				editor.setSelection([item.id]);
				onPlayMedia?.(item.id);
				return false;
			}
			scheduleLongPress(event, input);
			presence(event, input);
			return;
		}
		case "move":
			if (
				longPressOrigin &&
				Math.hypot(
					event.clientX - longPressOrigin.x,
					event.clientY - longPressOrigin.y,
				) > LONG_PRESS_SLOP
			)
				cancelLongPress();
			presence(event, input);
			return;
		case "up":
			cancelLongPress();
			presence(
				event,
				event.type === "pointercancel" || event.pointerType !== "mouse"
					? null
					: input,
			);
			return;
		case "leave":
			cancelLongPress();
			presence(event, null);
			return;
	}
}

function handleDoubleClick(item: BoardSceneItem | null): boolean {
	if (item?.type === "video" || item?.type === "audio") {
		onPlayMedia?.(item.id);
		return true;
	}
	if (item?.type === "file") {
		void onOpenFile?.(item.props.src);
		return true;
	}
	if (item?.type === "task") {
		if (!readonly)
			void goto(
				withCurrentWindow(buildSpaceTaskRoute(spaceId, item.props.taskRunId)),
			);
		return true;
	}
	return false;
}

function spread(clientX: number, clientY: number, index: number): WorldPoint {
	const origin = stage?.toWorld(clientX, clientY) ?? worldPoint(0, 0);
	return worldPoint(origin.x + index * 36, origin.y);
}

function dropFiles(clientX: number, clientY: number, files: BoardDropItem[]) {
	const created = files.map((entry, index) => ({
		id: editor.addFile(
			entry.path,
			spread(clientX, clientY, index),
			entry.snapshot,
		),
		path: entry.path,
	}));
	if (created.length === 0) return;
	editor.setSelection(created.map((entry) => entry.id));
	void enrichFileCards(created);
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

function handleDrop(event: DragEvent) {
	event.preventDefault();
	dropActive = false;
	if (readonly) return;
	const { files, tasks, apps } = readBoardResourceDrop(event.dataTransfer);
	const { clientX, clientY } = event;
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
}

onMount(() => {
	if (!host) return;
	if (!readonly) {
		applyTaskRuns(getCachedTaskRuns(spaceId));
		void restoreCachedTaskRuns(spaceId)
			.then(applyTaskRuns)
			.catch(() => undefined);
	}
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
				imageBackground: backdropReady,
			};
		},
		playback: () => playback,
		fileState: (path) => fileAvailability(spaceId, path),
		previews: remotePreviews,
		strokes: remoteStrokes,
		drawOverlay,
		onPointer: handlePointer,
		onDoubleClick: handleDoubleClick,
		onSurfaceChange: (size) => onSurfaceChange?.(size),
		onVisibleChange: (ids) => {
			visibleIds = ids;
		},
	});
	stage = mounted;
	void mounted.ready.then((ready) => {
		if (!ready || stage !== mounted) return;
		onExportReady?.({
			renderer: () => mounted.renderer,
			theme: () => {
				const { palette, colors, colorScheme } = mounted.theme;
				return { palette, colors, colorScheme };
			},
			assetKey: assets.assetKey,
			withTextures: (items, use) => assets.withTextures(items, use),
		});
	});
	window.addEventListener(CUSTOM_THEME_CHANGED_EVENT, handleCustomThemeChanged);
});

function setBackdropLoadState(state: BoardBackgroundLoadState | null) {
	backdropLoadState = state;
	onBackgroundLoadStateChange?.(state);
}

$effect(() => {
	const url = boardBackdrop?.url ?? null;
	const current = untrack(() => backdropLoadState);
	if (!url) {
		if (current) setBackdropLoadState(null);
		return;
	}
	if (current?.url === url) return;
	setBackdropLoadState({ url, status: "loading" });
	let disposed = false;
	const image = new globalThis.Image();
	image.onload = () => {
		if (!disposed) setBackdropLoadState({ url, status: "ready" });
	};
	image.onerror = () => {
		if (!disposed) setBackdropLoadState({ url, status: "error" });
	};
	image.src = url;
	return () => {
		disposed = true;
		image.onload = null;
		image.onerror = null;
	};
});

$effect(() => {
	const next = active;
	untrack(() => stage?.setActive(next));
});

$effect(() => {
	playback;
	highlightedIds;
	awarenessVersion;
	backdropReady;
	getResolvedTheme();
	customThemeVersion;
	untrack(() => stage?.invalidate());
});

$effect(() => {
	previewVersion;
	untrack(() => stage?.invalidate({ cards: true }));
});

onDestroy(() => {
	cancelLongPress();
	window.removeEventListener(
		CUSTOM_THEME_CHANGED_EVENT,
		handleCustomThemeChanged,
	);
	unsubscribeTaskRuns();
	unsubscribePreviews();
	stage?.destroy();
	stage = null;
	onExportReady?.(null);
	onBackgroundLoadStateChange?.(null);
});

function backdropSize(value: BoardThemeBackground): string {
	if (value.fit === "cover" || value.fit === "contain") return value.fit;
	if (!value.tileWidth || !value.tileHeight) return "auto";
	return `${value.tileWidth * editor.camera.zoom}px ${value.tileHeight * editor.camera.zoom}px`;
}

function backdropPosition(value: BoardThemeBackground): string {
	if (value.fit === "repeat" || value.fit === undefined)
		return `${editor.camera.x}px ${editor.camera.y}px`;
	return value.position ?? "center";
}

function backgroundCssColor(): string | undefined {
	const color = editor.settings.background.color;
	if (typeof color === "object") return color[resolveTheme().colorScheme];
	return color && !color.startsWith("#") && !color.includes("(")
		? `var(--board-${color}, ${color})`
		: color;
}
</script>

<div
	bind:this={host}
	class="board-stage-host relative isolate h-full w-full overflow-hidden {dropActive ? 'board-drop-active' : ''}"
	class:bg-bg-primary={Boolean(boardBackdrop)}
	role="application"
	aria-label={m.board_stage_aria({}, { locale })}
	data-drawer-swipe-ignore
	style:touch-action="none"
	style:background-color={backgroundCssColor()}
	use:pointerDropZone={{
		resolve: (payload) => {
			if (readonly) return null;
			const apps = payload.items.filter((item) => item.type === "app" && item.appId && item.appRef && item.appUrl);
			if (apps.length > 0) return { label: "Add App to Board", effect: "copy" };
			const items = toBoardDropItems(payload);
			if (items.length === 0) return null;
			return { label: m.board_add_to_board({}, { locale }), effect: "copy" };
		},
		drop: (payload, point) => {
			if (readonly) return;
			const apps = payload.items
				.filter((item) => item.type === "app" && item.appId && item.appRef && item.appUrl)
				.map((item) => ({ appId: item.appId as string, ref: item.appRef as string, url: item.appUrl as string, name: item.name, icon: item.icon }));
			dropApps(point.clientX, point.clientY, apps);
			dropFiles(point.clientX, point.clientY, toBoardDropItems(payload));
		},
	}}
	ondragover={(event) => {
		if (readonly) return;
		const types = event.dataTransfer?.types;
		if (!types) return;
		if (types.includes("text/cohub-path") || types.includes("application/x-cohub-resource")) {
			event.preventDefault();
			dropActive = true;
		}
	}}
	ondragleave={() => { dropActive = false; }}
	ondrop={handleDrop}
>
	{#if boardBackdrop && backdropReady}
		<div
			aria-hidden="true"
			class="pointer-events-none absolute inset-0 z-0"
			style:background-image={`url(${JSON.stringify(boardBackdrop.url)})`}
			style:background-position={backdropPosition(boardBackdrop)}
			style:background-repeat={boardBackdrop.fit === "repeat" || boardBackdrop.fit === undefined ? "repeat" : "no-repeat"}
			style:background-size={backdropSize(boardBackdrop)}
			style:opacity={boardBackdrop.opacity ?? 1}
		></div>
	{/if}
</div>

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
