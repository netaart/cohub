import type { BoardSemanticMutation } from "@cohub/protocol";
import type { ContentBlock } from "@cohub/protocol/core";
import type {
	SessionFileRecord,
	SessionForkRecord,
	SessionTurnRecord,
} from "@cohub/protocol/model";
import { sanitizeTaskRunForList } from "@cohub/protocol/task";
import type {
	LabelAssignmentListItem,
	LabelAssignmentPageInfo,
	LabelAssignmentRecord,
	LabelListItem,
	PublicUserProfile,
	SessionRecord,
	SpaceFsEntry,
	SpaceRecord,
	TaskRunRecord,
} from "@neta-art/cohub";
import type { SessionListPageInfo } from "$lib/cache/types";

export const DB_NAME = "cohub-web-cache";
export const DB_VERSION = 18;

export type SessionListForkRecord = Partial<SessionForkRecord> & {
	childSessionId: string;
	parentSessionId?: string | null;
	depth: number;
	anchorSequence?: number | null;
	createdAt?: string;
	firstUserTextAfterFork?: string | null;
	parentTitle?: string | null;
};

export type SessionListCacheRecord = {
	key: string;
	userKey: string;
	spaceId: string;
	kind: "recent";
	sessions: SessionRecord[];
	forks?: SessionListForkRecord[];
	pageInfo: SessionListPageInfo;
	updatedAt: number;
	lastAccessedAt: number;
	watermark: string | null;
	completeness: "partial" | "complete";
};

export type SessionListIndexItem = {
	userKey?: string;
	spaceId?: string;
	sessionId: string;
	activityAt: string | null;
	lastMessageAt: string | null;
	updatedAt: string | null;
	lastMessageId: string | null;
	preview: {
		title: string | null;
		latestMessageText: string | null;
		source: string | null;
		status: string | null;
		activeTurn?: SessionRecord["activeTurn"];
		userProfile?: SessionRecord["userProfile"];
		participantProfiles?: SessionRecord["participantProfiles"];
	};
};

export type SessionListIndexCacheRecord = {
	key: string;
	userKey: string;
	spaceId: string;
	kind: "recent";
	items: SessionListIndexItem[];
	forks?: SessionListForkRecord[];
	pageInfo: SessionListPageInfo;
	updatedAt: number;
	lastAccessedAt: number;
	watermark: string | null;
	completeness: "partial" | "complete";
};

export type SessionDetailCacheRecord = {
	key: string;
	userKey: string;
	spaceId: string;
	sessionId: string;
	session: SessionRecord;
	updatedAt: number;
	lastAccessedAt: number;
	watermark: string | null;
};

export type SessionTurnsCacheRecord = {
	key: string;
	userKey: string;
	spaceId: string;
	sessionId: string;
	session: SessionRecord | null;
	turns: SessionTurnRecord[];
	newestSequence: number | null;
	oldestSequence: number | null;
	hasMoreOlder: boolean;
	hasMoreNewer?: boolean;
	reconciledAt: number;
	updatedAt: number;
	lastAccessedAt: number;
	tailWatermark: string | null;
};

export type SessionGenerationSnapshotCacheRecord = {
	key: string;
	userKey: string;
	spaceId: string;
	sessionId: string;
	turnId: string | null;
	anchorUserMessageId: string | null;
	clientMessageId: string | null;
	status: string;
	contentBlocks: ContentBlock[];
	intermediateMessages: unknown[];
	streamMessageId: string | null;
	messageOrdinal: number | null;
	truncatedStart: boolean;
	patchSeq: number;
	finalizedPreview: boolean;
	runtimePhase: string | null;
	runtimePhaseAt: number | null;
	llmRound: number | null;
	runtimeProvider: string | null;
	runtimeModel: string | null;
	startedAt: number | null;
	lastEventAt: number | null;
	lastPatchAt: number | null;
	createdAt: number;
	updatedAt: number;
	expiresAt: number;
};

export type SpaceFsDirCacheRecord = {
	key: string;
	userKey: string;
	spaceId: string;
	dirPath: string;
	entries: SpaceFsEntry[];
	updatedAt: number;
	lastAccessedAt: number;
	watermark: string | null;
};

export type SpaceFsEpochCacheRecord = {
	key: string;
	userKey: string;
	spaceId: string;
	epoch: number;
	updatedAt: number;
};

export type SpaceRecordCacheRecord = {
	key: string;
	userKey: string;
	spaceId: string;
	space: SpaceRecord;
	updatedAt: number;
	lastAccessedAt: number;
	watermark: string | null;
};

