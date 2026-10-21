import type { BoardPlaybackSnapshot, BoardPatch } from "@cohub/protocol";
import { applyMatrix, invertMatrix, boardScriptScope, composeBoardScriptItems, prepareBoardScriptOutput, boardScriptTarget, validateBoardScriptCommit, type BoardScriptEvent, type BoardScriptOutput, type BoardScriptSnapshot } from "../model/index.js";
import { createBoardScriptObservers } from "../model/script-observers.js";
import { Application, Container, Graphics, type Renderer, RendererType } from "pixi.js";
import type { BoardEditor, BoardPointerEvent } from "../editor/index.js";
import { isCreationBoardTool, resizeCursorForHandle } from "../editor/index.js";
import {
	type BoardArrowItem,
	type BoardAssetSource,
	type BoardTaskItem,
	type BoardItem,
	type BoardScene,
	type BoardSceneItem,
	type BoardShapeColors,
	type BoardViewport,
	buildFallbackShapeColors,
	createBoardAnimationSampler,
	resolveBoardAnimationCamera,
	featuredTaskArtifact,
	pickBoardColor,
	type Rect,
	resolveItemColor,
	resolveSceneArrow,
	type SceneItem,
	elementClientToLocal,
	pointToWorld,
	screenPoint,
	stableCullRect,
	visibleWorldRect,
	type WorldPoint,
	worldPoint,
} from "../model/index.js";
import { type BoardPlayerFrame, createBoardPlayer } from "../player/index.js";
import {
	DEFAULT_BOARD_RENDER_LABELS,
	type BoardCardRendererResolver,
	type BoardRenderContext,
	type BoardRenderLabels,
	type BoardRenderPalette,
	type BoardRenderStyle,
	type BrowserBoardScriptHost,
	createBoardBackground,
	createBoardScriptHost,
	defaultBoardPalette,
	defaultBoardRenderStyle,
	getBoardCardRenderer,
	itemAlpha,
	getBoardResolution,
	parseBoardCssColor,
	updateBoardBackground,
} from "../render/index.js";
import { type BoardAssetManager, boardTextureEdge } from "./assets.js";
import { type BoardCanvasBox, boardCanvasSize, measureBoardCanvasBox } from "./canvas-size.js";
import { scheduleBoardMaintenance } from "./maintenance.js";
import { observeDisplayDensity } from "./display-density.js";
import { toBoardPointerEvent } from "./pointer.js";
import { createBoardPointerGestures } from "./pointer-gestures.js";
import { createBoardScriptPointerRouter } from "./script-pointer.js";
import { type BoardLiveStroke, createBoardScene } from "./scene.js";
import { drawBoardOverlay } from "./overlay.js";
import { createTextResolutionTracker } from "./text-resolution-tracker.js";
import { type BoardItemView, createBoardItemViewLayer } from "./views.js";

export type BoardStageTheme = {
	key: string;
	palette: BoardRenderPalette;
	colors: BoardShapeColors;
	colorScheme: "dark" | "light";
	style?: BoardRenderStyle;
	imageBackground?: boolean;
};

export type BoardStagePointerPhase = "down" | "move" | "up" | "leave";

export type BoardStageOptions = {
	editor: BoardEditor;
	assets: BoardAssetManager;
	source: BoardAssetSource;
	renderers?: BoardCardRendererResolver;
	views?: readonly BoardItemView[];
	theme?: () => BoardStageTheme;
	labels?: () => BoardRenderLabels;
	taskRun?: (taskRunId: string) => { status: BoardTaskItem["props"]["snapshot"]["status"]; startedAt?: string } | null;
	reducedMotion?: () => boolean;
	playback?: () => BoardPlaybackSnapshot | null;
	fileState?: (path: string) => "ok" | "missing" | "unavailable";
	previews?: () => ReadonlyMap<string, BoardItem>;
	strokes?: () => readonly BoardLiveStroke[];
	drawOverlay?: (overlay: Graphics, frame: { zoom: number; theme: BoardStageTheme; scene: BoardScene }) => void;
	onPointer?: (phase: BoardStagePointerPhase, event: PointerEvent, input: BoardPointerEvent) => boolean | undefined;
	onDoubleClick?: (item: BoardSceneItem | null, point: WorldPoint) => boolean | undefined;
	onSurfaceChange?: (size: { width: number; height: number }) => void;
	onVisibleChange?: (ids: ReadonlySet<string> | null) => void;
	onLiveChange?: (ids: ReadonlySet<string>) => void;
	safeRect?: () => Rect;
	scriptCapabilities?: Record<string, (id: string, input: unknown) => Promise<unknown>>;
};

export type BoardStage = {
	readonly ready: Promise<boolean>;
	readonly renderer: Renderer | null;
	readonly camera: BoardViewport;
	readonly theme: BoardStageTheme;
	setActive(active: boolean): void;
	setScriptMode(mode: "edit" | "interact" | "paused"): void;
	resetScripts(): void;
	invalidateScript(path: string): void;
	scriptError(id: string): string | null;
	scriptOutput(id: string): BoardScriptOutput | null;
	snapshotScripts(): Promise<Record<string, BoardScriptSnapshot>>;
	restoreScript(id: string, snapshot: BoardScriptSnapshot): void;
	subscribeScripts(listener: () => void): () => void;
	invalidate(options?: { cards?: boolean; items?: Iterable<string> }): void;
	isMaterialized(id: string): boolean;
	toWorld(clientX: number, clientY: number): WorldPoint;
	destroy(): void;
};

const LIVE_CHANNELS = ["document", "scene", "selection", "camera", "tool", "interaction", "hover", "editing", "playback"] as const;

