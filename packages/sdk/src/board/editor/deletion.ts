import {
	applyMatrix,
	type BoardAnimation,
	type BoardArrowEnd,
	type BoardArrowItem,
	type BoardItem,
	invertMatrix,
	isArrowBinding,
	pruneBoardTrack,
	resolveSceneArrow,
	type SceneItem,
	type WorldPoint,
} from "../model/index.js";
import type { EditorContext } from "./context.js";

export function createDeletionModule(ctx: EditorContext) {
	const { state } = ctx;

	function changesFor(ids: Iterable<string>): {
		items: Map<string, BoardItem | null>;
		animations?: Record<string, BoardAnimation>;
	} {
		const { scene, base } = state;
		const doomed = new Set<string>();
		for (const id of ids) {
			if (!scene.get(id)) continue;
			doomed.add(id);
			for (const child of scene.descendants(id)) doomed.add(child);
		}
		const changes = new Map<string, BoardItem | null>();
		for (const id of doomed) changes.set(id, null);
		for (const id of doomed) {
			for (const arrowId of scene.binders(id)) {
				if (doomed.has(arrowId) || changes.has(arrowId)) continue;
				const arrow = scene.get(arrowId) as SceneItem<BoardArrowItem> | undefined;
				if (!arrow) continue;
				const resolved = resolveSceneArrow(arrow, scene);
				const toLocal = invertMatrix(scene.layout.matrix(arrowId));
				const free = (end: BoardArrowEnd, point: WorldPoint): BoardArrowEnd => {
					if (!isArrowBinding(end) || !doomed.has(end.item)) return end;
					const local = applyMatrix(toLocal, point);
					return { x: local.x, y: local.y };
				};
				const { id: _id, frame: _frame, ...stored } = arrow;
				changes.set(arrowId, {
					...stored,
					props: {
						...arrow.props,
						start: free(arrow.props.start, resolved.start.point),
						end: free(arrow.props.end, resolved.end.point),
					},
				} as BoardItem);
			}
		}
		let animations: Record<string, BoardAnimation> | undefined;
		for (const [animationId, animation] of Object.entries(base.animations)) {
			const tracks = { ...animation.tracks };
			let changed = false;
			for (const [id, track] of Object.entries(tracks)) {
				const next = pruneBoardTrack(track, doomed);
				if (next === track) continue;
				changed = true;
				if (next) tracks[id] = next;
				else delete tracks[id];
			}
			if (!changed) continue;
			animations ??= { ...base.animations };
			animations[animationId] = { ...animation, tracks };
		}
		return { items: changes, ...(animations ? { animations } : {}) };
	}

	function deleteIds(ids: Iterable<string>) {
		const { items: changes, animations } = changesFor(ids);
		if (changes.size === 0) return;
		for (const [id, item] of changes) ctx.document.setDraftItem(id, item);
		ctx.document.commit(animations ? { animations } : {});
		state.selection = state.selection.filter((id) => !changes.has(id) || changes.get(id) !== null);
		if (state.editingId && changes.get(state.editingId) === null) state.editingId = null;
	}

	function deleteSelection() {
		const ids = ctx.query.unlockedIds(state.selection);
		if (ids.length === 0) return;
		deleteIds(ids);
		state.selection = [];
		state.editingId = null;
	}

	function deleteItem(id: string) {
		const target = state.scene.get(id);
		if (!target || ctx.query.isLocked(target)) return;
		deleteIds([id]);
	}

	return { deleteSelection, deleteItem };
}

export type DeletionModule = ReturnType<typeof createDeletionModule>;
