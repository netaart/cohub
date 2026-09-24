import {
	type BoardAuthoringSnapshot,
	type BoardSemanticMutation,
	isPureBoardAnimationChange,
	type RequestSource,
} from "@cohub/protocol";
import type {
	BoardPlaybackSnapshot,
	SpaceFsFileResponse,
	SpaceFsPreparingFile,
} from "@neta-art/cohub";
import { HttpError } from "@neta-art/cohub";
import {
	applyBoardAuthoringSnapshot,
	type BoardDocument,
	type BoardFrame,
	boardAuthoringSnapshotToDocument,
} from "@neta-art/cohub/board";
import {
	BOARD_AUTOMATION_ACTIVE_MS,
	type BoardAutomationActivity,
	boardAutomationExpiresAt,
	boardAutomationFocus,
	boardAutomationKind,
	createBoardAutomationActivity,
	mergeBoardAutomationActivity,
} from "$lib/board/board-activity";
import { parseBoardManifest } from "$lib/board/board-document";
import { resolveBoardManifestText } from "$lib/board/board-manifest-text";
import {
	boardPathMatchesTarget,
	canAdoptBoardVersion,
	hasBoardIdentity,
	mergeChangedRecords,
} from "$lib/board/board-sync-policy";
import {
	type BoardRuntimeData,
	boardRuntimeDataFromAuthoring,
} from "$lib/board/runtime/board-runtime";
import {
	deleteBoardPendingTransaction,
	listBoardPendingTransactions,
	markBoardPendingTransactionAttempt,
	writeBoardPendingTransaction,
} from "$lib/cache/repositories/board-pending-tx-repo";
import { sdk } from "$lib/sdk";
import { tryResolveTextFileResponse } from "$lib/space-file-text";

type BoardFileResponse = SpaceFsFileResponse | SpaceFsPreparingFile;

/** Cap on automatic conflict-rebase retries before surfacing an error. */
const MAX_CONFLICT_RECOVERY = 5;

export type InlineBoardPanelState = {
	path: string;
	boardId: string | null;
	document: BoardDocument | null;
	runtime: BoardRuntimeData | null;
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
	/** A tab actually went away (missing board, deleted path). */
	onBoardClosed?: (path: string) => void;
	onBeforeOpenBoard?: () => void;
	onMarkSavePending?: (path: string) => void;
	onClearSavePendingSoon?: (path: string) => void;
};

