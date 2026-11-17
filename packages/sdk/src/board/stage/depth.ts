import type { Container, Renderer } from "pixi.js";
import { RendererType } from "pixi.js";
import {
	type BoardDepthPose,
	type BoardDepthShadow,
	type BoardDepthSurface,
	type BoardProjection,
	type BoardSceneItem,
	type BoardScene,
	type BoardVec2,
	type WorldPoint,
	boardDepthContactShadow,
	boardDepthFlatPoint,
	boardDepthOf,
	boardDepthPictureOutline,
	boardDepthPose,
	boardDepthRiding,
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
	type BoardDepthObjectPlacement,
	type BoardDepthPicture,
	type BoardDepthShadows,
	type BoardDepthStage,
	type BoardGroundOptions,
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
	shadows: () => Container | null;
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
	prepare(input: { scene: BoardScene; projection: BoardProjection; resolution: number; touched: ReadonlySet<string> }): void;
	ground(content: Container | null, options?: BoardGroundOptions): boolean;
	unproject(scene: BoardScene, screen: BoardVec2): { id: string; world: WorldPoint } | null;
	outline(scene: BoardScene, id: string, projection: BoardProjection): WorldPoint[] | null;
	readonly riding: boolean;
	readonly active: boolean;
	destroy(): void;
};

type Lift = {
	id: string;
	item: BoardSceneItem | null;
	surface: BoardDepthSurface;
	pose: BoardDepthPose;
	picture: BoardDepthPicture;
	key: string;
	subtree: ReadonlySet<string>;
};

type Solid = { item: BoardSceneItem; hull: readonly (readonly [number, number, number])[] };

function touches(subtree: ReadonlySet<string>, touched: ReadonlySet<string>): boolean {
	if (!touched.size) return false;
	for (const id of subtree) if (touched.has(id)) return true;
	return false;
}

function inHull(points: readonly BoardVec2[], at: BoardVec2): BoardVec2 | null {
	let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
	for (const point of points) {
		x0 = Math.min(x0, point.x);
		y0 = Math.min(y0, point.y);
		x1 = Math.max(x1, point.x);
		y1 = Math.max(y1, point.y);
	}
	if (at.x < x0 || at.x > x1 || at.y < y0 || at.y > y1) return null;
	const hull = convexHull(points);
	for (let i = 0; i < hull.length; i++) {
		const a = hull[i] as BoardVec2;
		const b = hull[(i + 1) % hull.length] as BoardVec2;
		if ((b.x - a.x) * (at.y - a.y) - (b.y - a.y) * (at.x - a.x) < 0) return null;
	}
	return { x: (at.x - x0) / Math.max(x1 - x0, 1e-6), y: (at.y - y0) / Math.max(y1 - y0, 1e-6) };
}

