import type { BoardEditor, BoardPointerEvent } from "../editor/index.js";
import type { BoardFrame, BoardScene, BoardSceneItem, BoardViewport } from "../model/index.js";
import { toBoardPointerEvent } from "./pointer.js";

export type BoardItemViewContext = {
	editor: BoardEditor;
	zoom: number;
	selected: boolean;
	toPointerEvent(event: PointerEvent): BoardPointerEvent;
};

export type BoardItemViewInstance = {
	update?(item: BoardSceneItem, context: BoardItemViewContext): void;
	destroy?(): void;
};

export type BoardItemView = {
	type: string | ((item: BoardSceneItem) => boolean);
	mount(element: HTMLElement, item: BoardSceneItem, context: BoardItemViewContext): BoardItemViewInstance;
};

type Mounted = {
	view: BoardItemView;
	element: HTMLElement;
	instance: BoardItemViewInstance;
	item: BoardSceneItem;
	zoom: number;
	selected: boolean;
	style: string;
};

const VISIBLE_MARGIN = 240;

function screenStyle(frame: BoardFrame, camera: BoardViewport, order: number): string {
	const { zoom } = camera;
	return [
		`z-index:${order}`,
		`left:${frame.x * zoom + camera.x}px`,
		`top:${frame.y * zoom + camera.y}px`,
		`width:${frame.width * zoom}px`,
		`height:${frame.height * zoom}px`,
		`--board-zoom:${zoom}`,
		`transform:rotate(${frame.rotation}deg)`,
	].join(";");
}

function onScreen(frame: BoardFrame, camera: BoardViewport, surface: { width: number; height: number }) {
	const left = frame.x * camera.zoom + camera.x;
	const top = frame.y * camera.zoom + camera.y;
	return (
		left + frame.width * camera.zoom >= -VISIBLE_MARGIN &&
		top + frame.height * camera.zoom >= -VISIBLE_MARGIN &&
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
): BoardItemViewLayer {
	const element = host.ownerDocument.createElement("div");
	element.dataset.boardViews = "";
	element.style.cssText = "position:absolute;inset:0;z-index:2;overflow:hidden;pointer-events:none";
	host.appendChild(element);
	const mounted = new Map<string, Mounted>();
	const toPointerEvent = (event: PointerEvent) =>
		toBoardPointerEvent(event, host.getBoundingClientRect(), camera());
	const viewFor = (item: BoardSceneItem) =>
		views.find((view) => (typeof view.type === "string" ? view.type === item.type : view.type(item)));

	function unmount(id: string, entry: Mounted) {
		entry.instance.destroy?.();
		entry.element.remove();
		mounted.delete(id);
	}

	return {
		element,
		sync({ ids, scene, camera: view, surface, selection }) {
			if (views.length === 0) return;
			const live = new Set<string>();
			for (const id of ids ?? scene.items.map((item) => item.id)) {
				const item = scene.get(id);
				if (!item) continue;
				const itemView = viewFor(item);
				if (!itemView || !onScreen(item.frame, view, surface)) continue;
				live.add(item.id);
				const context = { editor, zoom: view.zoom, selected: selection.has(item.id), toPointerEvent };
				const style = screenStyle(item.frame, view, scene.indexOf(item.id));
				let entry = mounted.get(item.id);
				if (entry && entry.view !== itemView) {
					unmount(item.id, entry);
					entry = undefined;
				}
				if (!entry) {
					const node = host.ownerDocument.createElement("div");
					node.dataset.boardItem = item.id;
					node.style.cssText = `position:absolute;pointer-events:none;transform-origin:center;${style}`;
					element.appendChild(node);
					mounted.set(item.id, {
						view: itemView,
						element: node,
						instance: itemView.mount(node, item, context),
						item,
						zoom: context.zoom,
						selected: context.selected,
						style,
					});
					continue;
				}
				if (entry.style !== style) {
					entry.element.style.cssText = `position:absolute;pointer-events:none;transform-origin:center;${style}`;
					entry.style = style;
				}
				if (entry.item !== item || entry.zoom !== context.zoom || entry.selected !== context.selected) {
					entry.item = item;
					entry.zoom = context.zoom;
					entry.selected = context.selected;
					entry.instance.update?.(item, context);
				}
			}
			for (const [id, entry] of mounted) if (!live.has(id)) unmount(id, entry);
		},
		destroy() {
			for (const [id, entry] of mounted) unmount(id, entry);
			element.remove();
		},
	};
}
