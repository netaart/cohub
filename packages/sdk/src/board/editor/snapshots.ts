import {
	type BoardFileSnapshotFacts,
	type BoardItem,
	type BoardMediaSnapshot,
	type BoardModelFacts,
	boardModelCover,
	isBoardModelItem,
	mergeFileSnapshot,
	withBoardModelFacts,
} from "../model/index.js";
import { adoptBoardNaturalSize } from "@cohub/protocol";
import type { EditorContext } from "./context.js";
import { sameJson } from "./document-edits.js";

export type BoardNaturalSize = { id: string; width: number; height: number };

export type BoardModelLearned = { id: string; facts?: BoardModelFacts; coverUrl?: string };

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
			const cached = item.props.snapshot;
			const model = isBoardModelItem(item);
			const { coverUrl, ...read } = mergeFileSnapshot(cached, entry.snapshot, entry.replace === true);
			const sameFile = cached && (cached.mtimeMs === undefined || read.mtimeMs === cached.mtimeMs);
			const cover = model ? (sameFile ? cached.coverUrl : undefined) : coverUrl;
			const merged = {
				...read,
				...(sameFile && cached.clips ? { clips: cached.clips } : {}),
				...(sameFile && cached.nodes ? { nodes: cached.nodes } : {}),
				...(cover ? { coverUrl: cover } : {}),
			};
			if (!sameJson(merged, cached ?? {}))
				changes.set(entry.id, { ...item, props: { ...item.props, snapshot: merged } });
		}
		commit(changes);
	}

	function adoptModelFacts(models: BoardModelLearned[]) {
		const changes = new Map<string, BoardItem>();
		for (const { id, facts, coverUrl } of models) {
			const item = state.base.items[id];
			if (item?.type !== "file") continue;
			let next = item;
			const snapshot = facts && withBoardModelFacts(item.props.snapshot, facts);
			if (snapshot) next = { ...next, props: { ...next.props, snapshot } };
			const covered = coverUrl && next.props.snapshot?.coverUrl !== coverUrl ? { ...next, props: { ...next.props, snapshot: { ...next.props.snapshot, coverUrl } } } : null;
			if (covered && boardModelCover(covered) === coverUrl) next = covered;
			if (next !== item) changes.set(id, next);
		}
		commit(changes);
	}

	return { applyMediaFileChange, adoptMediaNaturalSizes, applyFileSnapshots, adoptModelFacts };
}

export type SnapshotsModule = ReturnType<typeof createSnapshotsModule>;
