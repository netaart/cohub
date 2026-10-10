import type {
	ChannelEnvelope,
	SessionRecord,
	SpaceRecord,
	UserSessionListItem,
	UserSessionSourceKey,
	UserSessionSpaceSummary,
} from "@neta-art/cohub";
import { untrack } from "svelte";
import { goto } from "$app/navigation";
import { resolveAppEntryRoute } from "$lib/app-entry";
import type { SessionListForkRecord } from "$lib/cache/db";
import { getCacheUserKeyAsync } from "$lib/cache/keys";
import { openCommandPalette } from "$lib/command-palette/open";
import { subscribeSpaceChannel } from "$lib/features/session-chat";
import { spacesInbox } from "$lib/features/spaces/spaces-inbox.svelte";
import { type LiveChange, LiveList } from "$lib/lists/live-list.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { mergeSessionRecord } from "$lib/session-record-merge";
import { compareSessionsByRecentActivity } from "$lib/session-sort";
import {
	mergeSessionTurnState,
	readSessionTurnState,
} from "$lib/session-turn-state";
import { getSpacePublicProfile } from "$lib/space-profile";
import { buildUserNewSessionRoute } from "$lib/space-routes";
import { authStore } from "$lib/stores/auth.svelte";
import {
	type ChatsFilter,
	chatsFilterScope,
	DEFAULT_CHATS_FILTER,
	readChatsFilter,
	type SessionEventRecord,
	sameChatsFilter,
	sessionFit,
	writeChatsFilter,
} from "$lib/stores/chats-filter";
import { getRecentSpaces } from "$lib/stores/recent-space";
import { findCachedSession } from "$lib/stores/session-detail-cache";
import {
	getCachedSessionListSnapshot,
	setCachedSessionList,
} from "$lib/stores/session-list-cache";
import {
	fetchLabelItemsFirstPageFresh,
	fetchSpaceLabels,
	flattenLabelsWithRefs,
	getCachedLabelItemsSnapshot,
	getCachedSpaceLabelsSnapshot,
} from "$lib/stores/space-labels";
import { getCachedSpaceList } from "$lib/stores/space-list-cache";
import { getCachedSpaceRecord } from "$lib/stores/space-record-cache";
import {
	getCachedUserSessionListSnapshot,
	setCachedUserSessionList,
} from "$lib/stores/user-session-list-cache";

const PAGE_SIZE = 30;
const SPACE_CHIP_LIMIT = 6;
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

function sourceSystemKey(source: UserSessionSourceKey) {
	return `session-source:${source}`;
}

