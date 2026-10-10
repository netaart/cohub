import type { BoardDocument } from "../model/index.js";
import type { EditorContext } from "./context.js";

export function createRemoteModule(ctx: EditorContext) {
	const { state } = ctx;
	let currentKey = ctx.options.key;
	let pending: { document: BoardDocument; key: string | undefined } | null = null;

	function apply(next: BoardDocument, key: string | undefined) {
		const sameDocument = key !== undefined && key === currentKey;
		currentKey = key;
		pending = null;
		if (sameDocument) {
			const { base } = state;
			const added = Object.keys(next.items).filter((id) => !base.items[id]);
			ctx.document.markAdded(added);
			const changed = new Set<string>([
				...added,
				...Object.keys(base.items).filter((id) => next.items[id] !== base.items[id]),
			]);
			const draftTextId = state.draftTextId;
			const keep = draftTextId ? ctx.document.draftItem(draftTextId) : undefined;
			ctx.document.adopt(next, changed);
			if (draftTextId && keep) ctx.document.writeDraft(new Map([[draftTextId, keep]]), true);
			state.selection = state.selection.filter((id) => state.scene.get(id));
			if (state.playhead && !next.animations[state.playhead.animationId]) ctx.animation.setPlayhead(null);
			return;
		}
		state.playhead = null;
		state.recording = false;
		ctx.document.reset(next);
		state.undoStack = [];
		state.redoStack = [];
		state.selection = [];
		state.editingId = null;
		state.draftTextId = null;
		state.saveError = null;
	}

	function loadDocument(next: BoardDocument, key?: string) {
		if (next === state.base) return;
		const sameDocument = key !== undefined && key === currentKey;
		if (sameDocument && (state.interaction.type !== "idle" || state.editingId)) {
			pending = { document: next, key };
			return;
		}
		apply(next, key);
	}

	function flushPending() {
		if (!pending) return;
		const { document, key } = pending;
		apply(document, key);
	}

	return { loadDocument, flushPending };
}

export type RemoteModule = ReturnType<typeof createRemoteModule>;
