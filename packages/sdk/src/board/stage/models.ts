import type { BoardModelSettings } from "@cohub/protocol/board-model";
import type { Renderer } from "pixi.js";
import type { BoardPointerEvent } from "../editor/index.js";
import { type BoardAssetSource, type BoardScene, type BoardSceneItem, boardModelFormat, boardModelViewKey, fileStem, isBoardModelItem, type WorldPoint } from "../model/index.js";
import type { BoardModelLive } from "../render/index.js";
import { boardModelSource, type LoadedModel, loadModelEngine, MODEL_VIEW_PRESETS, type ModelScene, type ModelView } from "../render/model3d/index.js";

export type BoardModelTheater = {
	sync(input: { scene: BoardScene; running: ReadonlySet<string>; entered: string | null }): void;
	live(id: string): BoardModelLive | null;
	tick(now: number, zoom: number): number | null;
	pointer(phase: "down" | "move" | "up", input: BoardPointerEvent): boolean;
	wheel(deltaY: number, world: WorldPoint): boolean;
	home(world: WorldPoint): boolean;
	key(key: string): boolean;
	over(world: WorldPoint): boolean;
	readonly view: ModelView | null;
	destroy(): void;
};

type Entry = {
	id: string;
	key: string;
	controller: AbortController;
	model: LoadedModel | null;
	scene: ModelScene | null;
	rect: { x: number; y: number; width: number; height: number } | null;
	leaving: boolean;
	retired: boolean;
	failed: boolean;
	live: BoardModelLive | null;
	settings: BoardModelSettings | undefined;
};

export type BoardModelTheaterOptions = {
	renderer: () => Renderer | null;
	source: BoardAssetSource;
	maxBytes: number;
	pick: (world: WorldPoint) => string | null;
	density: () => number;
	reducedMotion: () => boolean;
	changed: (id: string) => void;
	frame: () => void;
};

const ANIMATION_FRAME_MS = 1000 / 30;

function modelKey(item: BoardSceneItem): string | null {
	if (item.type !== "file" || !isBoardModelItem(item) || item.props.model?.display === "object") return null;
	return `${item.props.src}:${item.props.snapshot?.mtimeMs ?? ""}`;
}

const settingsOf = (item: BoardSceneItem) => (item.type === "file" ? item.props.model : undefined);

