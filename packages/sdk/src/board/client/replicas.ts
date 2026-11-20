import type { BoardPlaybackSnapshot } from "@cohub/protocol";
import type { HttpTransport } from "../../transport.js";
import {
	type BoardRemote,
	type BoardReplica,
	clearBoardReplicaStorage,
	createBoardReplica,
	createIndexedDbBoardReplicaStorage,
} from "../replica/index.js";
import { clearFileUrlCache } from "../../apis/space-file-url-store.js";

export type BoardReplicaLeaseOptions = {
	userKey?: string;
	readonly?: boolean;
	clientId?: string;
};

export type BoardReplicaLease = { replica: BoardReplica; release(): void };

type Entry = { replica: BoardReplica; boardId: string; refs: number };

const shared = new WeakMap<HttpTransport, Map<string, Entry>>();

export function leaseBoardReplica(
	http: HttpTransport,
	boardId: string,
	remote: BoardRemote,
	options: BoardReplicaLeaseOptions,
): BoardReplicaLease {
	const entries = shared.get(http) ?? new Map<string, Entry>();
	shared.set(http, entries);
	const key = JSON.stringify([boardId, options.readonly === true, options.userKey ?? null]);
	let entry = entries.get(key);
	if (!entry) {
		const storage =
			options.userKey !== undefined && globalThis.indexedDB
				? createIndexedDbBoardReplicaStorage({ userKey: options.userKey, boardId })
				: undefined;
		const replica = createBoardReplica({
			remote,
			...(storage ? { storage } : {}),
			...(options.readonly ? { readonly: true } : {}),
			...(options.clientId ? { clientId: options.clientId } : {}),
		});
		entry = { replica, boardId, refs: 0 };
		entries.set(key, entry);
		void replica.start();
	}
	entry.refs += 1;
	const held = entry;
	let released = false;
	return {
		replica: held.replica,
		release() {
			if (released) return;
			released = true;
			held.refs -= 1;
			if (held.refs > 0 || entries.get(key) !== held) return;
			entries.delete(key);
			held.replica.dispose();
		},
	};
}

export function captureBoardPlaybackResponse(http: HttpTransport, boardId: string) {
	const receivers = new Map<Entry, (playback: BoardPlaybackSnapshot | null) => void>();
	const entries = () => shared.get(http)?.values() ?? [];
	for (const entry of entries()) {
		if (entry.boardId === boardId) receivers.set(entry, entry.replica.capturePlaybackResponse());
	}
	return (playback: BoardPlaybackSnapshot | null) => {
		for (const entry of entries()) {
			if (entry.boardId !== boardId) continue;
			const receive = receivers.get(entry);
			if (receive) receive(playback);
			else void entry.replica.refresh();
		}
	};
}

const OWNER_KEY = "cohub:board-cache-owner";

export async function claimBoardCaches(userKey: string, storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage) {
	let previous: string | null;
	try {
		previous = storage?.getItem(OWNER_KEY) ?? null;
		storage?.setItem(OWNER_KEY, userKey);
	} catch {
		return;
	}
	if (!previous || previous === userKey) return;
	await Promise.all([clearBoardReplicaStorage({ userKey: previous }), clearFileUrlCache()]).catch(() => undefined);
}
