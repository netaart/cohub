import {
	applyBoardPatchToDocument,
	arrowBindings,
	type BoardAnimation,
	type BoardDocument,
	type BoardFrame,
	type BoardItem,
	type BoardPatch,
	type BoardSettings,
	buildBoardScene,
	compileBoardAnimations,
	evaluateBoardAnimations,
	IDENTITY_MATRIX,
	placeItem,
	type Rect,
	refreshBoardScene,
} from "../model/index.js";
import type { EditorContext } from "./context.js";
import { diffBoardEdits, isEmptyBoardPatch, routeBoardEdits, sameJson } from "./document-edits.js";

const UNDO_LIMIT = 200;

export function createDocumentModule(ctx: EditorContext) {
	const { state, options } = ctx;
	const draft = new Map<string, BoardItem | null>();
	const draftOrigins = new Map<string, BoardItem>();
	const recentlyAdded = new Set<string>();
	let evaluated: ReadonlyMap<string, BoardItem> = new Map();
	let played: ReadonlyMap<string, BoardItem> = new Map();
	let compiled: {
		animations: BoardDocument["animations"];
		items: BoardDocument["items"];
		value: ReturnType<typeof compileBoardAnimations>;
	} | null = null;

	function markAdded(ids: readonly string[]) {
		if (ids.length === 0) return;
		recentlyAdded.clear();
		for (const id of ids) recentlyAdded.add(id);
	}

	function consumeRecentlyAdded(): string[] {
		const ids = [...recentlyAdded];
		recentlyAdded.clear();
		return ids;
	}

	function displayItem(id: string): BoardItem | undefined {
		if (draft.has(id)) return draft.get(id) ?? undefined;
		return evaluated.get(id) ?? played.get(id) ?? state.base.items[id];
	}

	function displayDocument(): BoardDocument {
		const base = state.base;
		if (draft.size === 0 && evaluated.size === 0 && played.size === 0) return base;
		const items = { ...base.items };
		for (const [id, item] of played) items[id] = item;
		for (const [id, item] of evaluated) items[id] = item;
		for (const [id, item] of draft) {
			if (item) items[id] = item;
			else delete items[id];
		}
		return { ...base, items };
	}

	function reevaluate() {
		const { base, playhead } = state;
		if (!playhead || !base.animations[playhead.animationId]) {
			evaluated = new Map();
			return;
		}
		if (!compiled || compiled.animations !== base.animations || compiled.items !== base.items) {
			compiled = { animations: base.animations, items: base.items, value: compileBoardAnimations(base) };
		}
		evaluated = evaluateBoardAnimations(compiled.value, {
			[playhead.animationId]: playhead.time,
		}).items;
	}

	function setPlayedItems(items: ReadonlyMap<string, BoardItem>) {
		const previous = played;
		played = new Map([...items].filter(([id]) => state.base.items[id]));
		const changed = new Set([...previous.keys(), ...played.keys()]);
		for (const id of changed) {
			if (draft.has(id) || evaluated.has(id) || sameJson(previous.get(id), played.get(id))) changed.delete(id);
		}
		if (changed.size) rescene(changed);
	}

	function rescene(ids?: Iterable<string>) {
		if (ids) {
			const changed = [...ids];
			state.scene = refreshBoardScene(state.scene, displayItem, changed);
			ctx.query.invalidate(changed);
		} else {
			state.scene = buildBoardScene(displayDocument(), state.scene);
			ctx.query.invalidate();
			state.structureVersion += 1;
		}
		state.geometryVersion += 1;
	}

	function reset(next: BoardDocument) {
		state.base = next;
		draft.clear();
		draftOrigins.clear();
		played = new Map();
		reevaluate();
		state.scene = buildBoardScene(next);
		ctx.query.invalidate();
		state.structureVersion += 1;
		state.geometryVersion += 1;
	}

	function setDraftItem(id: string, item: BoardItem | null) {
		if (!draft.has(id)) {
			const shown = displayItem(id);
			if (shown) draftOrigins.set(id, shown);
		}
		draft.set(id, item);
	}

	function draftItem(id: string): BoardItem | null | undefined {
		return draft.get(id);
	}

	function dropDraftItem(id: string) {
		draft.delete(id);
	}

	function writeDraft(changes: ReadonlyMap<string, BoardItem | null>, structural = false) {
		if (changes.size === 0) return;
		for (const [id, item] of changes) setDraftItem(id, item);
		if (!structural) {
			for (const [id, item] of changes) {
				const before = state.scene.get(id);
				if (
					!item ||
					!before ||
					before.parent !== item.parent ||
					before.z !== item.z ||
					!sameJson(arrowBindings(before), arrowBindings(item))
				) {
					structural = true;
					break;
				}
			}
		}
		rescene(structural ? undefined : changes.keys());
	}

	function discardDraft() {
		draft.clear();
		draftOrigins.clear();
		reevaluate();
		rescene();
	}

	function send(patch: BoardPatch) {
		if (options.readonly || isEmptyBoardPatch(patch)) return;
		state.pendingCommits += 1;
		void Promise.resolve(options.onCommit(patch))
			.then(() => {
				state.saveError = null;
			})
			.catch((error: unknown) => {
				state.saveError = error instanceof Error ? error.message : "Failed to sync board";
			})
			.finally(() => {
				state.pendingCommits -= 1;
			});
	}

	function adopt(next: BoardDocument, changedIds?: Iterable<string>) {
		const base = state.base;
		const structural =
			played.size > 0 || !changedIds || next.animations !== base.animations || next.board !== base.board;
		state.base = next;
		played = new Map();
		draft.clear();
		draftOrigins.clear();
		reevaluate();
		if (structural || state.playhead) {
			rescene();
			return;
		}
		const ids = [...changedIds];
		const hierarchy = ids.some((id) => {
			const before = state.scene.get(id);
			const after = next.items[id];
			return (
				!before ||
				!after ||
				before.parent !== after.parent ||
				before.z !== after.z ||
				!sameJson(arrowBindings(before), arrowBindings(after))
			);
		});
		rescene(hierarchy ? undefined : ids);
	}

	function commit(
		extra: { board?: BoardSettings; animations?: Record<string, BoardAnimation> } = {},
		record = true,
	) {
		const ids = [...draft.keys()];
		const base = state.base;
		let target = routeBoardEdits({
			base,
			evaluated,
			draft,
			playhead: state.playhead,
			recording: state.recording,
			displayed: draftOrigins,
		});
		if (extra.board) target = { ...target, board: extra.board };
		if (extra.animations) target = { ...target, animations: extra.animations };
		const redo = diffBoardEdits(base, target, ids);
		if (isEmptyBoardPatch(redo)) {
			adopt(base);
			return;
		}
		if (record) {
			const undo = diffBoardEdits(target, base, ids);
			state.undoStack = [...state.undoStack.slice(-UNDO_LIMIT + 1), { undo, redo }];
			state.redoStack = [];
		}
		adopt(target, ids);
		send(redo);
	}

	function commitItems(changes: ReadonlyMap<string, BoardItem | null>, record = true) {
		if (changes.size === 0) return;
		for (const [id, item] of changes) setDraftItem(id, item);
		commit({}, record);
	}

	function applyPatch(patch: BoardPatch): boolean {
		const result = applyBoardPatchToDocument(state.base, patch);
		if (!result.ok) {
			state.saveError = result.diagnostics[0]?.message ?? "Could not apply the change";
			return false;
		}
		adopt(result.document, Object.keys(patch.items ?? {}));
		send(patch);
		return true;
	}

	function undo() {
		const entry = state.undoStack.at(-1);
		if (!entry) return;
		state.undoStack = state.undoStack.slice(0, -1);
		if (applyPatch(entry.undo)) state.redoStack = [...state.redoStack, entry];
	}

	function redo() {
		const entry = state.redoStack.at(-1);
		if (!entry) return;
		state.redoStack = state.redoStack.slice(0, -1);
		if (applyPatch(entry.redo)) state.undoStack = [...state.undoStack, entry];
	}

	function previewSettings(settings: BoardSettings) {
		state.settingsPreview = settings;
	}

	function setSettings(settings: BoardSettings) {
		state.settingsPreview = null;
		if (!sameJson(settings, state.base.board)) commit({ board: settings });
	}

	function reparent(item: BoardItem, frame: BoardFrame, parent: string | undefined, box: Rect): BoardItem {
		const { parent: _previous, ...root } = item;
		const orphan = root as BoardItem;
		const next = parent ? ({ ...orphan, parent } as BoardItem) : orphan;
		const matrix = parent ? state.scene.layout.matrix(parent) : IDENTITY_MATRIX;
		return placeItem(next, frame, matrix, box);
	}

	function topZ(parent: string | undefined): number {
		let z = 0;
		for (const id of state.scene.children(parent)) z = Math.max(z, displayItem(id)?.z ?? 0);
		return z + 1;
	}

	return {
		markAdded,
		consumeRecentlyAdded,
		displayItem,
		reevaluate,
		setPlayedItems,
		rescene,
		reset,
		setDraftItem,
		draftItem,
		dropDraftItem,
		writeDraft,
		discardDraft,
		adopt,
		commit,
		commitItems,
		undo,
		redo,
		previewSettings,
		setSettings,
		reparent,
		topZ,
	};
}

export type DocumentModule = ReturnType<typeof createDocumentModule>;