export function createBoardModelTheater(options: BoardModelTheaterOptions): BoardModelTheater {
	const entries = new Map<string, Entry>();
	const motionless = new Set<string>();
	const pointers = new Set<number>();
	let entered: string | null = null;
	let zoom = 1;
	let lastTick = 0;

	function layout(entry: Entry) {
		if (!entry.scene || !entry.rect) return;
		const { x, y, width, height } = entry.rect;
		entry.scene.view.position.set(x, y);
		entry.scene.resize(width, height, zoom, options.density());
	}

	function destroy(entry: Entry) {
		entry.controller.abort();
		if (entries.get(entry.id) === entry) entries.delete(entry.id);
		entry.scene?.view.removeFromParent();
		entry.scene?.destroy();
		entry.model?.destroy();
		entry.scene = null;
		entry.model = null;
	}

	// The card draws its still again first; the view goes once the card has let go.
	function release(entry: Entry) {
		if (!entry.scene) return destroy(entry);
		entry.controller.abort();
		entry.retired = true;
		options.changed(entry.id);
	}

	function sweep() {
		for (const entry of [...entries.values()]) if (entry.retired && !entry.scene?.view.parent) destroy(entry);
	}

	async function start(entry: Entry, item: BoardSceneItem) {
		if (item.type !== "file") return;
		const format = boardModelFormat(item.props.src, item.props.snapshot?.mimeType);
		const source = format && boardModelSource({ key: entry.key, src: item.props.src, format, size: item.props.snapshot?.size, name: fileStem(item.props.src) }, options.source);
		if (!source) return;
		const { signal } = entry.controller;
		const renderer = options.renderer();
		if (!renderer) return;
		try {
			const engine = await loadModelEngine();
			const [model] = await Promise.all([engine.loadModel(source, { signal, maxBytes: options.maxBytes }), engine.prepareModelRenderer(renderer)]);
			if (signal.aborted) return model.destroy();
			if (!model.player && entry.id !== entered) {
				motionless.add(entry.key);
				model.destroy();
				return destroy(entry);
			}
			const reducedMotion = options.reducedMotion();
			const scene = engine.createModelScene(model, { reducedMotion, home: entry.settings?.view, changed: options.frame });
			entry.model = model;
			entry.scene = scene;
			scene.clip = entry.settings?.animation ?? scene.clip;
			scene.playing = !reducedMotion;
			layout(entry);
			options.changed(entry.id);
			options.frame();
		} catch {
			entry.failed = true;
			if (!signal.aborted) options.changed(entry.id);
		}
	}

	function leave(entry: Entry) {
		if (entry.leaving || entry.retired) return;
		if (!entry.scene || entry.scene.atHome || options.reducedMotion()) return release(entry);
		entry.leaving = true;
		entry.scene.home();
		options.frame();
	}

	function configure(entry: Entry, settings: BoardModelSettings | undefined) {
		const before = entry.settings;
		entry.settings = settings;
		const scene = entry.scene;
		if (!scene) return;
		if (boardModelViewKey(before?.view) !== boardModelViewKey(settings?.view)) {
			scene.homeView = settings?.view ?? MODEL_VIEW_PRESETS.home;
			if (entry.id !== entered) scene.home();
		}
		if (before?.animation !== settings?.animation) scene.clip = settings?.animation ?? scene.clips[0] ?? null;
	}

	const enteredEntry = () => (entered ? entries.get(entered) : undefined);
	// A failed model keeps its still and leaves the pointer to the board.
	const onEntered = (world: WorldPoint) => {
		const entry = enteredEntry();
		return entry !== undefined && !entry.failed && options.pick(world) === entered;
	};

	return {
		sync({ scene, running, entered: next }) {
			sweep();
			const previous = entered;
			entered = next && isBoardModelItem(scene.get(next)) ? next : null;
			if (previous !== entered) {
				pointers.clear();
				for (const id of [previous, entered]) if (id) options.changed(id);
			}
			const wanted = new Map<string, BoardSceneItem>();
			for (const id of [...running, ...(entered ? [entered] : [])]) {
				const item = scene.get(id);
				const key = item && modelKey(item);
				if (key && (id === entered || !motionless.has(key))) wanted.set(id, item);
			}
			for (const entry of [...entries.values()]) {
				if (entry.retired) continue;
				const item = wanted.get(entry.id);
				if (!item || modelKey(item) !== entry.key) {
					if (item) release(entry);
					else leave(entry);
				} else {
					entry.leaving = false;
					configure(entry, settingsOf(item));
				}
			}
			for (const [id, item] of wanted) {
				const existing = entries.get(id);
				if (existing && !existing.retired) continue;
				if (existing) destroy(existing);
				const entry: Entry = { id, key: modelKey(item) as string, controller: new AbortController(), model: null, scene: null, rect: null, leaving: false, retired: false, failed: false, live: null, settings: settingsOf(item) };
				entries.set(id, entry);
				void start(entry, item);
			}
		},
		live(id) {
			const entry = entries.get(id);
			if (!entry || entry.retired || entry.failed || (!entry.scene && id !== entered)) return null;
			entry.live ??= {
				get view() {
					return entry.scene?.view ?? null;
				},
				get interactive() {
					return entered === id;
				},
				place(x, y, width, height) {
					const rect = entry.rect;
					if (rect && rect.x === x && rect.y === y && rect.width === width && rect.height === height) return;
					entry.rect = { x, y, width, height };
					layout(entry);
				},
			};
			return entry.live;
		},
		tick(now, nextZoom) {
			sweep();
			const rescaled = nextZoom !== zoom;
			zoom = nextZoom;
			const delta = lastTick ? now - lastTick : 0;
			let wait: number | null = null;
			for (const entry of entries.values()) {
				if (!entry.scene || entry.retired) continue;
				if (rescaled) layout(entry);
				const moving = entry.scene.step(delta);
				if (entry.leaving && !moving) release(entry);
				else if (moving) wait = 0;
				else if (entry.scene.playing) wait = Math.min(wait ?? ANIMATION_FRAME_MS, ANIMATION_FRAME_MS);
			}
			lastTick = wait === null ? 0 : now;
			return wait;
		},
		pointer(phase, input) {
			const scene = enteredEntry()?.scene;
			if (phase === "down") {
				if (!pointers.size && (input.button !== 0 || !onEntered(input.world))) return false;
				pointers.add(input.pointerId);
				scene?.press(input.pointerId, input.screen.x, input.screen.y, input.shiftKey);
				return true;
			}
			if (!pointers.has(input.pointerId)) return false;
			if (phase === "move") scene?.move(input.pointerId, input.screen.x, input.screen.y);
			else {
				pointers.delete(input.pointerId);
				scene?.release(input.pointerId);
			}
			return true;
		},
		wheel(deltaY, world) {
			if (!onEntered(world)) return false;
			enteredEntry()?.scene?.wheel(deltaY);
			return true;
		},
		home(world) {
			if (!onEntered(world)) return false;
			enteredEntry()?.scene?.home();
			return true;
		},
		key: (key) => enteredEntry()?.scene?.key(key) ?? false,
		over: onEntered,
		get view() {
			return enteredEntry()?.scene?.viewpoint ?? null;
		},
		destroy() {
			for (const entry of [...entries.values()]) destroy(entry);
			pointers.clear();
		},
	};
}
