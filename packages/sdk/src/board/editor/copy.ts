import {
	applyMatrix,
	arrowBindings,
	type BoardArrowItem,
	type BoardItem,
	createBoardItemId,
	invertMatrix,
	resolveSceneArrow,
	type SceneItem,
	type WorldPoint,
} from "../model/index.js";
import {
	type BoardClipboardPayload,
	DUPLICATE_OFFSET,
	defaultPasteOffset,
	encodeClipboard,
	materializeClipboard,
	parseClipboard,
	remapItems,
} from "./clipboard.js";
import type { EditorContext } from "./context.js";

export function createCopyModule(ctx: EditorContext) {
	const { state, options } = ctx;
	let internalClipboard: BoardClipboardPayload | null = null;
	let pasteCount = 0;

	function detachedSubtrees(ids: Iterable<string>): Record<string, BoardItem> {
		const { scene } = state;
		const items: Record<string, BoardItem> = {};
		for (const root of ctx.query.rootsOf(ids)) {
			const item = scene.get(root);
			if (!item) continue;
			const { id: _id, frame, ...stored } = item;
			items[root] = ctx.document.reparent(stored as BoardItem, frame, undefined, scene.layout.box(root));
			for (const child of scene.descendants(root)) {
				const value = ctx.document.displayItem(child);
				if (value) items[child] = value;
			}
		}
		return items;
	}

	function arrowEndPoint(id: string, which: "start" | "end") {
		const arrow = state.scene.get(id) as SceneItem<BoardArrowItem> | undefined;
		if (arrow?.type !== "arrow") return null;
		const resolved = resolveSceneArrow(arrow, state.scene);
		return applyMatrix(
			invertMatrix(state.scene.layout.matrix(id)),
			(which === "start" ? resolved.start : resolved.end).point,
		);
	}

	function duplicates(ids: string[], offset: number): Map<string, BoardItem> {
		const { scene } = state;
		const copied = detachedSubtrees(ids);
		for (const id of Object.keys(copied)) {
			for (const arrowId of scene.binders(id)) {
				const arrow = ctx.document.displayItem(arrowId);
				const shown = scene.get(arrowId);
				if (copied[arrowId] || !arrow || !shown || !arrowBindings(arrow).every((bound) => copied[bound])) continue;
				copied[arrowId] = ctx.document.reparent(arrow, shown.frame, undefined, scene.layout.box(arrowId));
			}
		}
		const idMap = new Map(Object.keys(copied).map((id) => [id, createBoardItemId()]));
		const moved = remapItems(
			copied,
			idMap,
			(item) =>
				item.parent && copied[item.parent]
					? item
					: { ...item, position: { x: item.position.x + offset, y: item.position.y + offset } },
			arrowEndPoint,
		);
		let z = ctx.document.topZ(undefined);
		return new Map(Object.entries(moved).map(([id, item]) => [id, item.parent ? item : { ...item, z: z++ }]));
	}

	function rootsOfCopies(copies: ReadonlyMap<string, BoardItem>): string[] {
		return [...copies].filter(([, item]) => !item.parent || !copies.has(item.parent)).map(([id]) => id);
	}

	function duplicateSelection() {
		if (options.readonly || state.selection.length === 0) return;
		const copies = duplicates(state.selection, DUPLICATE_OFFSET);
		if (copies.size === 0) return;
		const roots = rootsOfCopies(copies);
		ctx.document.markAdded(roots);
		state.selection = roots;
		ctx.document.commitItems(copies);
	}

	function copySelection(): BoardClipboardPayload | null {
		const { selection } = state;
		if (selection.length === 0) return null;
		const copied = detachedSubtrees(selection);
		const origin = ctx.query.contentBounds(ctx.query.rootsOf(selection));
		const payload = origin ? encodeClipboard(copied, { x: origin.x, y: origin.y }) : null;
		if (payload) {
			internalClipboard = payload;
			pasteCount = 0;
		}
		return payload;
	}

	function cutSelection(): BoardClipboardPayload | null {
		const payload = copySelection();
		if (payload) ctx.deletion.deleteSelection();
		return payload;
	}

	function pasteClipboard(raw?: unknown, at?: WorldPoint) {
		if (options.readonly) return;
		const parsed = parseClipboard(raw) ?? (raw == null ? parseClipboard(internalClipboard) : null);
		if (!parsed) return;
		pasteCount += 1;
		const offset = at ?? {
			x: parsed.origin.x + defaultPasteOffset(pasteCount).x,
			y: parsed.origin.y + defaultPasteOffset(pasteCount).y,
		};
		const pasted = materializeClipboard(parsed, offset);
		const entries = Object.entries(pasted).map(([id, item]) => ({ id, item }));
		const roots = entries.filter(({ item }) => !item.parent).map(({ id }) => id);
		const changes = ctx.creation.placeNew(entries);
		ctx.document.markAdded(roots);
		state.selection = roots;
		ctx.document.commitItems(changes);
	}

	return { duplicates, rootsOfCopies, duplicateSelection, copySelection, cutSelection, pasteClipboard };
}

export type CopyModule = ReturnType<typeof createCopyModule>;
