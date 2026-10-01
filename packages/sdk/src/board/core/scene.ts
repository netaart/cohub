
import {
	applyMatrix,
	IDENTITY_MATRIX,
	type BoardDocument,
	type BoardFrame,
	type BoardItem,
	type BoardItemLookup,
	type BoardLayout,
	type BoardMatrix,
	type BoardRect,
	arrowBindings,
	clampBoardFontSize,
	createBoardLayout,
	drawPointsBounds,
	invertMatrix,
	layoutBoardText,
	scaleVector,
} from "@cohub/protocol";
import { BOARD_DRAW_STROKE_SIZE } from "@cohub/protocol/board-constants";

export type SceneItem<T extends BoardItem = BoardItem> = T & {
	readonly id: string;
	readonly frame: BoardFrame;
};
export type BoardSceneItem = SceneItem;

export type BoardScene = {
	readonly items: readonly BoardSceneItem[];
	get(id: string): BoardSceneItem | undefined;
	indexOf(id: string): number;
	readonly layout: BoardLayout;
	children(id: string | undefined): readonly string[];
	descendants(id: string): string[];
	binders(id: string): readonly string[];
	opacity(id: string): number;
};

const EPSILON = 1e-6;

function stripScene(item: BoardSceneItem | BoardItem): BoardItem {
	if (!("frame" in item) && !("id" in item)) return item;
	const { id: _id, frame: _frame, ...rest } = item as BoardSceneItem;
	return rest as BoardItem;
}

export function orderBoardItems(items: Readonly<Record<string, BoardItem>>): string[] {
	const children = new Map<string, string[]>();
	for (const [id, item] of Object.entries(items)) {
		const parent = item.parent && items[item.parent] && item.parent !== id ? item.parent : "";
		const list = children.get(parent) ?? [];
		list.push(id);
		children.set(parent, list);
	}
	const compare = (a: string, b: string) => (items[a]?.z ?? 0) - (items[b]?.z ?? 0) || (a < b ? -1 : a > b ? 1 : 0);
	for (const list of children.values()) list.sort(compare);
	const order: string[] = [];
	const seen = new Set<string>();
	const visit = (id: string) => {
		if (seen.has(id)) return;
		seen.add(id);
		order.push(id);
		for (const child of children.get(id) ?? []) visit(child);
	};
	for (const id of children.get("") ?? []) visit(id);
	for (const id of Object.keys(items)) visit(id);
	return order;
}

export function buildBoardScene(document: BoardDocument, previous?: BoardScene | null): BoardScene {
	const items = document.items;
	const children = new Map<string, string[]>();
	const binders = new Map<string, string[]>();
	for (const [id, item] of Object.entries(items)) {
		const parent = item.parent && items[item.parent] ? item.parent : "";
		const list = children.get(parent) ?? [];
		list.push(id);
		children.set(parent, list);
		for (const bound of arrowBindings(item)) binders.set(bound, [...(binders.get(bound) ?? []), id]);
	}
	const layout = createBoardLayout(
		(id) => items[id],
		(id) => [...(children.get(id) ?? []), ...(binders.get(id) ?? [])],
	);
	const stable = new Map<string, boolean>();
	const isStable = (id: string, depth = 0): boolean => {
		const known = stable.get(id);
		if (known !== undefined) return known;
		const item = items[id];
		const before = previous?.get(id);
		let result = Boolean(item && before && stripSceneSource(before) === item) && depth < 64;
		if (result && item?.parent && items[item.parent]) result = isStable(item.parent, depth + 1);
		if (result && item) for (const bound of arrowBindings(item)) if (items[bound] && !isStable(bound, depth + 1)) result = false;
		stable.set(id, result);
		return result;
	};
	const ordered = orderBoardItems(items);
	const sceneItems: BoardSceneItem[] = [];
	const byId = new Map<string, BoardSceneItem>();
	const indexById = new Map<string, number>();
	for (const id of ordered) {
		const item = items[id] as BoardItem;
		const reused = isStable(id) ? previous?.get(id) : undefined;
		const scene = reused ?? toSceneItem(id, item, layout);
		indexById.set(id, sceneItems.length);
		sceneItems.push(scene);
		byId.set(id, scene);
	}
	return {
		items: sceneItems,
		get: (id) => byId.get(id),
		indexOf: (id) => indexById.get(id) ?? -1,
		layout,
		children: (id) => children.get(id ?? "") ?? [],
		descendants: (id) => {
			const result: string[] = [];
			const seen = new Set([id]);
			const stack = [...(children.get(id) ?? [])];
			while (stack.length) {
				const next = stack.pop() as string;
				if (seen.has(next)) continue;
				seen.add(next);
				result.push(next);
				stack.push(...(children.get(next) ?? []));
			}
			return result;
		},
		binders: (id) => binders.get(id) ?? [],
		opacity: (id) => cumulativeOpacity((key) => items[key], id),
	};
}

