<script lang="ts">
import type { BoardPlaybackSnapshot } from "@cohub/protocol";
import type {
	BoardArrowItem,
	BoardDrawPoint,
	BoardFileSnapshotFacts,
	BoardItem,
	BoardScene as BoardModelScene,
	BoardSceneItem,
	BoardTaskSnapshot,
	SceneItem,
} from "@neta-art/cohub/board";
import {
	type BoardPlayerFrame,
	type BoardShapeColors,
	type BoardViewport,
	cameraForFocus,
	cameraForState,
	createBoardPlayer,
	featuredTaskArtifact,
	isStrokeCorner,
	pickBoardColor,
	pointToWorld,
	type Rect,
	resolveItemColor,
	resolveSceneArrow,
	type ScreenPoint,
	sampleRadius,
	sceneItemToItem,
	screenPoint,
	screenToWorld,
	shapeCapabilities,
	stableCullRect,
	taskRunToBoardTaskSnapshot as taskBoardSnapshot,
	visibleWorldRect,
	worldPoint,
} from "@neta-art/cohub/board";
import {
	type BoardRenderContext,
	type BoardRenderPalette,
	type BrowserBoardSketchHost,
	createBoardBackground,
	createBoardSketchHost,
	getBoardCardRenderer,
	getBoardResolution,
	parseBoardCssColor,
	textZoomBucket,
	updateBoardBackground,
} from "@neta-art/cohub/board/render";
import {
	Application,
	Container,
	Graphics,
	type Renderer,
	RendererType,
} from "pixi.js";
import { onDestroy, onMount, untrack } from "svelte";
import { goto } from "$app/navigation";
import type { BoardAssetManager } from "$lib/board/board-asset-manager";
import type { BoardAssetSource } from "$lib/board/board-asset-source";
import {
	type BoardAwarenessController,
	collaborationColor,
} from "$lib/board/board-awareness";
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
import { createBoardScene } from "$lib/board/board-scene";
import {
	type BoardBackgroundLoadState,
	type BoardThemeBackground,
	type BoardThemeSnapshot,
	boardThemeKey,
	resolveBoardBackground,
	resolveBoardTheme,
} from "$lib/board/board-theme";
import { resizeCursorForHandle } from "$lib/board/core/selection-transform";
import type { BoardEditor } from "$lib/board/editor.svelte";
import { pointerDropZone } from "$lib/drag/pointer-drag.svelte";
import {
	type BoardDropItem,
	toBoardDropItems,
} from "$lib/drag/pointer-drag-core";
import { withCurrentWindow } from "$lib/features/space/modules/window-route";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { buildSpaceTaskRoute } from "$lib/space-routes";
import { SPACE_STYLE_CHANGED_EVENT } from "$lib/space-style";
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
	onPointerPresence,
	onSurfaceChange,
	onOpenFile,
	onPlayMedia,
	onExportReady,
	onBackgroundLoadStateChange,
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
} = $props();

const locale = $derived(getLocale());

let host: HTMLDivElement | null = $state(null);
let app: Application | null = null;
let world: Container | null = null;
let nodeLayer: Container | null = null;
let background: Container | null = null;
let boardBackdrop: BoardThemeBackground | null = $state(null);
let backdropUrl: string | null = $state(null);
let backdropLoadState: BoardBackgroundLoadState | null = $state(null);
let farLayer: Graphics | null = null;
let overlay: Graphics | null = null;
let scene: ReturnType<typeof createBoardScene> | null = null;
let sketches: BrowserBoardSketchHost | null = null;
let resizeObserver: ResizeObserver | null = null;
let resizeFrame = 0;
let renderFrame = 0;
let dropActive = $state(false);
let surface = $state<{ width: number; height: number }>({
	width: 0,
	height: 0,
});
const player = createBoardPlayer({
	resolveColor: (color) => {
		const theme = resolveTheme();
		return resolveItemColor(
			color,
			"brand",
			theme.colors,
			theme.colorScheme,
			parseBoardCssColor,
		);
	},
});
let tickFrame = 0;
let playbackCamera = $state<BoardViewport | null>(null);
const viewCamera = $derived(playbackCamera ?? editor.camera);
const renderZoom = $derived(viewCamera.zoom);

let lastCullRect: Rect | null = null;
const cullRect = $derived.by<Rect | null>(() => {
	if (surface.width === 0 || surface.height === 0) return null;
	const next = stableCullRect(
		visibleWorldRect(viewCamera, surface.width, surface.height),
	);
	const last = lastCullRect;
	if (
		last &&
		last.x === next.x &&
		last.y === next.y &&
		last.width === next.width &&
		last.height === next.height
	)
		return last;
	lastCullRect = next;
	return next;
});

const visibleIds = $derived.by<Set<string> | null>(() => {
	editor.structureVersion;
	editor.geometryVersion;
	return cullRect ? new Set(editor.idsInRect(cullRect)) : null;
});
let assetVersion = $state(0);
let spaceStyleVersion = $state(0);

function handleSpaceStyleChanged(event: Event) {
	const detail = (event as CustomEvent<{ spaceId?: string | null }>).detail;
	if (detail?.spaceId !== null && detail?.spaceId !== spaceId) return;
	spaceStyleVersion += 1;
	themeCache = null;
}

