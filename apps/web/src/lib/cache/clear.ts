import { clearFileUrlCache } from "@neta-art/cohub";
import { clearBoardReplicaStorage } from "@neta-art/cohub/board/replica";
import { deleteCacheDatabase } from "#lib/cache/db.ts";
import { clearModelStills } from "#lib/model3d/still-cache.ts";

export async function clearAllIndexedDbCache() {
	await Promise.all([
		deleteCacheDatabase(),
		clearBoardReplicaStorage(),
		clearFileUrlCache(),
		clearModelStills(),
	]);
}
