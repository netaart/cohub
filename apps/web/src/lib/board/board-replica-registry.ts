import type { BoardPlaybackCommand } from "@cohub/protocol";
import {
	type BoardReplica,
	type BoardReplicaStorage,
	createBoardReplica,
	createIndexedDbBoardReplicaStorage,
} from "@neta-art/cohub/board/replica";
import { getCacheUserKeyAsync } from "$lib/cache/keys";
import { sdk } from "$lib/sdk";

function boardReplicaStorage(
	spaceId: string,
	boardId: string,
): BoardReplicaStorage {
	const ready = getCacheUserKeyAsync().then((userKey) =>
		createIndexedDbBoardReplicaStorage({ userKey, spaceId, boardId }),
	);
	return {
		listPending: () => ready.then((storage) => storage.listPending()),
		putPending: (entry) => ready.then((storage) => storage.putPending(entry)),
		deletePending: (id) => ready.then((storage) => storage.deletePending(id)),
		readDocument: () => ready.then((storage) => storage.readDocument()),
		writeDocument: (version, document) =>
			ready.then((storage) => storage.writeDocument(version, document)),
	};
}

const entries = new Map<string, { replica: BoardReplica; refs: number }>();

/** Every view of a Board shares one replica, so its pending writes have one writer. */
export function acquireBoardReplica(spaceId: string, boardId: string) {
	const key = `${spaceId}:${boardId}`;
	let entry = entries.get(key);
	if (!entry) {
		const replica = createBoardReplica({
			remote: sdk.space(spaceId).board(boardId),
			storage: boardReplicaStorage(spaceId, boardId),
		});
		entry = { replica, refs: 0 };
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

export async function playBoardReplica(
	spaceId: string,
	boardId: string,
	command: BoardPlaybackCommand,
) {
	const board = sdk.space(spaceId).board(boardId);
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
	entries.get(`${spaceId}:${boardId}`)?.replica.receivePlayback(playback);
	return playback;
}
