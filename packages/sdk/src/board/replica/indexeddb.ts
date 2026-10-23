import type { BoardDocument, BoardPatch } from "@cohub/protocol";
import type { BoardPendingPatch, BoardReplicaStorage } from "./index.js";

export type BoardReplicaScope = { userKey: string; spaceId: string; boardId: string };

export type BoardReplicaDatabaseOptions = {
	database?: string;
};

type DocumentRecord = { board: string; userKey: string; version: number; document: BoardDocument };
type PendingRecord = { board: string; mutationId: string; userKey: string; order: number; patch: BoardPatch };

const DATABASE = "cohub-board";
const VERSION = 1;
const OPEN_TIMEOUT_MS = 3000;

const connections = new Map<string, Promise<IDBDatabase>>();

function open(name: string): Promise<IDBDatabase> {
	const existing = connections.get(name);
	if (existing) return existing;
	const opening = new Promise<IDBDatabase>((resolve, reject) => {
		const factory = globalThis.indexedDB;
		if (!factory) {
			reject(new Error("IndexedDB is unavailable."));
			return;
		}
		let late = false;
		const timer = setTimeout(() => {
			late = true;
			reject(new Error("IndexedDB did not open in time."));
		}, OPEN_TIMEOUT_MS);
		const request = factory.open(name, VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			const documents = db.createObjectStore("documents", { keyPath: "board" });
			documents.createIndex("user", "userKey");
			const pending = db.createObjectStore("pending", { keyPath: ["board", "mutationId"] });
			pending.createIndex("board", "board");
			pending.createIndex("user", "userKey");
		};
		request.onsuccess = () => {
			clearTimeout(timer);
			const db = request.result;
			if (late) {
				db.close();
				return;
			}
			const forget = () => {
				if (connections.get(name) === opening) connections.delete(name);
			};
			db.onversionchange = () => {
				db.close();
				forget();
			};
			db.onclose = forget;
			resolve(db);
		};
		request.onerror = () => {
			clearTimeout(timer);
			reject(request.error ?? new Error("IndexedDB failed to open."));
		};
	});
	connections.set(name, opening);
	opening.catch(() => {
		if (connections.get(name) === opening) connections.delete(name);
	});
	return opening;
}

async function transact<T>(
	name: string,
	stores: string[],
	mode: IDBTransactionMode,
	work: (tx: IDBTransaction) => () => T,
	retry = true,
): Promise<T> {
	const db = await open(name);
	let tx: IDBTransaction;
	try {
		tx = db.transaction(stores, mode);
	} catch (error) {
		if (!retry) throw error;
		db.close();
		connections.delete(name);
		return transact(name, stores, mode, work, false);
	}
	return new Promise<T>((resolve, reject) => {
		const result = work(tx);
		tx.oncomplete = () => resolve(result());
		tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
		tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
	});
}

function deleteByIndex(store: IDBObjectStore, index: string, key: IDBValidKey) {
	const request = store.index(index).openKeyCursor(IDBKeyRange.only(key));
	request.onsuccess = () => {
		const cursor = request.result;
		if (!cursor) return;
		store.delete(cursor.primaryKey);
		cursor.continue();
	};
}

let lastOrder = 0;

export function createIndexedDbBoardReplicaStorage(
	scope: BoardReplicaScope,
	options: BoardReplicaDatabaseOptions = {},
): BoardReplicaStorage {
	const name = options.database ?? DATABASE;
	const board = JSON.stringify([scope.userKey, scope.spaceId, scope.boardId]);
	return {
		listPending: () =>
			transact(name, ["pending"], "readonly", (tx) => {
				const request = tx.objectStore("pending").index("board").getAll(IDBKeyRange.only(board));
				return () =>
					(request.result as PendingRecord[])
						.sort((a, b) => a.order - b.order)
						.map(({ mutationId, patch }): BoardPendingPatch => ({ mutationId, patch }));
			}),
		putPending: ({ mutationId, patch }) =>
			transact(name, ["pending"], "readwrite", (tx) => {
				lastOrder = Math.max(Date.now(), lastOrder + 1);
				const record: PendingRecord = { board, mutationId, userKey: scope.userKey, order: lastOrder, patch };
				tx.objectStore("pending").put(record);
				return () => undefined;
			}),
		deletePending: (mutationId) =>
			transact(name, ["pending"], "readwrite", (tx) => {
				tx.objectStore("pending").delete([board, mutationId]);
				return () => undefined;
			}),
		readDocument: () =>
			transact(name, ["documents"], "readonly", (tx) => {
				const request = tx.objectStore("documents").get(board);
				return () => {
					const record = request.result as DocumentRecord | undefined;
					return record ? { version: record.version, document: record.document } : null;
				};
			}),
		writeDocument: (version, document) =>
			transact(name, ["documents"], "readwrite", (tx) => {
				const store = tx.objectStore("documents");
				const request = store.get(board);
				request.onsuccess = () => {
					const current = request.result as DocumentRecord | undefined;
					if (current && current.version > version) return;
					const record: DocumentRecord = { board, userKey: scope.userKey, version, document };
					store.put(record);
				};
				return () => undefined;
			}),
	};
}

export async function clearBoardReplicaStorage(
	options: BoardReplicaDatabaseOptions & { userKey?: string } = {},
): Promise<void> {
	const { userKey } = options;
	await transact(options.database ?? DATABASE, ["documents", "pending"], "readwrite", (tx) => {
		for (const name of ["documents", "pending"]) {
			const store = tx.objectStore(name);
			if (userKey === undefined) store.clear();
			else deleteByIndex(store, "user", userKey);
		}
		return () => undefined;
	});
}
