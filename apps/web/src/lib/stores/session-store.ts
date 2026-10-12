import type { SessionRecord } from "@neta-art/cohub";
import { canUseUserScopedCache } from "$lib/cache/keys";
import { sessionDetailRepo } from "$lib/cache/repositories/session-detail-repo";
import { userProfilesRepo } from "$lib/cache/repositories/user-profiles-repo";
import { sdk } from "$lib/sdk";
import type { SessionRecordInput } from "$lib/session-record-merge";
import { SessionStore } from "$lib/session-store";
import { readSessionTurnState } from "$lib/session-turn-state";
import { authStore } from "$lib/stores/auth.svelte";

export const sessionStore = new SessionStore({
	async save(records) {
		if (!canUseUserScopedCache()) return;
		const bySpace = new Map<string, SessionRecord[]>();
		for (const record of records) {
			const list = bySpace.get(record.spaceId);
			if (list) list.push(record);
			else bySpace.set(record.spaceId, [record]);
		}
		await Promise.all(
			[...bySpace].map(([spaceId, list]) =>
				sessionDetailRepo.setMany(spaceId, list),
			),
		);
	},
	async find(sessionId) {
		if (!canUseUserScopedCache()) return null;
		return (await sessionDetailRepo.find(sessionId))?.session ?? null;
	},
	async findMany(spaceId, sessionIds) {
		if (!canUseUserScopedCache()) return [];
		const snapshots = await sessionDetailRepo.getMany(spaceId, sessionIds);
		return Object.values(snapshots).map((snapshot) => snapshot.session);
	},
});

type Profile = NonNullable<SessionRecord["userProfile"]>;

function knownProfile(userUuid: string): Profile | null {
	const self = authStore.profile;
	if (self && userUuid === authStore.userUuid)
		return {
			userUuid,
			username: self.username,
			displayName: self.displayName,
			avatarUrl: self.avatarUrl,
		};
	return userProfilesRepo.getSync(userUuid);
}

async function completeProfiles(sessionId: string) {
	const session = sessionStore.get(sessionId);
	if (!session) return;
	const shown = profilesOf(session);
	const missing = membersOf(session).filter(
		(uuid) => !shown.some((profile) => profile.userUuid === uuid),
	);
	if (missing.length === 0) return;
	await userProfilesRepo
		.hydrate(missing.filter((uuid) => !knownProfile(uuid)))
		.catch(() => undefined);
	const current = sessionStore.get(sessionId);
	if (!current) return;
	const profileOf = (uuid: string) =>
		profilesOf(current).find((profile) => profile.userUuid === uuid) ??
		knownProfile(uuid);
	// A partial fill would read as complete; leave gaps to the server.
	if (!membersOf(current).every(profileOf)) return;
	sessionStore.merge({
		...current,
		userProfile: current.userUuid ? profileOf(current.userUuid) : null,
		participantProfiles: (current.participantUserUuids ?? []).flatMap(
			(uuid) => profileOf(uuid) ?? [],
		),
	});
}

function profilesOf(session: SessionRecord): Profile[] {
	return [session.userProfile, ...(session.participantProfiles ?? [])].filter(
		(profile): profile is Profile => Boolean(profile),
	);
}

function membersOf(session: SessionRecord) {
	const uuids = [session.userUuid, ...(session.participantUserUuids ?? [])];
	return [...new Set(uuids)].filter((uuid): uuid is string => Boolean(uuid));
}

let holders = 0;
let stopSync: (() => void) | null = null;

export function startSessionSync(): () => void {
	holders += 1;
	stopSync ??= connect();
	let released = false;
	return () => {
		if (released) return;
		released = true;
		holders -= 1;
		if (holders > 0) return;
		stopSync?.();
		stopSync = null;
	};
}

function connect() {
	const offEvents = sdk.onUserEvent((event) => {
		const turn = readSessionTurnState(event);
		if (turn) {
			sessionStore.applyTurn(turn);
			return;
		}
		if (event.type !== "session.created" && event.type !== "session.updated")
			return;
		const record = (event.payload as { session?: SessionRecordInput }).session;
		if (!record?.id || !record.spaceId) return;
		void sessionStore
			.applyRecord(record)
			.then(() => completeProfiles(record.id))
			.catch((error: unknown) =>
				console.warn("[session-store] realtime record failed", error),
			);
	});
	const offRemote = sessionDetailRepo.onRemote((session) =>
		sessionStore.mergeRemote(session),
	);
	const flush = () => void sessionStore.flush();
	const onVisibility = () => {
		if (document.visibilityState === "hidden") flush();
	};
	window.addEventListener("pagehide", flush);
	document.addEventListener("visibilitychange", onVisibility);
	return () => {
		offEvents();
		offRemote();
		window.removeEventListener("pagehide", flush);
		document.removeEventListener("visibilitychange", onVisibility);
		flush();
	};
}