function defaultTheme(): BoardStageTheme {
	return {
		key: "dark",
		palette: defaultBoardPalette("dark"),
		colors: buildFallbackShapeColors("dark"),
		colorScheme: "dark",
	};
}

const NO_IDS: ReadonlySet<string> = new Set();
const MARCH_STEP_MS = 160;
const MARCH_SMOOTH_MS = 40;
const TEXTURE_SETTLE_MS = 150;

const ROTATE_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5' fill='none' stroke='%23fff' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5' fill='none' stroke='%231d1d1f' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") 12 12, crosshair`;

const defaultStyles = new Map<string, BoardRenderStyle>();
function styleOf(theme: BoardStageTheme): BoardRenderStyle {
	if (theme.style) return theme.style;
	const cached = defaultStyles.get(theme.colorScheme);
	if (cached) return cached;
	const style = defaultBoardRenderStyle(theme.colorScheme);
	defaultStyles.set(theme.colorScheme, style);
	return style;
}

export function mountBoardStage(host: HTMLElement, options: BoardStageOptions): BoardStage {
	const { editor, assets } = options;
	const theme = options.theme ?? defaultTheme;
	const resolveRenderer = options.renderers ?? getBoardCardRenderer;
	let app: Application | null = null;
	let world: Container | null = null;
	let overlay: Graphics | null = null;
	let background: Container | null = null;
	let scene: ReturnType<typeof createBoardScene> | null = null;
	let scripts: BrowserBoardScriptHost | null = null;
	let scriptMode: "edit" | "interact" | "paused" = editor.readonly ? "interact" : "edit";
	let scriptTime = 0;
	let scriptLastTick = performance.now();
	const scriptOutputs = new Map<string, BoardScriptOutput>();
	const interactiveScripts = new Set<string>();
	const screenScripts = new Set<string>();
	const scriptObservers = createBoardScriptObservers((owner, event) => scripts?.event(owner, event));
	let stopTransforms: (() => void) | null = null;
	function syncTransformSubscription() {
		if (scriptObservers.transforms && !stopTransforms) {
			stopTransforms = editor.subscribeTransforms((event) => {
				if (active && scriptMode !== "paused") scriptObservers.transform(editor.document, event);
			});
		} else if (!scriptObservers.transforms && stopTransforms) {
			stopTransforms();
			stopTransforms = null;
		}
	}
	const scriptListeners = new Set<() => void>();
	let scriptVersion = 0;
	let composedVersion = -1;
	let composedZoom = 0;
	let composedPlayhead = "";
	let composedMoving = false;
	let composedGesture = false;
	let composedDocument: BoardEditor["document"] | null = null;
	let scriptHover: { owner: string; target: string } | null = null;
	const scriptPointers = createBoardScriptPointerRouter();
	let stopMaintenance: (() => void) | null = null;
	let stopDensity: (() => void) | null = null;
	let active = true;
	let disposed = false;
	let renderFrame = 0;
	let tickFrame = 0;
	let scriptTickFrame = 0;
	let cardTickFrame = 0;
	let cardTickTimer: ReturnType<typeof setTimeout> | null = null;
	let cardTickDue = 0;
	const staleIds = new Set<string>();
	let resizeFrame = 0;
	let canvasBox: BoardCanvasBox | null = null;
	let cardEpoch = 0;
	let surface = { width: 0, height: 0 };
	let playbackCamera: BoardViewport | null = null;
	let cursor = "";
	const renderCamera = () => playbackCamera ?? editor.camera;
	const views = createBoardItemViewLayer(host, editor, options.views ?? [], renderCamera, scheduleTick);

	const player = createBoardPlayer({
		resolveColor: (color) => {
			const current = theme();
			return { color: resolveItemColor(color, "brand", current.colors, current.colorScheme, parseBoardCssColor), alpha: itemAlpha(current, color) };
		},
	});

	let cull: { rect: Rect | null; ids: Set<string> | null; scene: BoardScene | null } = { rect: null, ids: null, scene: null };
	function visibleIds(): Set<string> | null {
		if (surface.width === 0 || surface.height === 0) return null;
		const rect = stableCullRect(visibleWorldRect(renderCamera(), surface.width, surface.height));
		const same =
			cull.rect &&
			cull.rect.x === rect.x &&
			cull.rect.y === rect.y &&
			cull.rect.width === rect.width &&
			cull.rect.height === rect.height;
		if (same && cull.scene === editor.scene) return cull.ids;
		cull = { rect: same ? cull.rect : rect, ids: new Set(editor.idsInRect(rect, true)), scene: editor.scene };
		options.onVisibleChange?.(cull.ids);
		return cull.ids;
	}

	const textureScale = () => renderCamera().zoom * (app?.renderer.resolution ?? 1);
	const textResolution = createTextResolutionTracker(TEXTURE_SETTLE_MS, scheduleTick);
	let refined = { scale: 0, geometry: 0 };
	let pendingRefine = "";
	let refineTimer: ReturnType<typeof setTimeout> | null = null;
	function stopRefine() {
		if (refineTimer !== null) clearTimeout(refineTimer);
		refineTimer = null;
		refined = { scale: 0, geometry: 0 };
		pendingRefine = "";
	}
	function scheduleRefine() {
		const scale = textureScale();
		const geometry = editor.geometryVersion;
		const key = `${scale}:${geometry}`;
		if (key === pendingRefine) return;
		pendingRefine = key;
		if (refineTimer !== null) clearTimeout(refineTimer);
		refineTimer = null;
		if (refined.scale === 0 || (scale <= refined.scale && geometry === refined.geometry)) {
			refined = { scale, geometry };
			return;
		}
		refineTimer = setTimeout(() => {
			refineTimer = null;
			refined = { scale, geometry };
			for (const id of scene?.liveIds() ?? []) {
				const item = editor.scene.get(id);
				if (item) assets.requestItem(item, boardTextureEdge(item, scale));
			}
		}, TEXTURE_SETTLE_MS);
	}

	const naturalIds = new Set<string>();
	let liveVersion = -1;
	function adoptNaturalSizes() {
		if (naturalIds.size === 0) return;
		const sizes: Array<{ id: string; width: number; height: number }> = [];
		for (const id of naturalIds) {
			const item = editor.itemById(id);
			const key = item && assets.assetKey(item);
			if (!item || !key) continue;
			const artifact = item.type === "task" ? featuredTaskArtifact(item.props.snapshot.artifacts) : null;
			const recorded =
				artifact?.type === "image" || artifact?.type === "video"
					? artifact
					: item.type === "image" || item.type === "video"
						? item.props.snapshot
						: null;
			if (!recorded || (recorded.naturalWidth && recorded.naturalHeight)) continue;
			const natural = assets.getNaturalSize(key);
			if (natural?.width && natural.height) sizes.push({ id, ...natural });
		}
		naturalIds.clear();
		if (sizes.length > 0) editor.adoptMediaNaturalSizes(sizes);
	}

	let lifted: { origin: Map<string, unknown>; ids: ReadonlySet<string> } | null = null;
	function liftedIds(): ReadonlySet<string> {
		const interaction = editor.interaction;
		if (interaction.type !== "translating" || !interaction.moved) {
			lifted = null;
			return NO_IDS;
		}
		if (lifted?.origin !== interaction.origin) lifted = { origin: interaction.origin, ids: new Set(interaction.origin.keys()) };
		return lifted.ids;
	}

	function renderContext(current: BoardStageTheme, renderScene: BoardScene, time: number): BoardRenderContext {
		const interaction = editor.interaction;
		return {
			settings: editor.settings,
			scene: renderScene,
			time,
			...(scripts ? { scripts } : {}),
			selectedIds: new Set(editor.selection),
			hoveredId: editor.hoverId,
			resizingIds: interaction.type === "resizing" ? new Set(interaction.origin.keys()) : new Set<string>(),
			liftedIds: liftedIds(),
			palette: current.palette,
			colors: current.colors,
			colorScheme: current.colorScheme,
			style: styleOf(current),
			themeKey: current.key,
			rendererType: app?.renderer.type === RendererType.CANVAS ? "canvas" : "gpu",
			zoom: renderCamera().zoom,
			textResolution: textResolution.value,
			reducedMotion: options.reducedMotion?.() ?? false,
			labels: options.labels?.() ?? DEFAULT_BOARD_RENDER_LABELS,
			taskRun: options.taskRun ?? (() => null),
			assetKey: assets.assetKey,
			getTexture: (key) => assets.getTexture(key),
			hasError: (key) => assets.hasError(key),
			fileState: (path) => options.fileState?.(path) ?? "ok",
			acquireTexture: (key, item) => {
				assets.acquire(key);
				assets.requestItem(item, boardTextureEdge(item, textureScale()));
				if (assets.getTexture(key)) naturalIds.add(item.id);
			},
			releaseTexture: (key) => assets.release(key),
		};
	}

	function syncBackground(current: BoardStageTheme) {
		if (!app) return;
		const context = {
			app,
			settings: editor.settings,
			viewport: editor.camera,
			colorScheme: current.colorScheme,
			palette: current.palette,
			hasImageBackground: current.imageBackground === true,
		};
		if (background) updateBoardBackground(background, context);
		else {
			background = createBoardBackground(context);
			app.stage.addChildAt(background, 0);
		}
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

	function previewItems(): Map<string, BoardItem> {
		const previews = new Map<string, BoardItem>();
		const remote = options.previews?.();
		if (!remote?.size) return previews;
		const local = localGestureItemIds();
		for (const [id, item] of remote) if (!local.has(id)) previews.set(id, item);
		return previews;
	}

	function liveStrokes(): BoardLiveStroke[] {
		const strokes = [...(options.strokes?.() ?? [])];
		const interaction = editor.interaction;
		if (interaction.type === "drawing")
			strokes.push({ id: interaction.id, points: interaction.points, color: interaction.color, size: interaction.size });
		return strokes;
	}

	function followCamera(frame: BoardPlayerFrame, renderScene: BoardScene): BoardViewport {
		return resolveBoardAnimationCamera(frame.camera, (id) => renderScene.get(id)?.frame, surface, frame.time, editor.camera);
	}

	let effectSampler: ReturnType<typeof createBoardAnimationSampler> | undefined;
	let effectDocument: BoardEditor["document"] | undefined;
	let effectAnimation: string | null = null;

	function arrowHead(target: Graphics, from: WorldPoint, to: WorldPoint, color: number, width: number, inv: number, alpha: number) {
		const angle = Math.atan2(to.y - from.y, to.x - from.x);
		const head = Math.max(14, 16 * inv);
		const spread = Math.PI / 6;
		target
			.moveTo(to.x - head * Math.cos(angle - spread), to.y - head * Math.sin(angle - spread))
			.lineTo(to.x, to.y)
			.lineTo(to.x - head * Math.cos(angle + spread), to.y - head * Math.sin(angle + spread))
			.stroke({ color, width, alpha, cap: "round", join: "round" });
	}

	function drawTransient(target: Graphics, current: BoardStageTheme) {
		const inv = 1 / Math.max(editor.camera.zoom, 0.0001);
		const interaction = editor.interaction;
		for (const guide of editor.snapGuides) {
			const vertical = guide.axis === "x";
			target
				.moveTo(vertical ? guide.at : guide.from, vertical ? guide.from : guide.at)
				.lineTo(vertical ? guide.at : guide.to, vertical ? guide.to : guide.at)
				.stroke({ color: current.palette.brand, width: inv, alpha: 0.9 });
		}
		if (interaction.type === "creatingArrow") {
			const color = pickBoardColor(current.colors, interaction.color, current.colorScheme);
			const target_ = interaction.targetItemId ? editor.itemById(interaction.targetItemId) : null;
			const end = target_
				? worldPoint(target_.frame.x + target_.frame.width / 2, target_.frame.y + target_.frame.height / 2)
				: interaction.current;
			const width = Math.max(interaction.size, 1.5 * inv);
			target.moveTo(interaction.start.x, interaction.start.y).lineTo(end.x, end.y).stroke({ color: color.stroke, width, alpha: 0.9 });
			arrowHead(target, interaction.start, end, color.stroke, width, inv, 0.95);
		}
		if (interaction.type === "creatingBox") {
			const color = pickBoardColor(current.colors, interaction.color, current.colorScheme);
			const { start, current: corner } = interaction;
			const w = Math.abs(corner.x - start.x);
			const h = Math.abs(corner.y - start.y);
			if (w > 1 || h > 1)
				target
					.roundRect(Math.min(start.x, corner.x), Math.min(start.y, corner.y), Math.max(w, 1), Math.max(h, 1), 4)
					.fill({ color: color.fill, alpha: 0.04 })
					.stroke({ color: color.stroke, width: 1.5 * inv, alpha: 0.85 });
		}
	}

	let march = 0;
	let marchTimer: ReturnType<typeof setTimeout> | null = null;

	function stopMarch() {
		if (marchTimer !== null) clearTimeout(marchTimer);
		marchTimer = null;
	}

	function scheduleMarch(style: BoardRenderStyle) {
		const stepped = style.motion === "stepped";
		if (marchTimer !== null || !active || disposed) return;
		marchTimer = setTimeout(() => {
			marchTimer = null;
			march += stepped ? 2 : 1;
			drawInteraction();
			scheduleRender();
		}, stepped ? MARCH_STEP_MS : MARCH_SMOOTH_MS);
	}

	function drawInteraction() {
		if (!overlay) return;
		const current = theme();
		const style = styleOf(current);
		const renderScene = editor.scene;
		const camera = renderCamera();
		const interaction = editor.interaction;
		const selected = editor.selection.flatMap((id) => renderScene.get(id) ?? []);
		const single = selected.length === 1 ? selected[0] : undefined;
		let arrowEndpoints: WorldPoint[] | undefined;
		if (single?.type === "arrow" && !single.locked) {
			const resolved = resolveSceneArrow(single as SceneItem<BoardArrowItem>, renderScene);
			arrowEndpoints = [resolved.start.point, resolved.mid, resolved.end.point];
		}
		const hoverId = interaction.type === "idle" ? editor.hoverId : null;
		const hovered = hoverId && !editor.selection.includes(hoverId) ? (renderScene.get(hoverId) ?? null) : null;
		overlay.clear();
		drawBoardOverlay(overlay, {
			zoom: camera.zoom,
			pointerType: editor.pointerType,
			palette: current.palette,
			style,
			scene: renderScene,
			hovered,
			selected,
			march,
			marquee: editor.marquee,
			transform: editor.selectionTransform,
			controls: editor.tool === "select",
			hoveredControl: editor.hoveredTransformControl,
			rotationPointer: interaction.type === "rotating" ? interaction.current : null,
			arrowEndpoints,
			ports: editor.connectionPorts,
			hoveredPort: editor.hoveredConnectionPort,
			bindTarget: editor.bindTargetFrame ?? editor.arrowDraft?.targetFrame ?? null,
		});
		options.drawOverlay?.(overlay, { zoom: camera.zoom, theme: current, scene: renderScene });
		drawTransient(overlay, current);
		editor.controlOutset = style.selection.outset;
		const marching = style.selection.dash > 0 && selected.length > 0 && !(options.reducedMotion?.() ?? false);
		if (marching) scheduleMarch(style);
		else stopMarch();
	}

	function cursorFor(): string {
		if (scriptMode === "interact" && scriptHover) {
			const output = scriptOutputs.get(scriptHover.owner);
			return output?.hits[scriptHover.target]?.cursor ?? (output?.listens.includes("click") ? "pointer" : "default");
		}
		const interaction = editor.interaction;
		switch (interaction.type) {
			case "panning":
			case "translating":
				return "grabbing";
			case "resizing":
				return resizeCursorForHandle(interaction.handle, interaction.single?.rotation ?? 0);
			case "rotating":
				return ROTATE_CURSOR;
			case "draggingArrowHandle":
			case "brushing":
				return "crosshair";
		}
		if (editor.spaceHeld || editor.tool === "hand") return "grab";
		const control = editor.hoveredTransformControl;
		if (control?.kind === "resize")
			return resizeCursorForHandle(control.handle, editor.selectionTransform?.frame.rotation ?? 0);
		if (control?.kind === "rotate") return ROTATE_CURSOR;
		if (isCreationBoardTool(editor.tool)) return "crosshair";
		const hovered = editor.hoverId ? editor.itemById(editor.hoverId) : null;
		return hovered && !hovered.locked && editor.registry.capabilities(hovered).canMove ? "move" : "default";
	}

	function scheduleRender() {
		if (renderFrame || !app || !active) return;
		renderFrame = requestAnimationFrame(() => {
			renderFrame = 0;
			app?.render();
		});
	}

	function scheduleCardTick(wait: number) {
		if (!active || disposed) return;
		const due = performance.now() + wait;
		if (cardTickFrame || (cardTickTimer !== null && cardTickDue <= due)) return;
		if (cardTickTimer !== null) clearTimeout(cardTickTimer);
		cardTickTimer = null;
		if (wait > 0) {
			cardTickDue = due;
			cardTickTimer = setTimeout(() => {
				cardTickTimer = null;
				scheduleCardTick(0);
			}, wait);
			return;
		}
		cardTickFrame = requestAnimationFrame(() => {
			cardTickFrame = 0;
			if (!scene) return;
			const next = scene.tick(performance.now());
			scheduleRender();
			if (next !== null) scheduleCardTick(next);
		});
	}

	function scheduleTick() {
		if (tickFrame || !active || disposed) return;
		tickFrame = requestAnimationFrame(() => {
			tickFrame = 0;
			sync();
		});
	}

	function cancelScriptPointers(owner?: string, retained?: BoardScriptOutput["hits"]) {
		scriptPointers.cancelScripts((pointerId, target) => {
			scripts?.event(target.owner, { type: "pointercancel", target: target.target, pointerId });
		}, owner, retained);
		if (!retained || (scriptHover && scriptHover.owner === owner && !Object.hasOwn(retained, scriptHover.target))) scriptHover = null;
	}

	function syncScripts() {
		if (!scripts) return;
		const now = performance.now();
		if (scriptMode !== "paused") scriptTime += Math.min(250, Math.max(0, now - scriptLastTick));
		scriptLastTick = now;
		const camera = renderCamera();
		if (scriptMode !== "paused" && scriptObservers.size) {
			scriptObservers.sync(editor.document, editor.selection, () => ({
				camera: { ...camera }, ...surface,
				safeRect: options.safeRect?.() ?? { x: 0, y: 0, ...surface },
			}));
		}
		scripts.sync(editor.document, editor.scene, camera, scriptTime, scriptMode === "interact", visibleIds());
	}

	function scheduleScriptTick() {
		if (scriptTickFrame || !active || disposed) return;
		scriptTickFrame = requestAnimationFrame(() => {
			scriptTickFrame = 0;
			if (tickFrame) return;
			syncScripts();
			if (scriptMode !== "paused" && scripts?.animated) scheduleScriptTick();
		});
	}

	function createScripts() {
		return createBoardScriptHost({
			host,
			isMaterialized: (id) => Boolean(scene?.getNode(id)),
			onSchedule: scheduleScriptTick,
			capabilities: {
				...options.scriptCapabilities,
				"board.emit": async (id: string, value: unknown) => {
					const message = value as { target?: string; type?: string; data?: unknown };
					if (!message || typeof message.target !== "string" || typeof message.type !== "string" || !boardScriptScope(editor.document, id).has(message.target)) throw new Error("Invalid script event target.");
					scripts?.event(message.target, { type: message.type, data: message.data });
				},
				...(!editor.readonly ? { "board.commit": async (id: string, value: unknown) => {
					validateBoardScriptCommit(editor.document, id, value as BoardPatch);
					await editor.commitPatch(value as BoardPatch);
				} } : {}),
			},
			onOutput: (id, output) => {
				if (output) {
					prepareBoardScriptOutput(editor.document, id, output);
					cancelScriptPointers(id, output.hits);
					scriptOutputs.set(id, output);
					if (Object.keys(output.hits).length) interactiveScripts.add(id); else interactiveScripts.delete(id);
					if (output.space === "screen" && Object.keys(output.items).length) screenScripts.add(id); else screenScripts.delete(id);
				} else {
					cancelScriptPointers(id);
					scriptOutputs.delete(id);
					interactiveScripts.delete(id);
					screenScripts.delete(id);
				}
				scriptObservers.update(id, output);
				syncTransformSubscription();
				scriptVersion++;
				scheduleTick();
			},
			readModule: async (src) => {
				const url = await options.source.resolveFileUrl(src);
				if (!url) throw new Error(`${src} is not available.`);
				const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
				if (!response.ok) throw new Error(`${src} could not be read.`);
				return response.text();
			},
			onFrame: () => { scheduleTick(); for (const listener of scriptListeners) listener(); },
		});
	}

	function sync() {
		if (!app || !world || !scene || !overlay) return;
		const current = theme();
		const hasScripts = editor.hasScripts;
		if (hasScripts && !scripts) {
			scripts = createScripts();
			scriptTime = 0;
			scriptLastTick = performance.now();
		} else if (!hasScripts && scripts) {
			const previous = scripts;
			scripts = null;
			previous.destroy();
			scriptObservers.clear();
			syncTransformSubscription();
			interactiveScripts.clear();
			screenScripts.clear();
			scriptOutputs.clear();
			editor.setScriptItems(new Map());
			scriptHover = null;
			composedVersion = -1;
			composedDocument = null;
		}
		syncBackground(current);

		player.enter(editor.consumeRecentlyAdded(), editor.document);
		const playback = options.playback?.() ?? null;
		const frame = player.frame(editor.document, playback, performance.now(), Date.now(), editor.playhead?.animationId ?? null);
		const previews = previewItems();
		const moving = new Map<string, BoardItem>(previews);
		for (const [id, item] of frame.items) moving.set(id, item);
		editor.setPlayedItems(moving);
		const animationId = editor.playhead?.animationId ?? (frame.playbackTime !== null ? playback?.animationId : null) ?? null;
		if (animationId && (effectDocument !== editor.document || effectAnimation !== animationId)) {
			effectDocument = editor.document;
			effectAnimation = animationId;
			effectSampler = createBoardAnimationSampler(editor.document, animationId);
		}
		if (editor.playhead && effectSampler) {
			frame.camera = effectSampler.at(editor.playhead.time).evaluation.camera;
			frame.time = editor.playhead.time;
		}
		const follows = editor.cameraPolicy === "follow" && Object.keys(frame.camera).length > 0;
		playbackCamera = follows ? followCamera(frame, editor.scene) : null;
		const camera = renderCamera();
		if (scripts && (scriptOutputs.size || composedVersion !== scriptVersion)) {
			const playheadKey = `${editor.playhead?.animationId ?? ""}:${editor.playhead?.time ?? ""}`;
			if (scriptVersion !== composedVersion || composedDocument !== editor.document || screenScripts.size > 0 && editor.gestureActive || composedGesture || moving.size || composedMoving || composedZoom !== camera.zoom || composedPlayhead !== playheadKey) {
				const animationItems = editor.animationItems();
				const composed = composeBoardScriptItems(editor.document, editor.scene, scriptOutputs, animationItems, camera,
					(owner, error) => scripts?.fault(owner, error instanceof Error ? error.message : String(error)),
					editor.gestureActive ? editor.scene.layout : undefined);
				const scriptedIds = new Set([...scriptOutputs.values()].flatMap((output) => Object.keys(output.patches)));
				for (const id of animationItems.keys()) if (!scriptedIds.has(id)) composed.delete(id);
				editor.setScriptItems(composed);
				composedMoving = moving.size > 0;
				composedPlayhead = playheadKey;
				composedZoom = camera.zoom;
				composedGesture = screenScripts.size > 0 && editor.gestureActive;
				composedVersion = scriptVersion;
				composedDocument = editor.document;
			}
		}

		const renderScene = editor.scene;
		world.position.set(camera.x, camera.y);
		world.scale.set(camera.zoom);

		const ids = visibleIds();
		textResolution.update(textureScale());
		const context = renderContext(current, renderScene, frame.time);
		if (animationId && effectSampler) {
			context.time = editor.playhead?.time ?? frame.time;
			const sampler = effectSampler;
			context.frameAt = sampler.frameAt;
		}
		const pinnedIds = new Set(editor.selection);
		for (const item of renderScene.items) {
			if (item.type === "effect" && item.props.kind === "trail" && renderScene.opacity(item.id) > 0) pinnedIds.add(item.id);
		}
		for (const id of previews.keys()) pinnedIds.add(id);
		if (editor.editingId) pinnedIds.add(editor.editingId);
		for (const id of frame.items.keys()) {
			pinnedIds.add(id);
			for (const child of renderScene.descendants(id)) pinnedIds.add(child);
			for (const binder of renderScene.binders(id)) pinnedIds.add(binder);
		}
		scene.sync({
			items: renderScene.items,
			strokes: liveStrokes(),
			scene: renderScene,
			context,
			getItem: (id) => renderScene.get(id) ?? null,
			visibleIds: ids,
			pinnedIds,
			globalSig: [cardEpoch, current.key].join("|"),
			staleIds,
			structureVersion: editor.structureVersion,
			geometryVersion: editor.geometryVersion,
			gestureActive: editor.gestureActive && editor.interaction.type !== "panning",
			focus: pointToWorld(screenPoint(surface.width / 2, surface.height / 2), camera),
		});
		staleIds.clear();
		if (scene.liveVersion !== liveVersion) {
			liveVersion = scene.liveVersion;
			options.onLiveChange?.(scene.liveIds());
		}
		adoptNaturalSizes();
		scheduleRefine();
		syncScripts();

		drawInteraction();

		views.sync({ ids, scene: renderScene, camera, surface, selection: context.selectedIds });
		const nextCursor = cursorFor();
		if (nextCursor !== cursor) host.style.cursor = cursor = nextCursor;

		scheduleRender();
		if (frame.running || scene.animated) scheduleTick();
		if (scriptMode !== "paused" && scripts?.animated) scheduleScriptTick();
		const cardWait = scene.tick(performance.now());
		if (cardWait !== null) scheduleCardTick(cardWait);
	}

	function resize() {
		cancelAnimationFrame(resizeFrame);
		resizeFrame = requestAnimationFrame(() => {
			if (!app || !active) return;
			const size = { width: host.clientWidth, height: host.clientHeight };
			if (size.width <= 0 || size.height <= 0) return;
			const density = host.ownerDocument.defaultView?.devicePixelRatio ?? 1;
			const canvas = boardCanvasSize(canvasBox ?? { ...size, density, device: null }, density);
			if (canvas.width !== app.screen.width || canvas.height !== app.screen.height || canvas.resolution !== app.renderer.resolution) {
				app.renderer.resize(canvas.width, canvas.height, canvas.resolution);
			}
			const sizeChanged = size.width !== surface.width || size.height !== surface.height;
			if (sizeChanged) {
				surface = size;
				editor.surfaceSize = surface;
				options.onSurfaceChange?.(surface);
			}
			sync();
		});
	}

	const localPoint = (x: number, y: number) => elementClientToLocal(host)(x, y);
	const inViews = (event: Event) => event.target instanceof Node && views.element.contains(event.target);

	function toInput(event: PointerEvent): BoardPointerEvent {
		return toBoardPointerEvent(event, host, renderCamera(), event.type === "pointermove" && editor.interaction.type === "drawing");
	}

	function scriptTarget(input: BoardPointerEvent) {
		if (!scriptOutputs.size) return null;
		const point = input.world;
		const candidates = editor.idsInRect({ x: point.x - 0.01, y: point.y - 0.01, width: 0.02, height: 0.02 }, true);
		return boardScriptTarget(editor.scene, candidates, point, scriptOutputs, editor.registry.hitTest);
	}

	function sendScriptEvent(target: { owner: string; target: string }, type: string, event: PointerEvent, input: BoardPointerEvent, related?: { owner: string; target: string } | null) {
		if (!scripts) return;
		const point = applyMatrix(invertMatrix(editor.scene.layout.matrix(target.owner)), input.world);
		scripts?.event(target.owner, { type, target: target.target, relatedTarget: related?.target, relatedOwner: related?.owner, point, pointerId: event.pointerId, pointerType: event.pointerType, buttons: event.buttons, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey });
	}

	function scriptPointer(type: "down" | "move" | "up" | "leave", event: PointerEvent, input: BoardPointerEvent): boolean {
		if (!scriptPointers.needsRouting(event.pointerId, interactiveScripts.size > 0)) return false;
		const enabled = scriptMode === "interact" && !editor.gestureActive && !editor.spaceHeld && event.button !== 1;
		const target = type === "leave" || !enabled || scriptPointers.owner(event.pointerId) === "editor" ? null : scriptTarget(input);
		if (target?.owner !== scriptHover?.owner || target?.target !== scriptHover?.target) {
			if (scriptHover) sendScriptEvent(scriptHover, "pointerleave", event, input, target);
			if (target) sendScriptEvent(target, "pointerenter", event, input, scriptHover);
			scriptHover = target;
		}
		const consumed = scriptPointers.owner(event.pointerId) === "script";
		const { recipient, click } = scriptPointers.route(type, event.pointerId, target, { x: event.clientX, y: event.clientY }, event.type !== "pointerup");
		if (type === "down" && recipient) host.focus({ preventScroll: true });
		if (recipient && type !== "leave") sendScriptEvent(recipient, input.cancelled ? "pointercancel" : `pointer${type}`, event, input);
		if (click) sendScriptEvent(click, "click", event, input);
		return consumed || recipient !== null;
	}

	function handleScriptKey(event: KeyboardEvent) {
		if (scriptMode !== "interact" || !scriptHover || event.target !== host || !scriptOutputs.get(scriptHover.owner)?.listens.includes(event.type)) return;
		const input: BoardScriptEvent = { type: event.type, target: scriptHover.target, key: event.key, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey };
		scripts?.event(scriptHover.owner, input);
		event.stopPropagation();
	}

	const pointers = createBoardPointerGestures(host, { move: routePointerMove, end: handlePointerUp });

	function handlePointerDown(event: PointerEvent) {
		if (!active || inViews(event)) return;
		editor.takeCameraControl();
		const input = toInput(event);
		if (scriptPointer("down", event, input)) {
			pointers.start(event);
			return;
		}
		if (options.onPointer?.("down", event, input) === false) return;
		pointers.start(event);
		editor.pointerDown(input);
	}

	function handlePointerMove(event: PointerEvent) {
		if (!active || pointers.has(event.pointerId) || inViews(event)) return;
		routePointerMove(event);
	}

	function routePointerMove(event: PointerEvent) {
		const input = toInput(event);
		if (scriptPointer("move", event, input)) return;
		if (options.onPointer?.("move", event, input) === false) return;
		editor.pointerMove(input);
	}

	function handlePointerUp(event: PointerEvent) {
		const input = toInput(event);
		if (scriptPointer("up", event, input)) return;
		if (options.onPointer?.("up", event, input) === false) return;
		editor.pointerUp(input);
		if (event.type === "pointercancel" || event.pointerType !== "mouse") editor.pointerLeave();
	}

	function handlePointerLeave(event: PointerEvent) {
		if (event.buttons !== 0) return;
		scriptPointer("leave", event, toInput(event));
		if (options.onPointer?.("leave", event, toInput(event)) === false) return;
		editor.pointerLeave();
	}

	function handleWheel(event: WheelEvent) {
		if (inViews(event)) return;
		event.preventDefault();
		editor.takeCameraControl();
		const point = localPoint(event.clientX, event.clientY);
		editor.wheel(point, event.deltaX, event.deltaY, event.ctrlKey || event.metaKey, event.deltaMode);
	}

	function handleDoubleClick(event: MouseEvent) {
		if (inViews(event)) return;
		const point = pointToWorld(localPoint(event.clientX, event.clientY), renderCamera());
		const item = editor.itemAt(point);
		if (options.onDoubleClick?.(item, point) === true || editor.readonly) return;
		if (item && !item.locked && editor.registry.capabilities(item).canEdit) {
			editor.editingId = item.id;
			return;
		}
		if (item && item.type !== "frame" && item.type !== "arrow") return;
		const label = editor.labelItemAt(point);
		if (label) editor.editingId = label.id;
		else if (!item) editor.beginTextDraft(point);
	}

	const listeners: Array<[string, (event: never) => void, AddEventListenerOptions?]> = [
		["keydown", handleScriptKey],
		["keyup", handleScriptKey],
		["pointerdown", handlePointerDown],
		["pointermove", handlePointerMove],
		["pointerleave", handlePointerLeave],
		["wheel", handleWheel, { passive: false }],
		["dblclick", handleDoubleClick],
	];

	const stopEditor = editor.subscribe(LIVE_CHANNELS, scheduleTick);
	const stopAssets = assets.subscribe((key) => {
		const ids = scene?.holders(key);
		if (!ids?.size) return;
		for (const id of ids) {
			staleIds.add(id);
			naturalIds.add(id);
		}
		scheduleTick();
	});
	const resizeObserver = new ResizeObserver((entries) => {
		const entry = entries[entries.length - 1];
		if (entry) canvasBox = measureBoardCanvasBox(entry, host.ownerDocument.defaultView?.devicePixelRatio ?? 1);
		resize();
	});

	const ready = (async () => {
		const instance = new Application();
		try {
			await instance.init({
				antialias: true,
				backgroundAlpha: 0,
				width: host.clientWidth,
				height: host.clientHeight,
				resolution: getBoardResolution({ width: host.clientWidth, height: host.clientHeight }),
				autoStart: false,
			});
		} catch (error) {
			console.error("Board canvas failed to start", error);
			instance.destroy({ removeView: true });
			return false;
		}
		if (disposed) {
			instance.destroy({ removeView: true });
			return false;
		}
		app = instance;
		stopMaintenance = scheduleBoardMaintenance(instance.renderer);
		Object.assign(instance.canvas.style, {
			position: "relative",
			zIndex: "1",
			display: "block",
			width: "100%",
			height: "100%",
			touchAction: "none",
		});
		host.insertBefore(instance.canvas, views.element);
		world = new Container({ isRenderGroup: true, label: "board-world" });
		const nodes = new Container({ isRenderGroup: true, label: "board-nodes" });
		overlay = new Graphics({ label: "board-interaction-overlay" });
		world.addChild(nodes, overlay);
		instance.stage.addChild(world);
		scene = createBoardScene({ world: nodes, overlay, getRenderer: resolveRenderer, requestFrame: scheduleTick });

		for (const [type, listener, listenerOptions] of listeners)
			host.addEventListener(type, listener as EventListener, listenerOptions);
		try {
			resizeObserver.observe(instance.canvas, { box: "device-pixel-content-box" });
		} catch {
			resizeObserver.observe(instance.canvas);
		}
		const window = host.ownerDocument.defaultView;
		if (window) stopDensity = observeDisplayDensity(window, resize);
		resize();
		return true;
	})();

	return {
		ready,
		get renderer() {
			return app ? (app.renderer as unknown as Renderer) : null;
		},
		get camera() {
			return renderCamera();
		},
		get theme() {
			return theme();
		},
		setScriptMode(mode) { if (mode === scriptMode) return; if (mode !== "interact") cancelScriptPointers(); scriptMode = mode; scriptLastTick = performance.now(); scheduleTick(); },
		resetScripts() { scriptTime = 0; scripts?.invalidate(); },
		invalidateScript(path) { scripts?.invalidate(path); },
		scriptOutput: (id) => scripts?.output(id) ?? null,
		async snapshotScripts() {
			const result: Record<string, BoardScriptSnapshot> = {};
			await Promise.all([...scriptOutputs.keys()].map(async (id) => { const snapshot = await scripts?.snapshot(id); if (snapshot) result[id] = snapshot; }));
			return result;
		},
		restoreScript(id, snapshot) { scripts?.restore(id, snapshot); },
		subscribeScripts(listener) { scriptListeners.add(listener); return () => { scriptListeners.delete(listener); }; },
		scriptError: (id) => scripts?.error(id) ?? null,
		setActive(next) {
			if (active === next) return;
			active = next;
			if (!active) {
				pointers.cancel();
				stopMarch();
				stopRefine();
				cancelScriptPointers();
				cancelAnimationFrame(scriptTickFrame);
				scriptTickFrame = 0;
				cancelAnimationFrame(renderFrame);
				cancelAnimationFrame(tickFrame);
				cancelAnimationFrame(cardTickFrame);
				if (cardTickTimer !== null) clearTimeout(cardTickTimer);
				renderFrame = 0;
				tickFrame = 0;
				cardTickFrame = 0;
				cardTickTimer = null;
				return;
			}
			player.reset();
			scriptLastTick = performance.now();
			resize();
		},
		invalidate(invalidation) {
			if (invalidation?.cards) {
				cardEpoch += 1;
			}
			for (const id of invalidation?.items ?? []) staleIds.add(id);
			scheduleTick();
		},
		isMaterialized: (id) => Boolean(scene?.getNode(id)),
		toWorld: (clientX, clientY) => pointToWorld(localPoint(clientX, clientY), renderCamera()),
		destroy() {
			disposed = true;
			pointers.cancel();
			stopMarch();
			stopRefine();
			textResolution.dispose();
			scriptPointers.clear();
			stopTransforms?.();
			scriptObservers.clear();
			scriptListeners.clear();
			stopMaintenance?.();
			stopDensity?.();
			stopEditor();
			stopAssets();
			resizeObserver.disconnect();
			cancelAnimationFrame(scriptTickFrame);
			cancelAnimationFrame(resizeFrame);
			cancelAnimationFrame(renderFrame);
			cancelAnimationFrame(tickFrame);
			cancelAnimationFrame(cardTickFrame);
			if (cardTickTimer !== null) clearTimeout(cardTickTimer);
			cardTickTimer = null;
			for (const [type, listener] of listeners) host.removeEventListener(type, listener as EventListener);
			editor.setPlayedItems(new Map());
			editor.setScriptItems(new Map());
			scene?.destroy(renderContext(theme(), editor.scene, 0));
			scene = null;
			scripts?.destroy();
			scripts = null;
			background?.destroy({ children: true });
			background = null;
			views.destroy();
			world = null;
			overlay = null;
			app?.destroy({ removeView: true });
			app = null;
		},
	};
}
