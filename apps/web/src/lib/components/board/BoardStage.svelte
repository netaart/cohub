<script lang="ts">
import type {
	BoardFileSnapshot,
	BoardItem,
	BoardTaskSnapshot,
	DrawPoint,
} from "@neta-art/cohub/board";
import {
	type BoardShapeColors,
	featuredTaskArtifact,
	isStrokeCorner,
	pickBoardColor,
	pointToWorld,
	type Rect,
	resolveArrow,
	type ScreenPoint,
	sampleRadius,
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
	createBoardBackground,
	getBoardCardRenderer,
	getBoardResolution,
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
import type { BoardRuntimeData } from "$lib/board/runtime/board-runtime";
import { createBoardAnimationRuntime } from "$lib/board/runtime/pixi-animation";
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
	runtime,
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
	runtime: BoardRuntimeData;
	/**
	 * Preview texture owner. Shared by every stage showing the same board (the
	 * live editor and its replay overlay) so a texture one stage releases is not
	 * torn out from under another — Pixi's `Assets` cache hands back the same
	 * texture instance per URL.
	 */
	assets: BoardAssetManager;
	/**
	 * Cache scope for previews. Still required in view mode: it namespaces asset
	 * keys so identical paths from different Spaces never collide.
	 */
	spaceId: string;
	/** Where referenced media is resolved from (live Space or published artifact). */
	assetSource: BoardAssetSource;
	/**
	 * View-only stage: no drops, no shape editing, and no workspace reads. A
	 * published Board is rendered from its snapshot alone.
	 */
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
	/** Open a workspace file in the preview panel (same target as the file tree). */
	onOpenFile?: (path: string) => void | Promise<void>;
	/** Start the single local media player for a playable node. */
	onPlayMedia?: (nodeId: string) => void;
	/**
	 * Hands the parent a way to export using this stage's live renderer and
	 * already-resolved theme. Passing a getter (rather than the renderer itself)
	 * keeps the caller from holding a reference past the stage's lifetime.
	 */
	onExportReady?: (bridge: BoardStageExportBridge | null) => void;
	onBackgroundLoadStateChange?: (
		state: BoardBackgroundLoadState | null,
	) => void;
} = $props();

const locale = $derived(getLocale());

let host: HTMLDivElement | null = $state(null);
let app: Application | null = null;
let world: Container | null = null;
let effectsBehind: Container | null = null;
let nodeLayer: Container | null = null;
let effectsFront: Container | null = null;
let screenEffects: Container | null = null;
let background: Container | null = null;
let boardBackdrop: BoardThemeBackground | null = $state(null);
let backdropUrl: string | null = $state(null);
let backdropLoadState: BoardBackgroundLoadState | null = $state(null);
let farLayer: Graphics | null = null;
let overlay: Graphics | null = null;
let scene: ReturnType<typeof createBoardScene> | null = null;
let animationRuntime: ReturnType<typeof createBoardAnimationRuntime> | null =
	null;
let resizeObserver: ResizeObserver | null = null;
let resizeFrame = 0;
// Render-on-demand: Pixi's ticker is disabled (autoStart: false) so an idle
// board draws nothing. Each scene sync schedules exactly one render for the
// next animation frame, coalescing bursts of updates into a single draw.
let renderFrame = 0;
let dropActive = $state(false);
let surface = $state<{ width: number; height: number }>({
	width: 0,
	height: 0,
});