function convexHull(points: readonly BoardVec2[]): BoardVec2[] {
	const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
	const cross = (o: BoardVec2, a: BoardVec2, b: BoardVec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
	const half = (list: BoardVec2[]) => {
		const out: BoardVec2[] = [];
		for (const point of list) {
			while (out.length >= 2 && cross(out[out.length - 2] as BoardVec2, out[out.length - 1] as BoardVec2, point) <= 0) out.pop();
			out.push(point);
		}
		out.pop();
		return out;
	};
	return [...half(sorted), ...half([...sorted].reverse())];
}

export function createBoardStageDepth(options: BoardStageDepthOptions): BoardStageDepth {
	let stage: BoardDepthStage | null = null;
	let loading = false;
	let failed = false;
	let disposed = false;
	let shadows: BoardDepthShadows | null = null;
	let projection: BoardProjection | null = null;
	const solids = new Map<string, Solid>();
	const lifts = new Map<string, Lift>();
	const models = new Map<string, { key: string; model: LoadedModel | null; controller: AbortController }>();
	let lastPrepare = 0;
	let clock = 0;
	let riders = 0;
	let grounded = false;
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
		const below = options.shadows();
		if (!layer || !below || !stage) return;
		shadows ??= createBoardDepthShadows();
		if (shadows.container.parent !== below) below.addChild(shadows.container);
		if (stage.view.parent !== layer) layer.addChildAt(stage.view, grounded ? 1 : 0);
	}

	function ground(content: Container | null, groundOptions?: BoardGroundOptions): boolean {
		const renderer = options.renderer();
		const layer = options.layer();
		if (!content || !groundOptions) {
			if (grounded) stage?.ground().view.removeFromParent();
			grounded = false;
			return false;
		}
		if (!stage) load();
		if (!stage || !renderer || !layer || !projection) return false;
		attach();
		const surface = stage.ground();
		if (surface.view.parent !== layer) layer.addChildAt(surface.view, 0);
		surface.draw(renderer, content, projection, groundOptions);
		grounded = true;
		return true;
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
		ground,
		prepare({ scene, projection: view, resolution, touched }) {
			const list = rootsOf(scene);
			if (list.length) load();
			const renderer = options.renderer();
			if (!stage || !renderer) return;
			projection = view;
			stage.aim(view);
			const wanted = new Set(list.map((item) => item.id));
			for (const id of [...lifts.keys()]) if (!wanted.has(id)) releaseLift(id);
			const objects: BoardDepthObject[] = [];
			const flats: Array<{ item: BoardSceneItem; depth: NonNullable<ReturnType<typeof boardDepthOf>> }> = [];
			for (const item of list) {
				const depth = boardDepthOf(item, scene);
				if (!depth || !options.host(item.id) || !scene.shown(item.id) || scene.opacity(item.id) <= 0) continue;
				const model = isBoardModelObject(item) ? modelOf(item) : null;
				const playback = model && boardModelPlayback(item, options.reducedMotion());
				if (model && playback && item.type === "file") {
					releaseLift(item.id);
					objects.push({ id: item.id, model, frame: item.frame, origin: item.origin, depth, view: item.props.model?.view, playback });
				} else flats.push({ item, depth });
			}
			for (const id of [...models.keys()]) if (!wanted.has(id)) releaseModel(id);
			const now = performance.now();
			clock += lastPrepare ? Math.min(now - lastPrepare, 100) : 0;
			lastPrepare = now;
			const shadowInput = new Map<string, { shadow: BoardDepthShadow; width: number; height: number; opacity: number }>();
			const { placements, moving } = stage.objects.sync(view, objects, clock);
			if (moving) options.animate();
			solids.clear();
			for (const object of objects) {
				const placement = placements.get(object.id) as BoardDepthObjectPlacement;
				const item = scene.get(object.id) as BoardSceneItem;
				solids.set(object.id, { item, hull: placement.hull });
				const shadow = boardDepthContactShadow(object.frame, object.depth, placement.size);
				if (shadow) shadowInput.set(object.id, { shadow, width: object.frame.width, height: object.frame.height, opacity: scene.opacity(object.id) });
			}
			const usedBacks = new Set<string>();
			const layers: BoardDepthLayer[] = [];
			riders = 0;
			for (const { item, depth } of flats) {
				const host = options.host(item.id) as Container;
				let lift = lifts.get(item.id);
				const surface = lift && lift.item === item ? lift.surface : boardDepthSurface({ frame: item.frame, origin: item.origin, depth }, lift?.surface);
				const ride = boardDepthRiding(scene, item, stage.objects.node);
				if (ride && depth.shadow > 0) riders += 1;
				const pose = boardDepthPose(surface, view, ride);
				const density = boardDepthDensity(view, resolution, pose);
				const key = `${item.frame.width}x${item.frame.height}@${density}`;
				if (!lift) {
					lift = { id: item.id, item, surface, pose, picture: createBoardDepthPicture(), key: "", subtree: subtreeOf(scene, item.id) };
					lifts.set(item.id, lift);
				}
				lift.item = item;
				lift.surface = surface;
				lift.pose = pose;
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
					pose,
					front: lift.picture.texture,
					back: back?.texture ?? null,
					opacity: scene.opacity(item.id),
					bend: bend ? { source: bend, width: item.frame.width, height: item.frame.height, amount: depth.bend.amount, phase: depth.bend.phase, shade: depth.shade } : null,
				});
				const shadow = boardDepthShadow(surface, pose, view, depth.shadow);
				if (shadow) shadowInput.set(item.id, { shadow, width: item.frame.width, height: item.frame.height, opacity: scene.opacity(item.id) });
			}
			for (const [id, entry] of [...backs]) {
				if (usedBacks.has(id)) continue;
				entry.picture.destroy();
				backs.delete(id);
			}
			attach();
			stage.sync(layers);
			stage.view.visible = !stage.empty;
			shadows?.sync(shadowInput);
		},
		unproject(scene, screen) {
			if (!projection) return null;
			let best: { id: string; world: WorldPoint; distance: number } | null = null;
			const shown = (id: string) => {
				const item = scene.get(id);
				return item && boardDepthOf(item, scene) && scene.shown(id) && scene.opacity(id) > 0 ? item : null;
			};
			for (const lift of lifts.values()) {
				const item = shown(lift.id);
				const hit = item && hitBoardDepthSurface(lift.surface, lift.pose, projection, screen);
				if (!item || !hit || (best && hit.distance >= best.distance)) continue;
				const point = boardDepthFlatPoint(item.frame, hit.u, hit.v);
				best = { id: lift.id, world: worldPoint(point.x, point.y), distance: hit.distance };
			}
			for (const [id, solid] of solids) {
				const item = shown(id);
				const at = item && inHull(solid.hull.map(([x, y, z]) => (projection as BoardProjection).project(x, y, z)), screen);
				if (!item || !at) continue;
				const middle = solid.hull.reduce((sum, [x, y, z]) => [sum[0] + x / 8, sum[1] + y / 8, sum[2] + z / 8], [0, 0, 0]);
				const distance = projection.depth(middle[0], middle[1], middle[2]);
				if (best && distance >= best.distance) continue;
				const point = boardDepthFlatPoint(item.frame, at.x, at.y);
				best = { id, world: worldPoint(point.x, point.y), distance };
			}
			return best && { id: best.id, world: best.world };
		},
		outline(scene, id, view) {
			const root = boardDepthRootOf(scene, id);
			if (!root || !isBoardDepthLifted(scene, id)) return null;
			const solid = solids.get(root);
			if (solid) return convexHull(solid.hull.map(([x, y, z]) => view.project(x, y, z))).map((point) => view.ground(point));
			const item = scene.get(id);
			const rootItem = scene.get(root);
			const depth = rootItem && boardDepthOf(rootItem, scene);
			if (!item || !rootItem || !depth || !lifts.has(root)) return null;
			const surface = boardDepthSurface({ frame: rootItem.frame, origin: rootItem.origin, depth });
			const pose = boardDepthPose(surface, view, stage ? boardDepthRiding(scene, rootItem, stage.objects.node) : undefined);
			return boardDepthPictureOutline(id === root ? null : item.frame, surface, pose, view);
		},
		get riding() {
			return riders > 0;
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
