import type {
	BoardPatch,
	BoardPlaybackCommand,
	BoardPlaybackSnapshot,
	RequestSource,
} from "@cohub/protocol";
import type {
	SpaceFsFileResponse,
	SpaceFsPreparingFile,
} from "@neta-art/cohub";
import { HttpError } from "@neta-art/cohub";
import { type BoardDocument, parseBoardManifest } from "@neta-art/cohub/board";
import {
	type BoardReplica,
	type BoardReplicaState,
	createBoardReplica,
} from "@neta-art/cohub/board/replica";
import {
	BOARD_AUTOMATION_ACTIVE_MS,
	type BoardAutomationActivity,
	boardAutomationExpiresAt,
	boardAutomationKind,
	createBoardAutomationActivity,
	mergeBoardAutomationActivity,
} from "$lib/board/board-activity";
import { resolveBoardManifestText } from "$lib/board/board-manifest-text";
import { boardPathMatchesTarget } from "$lib/board/board-sync-policy";
import {
	deleteBoardPendingPatch,
	listBoardPendingPatches,
	readBoardDocumentCache,
	writeBoardDocumentCache,
	writeBoardPendingPatch,
} from "$lib/cache/repositories/board-repo";
import { sdk } from "$lib/sdk";
import { tryResolveTextFileResponse } from "$lib/space-file-text";