$effect(() =>
	assets.subscribe(() => {
		assetVersion += 1;
	}),
);

let previewVersion = $state(filePreviewVersion());
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

let themeCache: BoardThemeSnapshot | null = null;

function resolveTheme(): BoardThemeSnapshot {
	const key = boardThemeKey(host, spaceStyleVersion);
	if (themeCache?.key === key) return themeCache;
	const current = resolveBoardTheme(host, spaceStyleVersion, key);
	themeCache = current;
	return current;
}

function getPalette(): BoardRenderPalette {
	return resolveTheme().palette;
}

$effect(() => {
	previewVersion;
	requestPreviews(visibleIds ?? []);
});

function requestPreviews(ids: Iterable<string>) {
	for (const id of ids) {
		const item = editor.itemById(id);
		if (item && assets.assetKey(item)) assets.requestItem(item);
	}
}

$effect(() => {
	assetVersion;
	const pending: Array<{ id: string; width: number; height: number }> = [];
	for (const item of itemsNearViewport()) {
		const taskArtifact =
			item.type === "task"
				? featuredTaskArtifact(item.props.snapshot.artifacts)
				: null;
		const visualArtifact =
			taskArtifact?.type === "image" || taskArtifact?.type === "video"
				? taskArtifact
				: null;
		const recorded = visualArtifact
			? visualArtifact
			: item.type === "image" || item.type === "video"
				? item.props.snapshot
				: null;
		if (!recorded) continue;
		if (recorded.naturalWidth && recorded.naturalHeight) continue;
		const key = assets.assetKey(item);
		if (!key) continue;
		const natural = assets.getNaturalSize(key);
		if (!natural?.width || !natural.height) continue;
		pending.push({ id: item.id, ...natural });
	}
	if (pending.length > 0) editor.adoptMediaNaturalSizes(pending);
});

function itemsNearViewport(): BoardSceneItem[] {
	const ids = visibleIds;
	if (!ids) return [];
	const result: BoardSceneItem[] = [];
	for (const id of ids) {
		const item = editor.itemById(id);
		if (item) result.push(item);
	}
	return result;
}

$effect(() => {
	if (readonly) return;
	previewVersion;
	const targets: Array<{ id: string; path: string }> = [];
	for (const item of itemsNearViewport()) {
		if (item.type !== "file") continue;
		const path = item.props.src;
		const stale = isFilePreviewStale(spaceId, path);
		const unenriched = item.props.snapshot?.mtimeMs === undefined;
		if (!stale && !unenriched) continue;
		targets.push({ id: item.id, path });
	}
	if (targets.length > 0) void enrichFileCards(targets);
});

function buildContext(
	palette: BoardRenderPalette,
	renderScene: BoardModelScene,
	time: number,
): BoardRenderContext {
	const colorScheme = resolveTheme().colorScheme;
	const resizingIds =
		editor.interaction.type === "resizing"
			? new Set(editor.interaction.origin.keys())
			: new Set<string>();
	return {
		settings: editor.settings,
		scene: renderScene,
		time,
		...(sketches ? { sketches } : {}),
		selectedIds: new Set(editor.selection),
		hoveredId: editor.hoverId,
		resizingIds,
		palette,
		colors: resolveTheme().colors,
		colorScheme,
		rendererType: app?.renderer.type === RendererType.CANVAS ? "canvas" : "gpu",
		zoom: renderZoom,
		assetKey: assets.assetKey,
		getTexture: (key) => assets.getTexture(key),
		hasError: (key) => assets.hasError(key),
		fileState: (path) => fileAvailability(spaceId, path),
		acquireTexture: (key) => assets.acquire(key),
		releaseTexture: (key) => assets.release(key),
	};
}

function sameBackdrop(
	left: BoardThemeBackground | null,
	right: BoardThemeBackground | null,
): boolean {
	return (
		left?.url === right?.url &&
		left?.tileWidth === right?.tileWidth &&
		left?.tileHeight === right?.tileHeight &&
		left?.fit === right?.fit &&
		left?.position === right?.position &&
		left?.opacity === right?.opacity
	);
}

function backdropSize(value: BoardThemeBackground): string {
	if (value.fit === "cover" || value.fit === "contain") return value.fit;
	if (!value.tileWidth || !value.tileHeight) return "auto";
	return `${value.tileWidth * editor.camera.zoom}px ${value.tileHeight * editor.camera.zoom}px`;
}

function backdropPosition(value: BoardThemeBackground): string {
	if (value.fit === "repeat" || value.fit === undefined) {
		return `${editor.camera.x}px ${editor.camera.y}px`;
	}
	return value.position ?? "center";
}

function backgroundCssColor(): string | undefined {
	const color = editor.settings.background.color;
	if (typeof color === "object") return color[resolveTheme().colorScheme];
	return color && !color.startsWith("#") && !color.includes("(")
		? `var(--board-${color}, ${color})`
		: color;
}

