import {
	type BoardFileSnapshotFacts,
	type BoardItem,
	type BoardMediaSnapshot,
	type BoardTaskSnapshot,
	featuredTaskArtifact,
	mergeFileSnapshot,
} from "../model/index.js";
import type { EditorContext } from "./context.js";
import { sameJson } from "./document-edits.js";

export type BoardNaturalSize = { id: string; width: number; height: number };

function fitHeight<T extends Extract<BoardItem, { size: unknown }>>(item: T, natural: BoardNaturalSize): T | null {
	const height = (item.size.width * natural.height) / natural.width;
	if (!Number.isFinite(height) || height <= 0) return null;
	return {
		...item,
		position: { x: item.position.x, y: item.position.y + (item.size.height - height) / 2 },
		size: { ...item.size, height },
	};
}

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
		for (const natural of sizes) {
			const item = state.base.items[natural.id];
			if (!item || natural.width <= 0 || natural.height <= 0) continue;
			const dimensions = { naturalWidth: natural.width, naturalHeight: natural.height };
			if (item.type === "task") {
				const artifact = featuredTaskArtifact(item.props.snapshot.artifacts);
				if ((artifact?.type !== "image" && artifact?.type !== "video") || (artifact.naturalWidth && artifact.naturalHeight))
					continue;
				const fitted = fitHeight(item, natural);
				if (!fitted) continue;
				const artifacts = item.props.snapshot.artifacts.map((entry) =>
					entry.id === artifact.id ? { ...entry, ...dimensions } : entry,
				);
				changes.set(natural.id, { ...fitted, props: { ...item.props, snapshot: { ...item.props.snapshot, artifacts } } });
				continue;
			}
			if (item.type !== "image" && item.type !== "video") continue;
			if (item.props.snapshot?.naturalWidth && item.props.snapshot.naturalHeight) continue;
			const fitted = fitHeight(item, natural);
			if (!fitted) continue;
			changes.set(natural.id, {
				...fitted,
				props: { ...item.props, snapshot: { ...item.props.snapshot, ...dimensions } },
			} as BoardItem);
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

	function applyTaskSnapshots(snapshots: ReadonlyMap<string, BoardTaskSnapshot>) {
		if (snapshots.size === 0) return;
		const changes = new Map<string, BoardItem>();
		for (const [id, item] of Object.entries(state.base.items)) {
			if (item.type !== "task") continue;
			const snapshot = snapshots.get(item.props.taskRunId);
			if (snapshot && !sameJson(snapshot, item.props.snapshot))
				changes.set(id, { ...item, props: { ...item.props, snapshot } });
		}
		commit(changes);
	}

	return { applyMediaFileChange, adoptMediaNaturalSizes, applyFileSnapshots, applyTaskSnapshots };
}

export type SnapshotsModule = ReturnType<typeof createSnapshotsModule>;