export type LabelTreeCacheRecord = {
	key: string;
	userKey: string;
	spaceId: string;
	labels: LabelListItem[];
	updatedAt: number;
	lastAccessedAt: number;
	watermark: string | null;
};

export type LabelItemsCacheRecord = {
	key: string;
	userKey: string;
	spaceId: string;
	labelId: string;
	items: LabelAssignmentListItem[];
	pageInfo: LabelAssignmentPageInfo;
	/** Optional page sessions/forks (v10+). Older records omit these. */
	sessions?: SessionRecord[];
	forks?: SessionListForkRecord[];
	updatedAt: number;
	lastAccessedAt: number;
	watermark: string | null;
	completeness: "partial" | "complete";
};

export type ResourceLabelsCacheRecord = {
	key: string;
	userKey: string;
	spaceId: string;
	resourceType: string;
	resourceRef: string;
	labels: LabelListItem[];
	assignments: LabelAssignmentRecord[];
	updatedAt: number;
	lastAccessedAt: number;
};

export type UserProfileCacheRecord = {
	key: string;
	userKey: string;
	userUuid: string;
	profile: PublicUserProfile | null;
	updatedAt: number;
	lastAccessedAt: number;
};

export type TaskRunSummaryCacheRecord = {
	key: string;
	userKey: string;
	spaceId: string;
	sessionId: string | null;
	turnId: string | null;
	taskRunId: string;
	taskType: string;
	status: TaskRunRecord["status"];
	run: TaskRunRecord;
	updatedAt: number;
	lastAccessedAt: number;
};

export type FilePendingDraftCacheRecord = {
	key: string;
	userKey: string;
	spaceId: string;
	path: string;
	draft: string;
	baseContent: string;
	baseMtimeMs: number;
	baseSize: number;
	mutationId: string;
	createdAt: number;
	updatedAt: number;
};

export type BoardPendingTransactionCacheRecord = {
	key: string;
	userKey: string;
	spaceId: string;
	boardId: string;
	txId: string;
	baseVersion: number;
	mutation: BoardSemanticMutation;
	attemptCount: number;
	createdAt: number;
	updatedAt: number;
	lastAttemptAt: number | null;
};

export type SessionFilesCacheRecord = {
	key: string;
	userKey: string;
	spaceId: string;
	sessionId: string;
	files: SessionFileRecord[];
	updatedAt: number;
	lastAccessedAt: number;
};

export type TaskRunDetailCacheRecord = {
	key: string;
	userKey: string;
	spaceId: string;
	sessionId: string | null;
	turnId: string | null;
	taskRunId: string;
	taskType: string;
	run: TaskRunRecord;
	progress: unknown;
	updatedAt: number;
	lastAccessedAt: number;
};

export type StoreName =
	| "session_lists"
	| "session_list_indexes"
	| "session_details"
	| "session_turns"
	| "session_generation_snapshots"
	| "space_fs_dirs"
	| "space_fs_epochs"
	| "space_records"
	| "space_activity"
	| "label_trees"
	| "label_items"
	| "resource_labels"
	| "user_profiles"
	| "file_pending_drafts"
	| "board_pending_txs"
	| "task_run_summaries"
	| "task_run_details"
	| "session_files";

let dbPromise: Promise<IDBDatabase> | null = null;
/** Resolved connection for O(1) reuse after open; cleared on versionchange/reset. */
let dbConnection: IDBDatabase | null = null;
/** In-flight open currently watched for late settle after a timeout. */
let watchedOpenPromise: Promise<IDBDatabase> | null = null;
/**
 * After open times out, fail-fast until this timestamp so concurrent cache ops
 * do not each wait the full open budget and spam the console.
 */
let openDegradedUntil = 0;
let lastOpenTimeoutLogAt = 0;

/** Guards against reload loops when an old client hits a newer IDB schema. */
const IDB_VERSION_RELOAD_KEY = "cohub:cache:idb-version-reload";

export class CacheVersionMismatchError extends Error {
	constructor(message = "App is out of date. Refresh the page to continue.") {
		super(message);
		this.name = "CacheVersionMismatchError";
	}
}

