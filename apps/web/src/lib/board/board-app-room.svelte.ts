import { BoardAwarenessUpdateSchema } from "@cohub/protocol/realtime";
import type { AppRoom, AppRoomEvent } from "@neta-art/cohub";
import type {
	BoardPresenceChannel,
	BoardPresencePayload,
} from "@neta-art/cohub/board/presence";
import type { BoardCollaboratorProfile } from "$lib/board/board-collaborator";
import { sdk } from "$lib/sdk";

const EVENT = "board.awareness";
const ROOM = { maxParticipants: 128, expiresInSeconds: 24 * 60 * 60 };
const RETRY_MS = [2_000, 5_000, 15_000, 60_000];
const JOIN_DELAY_MS = 1_000;

type Profile = { name: string };

export type BoardRoomChannel = BoardPresenceChannel & {
	readonly profiles: ReadonlyMap<string, BoardCollaboratorProfile>;
};

export function createBoardAppRoom(input: {
	appId: string;
	versionId: string;
	profile: () => Profile;
}): BoardRoomChannel & { destroy(): void } {
	let room: AppRoom<Record<string, unknown>> | null = null;
	let destroyed = false;
	let attempt = 0;
	let retry: ReturnType<typeof setTimeout> | null = null;
	let stops: Array<() => void> = [];
	let profiles = $state.raw<ReadonlyMap<string, BoardCollaboratorProfile>>(
		new Map(),
	);
	const receivers = new Set<(payload: BoardPresencePayload) => void>();
	let seq = 0;

	function readProfiles(current: AppRoom<Record<string, unknown>>) {
		const next = new Map<string, BoardCollaboratorProfile>();
		for (const member of current.members) {
			const presence = member.presence;
			const name = typeof presence?.name === "string" ? presence.name : "";
			if (!member.userKey || !name) continue;
			next.set(member.userKey, {
				userId: member.userKey,
				displayName: name.slice(0, 80),
				avatarUrl: null,
			});
		}
		profiles = next;
	}

	function deliver(
		current: AppRoom<Record<string, unknown>>,
		event: AppRoomEvent<unknown>,
	) {
		if (event.self) return;
		const member = current.members.find(
			(candidate) => candidate.participantId === event.sender.participantId,
		);
		// The viewer's other tabs share their userKey: never draw them as someone else.
		if (!member?.userKey || member.userKey === current.userKey) return;
		const data = event.data as { seq?: unknown; update?: unknown } | null;
		const parsed = BoardAwarenessUpdateSchema.safeParse(data?.update);
		const seq = data?.seq;
		if (
			!parsed.success ||
			typeof seq !== "number" ||
			!Number.isSafeInteger(seq)
		)
			return;
		const update = parsed.data;
		if (
			update.type !== "state" &&
			update.type !== "reaction" &&
			update.type !== "script"
		)
			return;
		const payload: BoardPresencePayload = {
			connectionId: member.participantId,
			actorId: member.userKey,
			actorName: profiles.get(member.userKey)?.displayName ?? "",
			seq,
			update,
		};
		for (const receive of receivers) receive(payload);
	}

	function scheduleRetry() {
		const delay = RETRY_MS[attempt];
		if (destroyed || retry || delay === undefined) return;
		attempt += 1;
		retry = setTimeout(() => {
			retry = null;
			void connect();
		}, delay);
	}

	function release() {
		for (const stop of stops) stop();
		stops = [];
		const current = room;
		room = null;
		profiles = new Map();
		void current?.disconnect().catch(() => undefined);
	}

	async function connect() {
		if (destroyed || room) return;
		let joined: AppRoom<Record<string, unknown>>;
		try {
			joined = await sdk.rooms.open({
				appId: input.appId,
				code: `BOARD-${input.versionId.replaceAll("-", "").toUpperCase()}`,
				create: ROOM,
			});
		} catch {
			scheduleRetry();
			return;
		}
		if (destroyed) {
			void joined.disconnect().catch(() => undefined);
			return;
		}
		room = joined;
		attempt = 0;
		stops = [
			joined.subscribe(EVENT, (event) => deliver(joined, event)),
			joined.onMembersChanged(() => readProfiles(joined)),
			joined.onStateChange((state) => {
				if (state !== "expired" && state !== "closed") return;
				release();
				scheduleRetry();
			}),
		];
		readProfiles(joined);
		void joined.setPresence(input.profile()).catch(() => undefined);
	}

	retry = setTimeout(() => {
		retry = null;
		void connect();
	}, JOIN_DELAY_MS);

	return {
		get profiles() {
			return profiles;
		},
		async updateAwareness(update) {
			if (room?.state !== "joined") return;
			seq += 1;
			if (update.type === "state")
				room.send(EVENT, {
					seq,
					update: {
						...update,
						tool: "play",
						selection: { ids: [], count: 0, bounds: null },
						editingId: null,
					},
				});
			else if (update.type === "reaction" || update.type === "script")
				room.send(EVENT, { seq, update });
		},
		subscribe({ awareness }) {
			if (!awareness) return () => undefined;
			const receive = (payload: BoardPresencePayload) => awareness({ payload });
			receivers.add(receive);
			return () => receivers.delete(receive);
		},
		destroy() {
			destroyed = true;
			if (retry) clearTimeout(retry);
			retry = null;
			receivers.clear();
			release();
		},
	};
}

const NO_PROFILES: ReadonlyMap<string, BoardCollaboratorProfile> = new Map();

export function createBoardRoomRelay(): BoardRoomChannel & {
	use(room: BoardRoomChannel | null): void;
} {
	let room = $state.raw<BoardRoomChannel | null>(null);
	type Handlers = Parameters<BoardPresenceChannel["subscribe"]>[0];
	const subscribers = new Map<Handlers, () => void>();
	return {
		get profiles() {
			return room?.profiles ?? NO_PROFILES;
		},
		updateAwareness: (update) =>
			room ? room.updateAwareness(update) : Promise.resolve(),
		subscribe(handlers) {
			subscribers.set(handlers, room?.subscribe(handlers) ?? (() => {}));
			return () => {
				subscribers.get(handlers)?.();
				subscribers.delete(handlers);
			};
		},
		use(next) {
			room = next;
			for (const [handlers, stop] of subscribers) {
				stop();
				subscribers.set(handlers, next?.subscribe(handlers) ?? (() => {}));
				handlers.resync?.();
			}
		},
	};
}