function cumulativeOpacity(lookup: BoardItemLookup, id: string): number {
	let value = 1;
	let cursor: string | undefined = id;
	for (let depth = 0; cursor && depth < 64; depth += 1) {
		const item: BoardItem | undefined = lookup(cursor);
		if (!item) break;
		value *= item.opacity;
		cursor = item.parent;
	}
	return value;
}

export function refreshBoardScene(previous: BoardScene, lookup: BoardItemLookup, ids: Iterable<string>): BoardScene {
	const dependents = (id: string) => [...previous.children(id), ...previous.binders(id)];
	const layout = createBoardLayout(lookup, dependents);
	const affected = new Set<string>();
	const stack = [...ids];
	while (stack.length) {
		const id = stack.pop() as string;
		if (affected.has(id) || !lookup(id)) continue;
		affected.add(id);
		stack.push(...dependents(id));
	}
	if (affected.size === 0) return previous;
	const sceneItems = previous.items.slice();
	const chain = refreshed.get(previous);
	const base = chain?.base ?? previous;
	const overrides = new Map<string, BoardSceneItem>(chain?.overrides);
	for (const id of affected) {
		const index = previous.indexOf(id);
		const scene = toSceneItem(id, lookup(id) as BoardItem, layout);
		overrides.set(id, scene);
		if (index >= 0) sceneItems[index] = scene;
	}
	const scene: BoardScene = {
		...base,
		items: sceneItems,
		get: (id) => overrides.get(id) ?? base.get(id),
		layout,
		opacity: (id) => cumulativeOpacity(lookup, id),
	};
	refreshed.set(scene, { base, overrides });
	return scene;
}

const refreshed = new WeakMap<BoardScene, { base: BoardScene; overrides: Map<string, BoardSceneItem> }>();

const sources = new WeakMap<BoardSceneItem, BoardItem>();

function stripSceneSource(scene: BoardSceneItem): BoardItem | undefined {
	return sources.get(scene);
}

export function toSceneItem(id: string, item: BoardItem, layout: BoardLayout): BoardSceneItem {
	const scene = { ...item, id, frame: layout.frame(id) } as BoardSceneItem;
	sources.set(scene, item);
	return scene;
}

function sameFrame(a: BoardFrame, b: BoardFrame): boolean {
	return (
		Math.abs(a.x - b.x) < EPSILON &&
		Math.abs(a.y - b.y) < EPSILON &&
		Math.abs(a.width - b.width) < EPSILON &&
		Math.abs(a.height - b.height) < EPSILON &&
		Math.abs(a.rotation - b.rotation) < EPSILON
	);
}

export function sceneItemToItem(
	scene: BoardSceneItem | (BoardItem & { id: string; frame?: BoardFrame }),
	layout: BoardLayout,
): BoardItem {
	const source = sources.get(scene as BoardSceneItem);
	if (source) return source;
	const item = stripScene(scene as BoardSceneItem);
	const frame = (scene as { frame?: BoardFrame }).frame;
	if (!frame) return item;
	if (layout.has(scene.id) && sameFrame(frame, layout.frame(scene.id))) return item;
	const parent = item.parent && layout.has(item.parent) ? layout.matrix(item.parent) : IDENTITY_MATRIX;
	return placeItem(item, frame, parent, itemBox(item, layout, scene.id));
}

