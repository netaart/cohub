
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

export type BoardPendingPatch = { mutationId: string; patch: BoardPatch };

export type BoardSyncTransport = {
	get(): Promise<BoardReadResult>;
	apply(patch: BoardPatch, options: { mutationId: string; clientId?: string }): Promise<BoardApplyResult>;
};

export type BoardSyncStore = {
	listPending(): Promise<BoardPendingPatch[]>;
	putPending(entry: BoardPendingPatch): Promise<void>;
	deletePending(mutationId: string): Promise<void>;
	readDocument(): Promise<{ version: number; document: Record<string, unknown> } | null>;
	writeDocument(version: number, document: BoardDocument): Promise<void>;
};

export type BoardSyncState = {
	document: BoardDocument | null;
	version: number;
	title: string | null;
	playback: BoardPlaybackSnapshot | null;
	loaded: boolean;
	pending: number;
	error: string | null;
};

export type BoardChangedPayload = {
	mutationId: string;
	baseVersion: number;
	version: number;
	after?: BoardDelta;
};

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;

function isRejection(error: unknown): boolean {
	const status = (error as { status?: number }).status;
	return typeof status === "number" && status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Board sync failed.";
}

export function createBoardSync(options: {
	transport: BoardSyncTransport;
	store: BoardSyncStore;
	clientId?: string;
	onChange: (state: BoardSyncState) => void;
}) {
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

	function recompute() {
		if (!server) {
			document = null;
			return;
		}
		let next = server;
		for (const entry of pending) {
			const result = applyBoardPatchToDocument(next, entry.patch, { cascade: true });
			if (result.ok) next = result.document;
		}
		document = next;
	}

	function snapshot(): BoardSyncState {
		return { document, version, title, playback, loaded, pending: pending.length, error: writeError ?? readError };
	}

	function emit() {
		if (!disposed) options.onChange(snapshot());
	}

	function adoptServer(next: BoardDocument, nextVersion: number, persist: boolean) {
		server = next;
		version = nextVersion;
		recompute();
		if (persist) void options.store.writeDocument(nextVersion, next).catch(() => undefined);
	}

	function adoptRead(result: BoardReadResult, readPlaybackRevision: number) {
		const parsed = parseBoardDocument({ board: result.board, items: result.items ?? {}, animations: result.animations ?? {} });
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
					const result = await options.transport.get();
					if (disposed) return;
					if (result.version >= version || !loaded) adoptRead(result, readPlaybackRevision);
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
					const result = await options.transport.apply(entry.patch, { mutationId: entry.mutationId, ...(options.clientId ? { clientId: options.clientId } : {}) });
					const stillPending = pending.some((item) => item.mutationId === entry.mutationId);
					pending = pending.filter((item) => item.mutationId !== entry.mutationId);
					void options.store.deletePending(entry.mutationId).catch(() => undefined);
					if (stillPending && server && !result.replayed && result.status === "applied" && result.version === version + 1) {
						const next = applyBoardPatchToDocument(server, entry.patch, { cascade: true });
						if (next.ok) adoptServer(next.document, result.version, true);
						else void refresh();
					} else if (result.version > version) void refresh();
					else recompute();
					retryDelay = RETRY_BASE_MS;
					writeError = null;
					emit();
				} catch (cause) {
					if (isRejection(cause)) {
						pending = pending.filter((item) => item.mutationId !== entry.mutationId);
						void options.store.deletePending(entry.mutationId).catch(() => undefined);
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

	return {
		async start() {
			const [cached, stored] = await Promise.all([
				options.store.readDocument().catch(() => null),
				options.store.listPending().catch(() => []),
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
		commit(patch: BoardPatch): Promise<void> {
			const entry = { mutationId: crypto.randomUUID(), patch };
			pending = [...pending, entry];
			recompute();
			emit();
			return options.store.putPending(entry).catch(() => undefined).then(() => flush());
		},
		receive(payload: BoardChangedPayload) {
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
				void options.store.deletePending(payload.mutationId).catch(() => undefined);
				recompute();
			}
			emit();
		},
		receivePlayback(next: BoardPlaybackSnapshot | null) {
			playbackRevision += 1;
			playback = next;
			emit();
		},
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
		get state(): BoardSyncState {
			return snapshot();
		},
		dispose() {
			disposed = true;
			if (retryTimer) clearTimeout(retryTimer);
		},
	};
}

export type BoardSync = ReturnType<typeof createBoardSync>;