type BoardFileResponse = SpaceFsFileResponse | SpaceFsPreparingFile;

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
		{ replica: BoardReplica; unsubscribe: () => void }
	>();
	const manifestRefreshByPath = new Map<string, Promise<void>>();
	const manifestRefreshRequested = new Set<string>();
	let automationActivities = $state<BoardAutomationActivity[]>([]);
	const activityTimers = new Map<
		string,
		{
			settle: ReturnType<typeof setTimeout>;
			expire: ReturnType<typeof setTimeout>;
		}
	>();
	const activityModelRequests = new Map<
		string,
		Promise<{ provider: string | null; id: string } | null>
	>();
	let disposed = false;

	function updateBoards(
		boardId: string,
		update: (board: InlineBoardPanelState) => InlineBoardPanelState,
	) {
		boards = boards.map((board) =>
			board.boardId === boardId ? update(board) : board,
		);
	}

	function clearActivityTimers(id: string) {
		const timers = activityTimers.get(id);
		if (!timers) return;
		clearTimeout(timers.settle);
		clearTimeout(timers.expire);
		activityTimers.delete(id);
	}

	function scheduleActivityLifecycle(activity: BoardAutomationActivity) {
		clearActivityTimers(activity.id);
		const settle = setTimeout(() => {
			automationActivities = automationActivities.map((item) =>
				item.id === activity.id && item.updatedAt === activity.updatedAt
					? { ...item, status: "settled" }
					: item,
			);
		}, BOARD_AUTOMATION_ACTIVE_MS);
		const expire = setTimeout(
			() => {
				clearActivityTimers(activity.id);
				automationActivities = automationActivities.filter(
					(item) => item.id !== activity.id,
				);
			},
			Math.max(0, boardAutomationExpiresAt(activity) - Date.now()),
		);
		activityTimers.set(activity.id, { settle, expire });
	}

	function resolveActivityModel(activity: BoardAutomationActivity) {
		const { sessionId, turnId } = activity.source;
		if (disposed || activity.kind !== "agent" || !sessionId || !turnId) return;
		const spaceId = activity.source.spaceId ?? options.getSpaceId();
		const key = `${spaceId}:${sessionId}:${turnId}`;
		let request = activityModelRequests.get(key);
		if (!request) {
			if (activityModelRequests.size >= 64) {
				const oldest = activityModelRequests.keys().next().value;
				if (oldest) activityModelRequests.delete(oldest);
			}
			request = sdk
				.space(spaceId)
				.session(sessionId)
				.turns.get(turnId)
				.then(({ turn }) =>
					turn.model ? { provider: turn.provider, id: turn.model } : null,
				)
				.catch(() => null);
			activityModelRequests.set(key, request);
		}
		void request.then((model) => {
			if (disposed || !model) return;
			automationActivities = automationActivities.map((item) =>
				item.id === activity.id && item.source.turnId === turnId
					? { ...item, model }
					: item,
			);
		});
	}

	function noteAutomation(
		boardId: string,
		event: {
			actorId: string;
			mutationId: string;
			itemIds: string[];
			source: RequestSource;
		},
	) {
		const document = boards.find((item) => item.boardId === boardId)?.document;
		if (!document) return;
		const activity = createBoardAutomationActivity(document, {
			boardId,
			actorId: event.actorId,
			txId: event.mutationId,
			itemIds: event.itemIds,
			source: event.source,
		});
		if (!activity) return;
		const previous = automationActivities;
		automationActivities = mergeBoardAutomationActivity(previous, activity);
		const retained = new Set(automationActivities.map((item) => item.id));
		for (const item of previous)
			if (!retained.has(item.id)) clearActivityTimers(item.id);
		const current = automationActivities.find(
			(item) => item.id === activity.id,
		);
		if (!current) return;
		scheduleActivityLifecycle(current);
		resolveActivityModel(current);
	}

	function clearActivitiesForBoard(boardId: string) {
		for (const activity of automationActivities)
			if (activity.boardId === boardId) clearActivityTimers(activity.id);
		automationActivities = automationActivities.filter(
			(item) => item.boardId !== boardId,
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
		const spaceId = options.getSpaceId();
		const client = sdk.space(spaceId).board(boardId);
		const replica = createBoardReplica({
			remote: client,
			storage: {
				listPending: async () =>
					(await listBoardPendingPatches(spaceId, boardId)).map((record) => ({
						mutationId: record.mutationId,
						patch: record.patch,
					})),
				putPending: async (entry) => {
					await writeBoardPendingPatch({ spaceId, boardId, ...entry });
				},
				deletePending: (mutationId) =>
					deleteBoardPendingPatch({ spaceId, boardId, mutationId }),
				readDocument: () => readBoardDocumentCache(spaceId, boardId),
				writeDocument: (version, document) =>
					writeBoardDocumentCache({ spaceId, boardId, version, document }),
			},
		});
		const stopState = replica.subscribe((state) =>
			adoptReplicaState(boardId, state),
		);
		const stopActivity = client.subscribe({
			changed: ({ payload }) => {
				if (
					payload.source &&
					payload.changed.items.length &&
					boardAutomationKind(payload.source)
				) {
					noteAutomation(boardId, {
						actorId: payload.actorId,
						mutationId: payload.mutationId,
						itemIds: payload.changed.items,
						source: payload.source,
					});
				}
			},
		});
		replicas.set(boardId, {
			replica,
			unsubscribe: () => {
				stopState();
				stopActivity();
			},
		});
		void replica.start();
		return replica;
	}

	function releaseReplica(boardId: string) {
		const entry = replicas.get(boardId);
		if (!entry) return;
		entry.unsubscribe();
		entry.replica.dispose();
		replicas.delete(boardId);
		clearActivitiesForBoard(boardId);
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
		const rawFile = await options.readFile(path);
		if (!rawFile || typeof rawFile !== "object" || !("content" in rawFile))
			throw new Error("Board manifest is being prepared. Retry in a moment.");
		const { file, error } = await tryResolveTextFileResponse(rawFile);
		if (error) throw new Error(error);
		const content = resolveBoardManifestText(file);
		if (content == null) throw new Error("Board manifest must be a text file.");
		const manifest = parseBoardManifest(content);
		if (!manifest) throw new Error("Board manifest is invalid.");
		return manifest.boardId;
	}

	async function openBoard(
		path: string,
		input: { activate?: boolean; showLoading?: boolean } = {},
	) {
		const activate = input.activate ?? true;
		const existing = boards.find((item) => item.path === path);
		if (!existing && input.showLoading === false) return;
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
		try {
			const boardId = await readManifest(path);
			if (!isCurrent(token, path, sourceKey)) return;
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
		} catch (cause) {
			if (!isCurrent(token, path, sourceKey)) return;
			if (
				existing?.document &&
				cause instanceof HttpError &&
				cause.status === 404
			) {
				closeBoard(path);
				return;
			}
			const message =
				cause instanceof Error ? cause.message : "Failed to open board";
			boards = boards.map((item) =>
				item.path === path
					? item.document
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
		await Promise.all(
			[...replicas.values()].map(({ replica }) => replica.retry()),
		);
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

	async function playBoard(boardId: string, command: BoardPlaybackCommand) {
		const board = sdk.space(options.getSpaceId()).board(boardId);
		const playback = await (async () => {
			switch (command.type) {
				case "play":
					return board.play(command.animationId, {
						...(command.position === undefined
							? {}
							: { position: command.position }),
						...(command.timeScale === undefined
							? {}
							: { timeScale: command.timeScale }),
						...(command.seed ? { seed: command.seed } : {}),
					});
				case "pause":
					return board.pause();
				case "resume":
					return board.resume();
				case "seek":
					return board.seek(command.position);
				case "next":
					return board.next();
				case "stop":
					return board.stop();
			}
		})();
		replicas.get(boardId)?.replica.receivePlayback(playback);
		return playback;
	}

	function dispose() {
		disposed = true;
		for (const boardId of [...replicas.keys()]) releaseReplica(boardId);
		for (const activity of automationActivities)
			clearActivityTimers(activity.id);
		activityModelRequests.clear();
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
		get automationActivities() {
			return automationActivities;
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
