const OPEN_TIMEOUT_MS = 3000;

export type IndexedDbWork<T> = (tx: IDBTransaction) => () => T;

export type IndexedDb = {
	transact: <T>(stores: string[], mode: IDBTransactionMode, work: IndexedDbWork<T>) => Promise<T>;
};

const connections = new Map<string, Promise<IDBDatabase>>();

export type IndexedDbUpgrade = (db: IDBDatabase, tx: IDBTransaction, oldVersion: number) => void;

function open(name: string, version: number, upgrade: IndexedDbUpgrade): Promise<IDBDatabase> {
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
		const request = factory.open(name, version);
		request.onupgradeneeded = (event) => upgrade(request.result, request.transaction as IDBTransaction, event.oldVersion);
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

export function indexedDb(name: string, version: number, upgrade: IndexedDbUpgrade): IndexedDb {
	async function transact<T>(stores: string[], mode: IDBTransactionMode, work: IndexedDbWork<T>, retry = true): Promise<T> {
		const db = await open(name, version, upgrade);
		let tx: IDBTransaction;
		try {
			tx = db.transaction(stores, mode);
		} catch (error) {
			if (!retry) throw error;
			db.close();
			connections.delete(name);
			return transact(stores, mode, work, false);
		}
		return new Promise<T>((resolve, reject) => {
			const result = work(tx);
			tx.oncomplete = () => resolve(result());
			tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
			tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
		});
	}
	return { transact: (stores, mode, work) => transact(stores, mode, work) };
}

export function deleteByIndex(store: IDBObjectStore, index: string, key: IDBValidKey) {
	const request = store.index(index).openKeyCursor(IDBKeyRange.only(key));
	request.onsuccess = () => {
		const cursor = request.result;
		if (!cursor) return;
		store.delete(cursor.primaryKey);
		cursor.continue();
	};
}