function itemBox(item: BoardItem, layout: BoardLayout, id: string): BoardRect {
	if ("size" in item && item.size) return { x: 0, y: 0, width: item.size.width, height: item.size.height };
	if (item.type === "text") {
		const text = layoutBoardText(item.props);
		return { x: 0, y: 0, width: text.width, height: text.height };
	}
	if (item.type === "draw") return drawPointsBounds(item.props.points, item.style.strokeWidth ?? BOARD_DRAW_STROKE_SIZE);
	return layout.box(id);
}

export function placeItem(item: BoardItem, frame: BoardFrame, parent: BoardMatrix, box: BoardRect): BoardItem {
	const [a, b] = parent;
	const parentScale = Math.hypot(a, b) || 1;
	const parentRotation = (Math.atan2(b, a) * 180) / Math.PI;
	const center = applyMatrix(invertMatrix(parent), { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 });
	const scale = scaleVector(item.scale);
	const width = frame.width / parentScale / (Math.abs(scale.x) || 1);
	const height = frame.height / parentScale / (Math.abs(scale.y) || 1);

	if (item.type === "arrow") {
		const currentCenter = { x: item.position.x + box.x + box.width / 2, y: item.position.y + box.y + box.height / 2 };
		const dx = center.x - currentCenter.x;
		const dy = center.y - currentCenter.y;
		if (Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON) return item;
		return { ...item, position: { x: item.position.x + dx, y: item.position.y + dy } };
	}

	let next: BoardItem = item;
	let nextBox = box;
	const resized = Math.abs(width - box.width) > EPSILON || Math.abs(height - box.height) > EPSILON;
	if (resized) {
		if (item.type === "text") {
			const factor = Math.abs(width - box.width) > EPSILON ? width / box.width : height / box.height;
			const props = {
				...item.props,
				fontSize: clampBoardFontSize(item.props.fontSize * factor),
				...(item.props.width ? { width: item.props.width * factor } : {}),
			};
			next = { ...item, props };
			const text = layoutBoardText(props);
			nextBox = { x: 0, y: 0, width: text.width, height: text.height };
		} else if (item.type === "draw") {
			const sx = width / box.width;
			const sy = height / box.height;
			const points = item.props.points.map((point) => ({ ...point, x: box.x + (point.x - box.x) * sx, y: box.y + (point.y - box.y) * sy }));
			next = { ...item, props: { ...item.props, points } };
			nextBox = drawPointsBounds(points, item.style.strokeWidth ?? BOARD_DRAW_STROKE_SIZE);
		} else if ("size" in item && item.size) {
			next = { ...item, size: { width, height } } as BoardItem;
			nextBox = { x: 0, y: 0, width, height };
		}
	}

	const rotation = frame.rotation - parentRotation;
	const radians = (rotation * Math.PI) / 180;
	const origin = { x: nextBox.x + item.origin.x * nextBox.width, y: nextBox.y + item.origin.y * nextBox.height };
	const boxCenter = { x: nextBox.x + nextBox.width / 2, y: nextBox.y + nextBox.height / 2 };
	const dx = (boxCenter.x - origin.x) * scale.x;
	const dy = (boxCenter.y - origin.y) * scale.y;
	const rotated = { x: dx * Math.cos(radians) - dy * Math.sin(radians), y: dx * Math.sin(radians) + dy * Math.cos(radians) };
	const position = { x: center.x - origin.x - rotated.x, y: center.y - origin.y - rotated.y };
	return { ...next, position, rotation: normalizeDegrees(rotation) } as BoardItem;
}

function normalizeDegrees(value: number): number {
	const normalized = ((value % 360) + 540) % 360 - 180;
	return Math.abs(normalized) < EPSILON ? 0 : Number(normalized.toFixed(6));
}

export function sceneItemsToRecord(items: readonly (BoardSceneItem | (BoardItem & { id: string }))[], layout: BoardLayout): Record<string, BoardItem> {
	const record: Record<string, BoardItem> = {};
	for (const scene of items) record[scene.id] = sceneItemToItem(scene, layout);
	return record;
}