function syncBackground(theme: BoardThemeSnapshot) {
	if (!app) return;
	const nextBackdrop = resolveBoardBackground(
		editor.settings,
		theme.background,
	);
	if (!sameBackdrop(boardBackdrop, nextBackdrop)) boardBackdrop = nextBackdrop;
	const nextUrl = nextBackdrop?.url ?? null;
	if (backdropUrl !== nextUrl) backdropUrl = nextUrl;
	const context = {
		app,
		settings: editor.settings,
		viewport: editor.camera,
		colorScheme: theme.colorScheme,
		palette: theme.palette,
		hasImageBackground: Boolean(
			nextBackdrop &&
				backdropLoadState?.url === nextBackdrop.url &&
				backdropLoadState.status === "ready",
		),
	};
	if (!background) {
		background = createBoardBackground(context);
		app.stage.addChildAt(background, 0);
		return;
	}
	updateBoardBackground(background, context);
}

function scheduleRender() {
	if (renderFrame || !app || !active) return;
	renderFrame = requestAnimationFrame(() => {
		renderFrame = 0;
		app?.render();
	});
}

function scheduleTick() {
	if (tickFrame || !active) return;
	tickFrame = requestAnimationFrame(() => {
		tickFrame = 0;
		syncStage();
	});
}

function localGestureItemIds(): Set<string> {
	const interaction = editor.interaction;
	switch (interaction.type) {
		case "translating":
		case "resizing":
		case "rotating":
			return new Set(interaction.origin.keys());
		case "draggingArrowHandle":
			return new Set([interaction.arrowId]);
		default:
			return new Set();
	}
}

