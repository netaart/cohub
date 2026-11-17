import type { Container, Renderer } from "pixi.js";
import { RendererType } from "pixi.js";
import {
	type BoardDepthShadow,
	type BoardDepthSurface,
	type BoardDepthView,
	type BoardSceneItem,
	type BoardScene,
	type BoardVec2,
	type WorldPoint,
	boardDepthContactShadow,
	boardDepthFlatPoint,
	boardDepthItemOutline,
	boardDepthOf,
	boardDepthRootOf,
	boardDepthRoots,
	boardDepthShadow,
	boardDepthSurface,
	boardModelPlayback,
	hitBoardDepthSurface,
	isBoardDepthLifted,
	isBoardModelObject,
	resolveBoardDepth,
	worldPoint,
} from "../model/index.js";
import type { LoadedModel } from "../render/model3d/index.js";
import {
	type BoardDepthBend,
	type BoardDepthLayer,
	type BoardDepthObject,
	type BoardDepthPicture,
	type BoardDepthShadows,
	type BoardDepthStage,
	BOARD_DEPTH_MAX_EDGE,
	boardDepthDensity,
	createBoardDepthPicture,
	createBoardDepthShadows,
	drawBoardDepthParts,
	loadBoardDepthEngine,
	resolveBoardDepthBend,
} from "../render/depth/index.js";

const NO_IDS: ReadonlySet<string> = new Set();

export type BoardStageDepthOptions = {
	renderer: () => Renderer | null;
	layer: () => Container | null;
	host: (id: string) => Container | null;
	parts: (id: string) => Container[];
	bend: (id: string) => unknown;
	fault: (id: string, message: string) => void;
	frame: () => void;
	animate: () => void;
	loadModel: (item: BoardSceneItem, signal: AbortSignal) => Promise<LoadedModel> | null;
	loaded?: (id: string, model: LoadedModel) => void;
	reducedMotion: () => boolean;
	maxEdge?: number;
};

export type BoardStageDepth = {
	elevated(scene: BoardScene): ReadonlySet<string>;
	pinned(scene: BoardScene): Iterable<string>;
	warm(): void;
	prepare(input: { scene: BoardScene; view: BoardDepthView; resolution: number; touched: ReadonlySet<string> }): void;
	unproject(scene: BoardScene, screen: BoardVec2): { id: string; world: WorldPoint } | null;
	outline(scene: BoardScene, id: string, view: BoardDepthView): WorldPoint[] | null;
	readonly active: boolean;
	destroy(): void;
};

type Lift = {
	id: string;
	surface: BoardDepthSurface;
	picture: BoardDepthPicture;
	key: string;
	subtree: ReadonlySet<string>;
};

function touches(subtree: ReadonlySet<string>, touched: ReadonlySet<string>): boolean {
	if (!touched.size) return false;
	for (const id of subtree) if (touched.has(id)) return true;
	return false;
}