/** Soft ceiling so a stuck IndexedDB never blocks UI data paths forever. */
export const IDB_OP_TIMEOUT_MS = 2_500;
export const IDB_OPEN_TIMEOUT_MS = 5_000;
/** Fail-fast window after an open timeout (keeps hanging open for late success). */
export const IDB_OPEN_DEGRADED_MS = 30_000;
/** Live budgets (mutable only via test reset so unit tests need not wait seconds). */
let idbOpTimeoutMs = IDB_OP_TIMEOUT_MS;
let idbOpenTimeoutMs = IDB_OPEN_TIMEOUT_MS;
let idbOpenDegradedMs = IDB_OPEN_DEGRADED_MS;
/** At most one open-timeout warn per throttle window while degraded. */
let idbOpenLogThrottleMs = 60_000;
/** At most one store-op timeout warn per throttle window. */
let idbStoreOpLogThrottleMs = 60_000;
let lastStoreOpTimeoutLogAt = 0;
/** Extreme-path self-heal: repeated hard failures wipe only `cohub-web-cache`. */
const IDB_FAILURE_WINDOW_MS = 30_000;
/** Count only real store ops after open; concurrent first-open races must not wipe cache. */
const IDB_FAILURE_THRESHOLD = 6;
const IDB_RECOVERY_COOLDOWN_MS = 5 * 60_000;

export class CacheTimeoutError extends Error {
	constructor(message = "IndexedDB operation timed out") {
		super(message);
		this.name = "CacheTimeoutError";
	}
}

function withTimeout<T>(
	promise: Promise<T>,
	label: string,
	ms = idbOpTimeoutMs,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new CacheTimeoutError(`${label} timed out after ${ms}ms`));
		}, ms);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	}) as Promise<T>;
}

function noteOpenTimedOut(error: CacheTimeoutError) {
	const now = Date.now();
	openDegradedUntil = Math.max(openDegradedUntil, now + idbOpenDegradedMs);
	if (now - lastOpenTimeoutLogAt < idbOpenLogThrottleMs) return;
	lastOpenTimeoutLogAt = now;
	console.warn(
		"[cache] IndexedDB open timed out; continuing without persistence",
		error,
	);
}

function noteStoreOpTimedOut(label: string, error: CacheTimeoutError) {
	const now = Date.now();
	if (now - lastStoreOpTimeoutLogAt < idbStoreOpLogThrottleMs) return;
	lastStoreOpTimeoutLogAt = now;
	console.warn(`[cache] ${label}`, error);
}

function clearOpenDegraded() {
	openDegradedUntil = 0;
}

/**
 * Keep a hanging open alive after timeout so a late success can restore
 * persistence without every concurrent caller re-waiting and re-logging.
 */
function watchInFlightOpen(promise: Promise<IDBDatabase>) {
	if (watchedOpenPromise === promise) return;
	watchedOpenPromise = promise;
	void promise.then(
		(db) => {
			// Accept late success even after a later open attempt started — any live
			// connection restores persistence for subsequent idb ops.
			if (!dbConnection) {
				dbConnection = db;
				if (dbPromise === null || dbPromise === promise) {
					dbPromise = promise;
				}
			}
			clearOpenDegraded();
			noteIdbSuccess();
		},
		() => {
			if (watchedOpenPromise === promise) watchedOpenPromise = null;
		},
	);
}

let recentIdbFailureAt: number[] = [];
let lastIdbRecoveryAt = 0;
let idbRecoveryInFlight: Promise<void> | null = null;

function isSevereIdbFailure(error: unknown) {
	if (error instanceof CacheTimeoutError) return true;
	if (!error || typeof error !== "object") return false;
	const name = "name" in error ? String(error.name) : "";
	const message = "message" in error ? String(error.message) : "";
	return (
		name === "QuotaExceededError" ||
		name === "InvalidStateError" ||
		name === "AbortError" ||
		name === "UnknownError" ||
		/transaction aborted/i.test(message) ||
		/timed out/i.test(message)
	);
}

function isStoreOpLabel(label: string) {
	// Only count real store ops toward wipe recovery. openCacheDb races on cold
	// start are expected under concurrency and must not clear warm cache.
	return label.startsWith("idb:");
}

function noteIdbSuccess() {
	recentIdbFailureAt = [];
}

