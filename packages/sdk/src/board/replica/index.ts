import {
	applyBoardDelta,
	applyBoardPatchToDocument,
	type BoardApplyResult,
	type BoardDelta,
	type BoardDocument,
	type BoardPatch,
	type BoardPlaybackSnapshot,
	type BoardReadResult,
	parseBoardDocument,
} from "@cohub/protocol";
import { createBoardEntityId } from "../model/items/id.js";

export type BoardPendingPatch = { mutationId: string; patch: BoardPatch };

export type BoardChangedPayload = {
	mutationId: string;
	baseVersion: number;
	version: number;
	after?: BoardDelta;
};

export type BoardRemote = {
	get(): Promise<BoardReadResult>;
	apply(patch: BoardPatch, options: { mutationId: string; clientId?: string }): Promise<BoardApplyResult>;
	subscribe?(handlers: {
		changed?: (event: { payload: BoardChangedPayload }) => void;
		playback?: (event: { payload: { playback: BoardPlaybackSnapshot | null } }) => void;
	}): () => void;
};

export type BoardReplicaStorage = {
	listPending(): Promise<BoardPendingPatch[]>;
	putPending(entry: BoardPendingPatch): Promise<void>;
	deletePending(mutationId: string): Promise<void>;
	readDocument(): Promise<{ version: number; document: Record<string, unknown> } | null>;
	writeDocument(version: number, document: BoardDocument): Promise<void>;
};

export type BoardReplicaState = {
	document: BoardDocument | null;
	version: number;
	title: string | null;
	playback: BoardPlaybackSnapshot | null;
	loaded: boolean;
	pending: number;
	error: string | null;
};

export type BoardReplicaOptions = {
	remote: BoardRemote;
	storage?: BoardReplicaStorage;
	clientId?: string;
	persistIntervalMs?: number;
};

function memoryStorage(): BoardReplicaStorage {
	return {
		listPending: async () => [],
		putPending: async () => undefined,
		deletePending: async () => undefined,
		readDocument: async () => null,
		writeDocument: async () => undefined,
	};
}

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;
const PERSIST_INTERVAL_MS = 500;

