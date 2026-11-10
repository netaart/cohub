import type {
	BoardPatch,
	BoardPlaybackCommand,
	BoardPlaybackSnapshot,
} from "@cohub/protocol";
import type {
	SpaceFsFileResponse,
	SpaceFsPreparingFile,
	SpaceFsSymlink,
} from "@neta-art/cohub";
import { HttpError } from "@neta-art/cohub";
import type { BoardDocument } from "@neta-art/cohub/board";
import type {
	BoardReplica,
	BoardReplicaState,
} from "@neta-art/cohub/board/replica";
import { readBoardManifestId } from "$lib/board/board-manifest-text";
import { boardPathMatchesTarget } from "$lib/board/board-sync-policy";
import { loadCheckpointBoard } from "$lib/board/checkpoint-board";
import { loadedCacheUserKey } from "$lib/cache/keys";
import {
	readBoardManifestCache,
	writeBoardManifestCache,
} from "$lib/cache/repositories/board-repo";
import { sdk } from "$lib/sdk";

type BoardFileResponse =
	| SpaceFsFileResponse
	| SpaceFsPreparingFile
	| SpaceFsSymlink;

export type InlineBoardPanelState = {
	path: string;
	boardId: string | null;
	document: BoardDocument | null;
	playback: BoardPlaybackSnapshot | null;
	loading: boolean;
	saving: boolean;
	error: string | null;
	saveError: string | null;
};

type BoardPreviewControllerOptions = {
	getSpaceId: () => string;
	getSourceKey: () => string;
	getReadonly?: () => boolean;
	getCheckpointId?: () => string | null;
	checkpointBoardMissing?: () => string;
	readFile: (path: string) => Promise<BoardFileResponse>;
	onOpenPanel?: () => void;
	onClosePanel?: () => void;
	onBoardClosed?: (path: string) => void;
	onBeforeOpenBoard?: () => void;
	onMarkSavePending?: (path: string) => void;
	onClearSavePendingSoon?: (path: string) => void;
};