function noteIdbFailure(error: unknown, label: string) {
	if (!isStoreOpLabel(label)) return;
	if (!isSevereIdbFailure(error)) return;
	const now = Date.now();
	recentIdbFailureAt = recentIdbFailureAt.filter(
		(at) => now - at < IDB_FAILURE_WINDOW_MS,
	);
	recentIdbFailureAt.push(now);
	if (recentIdbFailureAt.length < IDB_FAILURE_THRESHOLD) return;
	if (idbRecoveryInFlight) return;
	if (now - lastIdbRecoveryAt < IDB_RECOVERY_COOLDOWN_MS) return;

	lastIdbRecoveryAt = now;
	recentIdbFailureAt = [];
	idbRecoveryInFlight = (async () => {
		console.warn(
			"[cache] Repeated IndexedDB failures; clearing cohub-web-cache",
			{ label, error },
		);
		try {
			// Auth/login lives in Logto + localStorage, not this DB.
			await deleteCacheDatabase();
		} catch (recoveryError) {
			console.warn("[cache] Failed to clear IndexedDB during recovery", {
				recoveryError,
			});
		} finally {
			idbRecoveryInFlight = null;
		}
	})();
}

function isBrowser() {
	return typeof indexedDB !== "undefined";
}

function isClosingConnectionError(error: unknown) {
	return error instanceof DOMException && error.name === "InvalidStateError";
}

function isIdbVersionError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const name = "name" in error ? String(error.name) : "";
	if (name === "VersionError") return true;
	// Some browsers surface the name only in the message.
	const message = "message" in error ? String(error.message) : "";
	return /version\s*error/i.test(message);
}

function hasAttemptedVersionReload(): boolean {
	if (typeof sessionStorage === "undefined") return false;
	try {
		return sessionStorage.getItem(IDB_VERSION_RELOAD_KEY) === "1";
	} catch {
		return false;
	}
}

function markVersionReloadAttempted() {
	if (typeof sessionStorage === "undefined") return;
	try {
		sessionStorage.setItem(IDB_VERSION_RELOAD_KEY, "1");
	} catch {
		// ignore quota / private mode
	}
}

function clearVersionReloadAttempt() {
	if (typeof sessionStorage === "undefined") return;
	try {
		sessionStorage.removeItem(IDB_VERSION_RELOAD_KEY);
	} catch {
		// ignore
	}
}

/**
 * Recover from IDB VersionError (stale JS vs newer schema).
 * Auto-reloads once; if still mismatched, rejects with a friendly error.
 */
function recoverFromVersionMismatch(error: unknown): Promise<never> {
	const canReload =
		typeof globalThis.location?.reload === "function" &&
		!hasAttemptedVersionReload();
	if (canReload) {
		markVersionReloadAttempted();
		console.warn(
			"[cache] IndexedDB version mismatch; reloading for updated client",
			error,
		);
		globalThis.location.reload();
		// Leave the promise pending so callers do not flash a transient error.
		return new Promise(() => undefined);
	}
	console.warn(
		"[cache] IndexedDB version mismatch after reload; client is stale",
		error,
	);
	const alertFn = globalThis.alert;
	if (typeof alertFn === "function") {
		try {
			alertFn(
				"App is out of date. Hard-refresh the page (Ctrl/Cmd+Shift+R) to continue.",
			);
		} catch {
			// ignore headless / blocked alert
		}
	}
	return Promise.reject(new CacheVersionMismatchError());
}

function resetDbConnection(db?: IDBDatabase | null) {
	const target = db ?? dbConnection;
	try {
		target?.close();
	} catch {
		// ignore
	}
	dbConnection = null;
	dbPromise = null;
	watchedOpenPromise = null;
	clearOpenDegraded();
}

function createStore(
	db: IDBDatabase,
	name: StoreName,
	indexes: Array<{ name: string; keyPath: string | string[] }>,
) {
	if (db.objectStoreNames.contains(name)) return;
	const store = db.createObjectStore(name, { keyPath: "key" });
	for (const index of indexes) store.createIndex(index.name, index.keyPath);
}

/**
 * Summaries cached before list views dropped inline generation media can hold
 * megabytes each. Slim them in place so the first screen keeps its cache.
 */
function slimTaskRunSummaries(transaction: IDBTransaction | null) {
	const cursorRequest = transaction
		?.objectStore("task_run_summaries")
		.openCursor();
	if (!cursorRequest) return;
	cursorRequest.onsuccess = () => {
		const cursor = cursorRequest.result;
		if (!cursor) return;
		// One malformed record must not abort the upgrade transaction.
		try {
			const record = cursor.value as TaskRunSummaryCacheRecord | undefined;
			const run = record?.run && sanitizeTaskRunForList(record.run);
			if (record && run && run !== record.run)
				cursor.update({ ...record, run });
		} catch (error) {
			console.warn("[cache] skipped a task run summary while slimming", error);
		}
		cursor.continue();
	};
}

