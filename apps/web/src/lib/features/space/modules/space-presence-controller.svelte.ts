import type { SpacePresenceSnapshot, SpacePresenceUser } from "@neta-art/cohub";
import { sdk } from "#lib/sdk.ts";
import { arePresenceUsersEqual } from "./space-presence-equality.ts";

const sortPresenceUsers = (users: SpacePresenceUser[]) =>
	[...users].sort(
		(a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt),
	);

const isPresenceSnapshot = (value: unknown): value is SpacePresenceSnapshot => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const snapshot = value as {
		users?: unknown;
		spaceId?: unknown;
		updatedAt?: unknown;
	};
	return (
		typeof snapshot.spaceId === "string" &&
		typeof snapshot.updatedAt === "string" &&
		Array.isArray(snapshot.users)
	);
};

export function createSpacePresenceController(getSpaceId: () => string) {
	let users = $state<SpacePresenceUser[]>([]);
	let loading = $state(false);
	let loaded = $state(false);
	let activeSpaceId = "";
	let currentMeta: Record<string, unknown> | null = null;
	let currentMetaKey = "";
	let disposeRealtime: (() => void) | null = null;
	let loadSeq = 0;
	let started = false;

	function applySnapshot(snapshot: SpacePresenceSnapshot) {
		if (snapshot.spaceId !== activeSpaceId) return;
		const nextUsers = sortPresenceUsers(snapshot.users);
		// Busy spaces push full presence tables often; skip no-op UI writes.
		if (!arePresenceUsersEqual(users, nextUsers)) {
			users = nextUsers;
		}
		loaded = true;
	}

	async function load() {
		const spaceId = activeSpaceId;
		if (!spaceId) return;
		const seq = ++loadSeq;
		loading = true;
		try {
			const snapshot = await sdk.space(spaceId).presence.get();
			if (seq === loadSeq) applySnapshot(snapshot);
		} catch (error) {
			console.warn("[Presence] failed to load space presence", error);
		} finally {
			if (seq === loadSeq) loading = false;
		}
	}

	function stopSubscription() {
		disposeRealtime?.();
		disposeRealtime = null;
		loadSeq += 1;
		loading = false;
	}

	function startSubscription(spaceId: string) {
		activeSpaceId = spaceId;
		users = [];
		loaded = false;
		if (!spaceId) return;
		void load();
		void sdk
			.space(spaceId)
			.updatePresence(currentMeta)
			.catch((error) => {
				console.warn("[Presence] failed to update space presence", error);
			});
		disposeRealtime = sdk.space(spaceId).on("presence.updated", (event) => {
			if (isPresenceSnapshot(event.payload)) applySnapshot(event.payload);
		});
	}

	function syncSpace() {
		const nextSpaceId = getSpaceId();
		if (nextSpaceId === activeSpaceId) return;
		stopSubscription();
		if (started) startSubscription(nextSpaceId);
	}

	function updateMeta(meta: Record<string, unknown> | null) {
		const nextKey = JSON.stringify(meta ?? null);
		if (nextKey === currentMetaKey) return;
		currentMeta = meta;
		currentMetaKey = nextKey;
		if (!started || !activeSpaceId) return;
		void sdk
			.space(activeSpaceId)
			.updatePresence(meta)
			.catch((error) => {
				console.warn("[Presence] failed to update space presence", error);
			});
	}

	function start() {
		if (started) return;
		started = true;
		startSubscription(getSpaceId());
	}

	function dispose() {
		started = false;
		stopSubscription();
		activeSpaceId = "";
		users = [];
		loaded = false;
	}

	return {
		get users() {
			return users;
		},
		get loading() {
			return loading;
		},
		get loaded() {
			return loaded;
		},
		load,
		start,
		syncSpace,
		updateMeta,
		dispose,
	};
}
