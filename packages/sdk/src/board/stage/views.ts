import type { Texture } from "pixi.js";
import type { BoardEditor, BoardPointerEvent } from "../editor/index.js";
import { itemBounds, type BoardFrame, type BoardScene, type BoardSceneItem, type BoardViewport } from "../model/index.js";
import { boardBitmapResolution } from "../render/bitmap-resolution.js";
import { toBoardPointerEvent } from "./pointer.js";
import { type BoardViewSurface, boardViewDrawingSupported, createBoardViewSurface } from "./view-surface.js";

export type BoardItemViewContext = {
	editor: BoardEditor;
	detailed: boolean;
	selected: boolean;
	/** The item is entered (`editor.enteredId`): its view takes input, like an embedded page. */
	entered: boolean;
	drawn: boolean;
	canDraw: boolean;
	/** Draw the view into the canvas where supported. Only readable content draws: no cross-origin frames, CORS images. */
	setDrawable(drawable: boolean): void;
	toPointerEvent(event: PointerEvent): BoardPointerEvent;
};

export type BoardItemViewInstance = {
	update?(item: BoardSceneItem, context: BoardItemViewContext): void;
	destroy?(): void;
};

export type BoardItemView = {
	type: string | ((item: BoardSceneItem) => boolean);
	/** Optional screen-pixel threshold for expensive content, with built-in hysteresis. */
	contentSize?: { width: number; height: number };
	mount(element: HTMLElement, item: BoardSceneItem, context: BoardItemViewContext): BoardItemViewInstance;
};

type ViewState = Pick<BoardItemViewContext, "detailed" | "selected" | "entered">;

type ViewMode = "dom" | "drawn" | "hidden";

type Mounted = {
	id: string;
	view: BoardItemView;
	mode: ViewMode;
	node: HTMLElement;
	content: HTMLElement;
	surface: BoardViewSurface | null;
	instance: BoardItemViewInstance | null;
	drawable: boolean;
	item: BoardSceneItem;
	shown: BoardSceneItem;
	context: BoardItemViewContext;
	style: string;
};

const VISIBLE_MARGIN = 240;
const RASTER_BUDGET_MS = 4;

function worldStyle(frame: BoardFrame, order: number): string {
	return [
		"position:absolute;pointer-events:none;transform-origin:center",
		`z-index:${order}`,
		`left:${frame.x}px`,
		`top:${frame.y}px`,
		`width:${frame.width}px`,
		`height:${frame.height}px`,
		`transform:rotate(${frame.rotation}deg)${frame.mirrored ? " scaleX(-1)" : ""}`,
	].join(";");
}

function onScreen(frame: BoardFrame, camera: BoardViewport, surface: { width: number; height: number }) {
	const bounds = itemBounds(frame);
	const left = bounds.x * camera.zoom + camera.x;
	const top = bounds.y * camera.zoom + camera.y;
	return (
		left + bounds.width * camera.zoom >= -VISIBLE_MARGIN &&
		top + bounds.height * camera.zoom >= -VISIBLE_MARGIN &&
		left <= surface.width + VISIBLE_MARGIN &&
		top <= surface.height + VISIBLE_MARGIN
	);
}

export type BoardItemViewStats = { drawn: number; rasters: number; rasterMs: number };

export type BoardItemViewLayer = {
	readonly element: HTMLElement;
	readonly textures: ReadonlyMap<string, Texture>;
	sync(input: {
		ids: ReadonlySet<string> | null;
		scene: BoardScene;
		camera: BoardViewport;
		surface: { width: number; height: number };
		selection: ReadonlySet<string>;
		enteredId: string | null;
		resolution: number;
		live: (id: string) => boolean;
	}): void;
	stats(): BoardItemViewStats;
	destroy(): void;
};