export async function openCacheDb(): Promise<IDBDatabase | null> {
	if (!isBrowser()) return null;
	// Hot path: already open. Avoid re-entering timeout races on every idb op.
	if (dbConnection) return dbConnection;

	// After a timeout, fail fast so hundreds of concurrent cache ops do not each
	// wait 5s and flood the console. A late open success clears this via watch.
	if (dbPromise && Date.now() < openDegradedUntil) {
		watchInFlightOpen(dbPromise);
		return null;
	}

	// Degraded window elapsed but open still unresolved: abandon the shared slot
	// and start a fresh open. Keep watching the old promise so a late success
	// can still restore dbConnection without another full wait storm.
	if (dbPromise && openDegradedUntil > 0 && Date.now() >= openDegradedUntil) {
		watchInFlightOpen(dbPromise);
		dbPromise = null;
		clearOpenDegraded();
	}

	if (dbPromise) {
		try {
			const db = await withTimeout(dbPromise, "openCacheDb", idbOpenTimeoutMs);
			dbConnection = db;
			clearOpenDegraded();
			noteIdbSuccess();
			return db;
		} catch (error) {
			// Keep in-flight open so a late success is still shared via watch.
			if (error instanceof CacheTimeoutError) {
				watchInFlightOpen(dbPromise);
				noteOpenTimedOut(error);
				// open timeouts are not store ops; do not count toward wipe recovery.
				return null;
			}
			noteIdbFailure(error, "openCacheDb");
			throw error;
		}
	}
	const openPromise = new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onblocked = () => {
			dbPromise = null;
			watchedOpenPromise = null;
			reject(new Error("IndexedDB open blocked"));
		};
		request.onupgradeneeded = (event) => {
			const db = request.result;
			const { oldVersion } = event as IDBVersionChangeEvent;
			if (
				oldVersion < 18 &&
				db.objectStoreNames.contains("task_run_summaries")
			) {
				slimTaskRunSummaries(request.transaction);
			}
			if (
				oldVersion < 15 &&
				db.objectStoreNames.contains("board_pending_txs")
			) {
				// Pending records used the removed raw operation shape. With no live
				// Board data to migrate, rebuild this queue rather than allowing stale
				// records to block every future semantic commit.
				db.deleteObjectStore("board_pending_txs");
			}
			createStore(db, "space_records", [
				{ name: "by_user_space", keyPath: ["userKey", "spaceId"] },
				{ name: "by_last_accessed", keyPath: "lastAccessedAt" },
				{ name: "by_updated_at", keyPath: "updatedAt" },
			]);
			createStore(db, "space_activity", [
				{ name: "by_user_space", keyPath: ["userKey", "spaceId"] },
				{ name: "by_last_accessed", keyPath: "lastAccessedAt" },
				{ name: "by_updated_at", keyPath: "updatedAt" },
			]);
			createStore(db, "session_lists", [
				{ name: "by_user_space", keyPath: ["userKey", "spaceId"] },
				{ name: "by_last_accessed", keyPath: "lastAccessedAt" },
				{ name: "by_updated_at", keyPath: "updatedAt" },
			]);
			createStore(db, "session_list_indexes", [
				{ name: "by_user_space", keyPath: ["userKey", "spaceId"] },
				{ name: "by_last_accessed", keyPath: "lastAccessedAt" },
				{ name: "by_updated_at", keyPath: "updatedAt" },
			]);
			createStore(db, "session_details", [
				{ name: "by_user_space", keyPath: ["userKey", "spaceId"] },
				{
					name: "by_user_space_session",
					keyPath: ["userKey", "spaceId", "sessionId"],
				},
				{ name: "by_last_accessed", keyPath: "lastAccessedAt" },
				{ name: "by_updated_at", keyPath: "updatedAt" },
			]);
			createStore(db, "session_turns", [
				{ name: "by_user_space", keyPath: ["userKey", "spaceId"] },
				{
					name: "by_user_space_session",
					keyPath: ["userKey", "spaceId", "sessionId"],
				},
				{ name: "by_last_accessed", keyPath: "lastAccessedAt" },
			]);
			createStore(db, "session_generation_snapshots", [
				{ name: "by_user_space", keyPath: ["userKey", "spaceId"] },
				{
					name: "by_user_space_session",
					keyPath: ["userKey", "spaceId", "sessionId"],
				},
				{ name: "by_expires_at", keyPath: "expiresAt" },
				{ name: "by_updated_at", keyPath: "updatedAt" },
			]);
			createStore(db, "space_fs_dirs", [
				{ name: "by_user_space", keyPath: ["userKey", "spaceId"] },
				{
					name: "by_user_space_dir",
					keyPath: ["userKey", "spaceId", "dirPath"],
				},
				{ name: "by_last_accessed", keyPath: "lastAccessedAt" },
			]);
			createStore(db, "space_fs_epochs", [
				{ name: "by_user_space", keyPath: ["userKey", "spaceId"] },
				{ name: "by_updated_at", keyPath: "updatedAt" },
			]);
			createStore(db, "label_trees", [
				{ name: "by_user_space", keyPath: ["userKey", "spaceId"] },
				{ name: "by_last_accessed", keyPath: "lastAccessedAt" },
				{ name: "by_updated_at", keyPath: "updatedAt" },
			]);
			createStore(db, "label_items", [
				{ name: "by_user_space", keyPath: ["userKey", "spaceId"] },
				{
					name: "by_user_space_label",
					keyPath: ["userKey", "spaceId", "labelId"],
				},
				{ name: "by_last_accessed", keyPath: "lastAccessedAt" },
				{ name: "by_updated_at", keyPath: "updatedAt" },
			]);
			createStore(db, "resource_labels", [
				{ name: "by_user_space", keyPath: ["userKey", "spaceId"] },
				{
					name: "by_user_space_resource",
					keyPath: ["userKey", "spaceId", "resourceType", "resourceRef"],
				},
				{ name: "by_last_accessed", keyPath: "lastAccessedAt" },
			]);
			createStore(db, "user_profiles", [
				{ name: "by_user_uuid", keyPath: ["userKey", "userUuid"] },
				{ name: "by_last_accessed", keyPath: "lastAccessedAt" },
				{ name: "by_updated_at", keyPath: "updatedAt" },
			]);
			createStore(db, "file_pending_drafts", [
				{ name: "by_user_space", keyPath: ["userKey", "spaceId"] },
				{
					name: "by_user_space_path",
					keyPath: ["userKey", "spaceId", "path"],
				},
				{ name: "by_updated_at", keyPath: "updatedAt" },
			]);
			createStore(db, "board_pending_txs", [
				{ name: "by_user_space", keyPath: ["userKey", "spaceId"] },
				{
					name: "by_user_space_board",
					keyPath: ["userKey", "spaceId", "boardId"],
				},
				{ name: "by_created_at", keyPath: "createdAt" },
			]);
			createStore(db, "task_run_summaries", [
				{ name: "by_user_space", keyPath: ["userKey", "spaceId"] },
				{
					name: "by_user_space_session",
					keyPath: ["userKey", "spaceId", "sessionId"],
				},
				{
					name: "by_user_space_task",
					keyPath: ["userKey", "spaceId", "taskRunId"],
				},
				{ name: "by_last_accessed", keyPath: "lastAccessedAt" },
				{ name: "by_updated_at", keyPath: "updatedAt" },
			]);
			createStore(db, "session_files", [
				{ name: "by_user_space", keyPath: ["userKey", "spaceId"] },
				{ name: "by_last_accessed", keyPath: "lastAccessedAt" },
			]);
			createStore(db, "task_run_details", [
				{ name: "by_user_space", keyPath: ["userKey", "spaceId"] },
				{
					name: "by_user_space_session",
					keyPath: ["userKey", "spaceId", "sessionId"],
				},
				{
					name: "by_user_space_task",
					keyPath: ["userKey", "spaceId", "taskRunId"],
				},
				{ name: "by_last_accessed", keyPath: "lastAccessedAt" },
				{ name: "by_updated_at", keyPath: "updatedAt" },
			]);
		};
		request.onsuccess = () => {
			const db = request.result;
			// Another tab upgraded the schema; drop this connection so the next
			// open either upgrades or surfaces VersionError for recovery.
			db.onversionchange = () => resetDbConnection(db);
			dbConnection = db;
			clearOpenDegraded();
			clearVersionReloadAttempt();
			resolve(db);
		};
		request.onerror = () => {
			dbPromise = null;
			watchedOpenPromise = null;
			const error = request.error;
			if (isIdbVersionError(error)) {
				void recoverFromVersionMismatch(error).then(resolve, reject);
				return;
			}
			reject(error);
		};
	});
	// Share the catch-wrapped promise so all waiters (and late-open watch)
	// observe the same settle path and clear shared state on hard failure.
	const sharedOpen = openPromise.catch((error) => {
		if (dbPromise === sharedOpen) dbPromise = null;
		if (watchedOpenPromise === sharedOpen) watchedOpenPromise = null;
		if (!dbConnection) clearOpenDegraded();
		throw error;
	});
	dbPromise = sharedOpen;
	try {
		const db = await withTimeout(sharedOpen, "openCacheDb", idbOpenTimeoutMs);
		dbConnection = db;
		clearOpenDegraded();
		noteIdbSuccess();
		return db;
	} catch (error) {
		if (error instanceof CacheTimeoutError) {
			// Do not clear dbPromise on timeout — a late open can still be reused.
			watchInFlightOpen(sharedOpen);
			noteOpenTimedOut(error);
			return null;
		}
		noteIdbFailure(error, "openCacheDb");
		throw error;
	}
}