export function createBoardWindowController(
	options: BoardPreviewControllerOptions,
) {
	// Raw: records are replaced wholesale; keeps document identity for echo checks.
	let boards = $state.raw<InlineBoardPanelState[]>([]);
	let activeBoardPath = $state<string | null>(null);
	let requestTokenByPath = $state<Record<string, number>>({});
	let syncVersionByBoardId = $state<Record<string, number | null>>({});
	const pendingFlushByBoardId = new Map<string, Promise<void>>();
	const pendingFlushRequested = new Set<string>();
	const manifestRefreshByPath = new Map<string, Promise<void>>();
	const manifestRefreshRequested = new Set<string>();
	const boardRealtimeUnsubscribers = new Map<string, () => void>();
	/** Conflict-recovery attempts per document, to bound rebase retries. */
	let conflictAttemptsByBoardId: Record<string, number> = {};
	/** Remote semantic changes deferred while a save is in flight. */
	type AutomationEvent = {
		boardId: string;
		actorId: string;
		txId: string;
		itemIds: string[];
		source: RequestSource;
		fallbackFocus: BoardFrame | null;
	};
	type PendingRemoteEvent = {
		boardId: string;
		version: number;
		mutationId: string;
		changed: import("@cohub/protocol").BoardMutationReceipt["changed"];
		automation?: AutomationEvent;
	};
	let pendingRemoteEvents: PendingRemoteEvent[] = [];
	/** Documents that need a full authoring snapshot (version gap / missing projection). */
	let pendingRemoteBootstrap = new Set<string>();
	/** Documents currently inside drainRemoteRefresh — serialise per document. */
	const drainingDocuments = new Set<string>();
	/**
	 * txIds this client has successfully committed. Used to recognise our own
	 * transactions echoed back over realtime (which the editor already reflects),
	 * so they are skipped — while the *same user's other tabs/devices* (which send
	 * different txIds) are still reconciled. Keying on txId, not actorId, is what
	 * makes multi-tab editing work.
	 */
	const ownTxIds = new Set<string>();
	/**
	 * Documents with a conflict recovery in flight. While set, stale pending txs
	 * are NOT deleted up front — they are removed only once the editor's rebase
	 * re-commit durably writes a fresh transaction (see commitBoard). This closes
	 * the loss window where a crash or board-close between "delete stale" and
	 * "re-commit" would otherwise discard uncommitted local changes.
	 */
	const pendingRecoveryCleanup = new Set<string>();
	/**
	 * Recent CLI / Agent transactions, derived from committed transaction metadata.
	 *
	 * These are transient attribution only: they never touch the document, and each
	 * one self-expires so a finished automation run does not leave a marker behind.
	 */
	let automationActivities = $state<BoardAutomationActivity[]>([]);
	type ActivityTimers = {
		settle: ReturnType<typeof setTimeout>;
		expire: ReturnType<typeof setTimeout>;
	};
	const activityTimers = new Map<string, ActivityTimers>();
	const activityModelRequests = new Map<
		string,
		Promise<{ provider: string | null; id: string } | null>
	>();
	let disposed = false;

	function clearActivityTimers(id: string) {
		const timers = activityTimers.get(id);
		if (!timers) return;
		clearTimeout(timers.settle);
		clearTimeout(timers.expire);
		activityTimers.delete(id);
	}

	function expireActivity(id: string) {
		clearActivityTimers(id);
		automationActivities = automationActivities.filter(
			(item) => item.id !== id,
		);
	}

	function scheduleActivityLifecycle(activity: BoardAutomationActivity) {
		clearActivityTimers(activity.id);
		const expiresAt = boardAutomationExpiresAt(activity);
		const settle = setTimeout(() => {
			automationActivities = automationActivities.map((item) =>
				item.id === activity.id && item.updatedAt === activity.updatedAt
					? { ...item, status: "settled" }
					: item,
			);
		}, BOARD_AUTOMATION_ACTIVE_MS);
		const expire = setTimeout(
			() => expireActivity(activity.id),
			Math.max(0, expiresAt - Date.now()),
		);
		activityTimers.set(activity.id, { settle, expire });
	}

	function resolveActivityModel(activity: BoardAutomationActivity) {
		if (disposed || activity.kind !== "agent") return;
		const sessionId = activity.source.sessionId;
		const turnId = activity.source.turnId;
		if (!sessionId || !turnId) return;
		const targetSpaceId = activity.source.spaceId ?? options.getSpaceId();
		const key = `${targetSpaceId}:${sessionId}:${turnId}`;
		let request = activityModelRequests.get(key);
		if (!request) {
			if (activityModelRequests.size >= 64) {
				const oldestKey = activityModelRequests.keys().next().value;
				if (oldestKey) activityModelRequests.delete(oldestKey);
			}
			request = sdk
				.space(targetSpaceId)
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

	/** Record transient attribution without making it part of the Board document. */
	function noteRemoteTransaction(
		input: Omit<AutomationEvent, "fallbackFocus">,
		document?: BoardDocument | null,
		fallbackFocus: BoardFrame | null = null,
	) {
		const targetDocument =
			document ??
			boards.find((item) => item.boardId === input.boardId)?.document;
		if (!targetDocument) return;
		const activity = createBoardAutomationActivity(
			targetDocument,
			input,
			fallbackFocus,
		);
		if (!activity) return;
		const previousActivities = automationActivities;
		automationActivities = mergeBoardAutomationActivity(
			previousActivities,
			activity,
		);
		const retainedIds = new Set(automationActivities.map((item) => item.id));
		for (const previous of previousActivities) {
			if (!retainedIds.has(previous.id)) clearActivityTimers(previous.id);
		}
		const current = automationActivities.find(
			(item) => item.id === activity.id,
		);
		if (!current) return;
		scheduleActivityLifecycle(current);
		resolveActivityModel(current);
	}

	function clearActivitiesForBoard(boardId: string) {
		for (const activity of automationActivities) {
			if (activity.boardId === boardId) clearActivityTimers(activity.id);
		}
		automationActivities = automationActivities.filter(
			(item) => item.boardId !== boardId,
		);
	}

	/** A transaction was rejected as a version conflict (409) and can be rebased. */
	function isVersionConflict(error: unknown): boolean {
		return error instanceof HttpError && error.code === "VERSION_CONFLICT";
	}

	function inspect(boardId: string) {
		return sdk
			.space(options.getSpaceId())
			.board(boardId)
			.authoring({
				include: [
					"items",
					"connections",
					"effects",
					"compositions",
					"playback",
				],
			});
	}

	function subscribeBoardRealtime(boardId: string) {
		if (boardRealtimeUnsubscribers.has(boardId)) return;
		const boardClient = sdk.space(options.getSpaceId()).board(boardId);
		const unsubscribe = boardClient.subscribe({
			changed: (event) => {
				if (isOwnTransaction(event.payload.mutationId)) return;
				const source = event.payload.source;
				const currentDocument = boards.find(
					(item) => item.boardId === boardId,
				)?.document;
				const automation =
					event.payload.changed.items.length > 0 &&
					event.payload.actorId &&
					source &&
					boardAutomationKind(source)
						? {
								boardId,
								actorId: event.payload.actorId,
								txId: event.payload.mutationId,
								itemIds: event.payload.changed.items,
								source,
								fallbackFocus: currentDocument
									? boardAutomationFocus(
											currentDocument,
											event.payload.changed.items,
										)
									: null,
							}
						: undefined;
				if (automation) {
					noteRemoteTransaction(
						automation,
						currentDocument,
						automation.fallbackFocus,
					);
				}
				const pureAnimation = isPureBoardAnimationChange(event.payload.changed);
				if (event.payload.animationPatch && pureAnimation) {
					if (
						applyRemoteAnimationPatch({
							boardId,
							version: event.payload.version,
							changed: event.payload.changed,
							animationPatch: event.payload.animationPatch,
						})
					)
						return;
					requestRemoteRefresh(boardId);
					return;
				}
				requestRemoteChange(boardId, {
					version: event.payload.version,
					mutationId: event.payload.mutationId,
					changed: event.payload.changed,
					...(automation ? { automation } : {}),
				});
			},
			playback: (event) => applyPlayback(event.payload),
		});
		boardRealtimeUnsubscribers.set(boardId, unsubscribe);
	}

	function isCurrent(token: number, path: string, sourceKey: string) {
		const board = boards.find((item) => item.path === path);
		return (
			token === requestTokenByPath[path] &&
			Boolean(board) &&
			sourceKey === options.getSourceKey()
		);
	}

	async function openBoard(
		path: string,
		input: { activate?: boolean; showLoading?: boolean } = {},
	) {
		const activate = input.activate ?? true;
		const requestedLoading = input.showLoading ?? true;
		const sourceKey = options.getSourceKey();
		if (activate) options.onBeforeOpenBoard?.();
		const token = (requestTokenByPath[path] ?? 0) + 1;
		requestTokenByPath = { ...requestTokenByPath, [path]: token };
		if (activate) activeBoardPath = path;
		const existingBoard = boards.find((item) => item.path === path);
		// Reopening a loaded tab is a background identity check. Keep its editor
		// mounted until the authoritative manifest + bootstrap are both ready.
		const showLoading = requestedLoading && !existingBoard?.document;
		if (!showLoading && !existingBoard) return;
		if (showLoading) {
			const loadingBoard: InlineBoardPanelState = {
				path,
				boardId: null,
				document: null,
				runtime: null,
				loading: true,
				saving: false,
				error: null,
				saveError: null,
			};
			boards = existingBoard
				? boards.map((item) => (item.path === path ? loadingBoard : item))
				: [...boards, loadingBoard];
		}
		// The panel opens only once this tab is the committed active surface, so it
		// can never paint before there is something to render.
		if (activate) options.onOpenPanel?.();
		try {
			const rawFile = await options.readFile(path);
			if (!isCurrent(token, path, sourceKey)) return;
			if (!rawFile || typeof rawFile !== "object" || !("content" in rawFile)) {
				throw new Error("Board manifest is being prepared. Retry in a moment.");
			}
			const { file, error: hydrateError } =
				await tryResolveTextFileResponse(rawFile);
			if (!isCurrent(token, path, sourceKey)) return;
			if (hydrateError) throw new Error(hydrateError);
			// .board is JSON text; tolerate misclassified binary responses
			// (e.g. unknown MIME before the extension was registered).
			const content = resolveBoardManifestText(file);
			if (content == null) {
				throw new Error("Board manifest must be a text file.");
			}
			const manifest = parseBoardManifest(content);
			if (!manifest) throw new Error("Board manifest is invalid.");
			// Expose the manifest identity while the first inspect is in flight, so
			// realtime transactions can queue by boardId instead of being dropped.
			if (
				existingBoard?.boardId &&
				existingBoard.boardId !== manifest.boardId &&
				!boards.some(
					(item) =>
						item.boardId === existingBoard.boardId && item.path !== path,
				)
			) {
				boardRealtimeUnsubscribers.get(existingBoard.boardId)?.();
				boardRealtimeUnsubscribers.delete(existingBoard.boardId);
			}
			if (showLoading) {
				boards = boards.map((item) =>
					item.path === path ? { ...item, boardId: manifest.boardId } : item,
				);
			}
			subscribeBoardRealtime(manifest.boardId);
			const bootstrap = await inspect(manifest.boardId);
			if (!isCurrent(token, path, sourceKey)) return;
			const current = boards.find((item) => item.path === path);
			const currentVersion = syncVersionByBoardId[bootstrap.board.id] ?? null;
			if (
				current?.boardId === bootstrap.board.id &&
				isBusy(bootstrap.board.id)
			) {
				pendingRemoteBootstrap.add(bootstrap.board.id);
				return;
			}
			// A realtime bootstrap may win the race with this inspect. Never replace
			// a newer server snapshot with the older response.
			if (
				current?.boardId === bootstrap.board.id &&
				!canAdoptBoardVersion(currentVersion, bootstrap.board.version)
			) {
				boards = boards.map((item) =>
					item.path === path ? { ...item, loading: false } : item,
				);
				return;
			}
			if (
				existingBoard?.boardId &&
				existingBoard.boardId !== bootstrap.board.id
			) {
				clearActivitiesForBoard(existingBoard.boardId);
			}
			advanceSyncVersion(bootstrap.board.id, bootstrap.board.version);
			boards = boards.map((item) =>
				item.path === path
					? {
							path,
							boardId: bootstrap.board.id,
							document: boardAuthoringSnapshotToDocument(bootstrap),
							runtime: boardRuntimeDataFromAuthoring(bootstrap),
							loading: false,
							saving: false,
							error: null,
							saveError: null,
						}
					: item,
			);
			if (!options.getReadonly?.()) {
				void flushPendingTransactions(bootstrap.board.id).catch((error) => {
					setBoardError(
						bootstrap.board.id,
						error instanceof Error
							? error.message
							: "Board changes are saved locally and will retry.",
					);
				});
			}
		} catch (error) {
			if (!isCurrent(token, path, sourceKey)) return;
			if (!showLoading && error instanceof HttpError && error.status === 404) {
				closeBoard(path);
				return;
			}
			if (!showLoading) {
				boards = boards.map((item) =>
					item.path === path
						? {
								...item,
								saveError:
									error instanceof Error
										? error.message
										: "Failed to refresh board",
							}
						: item,
				);
				return;
			}
			boards = boards.map((item) =>
				item.path === path
					? {
							path,
							boardId: null,
							document: null,
							runtime: null,
							loading: false,
							saving: false,
							error:
								error instanceof Error ? error.message : "Failed to open board",
							saveError: null,
						}
					: item,
			);
		}
	}

	function hasBoardId(boardId: string) {
		return hasBoardIdentity(boards, boardId);
	}

	function refreshBoardManifest(path: string) {
		const activeRefresh = manifestRefreshByPath.get(path);
		if (activeRefresh) {
			manifestRefreshRequested.add(path);
			return activeRefresh;
		}
		const refresh = (async () => {
			try {
				do {
					manifestRefreshRequested.delete(path);
					await openBoard(path, {
						activate: false,
						showLoading: false,
					});
				} while (manifestRefreshRequested.delete(path));
			} finally {
				manifestRefreshByPath.delete(path);
			}
		})();
		manifestRefreshByPath.set(path, refresh);
		return refresh;
	}

	async function reconcileOpenBoards() {
		const paths = boards.map((item) => item.path);
		await Promise.all(paths.map((path) => refreshBoardManifest(path)));
	}

	function closeBoard(path = activeBoardPath) {
		if (!path) return;
		requestTokenByPath = {
			...requestTokenByPath,
			[path]: (requestTokenByPath[path] ?? 0) + 1,
		};
		const index = boards.findIndex((item) => item.path === path);
		const closing = boards.find((item) => item.path === path);
		const nextBoards = boards.filter((item) => item.path !== path);
		if (
			closing?.boardId &&
			!nextBoards.some((item) => item.boardId === closing.boardId)
		) {
			boardRealtimeUnsubscribers.get(closing.boardId)?.();
			boardRealtimeUnsubscribers.delete(closing.boardId);
			clearActivitiesForBoard(closing.boardId);
			pendingRemoteBootstrap.delete(closing.boardId);
			pendingRemoteEvents = pendingRemoteEvents.filter(
				(event) => event.boardId !== closing.boardId,
			);
		}
		boards = nextBoards;
		if (activeBoardPath === path)
			activeBoardPath =
				nextBoards[Math.max(0, index - 1)]?.path ?? nextBoards[0]?.path ?? null;
		if (nextBoards.length === 0) options.onClosePanel?.();
		options.onBoardClosed?.(path);
	}

	function dispose() {
		disposed = true;
		for (const unsubscribe of boardRealtimeUnsubscribers.values())
			unsubscribe();
		for (const activity of automationActivities) {
			clearActivityTimers(activity.id);
		}
		boardRealtimeUnsubscribers.clear();
		activityModelRequests.clear();
		ownTxIds.clear();
		conflictAttemptsByBoardId = {};
		pendingRecoveryCleanup.clear();
		boards = [];
		pendingRemoteEvents = [];
		pendingRemoteBootstrap.clear();
	}

	function closeBoardsAtPath(path: string, recursive = false) {
		const matches = boards
			.filter((item) => boardPathMatchesTarget(item.path, path, recursive))
			.map((item) => item.path);
		for (const boardPath of matches) closeBoard(boardPath);
	}

	function activateBoard(path: string) {
		if (!boards.some((item) => item.path === path)) return;
		activeBoardPath = path;
		options.onOpenPanel?.();
	}

	function flushPendingTransactions(boardId: string): Promise<void> {
		const activeFlush = pendingFlushByBoardId.get(boardId);
		if (activeFlush) {
			pendingFlushRequested.add(boardId);
			return activeFlush;
		}
		const flush = (async () => {
			try {
				do {
					pendingFlushRequested.delete(boardId);
					while (true) {
						const pending = await listBoardPendingTransactions(
							options.getSpaceId(),
							boardId,
						);
						if (pending.length === 0) break;
						const tx = pending[0];
						if (!tx) break;
						await markBoardPendingTransactionAttempt(tx);
						try {
							const mutation = tx.mutation;
							const result = await sdk
								.space(options.getSpaceId())
								.board(boardId)
								.mutateSemantic(mutation);
							advanceSyncVersion(boardId, result.board.version);
							// A successful commit resets the conflict-recovery budget.
							delete conflictAttemptsByBoardId[boardId];
							// ownTxIds is registered when the pending tx is written; keep
							// the id here too for txs recovered from durable storage.
							ownTxIds.add(tx.txId);
							if (ownTxIds.size > 256) {
								const oldest = ownTxIds.values().next().value;
								if (oldest) ownTxIds.delete(oldest);
							}
							await deleteBoardPendingTransaction({
								spaceId: options.getSpaceId(),
								boardId,
								txId: tx.txId,
							});
						} catch (error) {
							const attempts = conflictAttemptsByBoardId[boardId] ?? 0;
							if (
								isVersionConflict(error) &&
								attempts < MAX_CONFLICT_RECOVERY
							) {
								// A recovery is already in flight: this stale tx will be superseded
								// by the rebase re-commit, so stop rather than re-recovering.
								if (pendingRecoveryCleanup.has(boardId)) break;
								conflictAttemptsByBoardId[boardId] = attempts + 1;
								// Rebase onto the server truth and restart the loop; the editor
								// re-commits a fresh transaction with the correct base version.
								await recoverFromConflict(boardId);
								break;
							}
							throw error;
						}
					}
				} while (pendingFlushRequested.delete(boardId));
			} finally {
				pendingFlushByBoardId.delete(boardId);
			}
		})();
		pendingFlushByBoardId.set(boardId, flush);
		return flush;
	}

	/**
	 * Recover from a version conflict: fetch the server truth and hand it to the
	 * editor, which rebases its optimistic local changes onto it (reconcileExternal)
	 * and re-commits a single correct transaction. The now-stale pending txs are
	 * NOT deleted here — they are removed in commitBoard only after the fresh
	 * rebase transaction is durably written, so local changes survive a crash or
	 * board-close mid-recovery (the stale txs simply replay and re-recover).
	 */
	async function recoverFromConflict(boardId: string) {
		const bootstrap = await inspect(boardId);
		advanceSyncVersion(boardId, bootstrap.board.version);
		// Mark recovery in flight; commitBoard performs the stale-tx cleanup once
		// the fresh rebase transaction is persisted.
		pendingRecoveryCleanup.add(boardId);
		// Push the remote document to the editor (clearing `saving` so it is
		// accepted); the rebase + re-commit happens inside the editor.
		boards = boards.map((item) =>
			item.boardId === boardId
				? {
						...item,
						document: boardAuthoringSnapshotToDocument(bootstrap),
						runtime: boardRuntimeDataFromAuthoring(bootstrap),
						saving: false,
						saveError: null,
					}
				: item,
		);
	}

	/**
	 * Remove every pending transaction for a document except `keepTxId` (the fresh
	 * rebase transaction just persisted). Called once a recovery's re-commit is
	 * durable, so the stale pre-conflict txs are dropped only after their changes
	 * are safely re-recorded — never before.
	 */
	async function cleanupStaleTransactions(boardId: string, keepTxId: string) {
		pendingRecoveryCleanup.delete(boardId);
		const remaining = await listBoardPendingTransactions(
			options.getSpaceId(),
			boardId,
		);
		for (const other of remaining) {
			if (other.txId === keepTxId) continue;
			await deleteBoardPendingTransaction({
				spaceId: options.getSpaceId(),
				boardId,
				txId: other.txId,
			});
		}
	}

	async function commitBoard(
		boardId: string,
		path: string,
		document: BoardDocument,
		_before: BoardDocument,
		commands: import("@neta-art/cohub").BoardSemanticCommand[],
	) {
		if (options.getReadonly?.()) return;
		const savingPath =
			boards.find((item) => item.boardId === boardId)?.path ?? path;
		const txId = crypto.randomUUID();
		// A recovery re-commit with no resulting commands still must clear stale
		// pending mutations (their changes are already reflected server-side).
		if (commands.length === 0) {
			if (pendingRecoveryCleanup.has(boardId))
				await cleanupStaleTransactions(boardId, txId);
			return;
		}
		options.onMarkSavePending?.(savingPath);
		boards = boards.map((item) =>
			item.boardId === boardId
				? { ...item, saving: true, saveError: null }
				: item,
		);
		try {
			const baseVersion = syncVersionByBoardId[boardId];
			if (baseVersion == null) throw new Error("Board version is unavailable");
			const mutation: BoardSemanticMutation = {
				mutationId: txId,
				baseVersion,
				dryRun: false,
				commands,
			};
			await writeBoardPendingTransaction({
				spaceId: options.getSpaceId(),
				boardId,
				txId,
				baseVersion,
				mutation,
			});
			// Register before apply/realtime can race back, so our own echo is
			// skipped and does not wipe editor undo history via a remote load.
			ownTxIds.add(txId);
			if (ownTxIds.size > 256) {
				const oldest = ownTxIds.values().next().value;
				if (oldest) ownTxIds.delete(oldest);
			}
		} catch (error) {
			boards = boards.map((item) =>
				item.boardId === boardId
					? {
							...item,
							saving: false,
							saveError: error instanceof Error ? error.message : "Sync failed",
						}
					: item,
			);
			options.onClearSavePendingSoon?.(savingPath);
			void drainRemoteRefresh(boardId);
			throw error;
		}
		// The fresh (rebase) transaction is now durable; it supersedes any stale
		// pending txs from an in-flight recovery, so they can be safely removed.
		if (pendingRecoveryCleanup.has(boardId))
			await cleanupStaleTransactions(boardId, txId);
		boards = boards.map((item) =>
			item.boardId === boardId ? { ...item, document } : item,
		);
		try {
			await flushPendingTransactions(boardId);
			boards = boards.map((item) =>
				item.boardId === boardId
					? { ...item, saving: false, saveError: null }
					: item,
			);
		} catch (error) {
			boards = boards.map((item) =>
				item.boardId === boardId
					? {
							...item,
							saving: false,
							saveError:
								error instanceof Error
									? error.message
									: "Board changes are saved locally and will retry.",
						}
					: item,
			);
		} finally {
			options.onClearSavePendingSoon?.(savingPath);
			// Apply any remote refresh that arrived while this save was in flight.
			void drainRemoteRefresh(boardId);
		}
	}

	/** True if this txId was committed by this client (an echo to skip). */
	function isOwnTransaction(txId: unknown): boolean {
		return typeof txId === "string" && ownTxIds.has(txId);
	}

	function advanceSyncVersion(boardId: string, version: number) {
		const current = syncVersionByBoardId[boardId] ?? null;
		if (current !== null && version <= current) return;
		syncVersionByBoardId = { ...syncVersionByBoardId, [boardId]: version };
	}

	function isBusy(boardId: string): boolean {
		return Boolean(
			boards.some((item) => item.boardId === boardId && item.saving) ||
				pendingFlushByBoardId.has(boardId),
		);
	}

	function hasConsecutiveRemoteEvents(
		boardId: string,
		events: PendingRemoteEvent[],
	): boolean {
		const localVersion = syncVersionByBoardId[boardId] ?? null;
		if (localVersion == null) return false;
		const versions = events
			.filter((event) => event.version > localVersion)
			.map((event) => event.version)
			.sort((a, b) => a - b);
		return (
			versions.length > 1 &&
			versions.every((version, index) => version === localVersion + index + 1)
		);
	}

	/** Full authoring refresh used for version gaps or missing projections. */
	function requestRemoteRefresh(boardId: string) {
		if (!hasBoardId(boardId)) return;
		pendingRemoteBootstrap.add(boardId);
		if (isBusy(boardId)) return;
		void drainRemoteRefresh(boardId);
	}

	function requestRemoteChange(
		boardId: string,
		event: Omit<PendingRemoteEvent, "boardId">,
	) {
		if (!hasBoardId(boardId)) return;
		pendingRemoteEvents.push({ boardId, ...event });
		if (isBusy(boardId)) return;
		void drainRemoteRefresh(boardId);
	}

	async function applyRemoteChange(
		event: PendingRemoteEvent,
	): Promise<boolean> {
		const board = boards.find((item) => item.boardId === event.boardId);
		if (!board || board.saving || !board.document) return false;
		const localVersion = syncVersionByBoardId[event.boardId] ?? null;
		if (localVersion == null) return false;
		if (event.version <= localVersion) return true;
		if (event.version !== localVersion + 1) return false;
		const include = [
			...(event.changed.items.length || event.changed.orderChanged
				? (["items"] as const)
				: []),
			...(event.changed.connections.length ? (["connections"] as const) : []),
			...(event.changed.effects.length ? (["effects"] as const) : []),
			...(event.changed.compositions.length ? (["compositions"] as const) : []),
			...(event.changed.effects.length || event.changed.compositions.length
				? (["playback"] as const)
				: []),
		];
		const snapshot = await sdk
			.space(options.getSpaceId())
			.board(event.boardId)
			.authoring({
				include,
				...(event.changed.items.length && !event.changed.orderChanged
					? { itemIds: event.changed.items }
					: {}),
				...(event.changed.connections.length
					? { connectionIds: event.changed.connections }
					: {}),
				...(event.changed.effects.length
					? { effectIds: event.changed.effects }
					: {}),
				...(event.changed.compositions.length
					? { compositionIds: event.changed.compositions }
					: {}),
			});
		// A projected snapshot is safe only for the exact event version. If a later
		// mutation committed before this read, fall back to a complete authoring
		// snapshot so no intervening changed IDs are skipped.
		if (snapshot.board.version !== event.version) return false;
		const nextDocument = applyBoardAuthoringSnapshot(
			board.document,
			snapshot,
			event.changed,
		);

		const nextRuntime =
			event.changed.board ||
			event.changed.effects.length ||
			event.changed.compositions.length
				? boardRuntimeDataFromAuthoring({
						...snapshot,
						effects: mergeChangedRecords(
							board.runtime?.effects ?? [],
							snapshot.effects ?? [],
							event.changed.effects,
						),
						compositions: mergeChangedRecords(
							board.runtime?.compositions ?? [],
							snapshot.compositions ?? [],
							event.changed.compositions,
						),
						playback:
							"playback" in snapshot
								? (snapshot.playback ?? null)
								: (board.runtime?.playback ?? null),
					})
				: board.runtime;
		advanceSyncVersion(event.boardId, event.version);
		boards = boards.map((item) =>
			item.boardId === event.boardId
				? { ...item, document: nextDocument, runtime: nextRuntime, error: null }
				: item,
		);
		if (event.automation) {
			const { fallbackFocus, ...activityInput } = event.automation;
			noteRemoteTransaction(activityInput, nextDocument, fallbackFocus);
		}
		return true;
	}

	async function drainRemoteRefresh(boardId: string) {
		// Still saving: leave queue intact for the commit's finally block.
		if (isBusy(boardId)) return;
		// One drain at a time per document. Concurrent callers just queue; the
		// active drain re-checks the queue before exiting.
		if (drainingDocuments.has(boardId)) return;
		drainingDocuments.add(boardId);
		try {
			let guard = 0;
			while (guard < 8) {
				guard += 1;
				if (isBusy(boardId)) return;

				// Snapshot and remove this document's queued events for this pass.
				const events = pendingRemoteEvents
					.filter((event) => event.boardId === boardId)
					.sort((a, b) => a.version - b.version);
				pendingRemoteEvents = pendingRemoteEvents.filter(
					(event) => event.boardId !== boardId,
				);

				let needsBootstrap = pendingRemoteBootstrap.has(boardId);
				pendingRemoteBootstrap.delete(boardId);

				// A burst of contiguous events is cheaper and safer to reconcile from
				// one authoritative snapshot than by issuing one read per version.
				// Keep the single-event path incremental for the common low-volume case.
				const shouldBatch =
					!needsBootstrap && hasConsecutiveRemoteEvents(boardId, events);
				if (shouldBatch) needsBootstrap = true;

				// Events that failed contiguous semantic projection are retried after a
				// full authoring snapshot.
				let remainder: PendingRemoteEvent[] = [];
				if (!needsBootstrap) {
					for (let i = 0; i < events.length; i += 1) {
						const event = events[i];
						if (!event) continue;
						let ok = false;
						try {
							ok = await applyRemoteChange(event);
						} catch (error) {
							needsBootstrap = true;
							remainder = events.slice(i);
							setError(
								boardId,
								error instanceof Error
									? error.message
									: "Failed to sync Board change",
							);
							break;
						}
						if (!ok) {
							needsBootstrap = true;
							remainder = events.slice(i);
							break;
						}
					}
				} else {
					remainder = events;
				}

				if (!needsBootstrap) {
					// Fresh events may have arrived while we applied ops.
					if (
						pendingRemoteEvents.some((e) => e.boardId === boardId) ||
						pendingRemoteBootstrap.has(boardId)
					) {
						continue;
					}
					return;
				}

				try {
					const bootstrap = await inspect(boardId);
					const bootstrapDocument = applyBootstrap(boardId, bootstrap);
					const bootVersion = bootstrap.board.version;
					if (bootstrapDocument) {
						for (const event of events) {
							if (!event.automation || event.version > bootVersion) continue;
							const { fallbackFocus, ...activityInput } = event.automation;
							noteRemoteTransaction(
								activityInput,
								bootstrapDocument,
								fallbackFocus,
							);
						}
					}
					// Re-queue only events newer than the bootstrap; drop the rest.
					const newer = remainder.filter(
						(event) => event.version > bootVersion,
					);
					if (newer.length > 0) pendingRemoteEvents.push(...newer);
					pendingRemoteEvents = pendingRemoteEvents.filter(
						(event) => event.boardId !== boardId || event.version > bootVersion,
					);
				} catch (error) {
					// Put unapplied events back so a later drain can retry.
					if (remainder.length > 0) pendingRemoteEvents.push(...remainder);
					setError(
						boardId,
						error instanceof Error ? error.message : "Failed to sync board",
					);
					return;
				}
			}
		} finally {
			drainingDocuments.delete(boardId);
			// If the guard capped us (or events arrived as we exited), schedule
			// another pass. Concurrent callers that bounced on the draining set
			// will not retry themselves.
			const stillPending =
				pendingRemoteBootstrap.has(boardId) ||
				pendingRemoteEvents.some((event) => event.boardId === boardId);
			if (stillPending && !isBusy(boardId)) {
				queueMicrotask(() => {
					void drainRemoteRefresh(boardId);
				});
			}
		}
	}

	function renamePath(fromPath: string, toPath: string) {
		boards = boards.map((board) => {
			if (board.path === fromPath) return { ...board, path: toPath };
			if (board.path.startsWith(`${fromPath}/`)) {
				return {
					...board,
					path: `${toPath}${board.path.slice(fromPath.length)}`,
				};
			}
			return board;
		});
		if (activeBoardPath === fromPath) activeBoardPath = toPath;
		else if (activeBoardPath?.startsWith(`${fromPath}/`)) {
			activeBoardPath = `${toPath}${activeBoardPath.slice(fromPath.length)}`;
		}
	}

	function setBoardError(boardId: string, error: string) {
		boards = boards.map((board) =>
			board.boardId === boardId ? { ...board, saveError: error } : board,
		);
	}

	function setError(boardId: string, error: string) {
		setBoardError(boardId, error);
	}

	async function retryBoardSave(boardId: string) {
		if (!hasBoardId(boardId) || options.getReadonly?.()) return;
		boards = boards.map((item) =>
			item.boardId === boardId
				? { ...item, saving: true, saveError: null }
				: item,
		);
		try {
			await flushPendingTransactions(boardId);
			boards = boards.map((item) =>
				item.boardId === boardId
					? { ...item, saving: false, saveError: null }
					: item,
			);
		} catch (error) {
			boards = boards.map((item) =>
				item.boardId === boardId
					? {
							...item,
							saving: false,
							saveError: error instanceof Error ? error.message : "Sync failed",
						}
					: item,
			);
		}
	}

	function applyPlayback(playback: BoardPlaybackSnapshot) {
		boards = boards.map((item) =>
			item.boardId === playback.boardId && item.runtime
				? { ...item, runtime: { ...item.runtime, playback } }
				: item,
		);
	}

	function applyRemoteAnimationPatch(event: {
		boardId: string;
		version: number;
		changed: PendingRemoteEvent["changed"];
		animationPatch: {
			effects: BoardRuntimeData["effects"];
			compositions: BoardRuntimeData["compositions"];
			playback?: BoardPlaybackSnapshot | null;
		};
	}): boolean {
		const board = boards.find((item) => item.boardId === event.boardId);
		const localVersion = syncVersionByBoardId[event.boardId] ?? null;
		if (!board?.runtime || localVersion == null) return false;
		if (event.version <= localVersion) return true;
		if (isBusy(event.boardId) || drainingDocuments.has(event.boardId))
			return false;
		if (event.version !== localVersion + 1) return false;
		const effects = mergeChangedRecords(
			board.runtime.effects,
			event.animationPatch.effects,
			event.changed.effects,
		);
		const compositions = mergeChangedRecords(
			board.runtime.compositions,
			event.animationPatch.compositions,
			event.changed.compositions,
		);
		advanceSyncVersion(event.boardId, event.version);
		boards = boards.map((item) =>
			item.boardId === event.boardId && item.runtime
				? {
						...item,
						runtime: {
							...item.runtime,
							effects,
							compositions,
							...(event.animationPatch.playback !== undefined
								? { playback: event.animationPatch.playback }
								: {}),
						},
					}
				: item,
		);
		return true;
	}

	function applyBootstrap(
		boardId: string,
		bootstrap: BoardAuthoringSnapshot,
	): BoardDocument | null {
		const board = boards.find((item) => item.boardId === boardId);
		if (!board || board.saving) return null;
		const currentVersion = syncVersionByBoardId[boardId] ?? null;
		if (!canAdoptBoardVersion(currentVersion, bootstrap.board.version))
			return null;
		const document = boardAuthoringSnapshotToDocument(bootstrap);
		advanceSyncVersion(boardId, bootstrap.board.version);
		boards = boards.map((item) =>
			item.boardId === boardId
				? {
						...item,
						document,
						runtime: boardRuntimeDataFromAuthoring(bootstrap),
						loading: false,
						saveError: null,
					}
				: item,
		);
		return document;
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
		openBoard,
		closeBoard,
		activateBoard,
		commitBoard,
		retryBoardSave,
		refreshBoardManifest,
		reconcileOpenBoards,
		renamePath,
		closeBoardsAtPath,
		dispose,
	};
}