export function createBoardWindowController(
	options: BoardPreviewControllerOptions,
) {
	let boards = $state.raw<InlineBoardPanelState[]>([]);
	let activeBoardPath = $state<string | null>(null);
	const requestTokens = new Map<string, number>();
	let nextRequestToken = 0;
	const replicas = new Map<
		string,
		{ replica: BoardReplica; release: () => void }
	>();
	const manifestRefreshByPath = new Map<string, Promise<void>>();
	const manifestRefreshRequested = new Set<string>();
	function updateBoards(
		boardId: string,
		update: (board: InlineBoardPanelState) => InlineBoardPanelState,
	) {
		boards = boards.map((board) =>
			board.boardId === boardId ? update(board) : board,
		);
	}

	function adoptReplicaState(boardId: string, state: BoardReplicaState) {
		updateBoards(boardId, (board) => ({
			...board,
			document: state.document ?? board.document,
			playback: state.playback,
			loading: !state.document,
			saving: state.pending > 0,
			saveError: state.error,
		}));
	}

	function ensureReplica(boardId: string): BoardReplica {
		const existing = replicas.get(boardId);
		if (existing) return existing.replica;
		const { replica, release } = sdk
			.space(options.getSpaceId())
			.board(boardId)
			.replica({ userKey: loadedCacheUserKey() });
		const stopState = replica.subscribe((state) =>
			adoptReplicaState(boardId, state),
		);
		replicas.set(boardId, {
			replica,
			release: () => {
				stopState();
				release();
			},
		});
		return replica;
	}

	function releaseReplica(boardId: string) {
		const entry = replicas.get(boardId);
		if (!entry) return;
		entry.release();
		replicas.delete(boardId);
	}

	function hasBoard(path: string) {
		return boards.some((item) => item.path === path);
	}

	function isCurrent(token: number, path: string, sourceKey: string) {
		return (
			token === requestTokens.get(path) &&
			hasBoard(path) &&
			sourceKey === options.getSourceKey()
		);
	}

	async function readManifest(path: string): Promise<string> {
		return readBoardManifestId(await options.readFile(path));
	}

	function attachBoard(path: string, boardId: string) {
		const previous = boards.find((item) => item.path === path)?.boardId;
		if (previous === boardId && replicas.has(boardId)) return;
		if (
			previous &&
			previous !== boardId &&
			!boards.some((item) => item.boardId === previous && item.path !== path)
		)
			releaseReplica(previous);
		const sibling = boards.find(
			(item) => item.boardId === boardId && item.path !== path,
		);
		boards = boards.map((item) =>
			item.path === path
				? {
						...item,
						boardId,
						document: sibling?.document ?? null,
						playback: sibling?.playback ?? null,
						loading: !sibling?.document,
						error: null,
					}
				: item,
		);
		const replica = ensureReplica(boardId);
		adoptReplicaState(boardId, replica.state);
	}

	function detachBoard(path: string, message: string) {
		const board = boards.find((item) => item.path === path);
		if (
			board?.boardId &&
			!boards.some(
				(item) => item.boardId === board.boardId && item.path !== path,
			)
		)
			releaseReplica(board.boardId);
		boards = boards.map((item) =>
			item.path === path
				? {
						...item,
						boardId: null,
						document: null,
						playback: null,
						loading: false,
						error: message,
					}
				: item,
		);
	}

	function setBoard(path: string, update: Partial<InlineBoardPanelState>) {
		boards = boards.map((item) =>
			item.path === path ? { ...item, ...update } : item,
		);
	}

	async function openSavedBoard(
		path: string,
		token: number,
		source: { spaceId: string; sourceKey: string; checkpointId: string },
	) {
		try {
			const boardId = await readManifest(path);
			if (!isCurrent(token, path, source.sourceKey)) return;
			const document = await loadCheckpointBoard({ ...source, boardId });
			if (!isCurrent(token, path, source.sourceKey)) return;
			setBoard(path, { boardId, document, loading: false, error: null });
		} catch (cause) {
			if (!isCurrent(token, path, source.sourceKey)) return;
			const missing = cause instanceof HttpError && cause.status === 404;
			const message =
				missing && options.checkpointBoardMissing
					? options.checkpointBoardMissing()
					: cause instanceof Error
						? cause.message
						: "Failed to open board";
			setBoard(path, {
				boardId: null,
				document: null,
				loading: false,
				error: message,
			});
		}
	}

	async function openBoard(
		path: string,
		input: { activate?: boolean; showLoading?: boolean } = {},
	) {
		const activate = input.activate ?? true;
		const existing = boards.find((item) => item.path === path);
		if (!existing && input.showLoading === false) return;
		const spaceId = options.getSpaceId();
		const sourceKey = options.getSourceKey();
		if (activate) options.onBeforeOpenBoard?.();
		const token = ++nextRequestToken;
		requestTokens.set(path, token);
		if (activate) activeBoardPath = path;
		if (!existing)
			boards = [
				...boards,
				{
					path,
					boardId: null,
					document: null,
					playback: null,
					loading: true,
					saving: false,
					error: null,
					saveError: null,
				},
			];
		if (activate) options.onOpenPanel?.();
		const checkpointId = options.getCheckpointId?.() ?? null;
		if (checkpointId) {
			if (!existing?.document)
				await openSavedBoard(path, token, { spaceId, sourceKey, checkpointId });
			return;
		}
		const manifest = { spaceId, sourceKey, path };
		// Local first: open the cached Board while the server confirms the manifest.
		const opened = !existing?.boardId;
		if (opened) {
			const cachedId = await readBoardManifestCache(manifest).catch(() => null);
			if (cachedId && isCurrent(token, path, sourceKey))
				attachBoard(path, cachedId);
		}
		try {
			const boardId = await readManifest(path);
			if (!isCurrent(token, path, sourceKey)) return;
			void writeBoardManifestCache({ ...manifest, boardId }).catch(
				() => undefined,
			);
			attachBoard(path, boardId);
		} catch (cause) {
			if (!isCurrent(token, path, sourceKey)) return;
			const missing = cause instanceof HttpError && cause.status === 404;
			if (missing)
				void writeBoardManifestCache({ ...manifest, boardId: null }).catch(
					() => undefined,
				);
			if (missing && existing?.document) {
				closeBoard(path);
				return;
			}
			const message =
				cause instanceof Error ? cause.message : "Failed to open board";
			if (missing && opened) {
				detachBoard(path, message);
				return;
			}
			boards = boards.map((item) =>
				item.path === path
					? item.document || item.boardId
						? { ...item, saveError: message }
						: { ...item, loading: false, error: message }
					: item,
			);
		}
	}

	function refreshBoardManifest(path: string) {
		if (!hasBoard(path)) return Promise.resolve();
		const active = manifestRefreshByPath.get(path);
		if (active) {
			manifestRefreshRequested.add(path);
			return active;
		}
		const refresh = (async () => {
			try {
				do {
					manifestRefreshRequested.delete(path);
					await openBoard(path, { activate: false, showLoading: false });
				} while (manifestRefreshRequested.delete(path));
			} finally {
				manifestRefreshByPath.delete(path);
			}
		})();
		manifestRefreshByPath.set(path, refresh);
		return refresh;
	}

	async function reconcileOpenBoards() {
		await Promise.all(boards.map((item) => refreshBoardManifest(item.path)));
	}

	function closeBoard(path = activeBoardPath) {
		if (!path) return;
		requestTokens.delete(path);
		const index = boards.findIndex((item) => item.path === path);
		const closing = boards[index];
		const next = boards.filter((item) => item.path !== path);
		if (
			closing?.boardId &&
			!next.some((item) => item.boardId === closing.boardId)
		)
			releaseReplica(closing.boardId);
		boards = next;
		if (activeBoardPath === path)
			activeBoardPath =
				next[Math.max(0, index - 1)]?.path ?? next[0]?.path ?? null;
		if (next.length === 0) options.onClosePanel?.();
		options.onBoardClosed?.(path);
	}

	function closeBoardsAtPath(path: string, recursive = false) {
		for (const board of boards.filter((item) =>
			boardPathMatchesTarget(item.path, path, recursive),
		))
			closeBoard(board.path);
	}

	function activateBoard(path: string) {
		if (!hasBoard(path)) return;
		activeBoardPath = path;
		options.onOpenPanel?.();
	}

	function renamePath(fromPath: string, toPath: string) {
		const rename = (value: string) =>
			value === fromPath
				? toPath
				: value.startsWith(`${fromPath}/`)
					? `${toPath}${value.slice(fromPath.length)}`
					: value;
		boards = boards.map((board) => ({ ...board, path: rename(board.path) }));
		if (activeBoardPath) activeBoardPath = rename(activeBoardPath);
	}

	function commitBoard(boardId: string, patch: BoardPatch) {
		if (options.getReadonly?.()) return Promise.resolve();
		const replica = replicas.get(boardId)?.replica;
		if (!replica) return Promise.reject(new Error("Board is not open."));
		const path = boards.find((item) => item.boardId === boardId)?.path;
		if (path) options.onMarkSavePending?.(path);
		return replica.apply(patch).finally(() => {
			if (path) options.onClearSavePendingSoon?.(path);
		});
	}

	function retryBoardSave(boardId: string) {
		return replicas.get(boardId)?.replica.retry() ?? Promise.resolve();
	}

	function playBoard(boardId: string, command: BoardPlaybackCommand) {
		return sdk.space(options.getSpaceId()).board(boardId).control(command);
	}

	function dispose() {
		for (const boardId of [...replicas.keys()]) releaseReplica(boardId);
		boards = [];
	}

	return {
		get board() {
			return boards.find((item) => item.path === activeBoardPath) ?? null;
		},
		get boards() {
			return boards;
		},
		get activeBoardPath() {
			return activeBoardPath;
		},
		hasBoard,
		openBoard,
		closeBoard,
		activateBoard,
		commitBoard,
		playBoard,
		retryBoardSave,
		refreshBoardManifest,
		reconcileOpenBoards,
		renamePath,
		closeBoardsAtPath,
		dispose,
	};
}