/** Test-only: reset module connection state between unit tests. */
export function __resetCacheDbStateForTests(options?: {
	opTimeoutMs?: number;
	openTimeoutMs?: number;
	openDegradedMs?: number;
	openLogThrottleMs?: number;
	storeOpLogThrottleMs?: number;
}) {
	dbConnection = null;
	dbPromise = null;
	watchedOpenPromise = null;
	openDegradedUntil = 0;
	lastOpenTimeoutLogAt = 0;
	lastStoreOpTimeoutLogAt = 0;
	recentIdbFailureAt = [];
	lastIdbRecoveryAt = 0;
	idbRecoveryInFlight = null;
	idbOpTimeoutMs = options?.opTimeoutMs ?? IDB_OP_TIMEOUT_MS;
	idbOpenTimeoutMs = options?.openTimeoutMs ?? IDB_OPEN_TIMEOUT_MS;
	idbOpenDegradedMs = options?.openDegradedMs ?? IDB_OPEN_DEGRADED_MS;
	idbOpenLogThrottleMs = options?.openLogThrottleMs ?? 60_000;
	idbStoreOpLogThrottleMs = options?.storeOpLogThrottleMs ?? 60_000;
}

export async function deleteCacheDatabase() {
	if (!isBrowser()) return;
	// Never wait forever on a hung open before delete — recovery must progress.
	const pending = dbPromise?.catch(() => null) ?? Promise.resolve(null);
	const db = await Promise.race([
		pending,
		new Promise<null>((resolve) => {
			setTimeout(() => resolve(null), Math.min(1_000, idbOpenTimeoutMs));
		}),
	]);
	resetDbConnection(db);
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.deleteDatabase(DB_NAME);
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
		request.onblocked = () => resolve();
	});
}