// Keep the previous rect object while the snapped rect is unchanged.
let lastCullRect: Rect | null = null;
const cullRect = $derived.by<Rect | null>(() => {
	if (surface.width === 0 || surface.height === 0) return null;
	const next = stableCullRect(
		visibleWorldRect(editor.camera, surface.width, surface.height),
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
// Bumped whenever the asset manager resolves a new thumbnail URL, so cards
// re-sync and images pop in.
let assetVersion = $state(0);
let spaceStyleVersion = $state(0);

function handleSpaceStyleChanged(event: Event) {
	const detail = (event as CustomEvent<{ spaceId?: string | null }>).detail;
	if (detail?.spaceId !== null && detail?.spaceId !== spaceId) return;
	spaceStyleVersion += 1;
	themeCache = null;
}

// The manager is owned by the parent (BoardPanel) and may be shared with the
// replay stage, so this component never destroys it.
$effect(() =>
	assets.subscribe(() => {
		assetVersion += 1;
	}),
);

// Bumped when a workspace file change invalidates a cached preview, so visible
// file cards can refresh their snapshot.
let previewVersion = $state(filePreviewVersion());
const taskDetailRefreshes = new Map<string, string>();
const unsubscribeTaskRuns = onTaskRunsCacheUpdated((event) => {
	if (readonly || event.spaceId !== spaceId) return;
	applyTaskRuns(event.runs);
});

function applyTaskRuns(runs: ReturnType<typeof getCachedTaskRuns>) {
	const wanted = new Set(
		editor.items
			.filter((item) => item.type === "task")
			.map((item) => item.taskRunId),
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

/**
 * Resolved theme colors, cached per theme identity. The snapshot is shared by
 * live rendering and export so the two paths cannot drift.
 */
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

// Request image and video previews only for cards near the viewport. The margin
// preloads a band just off-screen so panning feels
// instant, and matches the culling margin so a texture is requested before its
// card scrolls into view. Tracks only items/camera/surface: loaded textures
// notify via `assetVersion`, which the render effect (not this one) consumes.
//
// The candidate set comes from the spatial index, not from scanning every item,
// so this stays proportional to what is near the viewport rather than to the
// document size.
$effect(() => {
	previewVersion;
	for (const item of itemsNearViewport()) {
		if (assets.assetKey(item)) assets.requestItem(item);
	}
});

// Adopt intrinsic image sizes once their textures resolve, so a frame created
// without dimension metadata stops letterboxing. The editor records the size on
// media files and task outputs, so each node is corrected once and never fights a
// later user resize. Only nearby nodes can have a resolved texture, which bounds
// this work to the same spatial candidate set.
$effect(() => {
	// Re-run when a texture lands.
	assetVersion;
	const pending: Array<{ id: string; width: number; height: number }> = [];
	for (const item of itemsNearViewport()) {
		const taskArtifact =
			item.type === "task"
				? featuredTaskArtifact(item.snapshot.artifacts)
				: null;
		const visualArtifact =
			taskArtifact?.type === "image" || taskArtifact?.type === "video"
				? taskArtifact
				: null;
		const recorded = visualArtifact
			? visualArtifact
			: item.type === "image" || item.type === "video"
				? item.snapshot
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

function itemsNearViewport(): BoardItem[] {
	const ids = visibleIds;
	if (!ids) return [];
	const result: BoardItem[] = [];
	for (const id of ids) {
		const item = editor.itemById(id);
		if (item) result.push(item);
	}
	return result;
}

// Fill in (and refresh) file-card previews for cards near the viewport.
//
// Two cases are handled here: a card whose snapshot was never enriched (created
// by another client, or by the CLI, which only writes the file ref), and a card
// whose file changed while the board was open. Both are bounded to what is near
// the viewport, so a board with thousands of file cards reads only the handful
// the user can actually see.
//
// Skipped entirely in view mode: a published Board has no live workspace behind
// it, so cards render from the snapshot captured at publish time.
$effect(() => {
	if (readonly) return;
	// Re-run when a file change invalidates a cached preview.
	previewVersion;
	const targets: Array<{ id: string; path: string }> = [];
	for (const item of itemsNearViewport()) {
		if (item.type !== "file") continue;
		const path = item.ref.path;
		const stale = isFilePreviewStale(spaceId, path);
		// An unenriched card has no mtime recorded yet.
		const unenriched = item.snapshot?.mtimeMs === undefined;
		if (!stale && !unenriched) continue;
		// The stale mark is consumed by the read itself, which carries the change
		// event's metadata with it.
		targets.push({ id: item.id, path });
	}
	if (targets.length > 0) void enrichFileCards(targets);
});

function buildContext(
	palette: BoardRenderPalette,
	getDisplayItem: (id: string) => BoardItem | null,
): BoardRenderContext {
	const colorScheme = resolveTheme().colorScheme;
	const resizingIds =
		editor.interaction.type === "resizing"
			? new Set(editor.interaction.origin.keys())
			: new Set<string>();
	return {
		document: editor.document,
		getItem: getDisplayItem,
		selectedIds: new Set(editor.selection),
		hoveredId: editor.hoverId,
		resizingIds,
		palette,
		colors: resolveTheme().colors,
		colorScheme,
		rendererType: app?.renderer.type === RendererType.CANVAS ? "canvas" : "gpu",
		zoom: editor.camera.zoom,
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
	return editor.document.appearance.background.color;
}

function syncBackground(theme: BoardThemeSnapshot) {
	if (!app) return;
	const nextBackdrop = resolveBoardBackground(
		editor.document.appearance,
		theme.background,
	);
	if (!sameBackdrop(boardBackdrop, nextBackdrop)) boardBackdrop = nextBackdrop;
	const nextUrl = nextBackdrop?.url ?? null;
	if (backdropUrl !== nextUrl) backdropUrl = nextUrl;
	const context = {
		app,
		document: editor.document,
		viewport: editor.camera,
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
		for (const preview of peer.gesture.nodes) {
			if (localIds.has(preview.nodeId)) continue;
			const item = editor.itemById(preview.nodeId);
			if (!item) continue;
			previews.set(preview.nodeId, {
				...item,
				frame: preview.frame,
				...(item.type === "arrow" && preview.arrow
					? {
							start: preview.arrow.start,
							end: preview.arrow.end,
							bend: preview.arrow.bend,
						}
					: {}),
			} as BoardItem);
		}
	}
	return previews;
}

function syncStage() {
	if (!app || !world || !scene) return;
	const theme = resolveTheme();
	const palette = theme.palette;
	syncBackground(theme);
	world.x = editor.camera.x;
	world.y = editor.camera.y;
	world.scale.set(editor.camera.zoom);
	if (world.parent !== app.stage) app.stage.addChild(world);
	if (screenEffects && screenEffects.parent !== app.stage)
		app.stage.addChild(screenEffects);

	const previewItems = remotePreviewItems();
	const getDisplayItem = (id: string) =>
		previewItems.get(id) ?? editor.itemById(id);
	const context = buildContext(palette, getDisplayItem);
	animationRuntime?.setEnteringItems(editor.consumeRecentlyAdded());
	const animationIds =
		animationRuntime?.nodeIdsToMaterialize() ?? new Set<string>();
	const pinnedIds = new Set(editor.selection);
	for (const id of previewItems.keys()) pinnedIds.add(id);
	if (editor.editingId) pinnedIds.add(editor.editingId);
	for (const id of animationIds) pinnedIds.add(id);

	// Global render signals that affect every card equally (asset readiness,
	// theme, text zoom-bucket, file availability). Selection and hover are tracked
	// per card by the scene. Use the quantised zoom bucket — not raw zoom — so tiny
	// zooms do not thrash text re-rasterisation.
	const globalSig = [
		assetVersion,
		previewVersion,
		resolveTheme().key,
		textZoomBucket(editor.camera.zoom),
	].join("|");

	animationRuntime?.prepareSceneSync();
	scene.sync({
		items: editor.items,
		connections: editor.connections,
		selectedConnectionIds: new Set(editor.selection),
		hoveredConnectionId: editor.hoveredConnectionId,
		context,
		getItem: getDisplayItem,
		visibleIds,
		cullRect,
		pinnedIds,
		globalSig,
		structureVersion: editor.structureVersion,
		geometryVersion: editor.geometryVersion,
		gestureActive:
			editor.gestureActive && editor.interaction.type !== "panning",
	});

	animationRuntime?.invalidatePoses();
	// Composition time zero must be applied before Pixi's first draw. The same
	// evaluator drives later frames, so scene sync and playback cannot diverge.
	animationRuntime?.applyCurrentState();

	const single = editor.selection.length === 1 ? editor.selectedItems[0] : null;
	let arrowEndpoints: Array<{ x: number; y: number }> | undefined;
	if (single?.type === "arrow" && !single.locked) {
		const resolved = resolveArrow(single);
		arrowEndpoints = [resolved.start, resolved.control, resolved.end];
	}
	scene.drawOverlay(
		{
			zoom: editor.camera.zoom,
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
			connectionDraft: editor.connectionDraft,
		},
		palette,
	);

	drawRemoteAwareness(context.colors, context.colorScheme);
	drawTransient(palette, context.colors, context.colorScheme);

	scheduleRender();
}

function drawFreehandStroke(
	graphics: Graphics,
	points: readonly DrawPoint[],
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
		if (gesture.kind === "connection") {
			// A peer's in-progress relation: anchor node to live pointer. Drawn dashed
			// so it reads as provisional rather than as a committed edge.
			const source = editor.itemById(gesture.sourceNodeId);
			if (!source) continue;
			const color = pickBoardColor(colors, gesture.color, mode);
			const from = {
				x: source.frame.x + source.frame.width / 2,
				y: source.frame.y + source.frame.height / 2,
			};
			overlay
				.moveTo(from.x, from.y)
				.lineTo(gesture.current.x, gesture.current.y)
				.stroke({
					color: color.stroke,
					width: Math.max(gesture.size, 1) * inv,
					alpha: 0.8,
				});
			const target = gesture.targetNodeId
				? editor.itemById(gesture.targetNodeId)
				: null;
			if (target)
				overlay
					.rect(
						target.frame.x,
						target.frame.y,
						target.frame.width,
						target.frame.height,
					)
					.stroke({ color: collaboration, width: 2 * inv, alpha: 0.9 });
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

/**
 * Draw in-progress gesture previews (freehand stroke, arrow being drawn) and
 * alignment guides onto the overlay, in world space. These are ephemeral — they
 * exist only while a gesture is active and never touch the document.
 */
function drawTransient(
	palette: BoardRenderPalette,
	colors: BoardShapeColors,
	mode: "dark" | "light",
) {
	if (!overlay) return;
	const zoom = editor.camera.zoom;
	const inv = 1 / Math.max(zoom, 0.0001);
	const interaction = editor.interaction;

	// Alignment guides.
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
		const { start, current } = interaction;
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

// Convert a DOM event to a surface-relative screen point (the single place
// screen coordinates enter the editor).
function toScreenPoint(
	event: PointerEvent | WheelEvent | MouseEvent,
): ScreenPoint {
	if (!host) return screenPoint(0, 0);
	const rect = host.getBoundingClientRect();
	return screenPoint(event.clientX - rect.left, event.clientY - rect.top);
}

function toPointerEvent(event: PointerEvent) {
	const screen = toScreenPoint(event);
	return {
		pointerId: event.pointerId,
		screen,
		world: pointToWorld(screen, editor.camera),
		shiftKey: event.shiftKey,
		metaKey: event.metaKey,
		ctrlKey: event.ctrlKey,
		altKey: event.altKey,
		button: event.button,
		buttons: event.buttons,
		pointerType: event.pointerType,
		cancelled:
			event.type === "pointercancel" || event.type === "lostpointercapture",
		// Pens report real pressure; mouse/touch default to a mid value so strokes
		// have a sensible, consistent width.
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
			boardMediaActionAt(item, input.world, editor.camera.zoom, {
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
		editor.camera,
	);
	const item = editor.itemAt(worldPointAtCursor);
	if (item && (item.type === "video" || item.type === "audio")) {
		onPlayMedia?.(item.id);
		return;
	}
	// A file card is an entry point, not an editable surface: activating it opens
	// the file in the workspace preview, the same destination as the file tree.
	if (item?.type === "file") {
		void onOpenFile?.(item.ref.path);
		return;
	}
	if (item?.type === "task") {
		if (!readonly)
			void goto(
				withCurrentWindow(buildSpaceTaskRoute(spaceId, item.taskRunId)),
			);
		return;
	}
	// View mode stops here: text editing and the blank-canvas text draft are both
	// authoring actions.
	if (readonly) return;
	if (item && !item.locked && shapeCapabilities(item).canEdit) {
		editor.editingId = item.id;
	} else if (!item) {
		editor.beginTextDraft(worldPointAtCursor);
	}
}

/**
 * Read previews for file cards and fold the results into their snapshots.
 *
 * Cards are already on the board before this runs, so a slow or failed read only
 * means less detail, never a missing card.
 */
async function enrichFileCards(targets: Array<{ id: string; path: string }>) {
	const resolved = await Promise.all(
		targets.map(async ({ id, path }) => {
			const item = editor.itemById(id);
			if (item?.type !== "file") return null;
			const result = await loadFilePreview(spaceId, {
				path,
				mimeType: item.snapshot?.mimeType,
				size: item.snapshot?.size,
				mtimeMs: item.snapshot?.mtimeMs,
			});
			// `replace` carries the distinction the editor needs: a complete read
			// describes the file as it is now, so fields it omits are fields the file
			// no longer has. An incomplete one is only merged, so a failed read never
			// blanks a card.
			return { id, snapshot: result.facts, replace: result.complete };
		}),
	);
	const updates = resolved.filter(
		(
			entry,
		): entry is {
			id: string;
			snapshot: BoardFileSnapshot;
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
		} catch {
			/* ignore malformed payload */
		}
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

/**
 * Place dropped workspace files on the board at a screen point.
 *
 * Shared by the native drag-and-drop path (desktop) and the touch/pen pointer
 * drag path (mobile), so both produce identical cards and enrichment.
 */
function dropBoardItems(
	clientX: number,
	clientY: number,
	items: BoardDropItem[],
) {
	if (!host || items.length === 0) return;
	const rect = host.getBoundingClientRect();
	const origin = screenToWorld(clientX, clientY, rect, editor.camera);

	// Tile dropped files to the right so a multi-drop stays readable. Every file is
	// accepted — non-media becomes a file card — so the created ids are collected
	// and handed to the preview enrichment below.
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
	// Surface the result of the drop: the new cards are the selection, which also
	// puts them under the selection toolbar for an immediate follow-up action.
	if (created.length > 0) {
		editor.setSelection(created.map((entry) => entry.id));
		// Read previews in the background; the cards are already on the board and
		// simply gain detail when this lands.
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
		case "geo":
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
			// Render on demand (see scheduleRender) instead of every tick, so an
			// idle board does not keep the GPU/CPU busy redrawing an unchanged
			// scene ~60 times a second.
			autoStart: false,
		});
	} catch (error) {
		console.error("{m.board_failed_init({}, { locale })}", error);
		instance.destroy({ removeView: true });
		return;
	}
	// The component may have been torn down while init was awaiting.
	if (disposed) {
		instance.destroy({ removeView: true });
		return;
	}
	app = instance;
	instance.canvas.classList.add("board-stage-canvas");
	host.appendChild(instance.canvas);
	world = new Container({ isRenderGroup: true, label: "board-world" });
	effectsBehind = new Container({ label: "board-effects-behind" });
	nodeLayer = new Container({ label: "board-nodes" });
	effectsFront = new Container({ label: "board-effects-front" });
	screenEffects = new Container({
		isRenderGroup: true,
		label: "board-screen-effects",
	});
	overlay = new Graphics({ label: "board-interaction-overlay" });
	// Batched far-LOD geometry. Lives at the bottom of the node layer so live
	// cards (selection, editing) always draw above the plates.
	farLayer = new Graphics({ label: "board-far-layer" });
	nodeLayer.addChild(farLayer);
	world.addChild(effectsBehind, nodeLayer, effectsFront, overlay);
	scene = createBoardScene({
		world: nodeLayer,
		farLayer,
		overlay,
		getRenderer: getBoardCardRenderer,
	});
	animationRuntime = createBoardAnimationRuntime({
		getNode: (nodeId) => scene?.getNode(nodeId) ?? null,
		getItem: (nodeId) => editor.itemById(nodeId),
		getGeometryVersion: () => editor.geometryVersion,
		getWorld: () => world,
		getLayers: () =>
			effectsBehind && effectsFront && screenEffects
				? { behind: effectsBehind, front: effectsFront, screen: screenEffects }
				: null,
		getScreen: () => ({
			width: app?.screen.width ?? 0,
			height: app?.screen.height ?? 0,
		}),
		getAccentColor: () => getPalette().brand,
		render: () => {
			if (active) app?.render();
		},
	});
	animationRuntime.setActive(active);
	animationRuntime.setData(runtime);

	// The export path deliberately reuses this renderer and this theme snapshot:
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

$effect(() => {
	// The entrance preset lives in the document appearance, while effects and
	// compositions arrive through the runtime snapshot. Keep the renderer's
	// animation model coherent for both local edits and remote refreshes.
	editor.appearance;
	animationRuntime?.setData({
		...runtime,
		enter: editor.appearance.motion?.enter ?? null,
	});
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
	animationRuntime?.setActive(active);
	if (!active) {
		cancelAnimationFrame(renderFrame);
		renderFrame = 0;
		return;
	}
	resizeStage();
	syncStage();
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
	awarenessVersion;
	assetVersion;
	// Re-render when the user theme or active Space style changes.
	getResolvedTheme();
	spaceStyleVersion;
	syncStage();
});

onDestroy(() => {
	disposed = true;
	window.removeEventListener(
		SPACE_STYLE_CHANGED_EVENT,
		handleSpaceStyleChanged,
	);
	resizeObserver?.disconnect();
	cancelAnimationFrame(resizeFrame);
	cancelAnimationFrame(renderFrame);
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
	// Stop animation and restore transient poses before releasing scene resources.
	animationRuntime?.destroy();
	animationRuntime = null;
	const context = buildContext(getPalette(), (id) => editor.itemById(id));
	scene?.destroy(context);
	scene = null;
	background?.destroy({ children: true });
	background = null;
	effectsBehind = null;
	nodeLayer = null;
	effectsFront = null;
	screenEffects = null;
	world = null;
	overlay = null;
	farLayer = null;
	// `destroy(true)` would release Pixi's global pools and the shared Assets
	// cache, breaking any other live renderer. Remove only this canvas.
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
		// Accept both the rich resource payload and the bare path, so a drag from
		// anywhere in the workspace (file tree, task tray) lands.
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
