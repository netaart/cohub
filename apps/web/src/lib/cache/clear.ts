import { clearBoardReplicaStorage } from "@neta-art/cohub/board/replica";
import { deleteCacheDatabase } from "$lib/cache/db";

export async function clearAllIndexedDbCache() {
	await Promise.all([deleteCacheDatabase(), clearBoardReplicaStorage()]);
}