async function withObjectStore<T>(
	storeName: StoreName,
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore, tx: IDBTransaction) => Promise<T> | T,
	retry = true,
): Promise<T | null> {
	const label = `idb:${mode}:${storeName}`;
	// Open has its own budget. Do not fold it into the per-op timeout or first-paint
	// concurrent reads race open and false-timeout, then recovery wipes warm cache.
	const db = await openCacheDb();
	if (!db) return null;
	try {
		const result = await withTimeout(
			(async () => {
				try {
					const tx = db.transaction(storeName, mode);
					return await run(tx.objectStore(storeName), tx);
				} catch (error) {
					if (retry && isClosingConnectionError(error)) {
						resetDbConnection(db);
						return withObjectStore(storeName, mode, run, false);
					}
					throw error;
				}
			})(),
			label,
			idbOpTimeoutMs,
		);
		if (result !== null) noteIdbSuccess();
		return result;
	} catch (error) {
		noteIdbFailure(error, label);
		if (error instanceof CacheTimeoutError) {
			noteStoreOpTimedOut(label, error);
			return null;
		}
		throw error;
	}
}

export async function idbRunTransaction<T>(
	storeNames: StoreName[],
	mode: IDBTransactionMode,
	run: (
		getStore: (name: StoreName) => IDBObjectStore,
		tx: IDBTransaction,
	) => Promise<T> | T,
	retry = true,
): Promise<T | null> {
	const label = `idb:${mode}:${storeNames.join(",")}`;
	const db = await openCacheDb();
	if (!db) return null;
	try {
		const result = await withTimeout(
			(async () => {
				let tx: IDBTransaction;
				try {
					tx = db.transaction(storeNames, mode);
				} catch (error) {
					if (retry && isClosingConnectionError(error)) {
						resetDbConnection(db);
						return idbRunTransaction(storeNames, mode, run, false);
					}
					throw error;
				}
				const completed = awaitTransaction(tx);
				try {
					const value = await run((name) => tx.objectStore(name), tx);
					await completed;
					return value;
				} catch (error) {
					try {
						tx.abort();
					} catch {
						// Transaction may already be complete or aborted.
					}
					await completed.catch(() => undefined);
					throw error;
				}
			})(),
			label,
			idbOpTimeoutMs,
		);
		if (result !== null) noteIdbSuccess();
		return result;
	} catch (error) {
		noteIdbFailure(error, label);
		if (error instanceof CacheTimeoutError) {
			noteStoreOpTimedOut(label, error);
			return null;
		}
		throw error;
	}
}

