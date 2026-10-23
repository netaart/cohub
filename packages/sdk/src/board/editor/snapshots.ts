import {
	type BoardFileSnapshotFacts,
	type BoardItem,
	type BoardMediaSnapshot,
	mergeFileSnapshot,
} from "../model/index.js";
import { adoptBoardNaturalSize } from "@cohub/protocol";
import type { EditorContext } from "./context.js";
import { sameJson } from "./document-edits.js";

export type BoardNaturalSize = { id: string; width: number; height: number };

export function createSnapshotsModule(ctx: EditorContext) {
	const { state } = ctx;
	const commit = (changes: Map<string, BoardItem>) => ctx.document.commitItems(changes, false);

	function applyMediaFileChange(path: string, change: { size?: number; mtimeMs?: number; removed?: boolean }) {
		if (change.removed) return;
		const changes = new Map<string, BoardItem>();
		for (const id of ctx.query.mediaIdsForPath(path)) {
			const item = state.base.items[id];
			if (!item || (item.type !== "image" && item.type !== "video" && item.type !== "audio")) continue;
			const snapshot: BoardMediaSnapshot = { ...item.props.snapshot };
			if (change.size !== undefined) snapshot.size = change.size;
			if (change.mtimeMs !== undefined) snapshot.mtimeMs = change.mtimeMs;
			delete snapshot.naturalWidth;
			delete snapshot.naturalHeight;
			if (item.type === "audio") delete snapshot.durationMs;
			if (!sameJson(snapshot, item.props.snapshot ?? {}))
				changes.set(id, { ...item, props: { ...item.props, snapshot } } as BoardItem);
		}
		commit(changes);
	}

	function adoptMediaNaturalSizes(sizes: BoardNaturalSize[]) {
		const changes = new Map<string, BoardItem>();
		for (const { id, ...natural } of sizes) {
			const item = state.base.items[id];
			const adopted = item && adoptBoardNaturalSize(item, natural);
			if (adopted) changes.set(id, adopted);
		}
		commit(changes);
	}

	function applyFileSnapshots(snapshots: Array<{ id: string; snapshot: BoardFileSnapshotFacts; replace?: boolean }>) {
		const changes = new Map<string, BoardItem>();
		for (const entry of snapshots) {
			const item = state.base.items[entry.id];
			if (item?.type !== "file") continue;
			const merged = mergeFileSnapshot(item.props.snapshot, entry.snapshot, entry.replace === true);
			if (!sameJson(merged, item.props.snapshot ?? {}))
				changes.set(entry.id, { ...item, props: { ...item.props, snapshot: merged } });
		}
		commit(changes);
	}

	return { applyMediaFileChange, adoptMediaNaturalSizes, applyFileSnapshots };
}

export type SnapshotsModule = ReturnType<typeof createSnapshotsModule>;
