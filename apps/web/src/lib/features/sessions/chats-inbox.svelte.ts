import {
	type ChannelEnvelope,
	isSessionInitiator,
	type SessionRecord,
	type SpaceRecord,
	type UserSessionListItem,
	type UserSessionSpaceSummary,
} from "@neta-art/cohub";
import { untrack } from "svelte";
import { resolveSpaceEntryRoute } from "#lib/app-entry.ts";
import type { SessionListForkRecord } from "#lib/cache/db.ts";
import { getCacheUserKeyAsync } from "#lib/cache/keys.ts";
import { openCommandPalette } from "#lib/command-palette/open.ts";
import { subscribeSpaceChannel } from "#lib/features/session-chat/index.ts";
import { nextSpaceChips } from "#lib/features/sessions/space-chips.ts";
import { spacesInbox } from "#lib/features/spaces/spaces-inbox.svelte.ts";
import { type LiveChange, LiveList } from "#lib/lists/live-list.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import { sdk } from "#lib/sdk.ts";
import {
	mergeSessionForks,
	readRealtimeSessionFork,
} from "#lib/session-fork-tree.ts";
import { mergeSessionRecord } from "#lib/session-record-merge.ts";
import { compareSessionsByRecentActivity } from "#lib/session-sort.ts";
import { getSpacePublicProfile } from "#lib/space-profile.ts";
import { buildUserNewSessionRoute } from "#lib/space-routes.ts";
import { authStore } from "#lib/stores/auth.svelte.ts";
import {
	type ChatsFilter,
	type ChatsKind,
	chatsFilterScope,
	chatsKindSystemKey,
	DEFAULT_CHATS_FILTER,
	readChatsFilter,
	type SessionEventRecord,
	sameChatsFilter,
	sessionFit,
	writeChatsFilter,
} from "#lib/stores/chats-filter.ts";
import { getRecentSpaces } from "#lib/stores/recent-space.ts";
import { findCachedSession } from "#lib/stores/session-detail-cache.ts";
import {
	getCachedSessionListSnapshot,
	setCachedSessionList,
} from "#lib/stores/session-list-cache.ts";
import { sessionStore, startSessionSync } from "#lib/stores/session-store.ts";
import {
	fetchLabelItemsFirstPageFresh,
	fetchSpaceLabels,
	flattenLabelsWithRefs,
	getCachedLabelItemsSnapshot,
	getCachedSpaceLabelsSnapshot,
} from "#lib/stores/space-labels.ts";
import { getCachedSpaceList } from "#lib/stores/space-list-cache.ts";
import { getCachedSpaceRecord } from "#lib/stores/space-record-cache.ts";
import {
	getCachedUserSessionListSnapshot,
	setCachedUserSessionList,
} from "#lib/stores/user-session-list-cache.ts";
import { goto } from "$app/navigation";

const PAGE_SIZE = 30;
const MEMO_LIMIT = 12;
const EMPTY_PAGE_INFO = { hasMore: false, nextCursor: null };

type Forks = SessionListForkRecord[];

export type ChatsView = {
	readonly sessions: UserSessionListItem[];
	readonly forks: Forks;
	readonly loading: boolean;
	readonly loadingMore: boolean;
	readonly error: string | null;
};

function withSpace(
	sessions: readonly SessionRecord[],
	space: UserSessionSpaceSummary,
): UserSessionListItem[] {
	return sessions.map((session) => ({ ...session, space }));
}

function sameInboxRow(row: UserSessionListItem, session: SessionRecord) {
	return (
		row.title === session.title &&
		row.updatedAt === session.updatedAt &&
		row.lastMessageId === session.lastMessageId
	);
}

function sessionOf({ space: _space, ...session }: UserSessionListItem) {
	return session as SessionRecord;
}

const liveRows = new WeakMap<
	UserSessionListItem,
	{ session: SessionRecord; row: UserSessionListItem }
>();

function liveRow(row: UserSessionListItem): UserSessionListItem {
	const session = sessionStore.get(row.id);
	if (!session) return row;
	const cached = liveRows.get(row);
	if (cached?.session === session) return cached.row;
	const live = { ...session, space: row.space } as UserSessionListItem;
	liveRows.set(row, { session, row: live });
	return live;
}

export function spaceSummaryOf(space: SpaceRecord): UserSessionSpaceSummary {
	return {
		id: space.id,
		name: space.name?.trim() || space.title?.trim() || m.spaces_default_name(),
		slug: space.slug ?? null,
		publicProfile: getSpacePublicProfile(space),
	};
}

function readSessionRecord(value: unknown): SessionEventRecord | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.id !== "string" || typeof record.spaceId !== "string")
		return null;
	return record as SessionEventRecord;
}