export function createBoardItemViewLayer(
	host: HTMLElement,
	editor: BoardEditor,
	views: readonly BoardItemView[],
	camera: () => BoardViewport,
	onInvalidate: () => void = () => {},
	layer: "above" | "below" = "above",
	draw = true,
): BoardItemViewLayer {
	const doc = host.ownerDocument;
	const element = doc.createElement("div");
	element.dataset.boardViews = "";
	element.style.cssText = `position:absolute;inset:0;z-index:${layer === "below" ? 0 : 2};overflow:hidden;pointer-events:none`;
	host.appendChild(element);
	const world = doc.createElement("div");
	world.style.cssText = "position:absolute;inset:0;transform-origin:0 0;pointer-events:none";
	element.appendChild(world);
	let cameraStyle = "";
	let drawing = draw && views.length > 0 && boardViewDrawingSupported();
	let resolution = 1;
	let live: (id: string) => boolean = () => false;
	const rasters = { count: 0, ms: 0 };
	let spent = 0;
	let budgetFrame = 0;
	const retired: BoardViewSurface[] = [];
	const mounted = new Map<string, Mounted>();
	const textures = new Map<string, Texture>();
	const pointers = new Map<number, string>();
	const retained = (id: string, entry: Mounted) =>
		entry.node.contains(doc.activeElement) || [...pointers.values()].includes(id);
	const pointerDown = (event: PointerEvent) => {
		const target = event.target as Element | null;
		const id = target?.closest<HTMLElement>("[data-board-item]")?.dataset.boardItem;
		if (id && mounted.has(id)) pointers.set(event.pointerId, id);
	};
	const pointerEnd = (event: PointerEvent) => {
		if (pointers.delete(event.pointerId)) onInvalidate();
	};
	element.addEventListener("pointerdown", pointerDown, true);
	element.addEventListener("focusout", onInvalidate);
	doc.addEventListener("pointerup", pointerEnd, true);
	doc.addEventListener("pointercancel", pointerEnd, true);
	const toPointerEvent = (event: PointerEvent) => toBoardPointerEvent(event, host, camera());
	const viewFor = (item: BoardSceneItem) =>
		views.find((view) => (typeof view.type === "string" ? view.type === item.type : view.type(item)));

	function retire(entry: Mounted) {
		if (entry.surface) retired.push(entry.surface);
		entry.surface = null;
		textures.delete(entry.id);
	}

	function spend(ms: number) {
		rasters.count += 1;
		rasters.ms += ms;
		spent += ms;
		budgetFrame ||= requestAnimationFrame(() => {
			budgetFrame = 0;
			spent = 0;
		});
	}

	function place(entry: Mounted, order: number) {
		const { frame } = entry.item;
		const style = worldStyle(frame, order);
		if (style === entry.style) return;
		entry.style = style;
		entry.node.style.cssText = nodeStyle(entry);
		entry.content.style.cssText = `position:relative;width:${frame.width}px;height:${frame.height}px`;
	}

	const nodeStyle = (entry: Mounted) => (entry.mode === "hidden" ? `${entry.style};visibility:hidden` : entry.style);

	function resize(entry: Mounted) {
		const { surface, item } = entry;
		if (!surface) return;
		const { width, height } = item.frame;
		surface.resize(width, height, boardBitmapResolution(width, height, resolution, surface.scale));
	}

	function present(entry: Mounted, item: BoardSceneItem, state: ViewState) {
		entry.item = item;
		const { context, instance } = entry;
		const drawn = entry.mode !== "dom";
		if (!instance) return;
		if (entry.shown === item && context.detailed === state.detailed && context.selected === state.selected && context.entered === state.entered && context.drawn === drawn && context.canDraw === drawing) return;
		entry.shown = item;
		entry.context = { ...context, ...state, drawn, canDraw: drawing };
		instance.update?.(item, entry.context);
	}

	function modeOf(entry: Mounted, detailed: boolean): ViewMode {
		if (!drawing || !entry.drawable) return "dom";
		return detailed && live(entry.id) ? "drawn" : "hidden";
	}

	function reconcile(entry: Mounted, detailed = entry.context.detailed) {
		const mode = modeOf(entry, detailed);
		if (mode === entry.mode) return;
		entry.mode = mode;
		retire(entry);
		let node: HTMLElement;
		if (mode === "drawn") {
			const surface = createBoardViewSurface(entry.content, {
				allow: () => spent < RASTER_BUDGET_MS,
				raster: spend,
				texture: () => {
					if (entry.surface !== surface || !surface.texture) return;
					textures.set(entry.id, surface.texture);
					onInvalidate();
				},
				error: fallBack,
			});
			entry.surface = surface;
			node = surface.element;
		} else {
			node = doc.createElement("div");
			node.appendChild(entry.content);
		}
		node.dataset.boardItem = entry.id;
		node.style.cssText = nodeStyle(entry);
		entry.node.replaceWith(node);
		entry.node = node;
		resize(entry);
		present(entry, entry.item, entry.context);
		onInvalidate();
	}

	function fallBack(error: unknown) {
		if (!drawing) return;
		drawing = false;
		console.warn("Board views can no longer be drawn into the canvas.", error);
		for (const entry of mounted.values()) reconcile(entry);
	}

	function mount(item: BoardSceneItem, view: BoardItemView, order: number, state: ViewState): Mounted {
		const content = doc.createElement("div");
		const node = doc.createElement("div");
		node.dataset.boardItem = item.id;
		node.appendChild(content);
		world.appendChild(node);
		const entry: Mounted = {
			id: item.id,
			view,
			mode: "dom",
			node,
			content,
			surface: null,
			instance: null,
			drawable: false,
			item,
			shown: item,
			style: "",
			context: {
				editor,
				...state,
				drawn: false,
				canDraw: drawing,
				setDrawable: (drawable) => {
					if (entry.drawable === drawable || mounted.get(entry.id) !== entry) return;
					entry.drawable = drawable;
					reconcile(entry);
				},
				toPointerEvent,
			},
		};
		mounted.set(item.id, entry);
		place(entry, order);
		entry.instance = view.mount(content, item, entry.context);
		present(entry, item, state);
		return entry;
	}

	function unmount(id: string, entry: Mounted) {
		entry.instance?.destroy?.();
		retire(entry);
		entry.node.remove();
		mounted.delete(id);
		for (const [pointer, owner] of pointers) if (owner === id) pointers.delete(pointer);
	}

	return {
		element,
		textures,
		sync({ ids, scene, camera: view, surface, selection, enteredId, resolution: density, live: isLive }) {
			if (views.length === 0) return;
			for (const old of retired.splice(0)) old.destroy();
			resolution = density;
			live = isLive;
			const transform = `translate(${view.x}px,${view.y}px) scale(${view.zoom})`;
			if (transform !== cameraStyle) world.style.transform = cameraStyle = transform;
			const shown = new Set<string>();
			const candidates = new Set(ids ?? scene.items.map((item) => item.id));
			for (const [id, entry] of mounted) if (retained(id, entry)) candidates.add(id);
			for (const id of candidates) {
				const item = scene.get(id);
				if (!item) continue;
				const itemView = viewFor(item);
				let entry = mounted.get(item.id);
				const held = entry ? retained(id, entry) : false;
				if (!itemView || (!held && !onScreen(item.frame, view, surface))) continue;
				shown.add(item.id);
				const minimum = itemView.contentSize;
				const threshold = entry?.context.detailed ? 0.85 : 1;
				const detailed = held || !minimum || (item.frame.width * view.zoom >= minimum.width * threshold && item.frame.height * view.zoom >= minimum.height * threshold);
				const state = { detailed, selected: selection.has(item.id), entered: enteredId === item.id };
				const order = scene.indexOf(item.id);
				if (entry && entry.view !== itemView) {
					unmount(item.id, entry);
					entry = undefined;
				}
				if (!entry) entry = mount(item, itemView, order, state);
				else {
					entry.item = item;
					reconcile(entry, detailed);
					place(entry, order);
					present(entry, item, state);
				}
				resize(entry);
			}
			for (const [id, entry] of mounted) if (!shown.has(id)) unmount(id, entry);
		},
		stats: () => ({ drawn: textures.size, rasters: rasters.count, rasterMs: rasters.ms }),
		destroy() {
			element.removeEventListener("pointerdown", pointerDown, true);
			element.removeEventListener("focusout", onInvalidate);
			doc.removeEventListener("pointerup", pointerEnd, true);
			doc.removeEventListener("pointercancel", pointerEnd, true);
			for (const [id, entry] of mounted) unmount(id, entry);
			for (const old of retired.splice(0)) old.destroy();
			cancelAnimationFrame(budgetFrame);
			element.remove();
		},
	};
}
