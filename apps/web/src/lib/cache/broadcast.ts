export type CacheBroadcastStore =
	| "space_records"
	| "space_lists"
	| "activity"
	| "session_lists"
	| "session_list_indexes"
	| "session_details"
	| "session_turns"
	| "space_fs_dirs"
	| "label_trees"
	| "label_items"
	| "resource_labels"
	| "user_profiles"
	| "palette_overview";

export type CacheBroadcastMessage = {
	type: "cache-updated" | "cache-deleted" | "cache-scope-invalidated";
	store: CacheBroadcastStore;
	key?: string;
	userKey: string;
	spaceId?: string;
	sessionId?: string;
	dirPath?: string;
	labelId?: string;
	resourceType?: string;
	resourceRef?: string;
	userUuid?: string;
	prefix?: string;
	epoch?: number;
	updatedAt: number;
};

const CHANNEL_NAME = "cohub-cache";
const STORAGE_PING_KEY = "cohub:cache-broadcast";
let channel: BroadcastChannel | null | undefined;
const listeners = new Set<(message: CacheBroadcastMessage) => void>();

function isBrowser() {
	return typeof window !== "undefined";
}

function getChannel() {
	if (!isBrowser()) return null;
	if (channel !== undefined) return channel;
	if (typeof BroadcastChannel === "undefined") {
		channel = null;
		return channel;
	}
	channel = new BroadcastChannel(CHANNEL_NAME);
	channel.onmessage = (event) => notify(event.data as CacheBroadcastMessage);
	return channel;
}

function notify(message: CacheBroadcastMessage) {
	for (const listener of listeners) listener(message);
}

export function publishCacheMessage(message: CacheBroadcastMessage) {
	if (!isBrowser()) return;
	getChannel()?.postMessage(message);
	try {
		window.localStorage.setItem(
			STORAGE_PING_KEY,
			JSON.stringify({ ...message, nonce: crypto.randomUUID() }),
		);
	} catch {
		// ignore fallback failures
	}
}

export function subscribeCacheMessages(
	listener: (message: CacheBroadcastMessage) => void,
) {
	if (!isBrowser()) return () => {};
	getChannel();
	listeners.add(listener);
	const onStorage = (event: StorageEvent) => {
		if (event.key !== STORAGE_PING_KEY || !event.newValue) return;
		try {
			const parsed = JSON.parse(event.newValue) as CacheBroadcastMessage;
			listener(parsed);
		} catch {
			// ignore malformed pings
		}
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(listener);
		window.removeEventListener("storage", onStorage);
	};
}
