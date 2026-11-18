import type { BoardDocument, BoardPatch } from "@cohub/protocol";
import { deleteByIndex, indexedDb } from "../../indexeddb.js";
import type { BoardPendingPatch, BoardReplicaStorage } from "./index.js";

export type BoardReplicaScope = { userKey: string; boardId: string };

export type BoardReplicaDatabaseOptions = {
	database?: string;
};

type DocumentRecord = { board: string; userKey: string; version: number; document: BoardDocument; spaceId?: string };
type PendingRecord = { board: string; mutationId: string; userKey: string; order: number; patch: BoardPatch };

const DATABASE = "cohub-board";
const VERSION = 2;

function upgrade(db: IDBDatabase, tx: IDBTransaction, oldVersion: number) {
	if (oldVersion >= 1) {
		// Cached documents refill from the server; unsent edits are rekeyed, never dropped.
		tx.objectStore("documents").clear();
		const pending = tx.objectStore("pending");
		const read = pending.getAll();
		read.onsuccess = () => {
			pending.clear();
			for (const record of read.result as PendingRecord[]) pending.put({ ...record, board: withoutSpace(record.board) });
		};
		return;
	}
	const documents = db.createObjectStore("documents", { keyPath: "board" });
	documents.createIndex("user", "userKey");
	const pending = db.createObjectStore("pending", { keyPath: ["board", "mutationId"] });
	pending.createIndex("board", "board");
	pending.createIndex("user", "userKey");
}

function withoutSpace(board: string): string {
	try {
		const [userKey, , boardId] = JSON.parse(board) as string[];
		return JSON.stringify([userKey, boardId]);
	} catch {
		return board;
	}
}

const database = (name: string) => indexedDb(name, VERSION, upgrade);

let lastOrder = 0;

export function createIndexedDbBoardReplicaStorage(
	scope: BoardReplicaScope,
	options: BoardReplicaDatabaseOptions = {},
): BoardReplicaStorage {
	const { transact } = database(options.database ?? DATABASE);
	const board = JSON.stringify([scope.userKey, scope.boardId]);
	return {
		listPending: () =>
			transact(["pending"], "readonly", (tx) => {
				const request = tx.objectStore("pending").index("board").getAll(IDBKeyRange.only(board));
				return () =>
					(request.result as PendingRecord[])
						.sort((a, b) => a.order - b.order)
						.map(({ mutationId, patch }): BoardPendingPatch => ({ mutationId, patch }));
			}),
		putPending: ({ mutationId, patch }) =>
			transact(["pending"], "readwrite", (tx) => {
				lastOrder = Math.max(Date.now(), lastOrder + 1);
				const record: PendingRecord = { board, mutationId, userKey: scope.userKey, order: lastOrder, patch };
				tx.objectStore("pending").put(record);
				return () => undefined;
			}),
		deletePending: (mutationId) =>
			transact(["pending"], "readwrite", (tx) => {
				tx.objectStore("pending").delete([board, mutationId]);
				return () => undefined;
			}),
		readDocument: () =>
			transact(["documents"], "readonly", (tx) => {
				const request = tx.objectStore("documents").get(board);
				return () => {
					const record = request.result as DocumentRecord | undefined;
					return record ? { version: record.version, document: record.document, spaceId: record.spaceId } : null;
				};
			}),
		writeDocument: (version, document, spaceId) =>
			transact(["documents"], "readwrite", (tx) => {
				const store = tx.objectStore("documents");
				const request = store.get(board);
				request.onsuccess = () => {
					const current = request.result as DocumentRecord | undefined;
					if (current && current.version > version) return;
					const record: DocumentRecord = { board, userKey: scope.userKey, version, document, ...(spaceId ? { spaceId } : {}) };
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
	await database(options.database ?? DATABASE).transact(["documents", "pending"], "readwrite", (tx) => {
		for (const name of ["documents", "pending"]) {
			const store = tx.objectStore(name);
			if (userKey === undefined) store.clear();
			else deleteByIndex(store, "user", userKey);
		}
		return () => undefined;
	});
}
