import {
	type BoardFrame,
	type BoardItem,
	type BoardSceneItem,
	sceneItemToItem,
	selectionBounds,
} from "../model/index.js";
import { type AlignMode, alignFrames, type DistributeAxis, distributeFrames } from "./align.js";
import type { EditorContext } from "./context.js";
import { resolveSelectionTransform } from "./selection-transform.js";
import { memo } from "./state.js";

const NUDGE_STEP = 1;
const NUDGE_STEP_LARGE = 10;

export function createSelectionModule(ctx: EditorContext) {
	const { state, registry } = ctx;

	const items = memo(
		() => [state.scene, state.selection] as const,
		(scene, selection): BoardSceneItem[] => {
			const result: BoardSceneItem[] = [];
			for (const id of selection) {
				const item = scene.get(id);
				if (item) result.push(item);
			}
			return result;
		},
	);
	const bounds = memo(
		() => [items()] as const,
		(selected) => selectionBounds(selected.map((item) => item.frame)),
	);
	const transform = memo(
		() => [items(), bounds()] as const,
		(selected, rect) => resolveSelectionTransform(registry, selected, rect),
	);

	function set(ids: string[]) {
		state.selection = ids;
	}

	function toggle(id: string) {
		const { selection } = state;
		state.selection = selection.includes(id) ? selection.filter((selected) => selected !== id) : [...selection, id];
	}

	function framesFor(ids: Iterable<string>): Map<string, BoardFrame> {
		const frames = new Map<string, BoardFrame>();
		for (const id of ids) {
			const frame = state.scene.get(id)?.frame;
			if (frame) frames.set(id, { ...frame });
		}
		return frames;
	}

	function placed(frames: ReadonlyMap<string, BoardFrame>): Map<string, BoardItem> {
		const changes = new Map<string, BoardItem>();
		for (const [id, frame] of frames) {
			const item = state.scene.get(id);
			if (item) changes.set(id, sceneItemToItem({ ...item, frame }, state.scene.layout));
		}
		return changes;
	}

	function movable(): string[] {
		return ctx.query.rootsOf(ctx.query.unlockedIds(state.selection));
	}

	function nudge(dx: number, dy: number, large: boolean) {
		const ids = movable();
		if (ids.length === 0) return;
		const step = large ? NUDGE_STEP_LARGE : NUDGE_STEP;
		const frames = new Map<string, BoardFrame>();
		for (const [id, frame] of framesFor(ids)) frames.set(id, { ...frame, x: frame.x + dx * step, y: frame.y + dy * step });
		ctx.document.commitItems(placed(frames));
	}

	function align(mode: AlignMode) {
		const ids = movable();
		if (ids.length < 2) return;
		ctx.document.commitItems(placed(alignFrames(framesFor(ids), mode)));
	}

	function distribute(axis: DistributeAxis) {
		const ids = movable();
		if (ids.length < 3) return;
		ctx.document.commitItems(placed(distributeFrames(framesFor(ids), axis)));
	}

	function edit(update: (item: BoardItem) => BoardItem | null, ids = ctx.query.unlockedIds(state.selection)) {
		const changes = new Map<string, BoardItem>();
		for (const id of ids) {
			const item = ctx.document.displayItem(id);
			const next = item ? update(item) : null;
			if (next && next !== item) changes.set(id, next);
		}
		ctx.document.commitItems(changes);
	}

	function toggleLock() {
		if (state.selection.length === 0) return;
		const lock = items().some((item) => !item.locked);
		edit((item) => {
			if (lock) return { ...item, locked: true };
			const { locked: _locked, ...unlocked } = item;
			return unlocked as BoardItem;
		}, state.selection);
	}

	function setColor(color: string) {
		edit((item) => {
			switch (item.type) {
				case "text":
				case "effect":
					return { ...item, style: { ...item.style, fill: color } };
				case "shape":
				case "frame":
					return { ...item, style: { ...item.style, stroke: color, ...(item.style.fill ? { fill: color } : {}) } };
				case "draw":
				case "arrow":
					return { ...item, style: { ...item.style, stroke: color } };
				default:
					return null;
			}
		});
	}

	function setStyle(style: Partial<BoardItem["style"]>) {
		edit((item) => ({ ...item, style: { ...item.style, ...style } }) as BoardItem);
	}

	function setProps(type: string, props: Record<string, unknown>) {
		edit((item) => {
			if (item.type !== type) return null;
			const next = { ...(item.props as object), ...props };
			const valid = registry.validateProps(type, next);
			if (!valid.ok) throw new Error(valid.message);
			return { ...item, props: next } as BoardItem;
		});
	}

	function restack(front: boolean) {
		const { scene } = state;
		const ids = ctx.query.rootsOf(state.selection);
		if (ids.length === 0) return;
		const changes = new Map<string, BoardItem>();
		const byParent = new Map<string | undefined, string[]>();
		for (const id of ids) {
			const parent = scene.get(id)?.parent;
			byParent.set(parent, [...(byParent.get(parent) ?? []), id]);
		}
		for (const [parent, members] of byParent) {
			const siblings = scene.children(parent).map((id) => ctx.document.displayItem(id)?.z ?? 0);
			let z = front ? Math.max(0, ...siblings) + 1 : Math.min(0, ...siblings) - members.length;
			const ordered = members.sort((a, b) => scene.indexOf(a) - scene.indexOf(b));
			for (const id of ordered) {
				const item = ctx.document.displayItem(id);
				if (item) changes.set(id, { ...item, z: z++ });
			}
		}
		ctx.document.commitItems(changes);
	}

	return {
		items,
		bounds,
		transform,
		set,
		toggle,
		clear: () => set([]),
		selectAll: () => set(state.scene.children(undefined).slice()),
		framesFor,
		placed,
		movable,
		nudge,
		align,
		distribute,
		toggleLock,
		setColor,
		setStyle,
		setProps,
		bringToFront: () => restack(true),
		sendToBack: () => restack(false),
	};
}

export type SelectionModule = ReturnType<typeof createSelectionModule>;