function sanitizeForIndexedDb<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function awaitTransaction(tx: IDBTransaction) {
	return new Promise<void>((resolve, reject) => {
		// Aborted transactions only fire `onabort` (not always `onerror`). Without
		// this handler, callers can hang forever after a successful network fetch
		// while waiting to persist into IndexedDB.
		tx.oncomplete = () => resolve();
		tx.onerror = () =>
			reject(tx.error ?? new Error("IndexedDB transaction failed"));
		tx.onabort = () =>
			reject(tx.error ?? new Error("IndexedDB transaction aborted"));
	});
}

export async function idbGet<T>(storeName: StoreName, key: string) {
	return withObjectStore(storeName, "readonly", (store) => {
		return new Promise<T | null>((resolve, reject) => {
			const request = store.get(key);
			request.onsuccess = () =>
				resolve((request.result as T | undefined) ?? null);
			request.onerror = () => reject(request.error);
		});
	});
}

export async function idbPut<T>(storeName: StoreName, value: T) {
	await withObjectStore(storeName, "readwrite", async (store, tx) => {
		store.put(sanitizeForIndexedDb(value));
		await awaitTransaction(tx);
		return true;
	});
}

export async function idbDelete(storeName: StoreName, key: string) {
	await withObjectStore(storeName, "readwrite", async (store, tx) => {
		store.delete(key);
		await awaitTransaction(tx);
		return true;
	});
}

export async function idbGetAll<T>(storeName: StoreName) {
	return (
		(await withObjectStore(storeName, "readonly", (store) => {
			return new Promise<T[]>((resolve, reject) => {
				const request = store.getAll();
				request.onsuccess = () => resolve((request.result as T[]) ?? []);
				request.onerror = () => reject(request.error);
			});
		})) ?? []
	);
}

export async function idbGetAllByIndex<T>(
	storeName: StoreName,
	indexName: string,
	query: IDBValidKey | IDBKeyRange,
) {
	return (
		(await withObjectStore(storeName, "readonly", (store) => {
			return new Promise<T[]>((resolve, reject) => {
				const request = store.index(indexName).getAll(query);
				request.onsuccess = () => resolve((request.result as T[]) ?? []);
				request.onerror = () => reject(request.error);
			});
		})) ?? []
	);
}

export async function idbGetSomeByIndex<T>(
	storeName: StoreName,
	indexName: string,
	query: IDBValidKey | IDBKeyRange,
	options?: {
		limit?: number;
		direction?: IDBCursorDirection;
		filter?: (record: T) => boolean;
	},
) {
	const limit = Math.max(0, Math.trunc(options?.limit ?? 100));
	if (limit === 0) return [];
	return (
		(await withObjectStore(storeName, "readonly", (store) => {
			return new Promise<T[]>((resolve, reject) => {
				const results: T[] = [];
				const request = store
					.index(indexName)
					.openCursor(query, options?.direction ?? "next");
				request.onsuccess = () => {
					const cursor = request.result;
					if (!cursor || results.length >= limit) {
						resolve(results);
						return;
					}
					const record = cursor.value as T;
					if (!options?.filter || options.filter(record)) results.push(record);
					cursor.continue();
				};
				request.onerror = () => reject(request.error);
			});
		})) ?? []
	);
}

export async function idbDeleteWhere<T extends { key: string }>(
	storeName: StoreName,
	predicate: (record: T) => boolean,
) {
	await withObjectStore(storeName, "readwrite", async (store, tx) => {
		const request = store.openCursor();
		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) return;
			if (predicate(cursor.value as T)) cursor.delete();
			cursor.continue();
		};
		request.onerror = () => {
			// Surface via transaction error/abort handlers.
		};
		await awaitTransaction(tx);
		return true;
	});
}