function isFullRecord(
	record: SessionEventRecord,
): record is SessionEventRecord & Omit<SessionRecord, "meta"> {
	return (
		"title" in record && "lastMessageAt" in record && "createdAt" in record
	);
}

class ChatsInbox {
	filter = $state<ChatsFilter>(DEFAULT_CHATS_FILTER);
	recentSpaces = $state.raw<UserSessionSpaceSummary[]>([]);

	readonly list = new LiveList<ChatsFilter, UserSessionListItem, Forks>({
		name: "chats",
		pageSize: PAGE_SIZE,
		memoLimit: MEMO_LIMIT,
		key: chatsFilterScope,
		id: (session) => session.id,
		compare: () => compareSessionsByRecentActivity,
		emptyExtra: () => [],
		mergeExtra: mergeSessionForks,
		fetch: async (filter, cursor) => {
			const page = await this.#fetchPage(filter, cursor);
			sessionStore.mergeAll(page.sessions.map(sessionOf));
			return {
				items: page.sessions.filter(
					(row) => Boolean(row.archivedAt) === filter.archived,
				),
				hasMore: page.pageInfo.hasMore,
				cursor: page.pageInfo.nextCursor,
				extra: page.forks,
			};
		},
		read: async (filter) => {
			const cached = await this.#readCachedPage(filter);
			if (cached) sessionStore.seedAll(cached.sessions.map(sessionOf));
			return cached
				? {
						items: cached.sessions.filter(
							(row) => Boolean(liveRow(row).archivedAt) === filter.archived,
						),
						hasMore: cached.pageInfo.hasMore,
						cursor: null,
						extra: cached.forks,
					}
				: null;
		},
		write: async (filter, snapshot) => {
			if (filter.space) return;
			await setCachedUserSessionList(
				chatsFilterScope(filter),
				snapshot.items,
				{ hasMore: snapshot.hasMore, nextCursor: null },
				{ expectedUserKey: this.#userKey, forks: snapshot.extra },
			);
		},
		covered: (filter) => !filter.space || filter.space.id === this.#roomSpaceId,
	});

	#userKey: string | null = null;
	#visible = 0;
	#releaseWatch: (() => void) | null = null;
	#roomSpaceId: string | null = null;
	#stopRoom: (() => void) | null = null;
	#stop: (() => void) | null = null;
	#releaseRecent: (() => void) | null = null;
	#chipsSettled = false;

	get view(): ChatsView {
		return this.viewOf(this.filter);
	}

	get sessions() {
		return this.view.sessions;
	}

	get spaceChips(): UserSessionSpaceSummary[] {
		const selected = this.filter.space;
		if (
			!selected ||
			this.recentSpaces.some((space) => space.id === selected.id)
		)
			return this.recentSpaces;
		return [selected, ...this.recentSpaces];
	}

	start(): () => void {
		if (this.#stop) return this.#stop;
		this.list.start();
		void this.#ensureUser();
		const stopSessionSync = startSessionSync();
		const stopEvents = sdk.onUserEvent((event) => this.#handleEvent(event));
		const stopChips = $effect.root(() => {
			$effect(() => {
				const spaces = spacesInbox.list.view("recent").items;
				const scoped = Boolean(this.filter.space);
				untrack(() => this.#syncChips(spaces, scoped));
			});
		});
		const onVisibility = () => {
			if (document.hidden) this.#syncChips();
		};
		document.addEventListener("visibilitychange", onVisibility);
		this.#stop = () => {
			stopSessionSync();
			stopEvents();
			stopChips();
			document.removeEventListener("visibilitychange", onVisibility);
			this.#hide();
			this.list.stop();
			this.#stop = null;
		};
		return this.#stop;
	}

	retain(): () => void {
		this.#visible += 1;
		if (this.#visible === 1) void this.#show();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#visible -= 1;
			if (this.#visible === 0) this.#hide();
		};
	}

	viewOf(filter: ChatsFilter): ChatsView {
		const view = this.list.view(filter);
		return {
			sessions: view.items.map(liveRow),
			forks: view.extra,
			loading: view.loading,
			loadingMore: view.loadingMore,
			error: view.error,
		};
	}

	setKind(kind: ChatsKind | null) {
		this.#applyFilter({ ...this.filter, kind, archived: false });
	}

	setSpace(space: UserSessionSpaceSummary | null) {
		this.#applyFilter({ ...this.filter, space });
	}

	setArchived(archived: boolean) {
		this.#applyFilter({ ...this.filter, archived });
	}

	showAll() {
		this.#applyFilter({ kind: null, space: null, archived: false });
	}

	reflectArchive(session: SessionRecord) {
		this.#applySession(session, { settled: true });
	}

	prewarm(filters: readonly ChatsFilter[]) {
		for (const filter of filters) void this.list.open(filter);
	}

	findById(sessionId: string) {
		const row = this.list.find(sessionId);
		return row ? liveRow(row) : null;
	}

	async findLocal(sessionId: string): Promise<UserSessionListItem | null> {
		const known = this.findById(sessionId);
		if (known) return known;
		const [cached] = await Promise.all([
			findCachedSession(sessionId),
			this.#ensureUser().then(() => this.list.ready(this.filter)),
		]);
		const listed = this.findById(sessionId);
		if (listed || !cached) return listed;
		return {
			...cached.session,
			space: await this.#cachedSpaceSummary(cached.spaceId),
		};
	}

	upsertSession(session: UserSessionListItem) {
		sessionStore.merge(sessionOf(session));
		this.#applySession(session, { settled: true, space: session.space });
	}

	recordFork(session: SessionRecord, fork: SessionListForkRecord) {
		this.#applySession(session, { settled: true, fork });
	}

	syncSession(session: SessionRecord, space: SpaceRecord | null) {
		const existing = this.findById(session.id);
		if (existing && sameInboxRow(existing, session)) return;
		this.upsertSession({
			...session,
			space:
				existing?.space ??
				(space?.id === session.spaceId ? spaceSummaryOf(space) : null),
		} as UserSessionListItem);
	}

	loadMore() {
		return this.list.loadMore(this.filter);
	}

	async newChat() {
		const space = this.filter.space;
		if (space) {
			await goto(buildUserNewSessionRoute(space.id));
			return;
		}
		const knowsSpaces =
			this.recentSpaces.length > 0 ||
			getRecentSpaces(authStore.userUuid ?? "").length > 0 ||
			Boolean(getCachedSpaceList()?.length);
		if (!knowsSpaces) {
			const destination = await resolveSpaceEntryRoute();
			if (destination) {
				await goto(destination);
				return;
			}
		}
		openNewChatSpacePicker();
	}

	async #ensureUser() {
		const userKey = await getCacheUserKeyAsync();
		if (userKey === this.#userKey) return;
		this.#userKey = userKey;
		this.filter = readChatsFilter(userKey);
		this.recentSpaces = [];
		this.#chipsSettled = false;
	}

	async #show() {
		await this.#ensureUser();
		if (this.#visible === 0) return;
		this.#watch();
		this.#releaseRecent?.();
		this.#releaseRecent = spacesInbox.list.watch("recent");
	}

	#hide() {
		this.#releaseWatch?.();
		this.#releaseWatch = null;
		this.#releaseRecent?.();
		this.#releaseRecent = null;
		this.#joinRoom(null);
		this.#syncChips();
	}

	#watch() {
		this.#joinRoom(this.filter.space?.id ?? null);
		this.#releaseWatch?.();
		this.#releaseWatch = this.list.watch(this.filter);
	}

	#applyFilter(next: ChatsFilter) {
		if (sameChatsFilter(next, this.filter)) return;
		this.filter = next;
		if (this.#userKey) writeChatsFilter(this.#userKey, next);
		if (this.#visible > 0) this.#watch();
	}

	#joinRoom(spaceId: string | null) {
		const previous = this.#roomSpaceId;
		if (spaceId === previous) return;
		this.#stopRoom?.();
		this.#stopRoom = null;
		this.#roomSpaceId = spaceId;
		if (previous)
			this.list.invalidate((filter) => filter.space?.id === previous);
		if (!spaceId) return;
		this.#stopRoom = subscribeSpaceChannel(spaceId, () => undefined);
	}

	#handleEvent(event: ChannelEnvelope) {
		if (event.type !== "session.created" && event.type !== "session.updated")
			return;
		const record = readSessionRecord(
			(event.payload as { session?: unknown }).session,
		);
		if (!record) return;
		const created = event.type === "session.created";
		this.#applySession(record, {
			settled: created,
			fork: created ? readRealtimeSessionFork(event.payload) : null,
		});
	}

	#applySession(
		record: SessionEventRecord,
		options: {
			settled: boolean;
			space?: UserSessionSpaceSummary | null;
			fork?: SessionListForkRecord | null;
		},
	) {
		const viewer = authStore.userUuid ?? null;
		const merge = (existing: UserSessionListItem) =>
			mergeSessionRecord(
				existing,
				record as Omit<SessionRecord, "meta">,
			) as UserSessionListItem;
		if (!isFullRecord(record)) {
			const known = this.list.find(record.id);
			if (known) {
				this.list.apply({ id: record.id, fit: () => "keep", merge });
			}
			return;
		}
		const known = sessionStore.get(record.id);
		const current = known
			? mergeSessionRecord(known, record as Omit<SessionRecord, "meta">)
			: record;
		const change: LiveChange<ChatsFilter, UserSessionListItem, Forks> = {
			id: record.id,
			fit: (filter) => sessionFit(current, filter, viewer),
			merge,
			create: (filter) => {
				const space =
					filter.space ?? options.space ?? this.spaceSummary(record.spaceId);
				return space
					? (mergeSessionRecord(undefined, {
							...current,
							space,
						} as Omit<SessionRecord, "meta">) as UserSessionListItem)
					: null;
			},
			settled: options.settled,
			extra: options.fork ? [options.fork] : undefined,
		};
		this.list.apply(change);
	}

	spaceSummary(spaceId: string): UserSessionSpaceSummary | null {
		const space = spacesInbox.find(spaceId);
		if (space) return spaceSummaryOf(space);
		return (
			this.recentSpaces.find((chip) => chip.id === spaceId) ??
			this.list.findBy((session) => session.spaceId === spaceId)?.space ??
			null
		);
	}

	async #cachedSpaceSummary(spaceId: string) {
		const known = this.spaceSummary(spaceId);
		if (known) return known;
		const cached = await getCachedSpaceRecord(spaceId).catch(() => null);
		return cached ? spaceSummaryOf(cached.space) : null;
	}

	async #readCachedPage(filter: ChatsFilter) {
		const { space, kind } = filter;
		if (space && filter.archived) return null;
		if (!space) {
			const cached = await getCachedUserSessionListSnapshot(
				chatsFilterScope(filter),
			);
			return cached
				? {
						sessions: cached.sessions,
						forks: cached.forks,
						pageInfo: cached.pageInfo,
					}
				: null;
		}
		if (!kind) {
			const cached = await getCachedSessionListSnapshot(space.id);
			return cached
				? {
						sessions: withSpace(cached.sessions, space),
						forks: cached.forks,
						pageInfo: cached.pageInfo,
					}
				: null;
		}
		const labels = (await getCachedSpaceLabelsSnapshot(space.id))?.labels;
		const label = labels
			? flattenLabelsWithRefs(labels).find(
					(item) => item.systemKey === chatsKindSystemKey(kind),
				)
			: null;
		if (!label) return null;
		const cached = await getCachedLabelItemsSnapshot(space.id, label.id);
		return cached
			? {
					sessions: withSpace(cached.sessions, space),
					forks: cached.forks ?? [],
					pageInfo: cached.pageInfo,
				}
			: null;
	}

	async #fetchPage(filter: ChatsFilter, cursor: string | null) {
		const { space, kind, archived } = filter;
		if (!space) {
			const facet = archived ? null : kind;
			const result = await sdk.user.listSessions({
				limit: PAGE_SIZE,
				cursor,
				initiator: facet && isSessionInitiator(facet) ? [facet] : null,
				source: facet && !isSessionInitiator(facet) ? [facet] : null,
				includeForks: true,
				archived: archived ? "only" : undefined,
			});
			return {
				sessions: result.sessions ?? [],
				forks: result.forks ?? [],
				pageInfo: result.pageInfo ?? EMPTY_PAGE_INFO,
			};
		}
		if (!kind || archived) {
			const result = await sdk.space(space.id).sessions.list({
				limit: PAGE_SIZE,
				cursor,
				includeForks: true,
				archived: archived ? "only" : undefined,
			});
			const pageInfo = result.pageInfo ?? EMPTY_PAGE_INFO;
			const forks = result.forks ?? [];
			if (!cursor && !archived)
				void setCachedSessionList(
					space.id,
					result.sessions ?? [],
					pageInfo,
					forks,
				).catch(() => undefined);
			return {
				sessions: withSpace(result.sessions ?? [], space),
				forks,
				pageInfo,
			};
		}
		const labels = await fetchSpaceLabels(space.id);
		const label = flattenLabelsWithRefs(labels).find(
			(item) => item.systemKey === chatsKindSystemKey(kind),
		);
		if (!label) return { sessions: [], forks: [], pageInfo: EMPTY_PAGE_INFO };
		const result = cursor
			? await sdk
					.space(space.id)
					.labels.listItems(label.ref, { limit: PAGE_SIZE, cursor })
			: await fetchLabelItemsFirstPageFresh(space.id, label.id, label.ref);
		return {
			sessions: withSpace(result.sessions ?? [], space),
			forks: result.forks ?? [],
			pageInfo: result.pageInfo ?? EMPTY_PAGE_INFO,
		};
	}

	#syncChips(
		spaces = spacesInbox.list.view("recent").items,
		scoped = Boolean(this.filter.space),
	) {
		const hold =
			this.#chipsSettled && scoped && this.#visible > 0 && !document.hidden;
		this.recentSpaces = nextSpaceChips(
			this.recentSpaces,
			spaces,
			hold,
			spaceSummaryOf,
		);
		this.#chipsSettled = hold || spacesInbox.list.isLive("recent");
	}
}

export const chatsInbox = new ChatsInbox();

export function openNewChatSpacePicker() {
	openCommandPalette({ lens: "space", intent: "new-chat" });
}
