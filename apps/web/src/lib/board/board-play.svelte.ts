import {
	applyBoardPatchToDocument,
	type BoardDocument,
	type BoardPatch,
	diffBoardDocuments,
	isEmptyBoardPatch,
} from "@neta-art/cohub/board";
import { loadPublishedBoard } from "$lib/board/published-board";
import type { BoardPlayStore } from "$lib/cache/repositories/board-play-saves-repo";

const SAVE_INTERVAL_MS = 1_000;
const MAX_SAVE_BYTES = 2 * 1024 * 1024;

export async function loadBoardPlay(
	url: string,
	options: { playable: boolean; store: Promise<BoardPlayStore | null> | null },
) {
	const store = (options.store ?? Promise.resolve(null)).catch(() => null);
	const saved = store
		.then((opened) => opened?.read() ?? null)
		.catch(() => null);
	const [board, opened, overlay] = await Promise.all([
		loadPublishedBoard(url),
		store,
		saved,
	]);
	const play = options.playable
		? openBoardPlay(board.document, opened, overlay)
		: null;
	return { board, play };
}

export function openBoardPlay(
	base: BoardDocument,
	store: BoardPlayStore | null,
	saved: BoardPatch | null,
) {
	const applied = saved ? applyBoardPatchToDocument(base, saved) : null;
	if (saved && !applied?.ok) void store?.write(null).catch(() => undefined);
	const restored = applied?.ok ? applied.document : null;
	let document = $state.raw(restored ?? base);
	let changed = $state(restored !== null);
	let latest = document;
	let written = latest;
	let timer: ReturnType<typeof setTimeout> | null = null;

	function save() {
		if (timer) clearTimeout(timer);
		timer = null;
		if (latest === written) return;
		written = latest;
		const overlay = diffBoardDocuments(base, latest);
		const empty = isEmptyBoardPatch(overlay);
		changed = !empty;
		if (!store) return;
		const kept =
			empty || JSON.stringify(overlay).length > MAX_SAVE_BYTES ? null : overlay;
		void store.write(kept).catch((error) => {
			console.warn("[board] failed to save play", error);
		});
	}

	function show(next: BoardDocument) {
		document = next;
		latest = next;
		save();
	}

	return {
		get document() {
			return document;
		},
		get changed() {
			return changed;
		},
		commit(next: BoardDocument) {
			latest = next;
			changed = true;
			timer ??= setTimeout(save, SAVE_INTERVAL_MS);
		},
		reset(): BoardDocument {
			const previous = latest;
			// A new reference, so the Board reloads even if it opened from `base`.
			show({ ...base });
			return previous;
		},
		restore(previous: BoardDocument) {
			show(previous);
		},
		flush: save,
		saveOnHide() {
			const page = globalThis.document;
			const hidden = () => {
				if (page.visibilityState === "hidden") save();
			};
			window.addEventListener("pagehide", save);
			page.addEventListener("visibilitychange", hidden);
			return () => {
				window.removeEventListener("pagehide", save);
				page.removeEventListener("visibilitychange", hidden);
			};
		},
	};
}

export type BoardPlay = ReturnType<typeof openBoardPlay>;
