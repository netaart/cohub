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

type Entry = { replica: BoardReplica; boardKey: string; refs: number };

const shared = new WeakMap<HttpTransport, Map<string, Entry>>();

export function leaseBoardReplica(
	http: HttpTransport,
	spaceId: string,
	boardId: string,
	remote: BoardRemote,
	options: BoardReplicaLeaseOptions,
): BoardReplicaLease {
	const entries = shared.get(http) ?? new Map<string, Entry>();
	shared.set(http, entries);
	const boardKey = `${spaceId}:${boardId}`;
	const key = JSON.stringify([boardKey, options.readonly === true, options.userKey ?? null]);
	let entry = entries.get(key);
	if (!entry) {
		const storage =
			options.userKey !== undefined && globalThis.indexedDB
				? createIndexedDbBoardReplicaStorage({ userKey: options.userKey, spaceId, boardId })
				: undefined;
		const replica = createBoardReplica({
			remote,
			...(storage ? { storage } : {}),
			...(options.readonly ? { readonly: true } : {}),
			...(options.clientId ? { clientId: options.clientId } : {}),
		});
		entry = { replica, boardKey, refs: 0 };
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

export function shareBoardPlayback(http: HttpTransport, spaceId: string, boardId: string, playback: BoardPlaybackSnapshot | null) {
	const boardKey = `${spaceId}:${boardId}`;
	for (const entry of shared.get(http)?.values() ?? []) if (entry.boardKey === boardKey) entry.replica.receivePlayback(playback);
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