function mergeForks(current: Forks, incoming: Forks): Forks {
	if (incoming.length === 0) return current;
	const byChild = new Map(current.map((fork) => [fork.childSessionId, fork]));
	for (const fork of incoming) byChild.set(fork.childSessionId, fork);
	return [...byChild.values()];
}

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
		row.lastMessageId === session.lastMessageId &&
		row.activeTurnSequence === session.activeTurnSequence &&
		row.activeTurn?.id === session.activeTurn?.id &&
		row.activeTurn?.status === session.activeTurn?.status &&
		row.lastTurnIssue === session.lastTurnIssue
	);
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
	recentSpaces = $state<UserSessionSpaceSummary[]>([]);

	readonly list = new LiveList<ChatsFilter, UserSessionListItem, Forks>({
		name: "chats",
		pageSize: PAGE_SIZE,
		memoLimit: MEMO_LIMIT,
		key: chatsFilterScope,
		id: (session) => session.id,
		compare: () => compareSessionsByRecentActivity,
		emptyExtra: () => [],
		mergeExtra: mergeForks,
		fetch: async (filter, cursor) => {
			const page = await this.#fetchPage(filter, cursor);
			return {
				items: page.sessions,
				hasMore: page.pageInfo.hasMore,
				cursor: page.pageInfo.nextCursor,
				extra: page.forks,
			};
		},
		read: async (filter) => {
			const cached = await this.#readCachedPage(filter);
			return cached
				? {
						items: cached.sessions,
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
	#chipsFrozen = false;

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
		const stopEvents = sdk.onUserEvent((event) => this.#handleEvent(event));
		const stopChips = $effect.root(() => {
			$effect(() => {
				const spaces = spacesInbox.list.view("recent").items;
				untrack(() => this.#setRecentSpaces(spaces));
			});
		});
		this.#stop = () => {
			stopEvents();
			stopChips();
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
			sessions: view.items,
			forks: view.extra,
			loading: view.loading,
			loadingMore: view.loadingMore,
			error: view.error,
		};
	}

	setSource(source: UserSessionSourceKey | null) {
		this.#applyFilter({ ...this.filter, source });
	}

	setSpace(space: UserSessionSpaceSummary | null) {
		this.#applyFilter({ ...this.filter, space });
	}

	showAll() {
		this.#applyFilter({ source: null, space: null });
	}

	prewarm(filters: readonly ChatsFilter[]) {
		for (const filter of filters) void this.list.open(filter);
	}

	findById(sessionId: string) {
		return this.list.find(sessionId) ?? null;
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
		this.#applySession(session, { settled: true, space: session.space });
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
			const destination = await resolveAppEntryRoute();
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
		this.#chipsFrozen = false;
	}

	async #show() {
		await this.#ensureUser();
		if (this.#visible === 0) return;
		this.#watch();
		void spacesInbox.list.open("recent");
	}

	#hide() {
		this.#releaseWatch?.();
		this.#releaseWatch = null;
		this.#joinRoom(null);
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
		const turn = readSessionTurnState(event);
		if (turn?.sessionId) {
			this.list.apply({
				id: turn.sessionId,
				fit: () => "keep",
				merge: (session) => mergeSessionTurnState(session, turn),
			});
			return;
		}
		if (event.type !== "session.created" && event.type !== "session.updated")
			return;
		const record = readSessionRecord(
			(event.payload as { session?: unknown }).session,
		);
		if (record)
			this.#applySession(record, { settled: event.type === "session.created" });
	}

	#applySession(
		record: SessionEventRecord,
		options: { settled: boolean; space?: UserSessionSpaceSummary | null },
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
		const change: LiveChange<ChatsFilter, UserSessionListItem> = {
			id: record.id,
			fit: (filter) => sessionFit(record, filter, viewer),
			merge,
			create: (filter) => {
				const space =
					filter.space ?? options.space ?? this.spaceSummary(record.spaceId);
				return space
					? (mergeSessionRecord(undefined, {
							...record,
							space,
						} as Omit<SessionRecord, "meta">) as UserSessionListItem)
					: null;
			},
			settled: options.settled,
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
		const { space, source } = filter;
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
		if (!source) {
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
					(item) => item.systemKey === sourceSystemKey(source),
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
		const { space, source } = filter;
		if (!space) {
			const result = await sdk.user.listSessions({
				limit: PAGE_SIZE,
				cursor,
				source: source ? [source] : null,
				includeForks: true,
			});
			return {
				sessions: result.sessions ?? [],
				forks: result.forks ?? [],
				pageInfo: result.pageInfo ?? EMPTY_PAGE_INFO,
			};
		}
		if (!source) {
			const result = await sdk
				.space(space.id)
				.sessions.list({ limit: PAGE_SIZE, cursor, includeForks: true });
			const pageInfo = result.pageInfo ?? EMPTY_PAGE_INFO;
			const forks = result.forks ?? [];
			if (!cursor)
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
			(item) => item.systemKey === sourceSystemKey(source),
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

	#setRecentSpaces(spaces: SpaceRecord[]) {
		const next = spaces
			.filter((space) => !space.isArchived)
			.slice(0, SPACE_CHIP_LIMIT)
			.map(spaceSummaryOf);
		if (!this.#chipsFrozen || this.recentSpaces.length === 0) {
			this.recentSpaces = next;
			this.#chipsFrozen = next.length > 0;
			return;
		}
		const byId = new Map(spaces.map((space) => [space.id, space]));
		this.recentSpaces = this.recentSpaces.map((chip) => {
			const space = byId.get(chip.id);
			return space ? spaceSummaryOf(space) : chip;
		});
	}
}

export const chatsInbox = new ChatsInbox();

export function openNewChatSpacePicker() {
	openCommandPalette({ lens: "space", intent: "new-chat" });
}