function isRejection(error: unknown): boolean {
	const status = (error as { status?: number }).status;
	return (
		typeof status === "number" &&
		status >= 400 &&
		status < 500 &&
		![401, 403, 408, 429].includes(status)
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Board sync failed.";
}

export function createBoardReplica(options: BoardReplicaOptions) {
	const remote = options.remote;
	const storage = options.storage ?? memoryStorage();
	const listeners = new Set<(state: BoardReplicaState) => void>();
	let unsubscribeRemote: (() => void) | null = null;
	let server: BoardDocument | null = null;
	let version = 0;
	let title: string | null = null;
	let playback: BoardPlaybackSnapshot | null = null;
	let playbackRevision = 0;
	let loaded = false;
	let readError: string | null = null;
	let writeError: string | null = null;
	let pending: BoardPendingPatch[] = [];
	let document: BoardDocument | null = null;
	let sending = false;
	let refreshing: Promise<void> | null = null;
	let refreshAgain = false;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let retryDelay = RETRY_BASE_MS;
	let disposed = false;
	let unpersisted: { version: number; document: BoardDocument } | null = null;
	let persistTimer: ReturnType<typeof setTimeout> | null = null;

	function subscribeRemote(): (() => void) | null {
		if (!remote.subscribe) return null;
		try {
			return remote.subscribe({
				changed: (event) => receive(event.payload),
				playback: (event) => receivePlayback(event.payload.playback),
			});
		} catch {
			return null;
		}
	}

	function recompute() {
		if (!server) {
			document = null;
			return;
		}
		let next = server;
		for (const entry of pending) {
			const result = applyBoardPatchToDocument(next, entry.patch);
			if (result.ok) next = result.document;
		}
		document = next;
	}

	function snapshot(): BoardReplicaState {
		return {
			document,
			version,
			title,
			playback,
			loaded,
			pending: pending.length,
			error: writeError ?? readError,
		};
	}

	let current = snapshot();

	function emit() {
		if (disposed) return;
		current = snapshot();
		for (const listener of [...listeners]) listener(current);
	}

	function adoptServer(
		next: BoardDocument,
		nextVersion: number,
		persist: boolean,
	) {
		server = next;
		version = nextVersion;
		recompute();
		if (persist) schedulePersist(nextVersion, next);
	}

	function schedulePersist(nextVersion: number, next: BoardDocument) {
		unpersisted = { version: nextVersion, document: next };
		persistTimer ??= setTimeout(
			persistNow,
			options.persistIntervalMs ?? PERSIST_INTERVAL_MS,
		);
	}

	function persistNow() {
		if (persistTimer) clearTimeout(persistTimer);
		persistTimer = null;
		const entry = unpersisted;
		unpersisted = null;
		if (entry)
			void storage
				.writeDocument(entry.version, entry.document)
				.catch(() => undefined);
	}

	function adoptRead(result: BoardReadResult, readPlaybackRevision: number) {
		const parsed = parseBoardDocument({
			board: result.board,
			items: result.items ?? {},
			animations: result.animations ?? {},
		});
		if (!parsed.ok) throw new Error(`Board ${result.id} could not be read.`);
		title = result.title;
		if (readPlaybackRevision === playbackRevision) playback = result.playback;
		loaded = true;
		adoptServer(parsed.document, result.version, true);
	}

	function refresh(): Promise<void> {
		if (refreshing) {
			refreshAgain = true;
			return refreshing;
		}
		refreshing = (async () => {
			try {
				do {
					refreshAgain = false;
					const readPlaybackRevision = playbackRevision;
					const result = await remote.get();
					if (disposed) return;
					if (result.version >= version || !loaded)
						adoptRead(result, readPlaybackRevision);
					readError = null;
					emit();
				} while (refreshAgain && !disposed);
			} catch (cause) {
				readError = errorMessage(cause);
				emit();
			} finally {
				refreshing = null;
			}
		})();
		return refreshing;
	}

	function scheduleRetry() {
		if (retryTimer || disposed) return;
		retryTimer = setTimeout(() => {
			retryTimer = null;
			void flush();
		}, retryDelay);
		retryDelay = Math.min(RETRY_MAX_MS, retryDelay * 2);
	}

	async function flush() {
		if (sending || disposed || !loaded) return;
		sending = true;
		try {
			while (pending.length && !disposed) {
				const entry = pending[0] as BoardPendingPatch;
				try {
					const result = await remote.apply(entry.patch, {
						mutationId: entry.mutationId,
						...(options.clientId ? { clientId: options.clientId } : {}),
					});
					const stillPending = pending.some(
						(item) => item.mutationId === entry.mutationId,
					);
					pending = pending.filter(
						(item) => item.mutationId !== entry.mutationId,
					);
					void storage
						.deletePending(entry.mutationId)
						.catch(() => undefined);
					if (
						stillPending &&
						server &&
						!result.replayed &&
						result.status === "applied" &&
						result.version === version + 1
					) {
						const next = applyBoardPatchToDocument(server, entry.patch);
						if (next.ok) adoptServer(next.document, result.version, true);
						else void refresh();
					} else if (result.version > version) void refresh();
					else recompute();
					retryDelay = RETRY_BASE_MS;
					writeError = null;
					emit();
				} catch (cause) {
					if (isRejection(cause)) {
						pending = pending.filter(
							(item) => item.mutationId !== entry.mutationId,
						);
						void storage
							.deletePending(entry.mutationId)
							.catch(() => undefined);
						writeError = errorMessage(cause);
						recompute();
						emit();
						void refresh();
						continue;
					}
					writeError = errorMessage(cause);
					emit();
					scheduleRetry();
					return;
				}
			}
		} finally {
			sending = false;
		}
	}

	function receive(payload: BoardChangedPayload) {
		if (!loaded) {
			void refresh();
			return;
		}
		if (payload.version <= version) return;
		if (payload.baseVersion !== version || !payload.after || !server) {
			void refresh();
			return;
		}
		adoptServer(applyBoardDelta(server, payload.after), payload.version, true);
		if (pending.some((entry) => entry.mutationId === payload.mutationId)) {
			pending = pending.filter((entry) => entry.mutationId !== payload.mutationId);
			void storage.deletePending(payload.mutationId).catch(() => undefined);
			recompute();
		}
		emit();
	}

	function receivePlayback(next: BoardPlaybackSnapshot | null) {
		playbackRevision += 1;
		playback = next;
		emit();
	}

	return {
		get state(): BoardReplicaState {
			return current;
		},
		subscribe(listener: (state: BoardReplicaState) => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async start() {
			unsubscribeRemote ??= subscribeRemote();

			const [cached, stored] = await Promise.all([
				storage.readDocument().catch(() => null),
				storage.listPending().catch(() => []),
			]);
			if (disposed) return;
			pending = stored;
			if (cached && !server) {
				const parsed = parseBoardDocument(cached.document);
				if (parsed.ok) adoptServer(parsed.document, cached.version, false);
			}
			emit();
			await refresh();
			await flush();
		},
		apply(patch: BoardPatch): Promise<void> {
			const entry = { mutationId: createBoardEntityId(), patch };
			pending = [...pending, entry];
			recompute();
			emit();
			return storage
				.putPending(entry)
				.catch(() => undefined)
				.then(() => flush());
		},
		receive,
		receivePlayback,
		refresh,
		retry() {
			if (retryTimer) clearTimeout(retryTimer);
			retryTimer = null;
			retryDelay = RETRY_BASE_MS;
			readError = null;
			writeError = null;
			emit();
			return refresh().then(flush);
		},
		dispose() {
			disposed = true;
			unsubscribeRemote?.();
			unsubscribeRemote = null;
			listeners.clear();
			if (retryTimer) clearTimeout(retryTimer);
			persistNow();
		},
	};
}

export type BoardReplica = ReturnType<typeof createBoardReplica>;