export function createBoardStageDepth(options: BoardStageDepthOptions): BoardStageDepth {
	let stage: BoardDepthStage | null = null;
	let loading = false;
	let failed = false;
	let disposed = false;
	let shadows: BoardDepthShadows | null = null;
	const solids = new Map<string, BoardDepthSurface>();
	const lifts = new Map<string, Lift>();
	const models = new Map<string, { key: string; model: LoadedModel | null; controller: AbortController }>();
	let lastPrepare = 0;
	let clock = 0;
	const faults = new Map<string, string>();
	const fault = (id: string, message: string) => {
		if (faults.get(id) === message) return;
		faults.set(id, message);
		options.fault(id, message);
	};
	const backs = new Map<string, { picture: BoardDepthPicture; key: string; subtree: ReadonlySet<string> }>();
	let elevatedScene: BoardScene | null = null;
	let elevated: ReadonlySet<string> = NO_IDS;
	let rootsScene: BoardScene | null = null;
	let roots: BoardSceneItem[] = [];

	function rootsOf(scene: BoardScene): BoardSceneItem[] {
		if (scene !== rootsScene) {
			rootsScene = scene;
			roots = boardDepthRoots(scene);
		}
		return roots;
	}

	function load() {
		if (loading || stage || failed || disposed) return;
		const renderer = options.renderer();
		if (!renderer) return;
		if (renderer.type !== RendererType.WEBGL) {
			failed = true;
			return;
		}
		loading = true;
		loadBoardDepthEngine()
			.then((engine) => engine.createBoardDepthStage(renderer))
			.then((next) => {
				loading = false;
				if (disposed) return next.destroy();
				stage = next;
				options.frame();
			})
			.catch((error) => {
				loading = false;
				failed = true;
				console.error("Board depth failed to start", error);
			});
	}

	function subtreeOf(scene: BoardScene, id: string): ReadonlySet<string> {
		return new Set([id, ...scene.descendants(id)]);
	}

	function bendOf(renderer: Renderer, id: string, kind: string): BoardDepthBend | null {
		return kind === "custom" ? resolveBoardDepthBend(renderer, id, options.bend(id), fault) : null;
	}

	function modelOf(item: BoardSceneItem): LoadedModel | null {
		if (item.type !== "file") return null;
		const key = `${item.props.src}:${item.props.snapshot?.mtimeMs ?? ""}`;
		let entry = models.get(item.id);
		if (entry && entry.key !== key) {
			releaseModel(item.id);
			entry = undefined;
		}
		if (!entry) {
			const controller = new AbortController();
			const next = { key, model: null as LoadedModel | null, controller };
			models.set(item.id, next);
			options
				.loadModel(item, controller.signal)
				?.then((model) => {
					if (controller.signal.aborted || models.get(item.id) !== next) return model.destroy();
					next.model = model;
					options.loaded?.(item.id, model);
					options.frame();
				})
				.catch(() => undefined);
			entry = next;
		}
		return entry.model;
	}

	function releaseModel(id: string) {
		const entry = models.get(id);
		if (!entry) return;
		models.delete(id);
		entry.controller.abort();
		entry.model?.destroy();
	}

	function attach() {
		const layer = options.layer();
		if (!layer || !stage) return;
		shadows ??= createBoardDepthShadows();
		if (shadows.container.parent !== layer) layer.addChild(shadows.container);
		if (stage.view.parent !== layer) layer.addChild(stage.view);
	}

	function releaseLift(id: string) {
		lifts.get(id)?.picture.destroy();
		lifts.delete(id);
	}

	function drawBack(renderer: Renderer, scene: BoardScene, id: string, density: number, touched: ReadonlySet<string>): BoardDepthPicture | null {
		const item = scene.get(id);
		const parts = options.parts(id);
		if (!item || !parts.length) return null;
		let entry = backs.get(id);
		const key = `${item.frame.width}x${item.frame.height}@${density}`;
		if (!entry) {
			entry = { picture: createBoardDepthPicture(), key: "", subtree: subtreeOf(scene, id) };
			backs.set(id, entry);
		}
		const stale = entry.key !== key || touches(entry.subtree, touched);
		if (!stale) return entry.picture;
		entry.key = key;
		entry.subtree = subtreeOf(scene, id);
		drawBoardDepthParts(renderer, entry.picture, parts, item.frame, density, options.maxEdge);
		return entry.picture;
	}

	return {
		elevated(scene) {
			if (!stage) return NO_IDS;
			if (scene === elevatedScene) return elevated;
			elevatedScene = scene;
			const next = rootsOf(scene).map((item) => item.id);
			if (next.length !== elevated.size || next.some((id) => !elevated.has(id))) elevated = next.length ? new Set(next) : NO_IDS;
			return elevated;
		},
		*pinned(scene) {
			for (const root of rootsOf(scene)) {
				yield root.id;
				yield* scene.descendants(root.id);
				const back = resolveBoardDepth(root.depth)?.back;
				if (back && scene.get(back)) {
					yield back;
					yield* scene.descendants(back);
				}
			}
		},
		warm: load,
		prepare({ scene, view, resolution, touched }) {
			const list = rootsOf(scene);
			if (list.length) load();
			const renderer = options.renderer();
			if (!stage || !renderer) return;
			const wanted = new Set(list.map((item) => item.id));
			for (const id of [...lifts.keys()]) if (!wanted.has(id)) releaseLift(id);
			const usedBacks = new Set<string>();
			const layers: BoardDepthLayer[] = [];
			const objects: BoardDepthObject[] = [];
			const shadowInput = new Map<string, { shadow: BoardDepthShadow; width: number; height: number; opacity: number }>();
			for (const item of list) {
				const depth = boardDepthOf(item);
				const host = options.host(item.id);
				if (!depth || !host || !scene.shown(item.id) || scene.opacity(item.id) <= 0) continue;
				const model = isBoardModelObject(item) ? modelOf(item) : null;
				const playback = model && boardModelPlayback(item, options.reducedMotion());
				if (model && playback && item.type === "file") {
					releaseLift(item.id);
					objects.push({ id: item.id, model, frame: item.frame, origin: item.origin, depth, view: item.props.model?.view, playback });
					continue;
				}
				let lift = lifts.get(item.id);
				const surface = boardDepthSurface({ frame: item.frame, origin: item.origin, depth }, view, lift?.surface);
				const density = boardDepthDensity(view, resolution, surface);
				const key = `${item.frame.width}x${item.frame.height}@${density}`;
				if (!lift) {
					lift = { id: item.id, surface, picture: createBoardDepthPicture(), key: "", subtree: subtreeOf(scene, item.id) };
					lifts.set(item.id, lift);
				}
				lift.surface = surface;
				if (lift.key !== key || touches(lift.subtree, touched)) {
					lift.subtree = subtreeOf(scene, item.id);
					lift.key = key;
					lift.picture.draw(renderer, host, item.frame, density, options.maxEdge ?? BOARD_DEPTH_MAX_EDGE);
				}
				const backId = depth.back && depth.back !== item.id && scene.get(depth.back) ? depth.back : null;
				const back = backId ? drawBack(renderer, scene, backId, density, touched) : null;
				if (backId) usedBacks.add(backId);
				const bend = bendOf(renderer, item.id, depth.bend.kind);
				layers.push({
					id: item.id,
					surface,
					front: lift.picture.texture,
					back: back?.texture ?? null,
					opacity: scene.opacity(item.id),
					bend: bend ? { source: bend, width: item.frame.width, height: item.frame.height, amount: depth.bend.amount, phase: depth.bend.phase, shade: depth.shade } : null,
				});
				const shadow = boardDepthShadow(surface, view, depth.shadow);
				if (shadow) shadowInput.set(item.id, { shadow, width: item.frame.width, height: item.frame.height, opacity: scene.opacity(item.id) });
			}
			for (const id of [...models.keys()]) if (!wanted.has(id)) releaseModel(id);
			const now = performance.now();
			clock += lastPrepare ? Math.min(now - lastPrepare, 100) : 0;
			lastPrepare = now;
			const { sizes, moving } = stage.objects.sync(view, objects, clock);
			if (moving) options.animate();
			for (const object of objects) {
				const size = sizes.get(object.id) ?? { width: object.frame.width, height: object.frame.height, thickness: 0 };
				const raised = { ...object.depth, lift: object.depth.lift + size.thickness / 2 };
				const surface = boardDepthSurface({ frame: object.frame, origin: object.origin, depth: raised }, view);
				solids.set(object.id, surface);
				const shadow = boardDepthContactShadow(object.frame, object.depth, size);
				if (shadow) shadowInput.set(object.id, { shadow, width: object.frame.width, height: object.frame.height, opacity: scene.opacity(object.id) });
			}
			for (const id of [...solids.keys()]) if (!objects.some((object) => object.id === id)) solids.delete(id);
			for (const [id, entry] of [...backs]) {
				if (usedBacks.has(id)) continue;
				entry.picture.destroy();
				backs.delete(id);
			}
			attach();
			stage.resize(view.width, view.height);
			stage.view.position.set(-view.x / view.zoom, -view.y / view.zoom);
			stage.view.scale.set(1 / view.zoom);
			stage.sync(layers);
			stage.view.visible = !stage.empty;
			shadows?.sync(shadowInput);
		},
		unproject(scene, screen) {
			let best: { id: string; world: WorldPoint; distance: number } | null = null;
			const surfaces = [...[...lifts.values()].map((lift) => [lift.id, lift.surface] as const), ...solids];
			for (const [id, surface] of surfaces) {
				const item = scene.get(id);
				if (!item || !boardDepthOf(item) || !scene.shown(id) || scene.opacity(id) <= 0) continue;
				const hit = hitBoardDepthSurface(surface, screen);
				if (!hit || (best && hit.distance >= best.distance)) continue;
				const point = boardDepthFlatPoint(item.frame, hit.u, hit.v);
				best = { id, world: worldPoint(point.x, point.y), distance: hit.distance };
			}
			return best && { id: best.id, world: best.world };
		},
		outline(scene, id, view) {
			const root = boardDepthRootOf(scene, id);
			if (!root || !(lifts.has(root) || solids.has(root)) || !isBoardDepthLifted(scene, id)) return null;
			return boardDepthItemOutline(scene, id, view)?.map((point) => worldPoint(point.x, point.y)) ?? null;
		},
		get active() {
			return lifts.size > 0 || solids.size > 0;
		},
		destroy() {
			disposed = true;
			for (const id of [...lifts.keys()]) releaseLift(id);
			for (const id of [...models.keys()]) releaseModel(id);
			for (const entry of backs.values()) entry.picture.destroy();
			backs.clear();
			shadows?.destroy();
			shadows = null;
			stage?.view.removeFromParent();
			stage?.destroy();
			stage = null;
		},
	};
}
