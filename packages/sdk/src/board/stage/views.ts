import type { BoardEditor, BoardPointerEvent } from "../editor/index.js";
import { itemBounds, type BoardFrame, type BoardScene, type BoardSceneItem, type BoardViewport } from "../model/index.js";
import { toBoardPointerEvent } from "./pointer.js";

export type BoardItemViewContext = {
	editor: BoardEditor;
	detailed: boolean;
	selected: boolean;
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

type Mounted = {
	view: BoardItemView;
	element: HTMLElement;
	instance: BoardItemViewInstance;
	item: BoardSceneItem;
	detailed: boolean;
	selected: boolean;
	style: string;
};

const VISIBLE_MARGIN = 240;

function worldStyle(frame: BoardFrame, order: number): string {
	return [
		`z-index:${order}`,
		`left:${frame.x}px`,
		`top:${frame.y}px`,
		`width:${frame.width}px`,
		`height:${frame.height}px`,
		`transform:rotate(${frame.rotation}deg)`,
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

export type BoardItemViewLayer = {
	readonly element: HTMLElement;
	sync(input: {
		ids: ReadonlySet<string> | null;
		scene: BoardScene;
		camera: BoardViewport;
		surface: { width: number; height: number };
		selection: ReadonlySet<string>;
	}): void;
	destroy(): void;
};

export function createBoardItemViewLayer(
	host: HTMLElement,
	editor: BoardEditor,
	views: readonly BoardItemView[],
	camera: () => BoardViewport,
	onInvalidate: () => void = () => {},
): BoardItemViewLayer {
	const element = host.ownerDocument.createElement("div");
	element.dataset.boardViews = "";
	element.style.cssText = "position:absolute;inset:0;z-index:2;overflow:hidden;pointer-events:none";
	host.appendChild(element);
	const world = host.ownerDocument.createElement("div");
	world.style.cssText = "position:absolute;inset:0;transform-origin:0 0;pointer-events:none";
	element.appendChild(world);
	let cameraStyle = "";
	const mounted = new Map<string, Mounted>();
	const pointers = new Map<number, string>();
	const retained = (id: string, entry: Mounted) =>
		entry.element.contains(host.ownerDocument.activeElement) || [...pointers.values()].includes(id);
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
	host.ownerDocument.addEventListener("pointerup", pointerEnd, true);
	host.ownerDocument.addEventListener("pointercancel", pointerEnd, true);
	const toPointerEvent = (event: PointerEvent) =>
		toBoardPointerEvent(event, host, camera());
	const viewFor = (item: BoardSceneItem) =>
		views.find((view) => (typeof view.type === "string" ? view.type === item.type : view.type(item)));

	function unmount(id: string, entry: Mounted) {
		entry.instance.destroy?.();
		entry.element.remove();
		mounted.delete(id);
		for (const [pointer, owner] of pointers) if (owner === id) pointers.delete(pointer);
	}

	return {
		element,
		sync({ ids, scene, camera: view, surface, selection }) {
			if (views.length === 0) return;
			const transform = `translate(${view.x}px,${view.y}px) scale(${view.zoom})`;
			if (transform !== cameraStyle) world.style.transform = cameraStyle = transform;
			const live = new Set<string>();
			const candidates = new Set(ids ?? scene.items.map((item) => item.id));
			for (const [id, entry] of mounted) if (retained(id, entry)) candidates.add(id);
			for (const id of candidates) {
				const item = scene.get(id);
				if (!item) continue;
				const itemView = viewFor(item);
				let entry = mounted.get(item.id);
				const held = entry ? retained(id, entry) : false;
				if (!itemView || (!held && !onScreen(item.frame, view, surface))) continue;
				live.add(item.id);
				const style = worldStyle(item.frame, scene.indexOf(item.id));
				const minimum = itemView.contentSize;
				const threshold = entry?.detailed ? 0.85 : 1;
				const detailed = held || !minimum || (item.frame.width * view.zoom >= minimum.width * threshold && item.frame.height * view.zoom >= minimum.height * threshold);
				const context = { editor, detailed, selected: selection.has(item.id), toPointerEvent };
				if (entry && entry.view !== itemView) {
					unmount(item.id, entry);
					entry = undefined;
				}
				if (!entry) {
					const node = host.ownerDocument.createElement("div");
					node.dataset.boardItem = item.id;
					node.style.cssText = `position:absolute;pointer-events:none;transform-origin:center;${style}`;
					world.appendChild(node);
					mounted.set(item.id, {
						view: itemView,
						element: node,
						instance: itemView.mount(node, item, context),
						item,
						detailed: context.detailed,
						selected: context.selected,
						style,
					});
					continue;
				}
				if (entry.style !== style) {
					entry.element.style.cssText = `position:absolute;pointer-events:none;transform-origin:center;${style}`;
					entry.style = style;
				}
				if (entry.item !== item || entry.detailed !== context.detailed || entry.selected !== context.selected) {
					entry.item = item;
					entry.detailed = context.detailed;
					entry.selected = context.selected;
					entry.instance.update?.(item, context);
				}
			}
			for (const [id, entry] of mounted) if (!live.has(id)) unmount(id, entry);
		},
		destroy() {
			element.removeEventListener("pointerdown", pointerDown, true);
			element.removeEventListener("focusout", onInvalidate);
			host.ownerDocument.removeEventListener("pointerup", pointerEnd, true);
			host.ownerDocument.removeEventListener("pointercancel", pointerEnd, true);
			for (const [id, entry] of mounted) unmount(id, entry);
			element.remove();
		},
	};
}