function remotePreviewItems(): Map<string, BoardItem> {
	const previews = new Map<string, BoardItem>();
	const localIds = localGestureItemIds();
	const peers = [...awareness.peers].sort(
		(a, b) => a.lastSeenAt - b.lastSeenAt,
	);
	for (const peer of peers) {
		if (peer.gesture?.kind !== "transform") continue;
		for (const preview of peer.gesture.items) {
			if (localIds.has(preview.itemId)) continue;
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

function pushMovingItems(frame: BoardPlayerFrame): Map<string, BoardItem> {
	const previews = remotePreviewItems();
	const moving = new Map<string, BoardItem>(previews);
	for (const [id, item] of frame.items) moving.set(id, item);
	editor.setPlayedItems(moving);
	return previews;
}

function applyPlaybackCamera(
	frame: BoardPlayerFrame,
	renderScene: BoardModelScene,
): BoardViewport {
	let camera: BoardViewport = { ...editor.camera };
	const focus = frame.camera.focus;
	if (focus !== undefined && surface.width > 0 && surface.height > 0) {
		camera =
			cameraForFocus(focus, (id) => renderScene.get(id)?.frame, surface, {
				padding: 48,
			}) ?? camera;
	}
	if (frame.camera.zoom !== undefined) {
		camera = { ...camera, zoom: frame.camera.zoom };
	}
	if (frame.camera.center) {
		camera = cameraForState(
			{
				centerX: frame.camera.center.x,
				centerY: frame.camera.center.y,
				zoom: camera.zoom,
			},
			surface,
		);
	}
	if (frame.camera.shake) {
		const t = frame.time / 1000;
		camera = {
			...camera,
			x: camera.x + Math.sin(t * 91.3) * frame.camera.shake,
			y: camera.y + Math.cos(t * 77.9) * frame.camera.shake,
		};
	}
	return camera;
}

function syncStage() {
	if (!app || !world || !scene) return;
	const theme = resolveTheme();
	const palette = theme.palette;
	syncBackground(theme);

	player.enter(editor.consumeRecentlyAdded(), editor.document);
	const frame = player.frame(
		editor.document,
		playback,
		performance.now(),
		Date.now(),
		editor.playhead?.animationId ?? null,
	);
	const previews = pushMovingItems(frame);
	const renderScene = editor.scene;
	const camera = applyPlaybackCamera(frame, renderScene);
	playbackCamera = Object.keys(frame.camera).length > 0 ? camera : null;
	world.x = camera.x;
	world.y = camera.y;
	world.scale.set(camera.zoom);
	if (world.parent !== app.stage) app.stage.addChild(world);

	const context = buildContext(palette, renderScene, frame.time);
	const pinnedIds = new Set(editor.selection);
	for (const id of previews.keys()) pinnedIds.add(id);
	if (editor.editingId) pinnedIds.add(editor.editingId);
	for (const id of frame.items.keys()) {
		pinnedIds.add(id);
		for (const child of renderScene.descendants(id)) pinnedIds.add(child);
		for (const binder of renderScene.binders(id)) pinnedIds.add(binder);
	}

	const globalSig = [
		assetVersion,
		previewVersion,
		resolveTheme().key,
		textZoomBucket(renderZoom),
	].join("|");

	scene.sync({
		items: renderScene.items,
		scene: renderScene,
		context,
		getItem: (id) => renderScene.get(id) ?? null,
		visibleIds,
		pinnedIds,
		globalSig,
		structureVersion: editor.structureVersion,
		geometryVersion: editor.geometryVersion,
		gestureActive:
			editor.gestureActive && editor.interaction.type !== "panning",
	});

	const single =
		editor.selection.length === 1
			? renderScene.get(editor.selection[0] as string)
			: null;
	let arrowEndpoints: Array<{ x: number; y: number }> | undefined;
	if (single?.type === "arrow" && !single.locked) {
		const resolved = resolveSceneArrow(
			single as SceneItem<BoardArrowItem>,
			renderScene,
		);
		arrowEndpoints = [resolved.start.point, resolved.mid, resolved.end.point];
	}
	scene.drawOverlay(
		{
			zoom: viewCamera.zoom,
			pointerType: editor.pointerType,
			marquee: editor.marquee,
			selection: editor.selection,
			transform: editor.selectionTransform,
			controls: editor.tool === "select",
			hoveredControl: editor.hoveredTransformControl,
			rotationPointer:
				editor.interaction.type === "rotating"
					? editor.interaction.current
					: null,
			arrowEndpoints,
			ports: editor.connectionPorts,
			hoveredPort: editor.hoveredConnectionPort,
			arrowDraft: null,
			bindTarget:
				editor.bindTargetFrame ?? editor.arrowDraft?.targetFrame ?? null,
		},
		palette,
	);

	drawRemoteAwareness(context.colors, context.colorScheme);
	drawTransient(palette, context.colors, context.colorScheme);

	scheduleRender();
	if (frame.running || scene.animated) scheduleTick();
}

function drawFreehandStroke(
	graphics: Graphics,
	points: readonly BoardDrawPoint[],
	style: { color: number; size: number; alpha: number },
) {
	if (points.length === 0) return;
	if (points.length === 1) {
		const point = points[0];
		if (point) {
			graphics
				.circle(point.x, point.y, sampleRadius(style.size, point.p))
				.fill({
					color: style.color,
					alpha: style.alpha,
				});
		}
		return;
	}
	for (let index = 1; index < points.length; index += 1) {
		const from = points[index - 1];
		const to = points[index];
		if (!from || !to) continue;
		const width =
			sampleRadius(style.size, from.p) + sampleRadius(style.size, to.p);
		graphics.moveTo(from.x, from.y).lineTo(to.x, to.y).stroke({
			color: style.color,
			width,
			alpha: style.alpha,
			cap: "round",
			join: "round",
		});
	}
	for (let index = 0; index < points.length; index += 1) {
		const point = points[index];
		if (!point) continue;
		if (!isStrokeCorner(points, index)) continue;
		graphics.circle(point.x, point.y, sampleRadius(style.size, point.p)).fill({
			color: style.color,
			alpha: style.alpha,
		});
	}
}

function drawRemoteAwareness(colors: BoardShapeColors, mode: "dark" | "light") {
	if (!overlay) return;
	const inv = 1 / Math.max(editor.camera.zoom, 0.0001);
	for (const peer of awareness.peers) {
		const collaboration = collaborationColor(peer.actorId);
		const selection = peer.state?.selection;
		if (selection?.bounds && selection.count > 0) {
			const bounds = selection.bounds;
			const editing = peer.state?.editingId != null;
			overlay.rect(bounds.x, bounds.y, bounds.width, bounds.height).stroke({
				color: collaboration,
				width: (editing ? 2 : 1.25) * inv,
				alpha: editing ? 0.94 : 0.82,
			});
			if (editing) {
				overlay
					.circle(bounds.x, bounds.y, 3.5 * inv)
					.fill({ color: collaboration, alpha: 0.96 });
			}
		}

		const gesture = peer.gesture;
		if (!gesture) continue;
		if (gesture.kind === "draw") {
			const color = pickBoardColor(colors, gesture.color, mode);
			drawFreehandStroke(overlay, gesture.points, {
				color: color.stroke,
				size: gesture.size,
				alpha: 0.9,
			});
			continue;
		}
		if (gesture.kind === "arrow") {
			const color = pickBoardColor(colors, gesture.color, mode);
			const angle = Math.atan2(
				gesture.current.y - gesture.start.y,
				gesture.current.x - gesture.start.x,
			);
			const head = Math.max(14, 16 * inv);
			const spread = Math.PI / 6;
			overlay
				.moveTo(gesture.start.x, gesture.start.y)
				.lineTo(gesture.current.x, gesture.current.y)
				.stroke({
					color: color.stroke,
					width: Math.max(gesture.size, 1.5 * inv),
					alpha: 0.88,
				});
			overlay
				.moveTo(
					gesture.current.x - head * Math.cos(angle - spread),
					gesture.current.y - head * Math.sin(angle - spread),
				)
				.lineTo(gesture.current.x, gesture.current.y)
				.lineTo(
					gesture.current.x - head * Math.cos(angle + spread),
					gesture.current.y - head * Math.sin(angle + spread),
				)
				.stroke({
					color: color.stroke,
					width: Math.max(gesture.size, 1.5 * inv),
					alpha: 0.92,
					cap: "round",
					join: "round",
				});
			continue;
		}
		if (gesture.kind === "box") {
			const color = pickBoardColor(colors, gesture.color, mode);
			const x = Math.min(gesture.start.x, gesture.current.x);
			const y = Math.min(gesture.start.y, gesture.current.y);
			const width = Math.max(1, Math.abs(gesture.current.x - gesture.start.x));
			const height = Math.max(1, Math.abs(gesture.current.y - gesture.start.y));
			overlay
				.roundRect(x, y, width, height, 4)
				.fill({ color: color.fill, alpha: 0.05 })
				.stroke({ color: color.stroke, width: 1.5 * inv, alpha: 0.82 });
			continue;
		}
		if (gesture.kind === "transform" && gesture.bounds) {
			overlay
				.rect(
					gesture.bounds.x,
					gesture.bounds.y,
					gesture.bounds.width,
					gesture.bounds.height,
				)
				.stroke({
					color: collaboration,
					width: 1.5 * inv,
					alpha: 0.88,
				});
		}
	}
}

function drawTransient(
	palette: BoardRenderPalette,
	colors: BoardShapeColors,
	mode: "dark" | "light",
) {
	if (!overlay) return;
	const zoom = editor.camera.zoom;
	const inv = 1 / Math.max(zoom, 0.0001);
	const interaction = editor.interaction;

	for (const guide of editor.snapGuides) {
		overlay
			.moveTo(
				guide.axis === "x" ? guide.at : guide.from,
				guide.axis === "x" ? guide.from : guide.at,
			)
			.lineTo(
				guide.axis === "x" ? guide.at : guide.to,
				guide.axis === "x" ? guide.to : guide.at,
			)
			.stroke({ color: palette.brand, width: inv, alpha: 0.9 });
	}

	if (interaction.type === "drawing" && interaction.points.length > 0) {
		const color = pickBoardColor(colors, interaction.color, mode);
		drawFreehandStroke(overlay, interaction.points, {
			color: color.stroke,
			size: interaction.size,
			alpha: 0.92,
		});
	}

	if (interaction.type === "creatingArrow") {
		const color = pickBoardColor(colors, interaction.color, mode);
		const start = interaction.start;
		const target = interaction.targetItemId
			? editor.itemById(interaction.targetItemId)
			: null;
		const current = target
			? worldPoint(
					target.frame.x + target.frame.width / 2,
					target.frame.y + target.frame.height / 2,
				)
			: interaction.current;
		overlay
			.moveTo(start.x, start.y)
			.lineTo(current.x, current.y)
			.stroke({
				color: color.stroke,
				width: Math.max(interaction.size, 1.5 * inv),
				alpha: 0.9,
			});
		const angle = Math.atan2(current.y - start.y, current.x - start.x);
		const head = Math.max(14, 16 * inv);
		const spread = Math.PI / 6;
		overlay
			.moveTo(
				current.x - head * Math.cos(angle - spread),
				current.y - head * Math.sin(angle - spread),
			)
			.lineTo(current.x, current.y)
			.lineTo(
				current.x - head * Math.cos(angle + spread),
				current.y - head * Math.sin(angle + spread),
			)
			.stroke({
				color: color.stroke,
				width: Math.max(interaction.size, 1.5 * inv),
				alpha: 0.95,
				cap: "round",
				join: "round",
			});
	}

	if (interaction.type === "creatingBox") {
		const color = pickBoardColor(colors, interaction.color, mode);
		const { start, current } = interaction;
		const x = Math.min(start.x, current.x);
		const y = Math.min(start.y, current.y);
		const w = Math.abs(current.x - start.x);
		const h = Math.abs(current.y - start.y);
		if (w > 1 || h > 1) {
			overlay
				.roundRect(x, y, Math.max(w, 1), Math.max(h, 1), 4)
				.fill({ color: color.fill, alpha: 0.04 })
				.stroke({
					color: color.stroke,
					width: 1.5 * inv,
					alpha: 0.85,
				});
		}
	}
}

function reportSurfaceSize() {
	if (!app) {
		surface = { width: 0, height: 0 };
		onSurfaceChange?.({ width: 0, height: 0 });
		return;
	}
	surface = { width: app.screen.width, height: app.screen.height };
	onSurfaceChange?.({ width: app.screen.width, height: app.screen.height });
}

function resizeStage() {
	if (!app) return;
	cancelAnimationFrame(resizeFrame);
	resizeFrame = requestAnimationFrame(() => {
		if (!app) return;
		app.resize();
		reportSurfaceSize();
		syncStage();
	});
}

function toScreenPoint(
	event: PointerEvent | WheelEvent | MouseEvent,
): ScreenPoint {
	if (!host) return screenPoint(0, 0);
	const rect = host.getBoundingClientRect();
	return screenPoint(event.clientX - rect.left, event.clientY - rect.top);
}

function inputCamera() {
	return playbackCamera ?? editor.camera;
}
function toPointerEvent(event: PointerEvent) {
	const screen = toScreenPoint(event);
	return {
		pointerId: event.pointerId,
		screen,
		world: pointToWorld(screen, inputCamera()),
		shiftKey: event.shiftKey,
		metaKey: event.metaKey,
		ctrlKey: event.ctrlKey,
		altKey: event.altKey,
		button: event.button,
		buttons: event.buttons,
		pointerType: event.pointerType,
		cancelled:
			event.type === "pointercancel" || event.type === "lostpointercapture",
		pressure:
			event.pointerType === "pen" && event.pressure > 0 ? event.pressure : 0.5,
	};
}

function pointerType(event: PointerEvent): "mouse" | "pen" | "touch" {
	if (event.pointerType === "pen" || event.pointerType === "touch")
		return event.pointerType;
	return "mouse";
}

function publishPointerPresence(event: PointerEvent) {
	const point = toPointerEvent(event).world;
	onPointerPresence?.({
		x: point.x,
		y: point.y,
		pointerType: pointerType(event),
	});
}

function handlePointerDown(event: PointerEvent) {
	if (!host) return;
	const input = toPointerEvent(event);
	if (event.button === 0) {
		const item = editor.itemAt(input.world);
		const key = item ? assets.assetKey(item) : null;
		if (
			item &&
			playableBoardMedia(item, assetSource) &&
			boardMediaActionAt(item, input.world, inputCamera().zoom, {
				materialized: Boolean(scene?.getNode(item.id)),
				hasVideoPreview: Boolean(key && assets.getTexture(key)),
			})
		) {
			event.preventDefault();
			editor.setSelection([item.id]);
			onPlayMedia?.(item.id);
			return;
		}
	}
	host.setPointerCapture(event.pointerId);
	editor.pointerDown(input);
	onPointerPresence?.({
		x: input.world.x,
		y: input.world.y,
		pointerType: pointerType(event),
	});
}

function handlePointerMove(event: PointerEvent) {
	const input = toPointerEvent(event);
	editor.pointerMove(input);
	onPointerPresence?.({
		x: input.world.x,
		y: input.world.y,
		pointerType: pointerType(event),
	});
}

function handlePointerUp(event: PointerEvent) {
	editor.pointerUp(toPointerEvent(event));
	if (event.type === "pointercancel" || event.pointerType !== "mouse") {
		editor.pointerLeave();
		onPointerPresence?.(null);
	} else {
		publishPointerPresence(event);
	}
}

function handlePointerLeave(event: PointerEvent) {
	if (event.buttons !== 0) return;
	editor.pointerLeave();
	onPointerPresence?.(null);
}

function handleWheel(event: WheelEvent) {
	event.preventDefault();
	editor.wheel(
		toScreenPoint(event),
		event.deltaX,
		event.deltaY,
		event.ctrlKey || event.metaKey,
		event.deltaMode,
	);
}

function handleDoubleClick(event: MouseEvent) {
	const rect = host?.getBoundingClientRect() ?? new DOMRect();
	const worldPointAtCursor = screenToWorld(
		event.clientX,
		event.clientY,
		rect,
		inputCamera(),
	);
	const item = editor.itemAt(worldPointAtCursor);
	if (item && (item.type === "video" || item.type === "audio")) {
		onPlayMedia?.(item.id);
		return;
	}
	if (item?.type === "file") {
		void onOpenFile?.((item.props as { src: string }).src);
		return;
	}
	if (item?.type === "task") {
		if (!readonly)
			void goto(
				withCurrentWindow(
					buildSpaceTaskRoute(
						spaceId,
						(item.props as { taskRunId: string }).taskRunId,
					),
				),
			);
		return;
	}
	if (readonly) return;
	if (item && !item.locked && shapeCapabilities(item).canEdit) {
		editor.editingId = item.id;
	} else if (!item || item.type === "frame" || item.type === "arrow") {
		const label = editor.labelItemAt(worldPointAtCursor);
		if (label) editor.editingId = label.id;
		else if (!item) editor.beginTextDraft(worldPointAtCursor);
	}
}

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
	const updates = resolved.filter(
		(
			entry,
		): entry is {
			id: string;
			snapshot: BoardFileSnapshotFacts;
			replace: boolean;
		} => entry !== null,
	);
	if (updates.length > 0) editor.applyFileSnapshots(updates);
}

type BoardTaskDropItem = {
	taskRunId: string;
	snapshot: BoardTaskSnapshot;
};

type BoardAppDropItem = {
	appId: string;
	ref: string;
	url: string;
	name: string;
	icon?: string;
};

function handleDrop(event: DragEvent) {
	event.preventDefault();
	dropActive = false;
	if (readonly) return;

	const items: BoardDropItem[] = [];
	const taskItems: BoardTaskDropItem[] = [];
	const appItems: BoardAppDropItem[] = [];

	const raw = event.dataTransfer?.getData("application/x-cohub-resource");
	if (raw) {
		try {
			const payload = JSON.parse(raw) as {
				resources?: Array<{
					type?: string;
					title?: string;
					path?: string;
					ref?: string;
					appId?: string;
					icon?: string;
					href?: string;
					mimeType?: string;
					size?: number;
					mtimeMs?: number;
					taskRunId?: string;
					snapshot?: BoardTaskSnapshot;
				}>;
			};
			for (const resource of payload.resources ?? []) {
				if (
					resource.type === "app" &&
					resource.appId &&
					resource.ref &&
					resource.href &&
					resource.title
				) {
					appItems.push({
						appId: resource.appId,
						ref: resource.ref,
						url: resource.href,
						name: resource.title,
						icon: resource.icon,
					});
					continue;
				}
				if (
					resource.type === "task" &&
					resource.taskRunId &&
					resource.snapshot
				) {
					taskItems.push({
						taskRunId: resource.taskRunId,
						snapshot: resource.snapshot,
					});
					continue;
				}
				if (resource.type && resource.type !== "file") continue;
				const path = (resource.path ?? resource.ref ?? "").replace(/\/$/, "");
				if (!path) continue;
				items.push({
					path,
					snapshot: {
						title: resource.title,
						mimeType: resource.mimeType,
						size: resource.size,
						mtimeMs: resource.mtimeMs,
					},
				});
			}
		} catch {}
	}

	if (items.length === 0 && taskItems.length === 0) {
		const path = event.dataTransfer
			?.getData("text/cohub-path")
			?.replace(/\/$/, "");
		if (path && !path.startsWith("cohub://tasks/")) items.push({ path });
	}

	if (taskItems.length > 0)
		dropTaskItems(event.clientX, event.clientY, taskItems);
	if (items.length > 0) dropBoardItems(event.clientX, event.clientY, items);
	if (appItems.length > 0) dropAppItems(event.clientX, event.clientY, appItems);
}

function dropBoardItems(
	clientX: number,
	clientY: number,
	items: BoardDropItem[],
) {
	if (!host || items.length === 0) return;
	const rect = host.getBoundingClientRect();
	const origin = screenToWorld(clientX, clientY, rect, editor.camera);

	let offsetX = 0;
	const created: Array<{ id: string; path: string }> = [];
	for (const entry of items) {
		const id = editor.addFile(
			entry.path,
			worldPoint(origin.x + offsetX, origin.y),
			entry.snapshot,
		);
		created.push({ id, path: entry.path });
		offsetX += 36;
	}
	if (created.length > 0) {
		editor.setSelection(created.map((entry) => entry.id));
		void enrichFileCards(created);
	}
}

function dropAppItems(
	clientX: number,
	clientY: number,
	items: BoardAppDropItem[],
) {
	if (!host || items.length === 0) return;
	const rect = host.getBoundingClientRect();
	const origin = screenToWorld(clientX, clientY, rect, editor.camera);
	const created = items.map((entry, index) =>
		editor.addApp(entry, worldPoint(origin.x + index * 36, origin.y)),
	);
	editor.setSelection(created);
}

function dropTaskItems(
	clientX: number,
	clientY: number,
	items: BoardTaskDropItem[],
) {
	if (!host || items.length === 0) return;
	const rect = host.getBoundingClientRect();
	const origin = screenToWorld(clientX, clientY, rect, editor.camera);
	const created = items.map((entry, index) =>
		editor.addTask(
			entry.taskRunId,
			entry.snapshot,
			worldPoint(origin.x + index * 36, origin.y),
		),
	);
	editor.setSelection(created);
}

const ROTATE_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5' fill='none' stroke='%23fff' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5' fill='none' stroke='%231d1d1f' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") 12 12, crosshair`;

const cursor = $derived.by(() => {
	const interaction = editor.interaction;
	if (interaction.type === "panning") return "grabbing";
	if (interaction.type === "translating") return "grabbing";
	if (interaction.type === "resizing")
		return resizeCursorForHandle(
			interaction.handle,
			interaction.single?.rotation ?? 0,
		);
	if (interaction.type === "rotating") return ROTATE_CURSOR;
	if (interaction.type === "draggingArrowHandle") return "crosshair";
	if (interaction.type === "brushing") return "crosshair";
	if (editor.spaceHeld || editor.tool === "hand") return "grab";

	const control = editor.hoveredTransformControl;
	if (control?.kind === "resize")
		return resizeCursorForHandle(
			control.handle,
			editor.selectionTransform?.frame.rotation ?? 0,
		);
	if (control?.kind === "rotate") return ROTATE_CURSOR;

	switch (editor.tool) {
		case "draw":
		case "arrow":
		case "shape":
		case "frame":
		case "text":
			return "crosshair";
		default: {
			const hovered = editor.hoverId ? editor.itemById(editor.hoverId) : null;
			return hovered && !hovered.locked && shapeCapabilities(hovered).canMove
				? "move"
				: "default";
		}
	}
});

let disposed = false;

onMount(async () => {
	if (!host) return;
	if (!readonly) {
		applyTaskRuns(getCachedTaskRuns(spaceId));
		void restoreCachedTaskRuns(spaceId)
			.then(applyTaskRuns)
			.catch(() => undefined);
	}
	const instance = new Application();
	try {
		await instance.init({
			antialias: true,
			autoDensity: true,
			backgroundAlpha: 0,
			resizeTo: host,
			resolution: getBoardResolution(),
			autoStart: false,
		});
	} catch (error) {
		console.error("{m.board_failed_init({}, { locale })}", error);
		instance.destroy({ removeView: true });
		return;
	}
	if (disposed) {
		instance.destroy({ removeView: true });
		return;
	}
	app = instance;
	instance.canvas.classList.add("board-stage-canvas");
	host.appendChild(instance.canvas);
	world = new Container({ isRenderGroup: true, label: "board-world" });
	nodeLayer = new Container({ label: "board-nodes" });
	overlay = new Graphics({ label: "board-interaction-overlay" });
	farLayer = new Graphics({ label: "board-far-layer" });
	nodeLayer.addChild(farLayer);
	world.addChild(nodeLayer, overlay);
	scene = createBoardScene({
		world: nodeLayer,
		farLayer,
		overlay,
		getRenderer: getBoardCardRenderer,
		onFarLayerFrame: scheduleRender,
	});
	sketches = createBoardSketchHost({
		readModule: async (src) => {
			const url = await assetSource.resolveFileUrl(src);
			if (!url) throw new Error(`${src} is not available.`);
			const response = await fetch(url);
			if (!response.ok) throw new Error(`${src} could not be read.`);
			return response.text();
		},
		onFrame: () => syncStage(),
	});

	onExportReady?.({
		renderer: () => (app ? (app.renderer as unknown as Renderer) : null),
		theme: () => {
			const resolved = resolveTheme();
			return {
				palette: resolved.palette,
				colors: resolved.colors,
				colorScheme: resolved.colorScheme,
			};
		},
		assetKey: assets.assetKey,
		withTextures: (items, use) => assets.withTextures(items, use),
	});

	host.addEventListener("pointerdown", handlePointerDown);
	host.addEventListener("pointermove", handlePointerMove);
	host.addEventListener("pointerup", handlePointerUp);
	host.addEventListener("pointercancel", handlePointerUp);
	host.addEventListener("lostpointercapture", handlePointerUp);
	host.addEventListener("pointerleave", handlePointerLeave);
	host.addEventListener("wheel", handleWheel, { passive: false });
	host.addEventListener("dblclick", handleDoubleClick);

	resizeObserver = new ResizeObserver(resizeStage);
	resizeObserver.observe(host);
	resizeStage();
	window.addEventListener(SPACE_STYLE_CHANGED_EVENT, handleSpaceStyleChanged);
});

function setBackdropLoadState(state: BoardBackgroundLoadState | null) {
	backdropLoadState = state;
	onBackgroundLoadStateChange?.(state);
}

$effect(() => {
	const url = backdropUrl;
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
	if (!active) {
		cancelAnimationFrame(renderFrame);
		cancelAnimationFrame(tickFrame);
		renderFrame = 0;
		tickFrame = 0;
		return;
	}
	untrack(() => {
		player.reset();
		resizeStage();
		syncStage();
	});
});

$effect(() => {
	editor.items;
	editor.camera;
	editor.selection;
	editor.hoverId;
	editor.marquee;
	editor.bounds;
	editor.interaction;
	editor.snapGuides;
	editor.structureVersion;
	editor.geometryVersion;
	editor.scene;
	playback;
	awarenessVersion;
	assetVersion;
	getResolvedTheme();
	spaceStyleVersion;
	untrack(scheduleTick);
});

onDestroy(() => {
	disposed = true;
	editor.setPlayedItems(new Map());
	window.removeEventListener(
		SPACE_STYLE_CHANGED_EVENT,
		handleSpaceStyleChanged,
	);
	resizeObserver?.disconnect();
	cancelAnimationFrame(resizeFrame);
	cancelAnimationFrame(renderFrame);
	cancelAnimationFrame(tickFrame);
	unsubscribeTaskRuns();
	unsubscribePreviews();
	if (host) {
		host.removeEventListener("pointerdown", handlePointerDown);
		host.removeEventListener("pointermove", handlePointerMove);
		host.removeEventListener("pointerup", handlePointerUp);
		host.removeEventListener("pointercancel", handlePointerUp);
		host.removeEventListener("lostpointercapture", handlePointerUp);
		host.removeEventListener("pointerleave", handlePointerLeave);
		host.removeEventListener("wheel", handleWheel);
		host.removeEventListener("dblclick", handleDoubleClick);
	}
	const context = buildContext(getPalette(), editor.scene, 0);
	scene?.destroy(context);
	scene = null;
	sketches?.destroy();
	sketches = null;
	background?.destroy({ children: true });
	background = null;
	nodeLayer = null;
	world = null;
	overlay = null;
	farLayer = null;
	app?.destroy({ removeView: true });
	app = null;
	onExportReady?.(null);
	onBackgroundLoadStateChange?.(null);
});
</script>

<div
	bind:this={host}
	class="board-stage-host relative isolate h-full w-full overflow-hidden {dropActive ? 'board-drop-active' : ''}"
	class:bg-bg-primary={Boolean(boardBackdrop)}
	role="application"
	aria-label={m.board_stage_aria({}, { locale })}
	data-drawer-swipe-ignore
	style:cursor={cursor}
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
			if (apps.length > 0) dropAppItems(point.clientX, point.clientY, apps);
			const items = toBoardDropItems(payload);
			if (items.length > 0) dropBoardItems(point.clientX, point.clientY, items);
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
	{#if boardBackdrop && backdropLoadState?.url === boardBackdrop.url && backdropLoadState.status === "ready"}
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
	.board-stage-host :global(.board-stage-canvas) {
		position: relative;
		z-index: 1;
		display: block;
	}

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
