import type {
	ChannelEnvelope,
	SessionRecord,
	SpaceRecord,
	UserSessionListItem,
	UserSessionSourceKey,
	UserSessionSpaceSummary,
} from "@neta-art/cohub";
import { goto } from "$app/navigation";
import { resolveAppEntryRoute } from "$lib/app-entry";
import type { SessionListForkRecord } from "$lib/cache/db";
import { getCacheUserKeyAsync } from "$lib/cache/keys";
import {
	getCachedSpacePage,
	setCachedSpacePage,
} from "$lib/cache/space-list-page-cache";
import { openCommandPalette } from "$lib/command-palette/open";
import { subscribeSpaceChannel } from "$lib/features/session-chat";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { mergeSessionRecord } from "$lib/session-record-merge";
import { sortSessionsByRecentActivity } from "$lib/session-sort";
import { getSpacePublicProfile } from "$lib/space-profile";
import { buildUserNewSessionRoute } from "$lib/space-routes";
import { authStore } from "$lib/stores/auth.svelte";
import {
	type ChatsFilter,
	chatsFilterScope,
	DEFAULT_CHATS_FILTER,
	readChatsFilter,
	sameChatsFilter,
	writeChatsFilter,
} from "$lib/stores/chats-filter";
import { getRecentSpaces } from "$lib/stores/recent-space";
import { reconcileGenerationStateFromSessionList } from "$lib/stores/session-generation-list-reconcile";
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
import {
	emptyUserSessionListPageInfo,
	getCachedUserSessionListSnapshot,
	setCachedUserSessionList,
} from "$lib/stores/user-session-list-cache";

const PAGE_SIZE = 30;
const REALTIME_REFRESH_DEBOUNCE_MS = 400;
const SPACE_CHIP_LIMIT = 6;
const SPACE_PAGE_SIZE = 50;
const SPACE_CHIPS_TTL_MS = 60_000;

type Page = {
	sessions: UserSessionListItem[];
	forks: SessionListForkRecord[];
	pageInfo: { hasMore: boolean; nextCursor: string | null };
};

const MEMO_LIMIT = 12;

const EMPTY_PAGE_INFO = { hasMore: false, nextCursor: null };

function sourceSystemKey(source: UserSessionSourceKey) {
	return `session-source:${source}`;
}

function mergeForks(
	current: readonly SessionListForkRecord[],
	incoming: readonly SessionListForkRecord[],
): SessionListForkRecord[] {
	if (incoming.length === 0) return current as SessionListForkRecord[];
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

export function spaceSummaryOf(space: SpaceRecord): UserSessionSpaceSummary {
	return {
		id: space.id,
		name: space.name?.trim() || space.title?.trim() || m.spaces_default_name(),
		slug: space.slug ?? null,
		publicProfile: getSpacePublicProfile(space),
	};
}

function isSourceMatch(
	session: SessionRecord,
	source: UserSessionSourceKey | null,
): boolean {
	if (!source) return true;
	if (source !== "web") return false;
	const raw = session.source?.trim().toLowerCase() ?? "";
	return raw === "" || raw === "web" || raw === "web_app";
}

type TurnNotifyPayload = {
	spaceId?: unknown;
	sessionId?: unknown;
	userPreview?: unknown;
	completedAt?: unknown;
};

function activeTurnFromEvent(event: ChannelEnvelope) {
	if (event.type !== "session.updated") return null;
	const session = (event.payload as { session?: unknown } | null)?.session;
	if (!session || typeof session !== "object" || Array.isArray(session))
		return null;
	const record = session as Record<string, unknown>;
	if (
		typeof record.id !== "string" ||
		typeof record.spaceId !== "string" ||
		typeof record.activeTurnSequence !== "number" ||
		!Number.isSafeInteger(record.activeTurnSequence) ||
		record.activeTurnSequence < 0
	)
		return null;
	return {
		sessionId: record.id,
		spaceId: record.spaceId,
		activeTurn: record.activeTurn as UserSessionListItem["activeTurn"],
		activeTurnSequence: record.activeTurnSequence,
	};
}

// No Space: /api/me/sessions; a Space: its session list, or its Source label items.
class ChatsInbox {
	filter = $state<ChatsFilter>(DEFAULT_CHATS_FILTER);
	sessions = $state<UserSessionListItem[]>([]);
	forks = $state<SessionListForkRecord[]>([]);
	pageInfo = $state(emptyUserSessionListPageInfo());
	loading = $state(false);
	loadingMore = $state(false);
	refreshing = $state(false);
	error = $state<string | null>(null);
	recentSpaces = $state<UserSessionSpaceSummary[]>([]);

	#userKey: string | null = null;
	#retainCount = 0;
	#generation = 0;
	#refreshSeq = 0;
	#refreshTimer: ReturnType<typeof setTimeout> | null = null;
	#stopUserEvents: (() => void) | null = null;
	#stopSpaceEvents: (() => void) | null = null;
	#chipsFrozen = false;
	#activation = 0;
	#firstPageInfo = emptyUserSessionListPageInfo();
	#extraPages = 0;
	#memo = new Map<string, Page>();

	get spaceChips(): UserSessionSpaceSummary[] {
		const selected = this.filter.space;
		if (
			!selected ||
			this.recentSpaces.some((space) => space.id === selected.id)
		)
			return this.recentSpaces;
		return [selected, ...this.recentSpaces];
	}

	retain(): () => void {
		this.#retainCount += 1;
		if (this.#retainCount === 1) void this.#activate();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#retainCount -= 1;
			if (this.#retainCount === 0) this.#deactivate();
		};
	}

	setSource(source: UserSessionSourceKey | null) {
		this.#applyFilter({ ...this.filter, source });
	}

	toggleSpace(space: UserSessionSpaceSummary | null) {
		const next = space && this.filter.space?.id !== space.id ? space : null;
		this.#applyFilter({ ...this.filter, space: next });
	}

	setSpace(space: UserSessionSpaceSummary | null) {
		this.#applyFilter({ ...this.filter, space });
	}

	async prewarm(filters: readonly ChatsFilter[]) {
		const userKey = this.#userKey;
		for (const filter of filters) {
			const scope = chatsFilterScope(filter);
			if (this.#memo.has(scope)) continue;
			const cached = await this.#readCachedPage(filter).catch(() => null);
			if (!cached || userKey !== this.#userKey || this.#memo.has(scope))
				continue;
			this.#remember(scope, cached);
		}
	}

	showAll() {
		this.#applyFilter({ source: null, space: null });
	}

	findById(sessionId: string) {
		return this.sessions.find((session) => session.id === sessionId) ?? null;
	}

	upsertSession(session: UserSessionListItem) {
		const existing = this.findById(session.id);
		if (!existing) {
			const { space, source } = this.filter;
			if (space && space.id !== session.spaceId) return;
			if (!isSourceMatch(session, source)) return;
		}
		this.#setSessions([
			mergeSessionRecord(existing ?? undefined, session) as UserSessionListItem,
			...this.sessions.filter((item) => item.id !== session.id),
		]);
		void this.#persistFirstPage();
	}

	async refresh() {
		const seq = ++this.#refreshSeq;
		const generation = this.#generation;
		const filter = this.filter;
		const userKey = await getCacheUserKeyAsync();
		if (this.sessions.length === 0) this.loading = true;
		else this.refreshing = true;
		this.error = null;
		try {
			const startedAt = Date.now();
			const page = await this.#fetchPage(filter, null);
			if (seq !== this.#refreshSeq || generation !== this.#generation) return;
			if ((await getCacheUserKeyAsync()) !== userKey) return;
			this.#firstPageInfo = page.pageInfo;
			if (this.#extraPages === 0) this.pageInfo = page.pageInfo;
			this.#setSessions(
				this.#extraPages > 0 ? this.#mergeById(page.sessions) : page.sessions,
				{ forks: page.forks, authoritative: true, startedAt },
			);
			void this.#persistFirstPage(filter, userKey);
		} catch (error) {
			if (seq !== this.#refreshSeq || generation !== this.#generation) return;
			console.warn("[chats] Failed to refresh", error);
			if (this.sessions.length === 0)
				this.error =
					error instanceof Error ? error.message : "Failed to load chats";
		} finally {
			if (seq === this.#refreshSeq && generation === this.#generation) {
				this.loading = false;
				this.refreshing = false;
			}
		}
	}

	async loadMore() {
		if (this.loadingMore || !this.pageInfo.hasMore || !this.pageInfo.nextCursor)
			return;
		const generation = this.#generation;
		const filter = this.filter;
		this.loadingMore = true;
		try {
			const startedAt = Date.now();
			const page = await this.#fetchPage(filter, this.pageInfo.nextCursor);
			if (generation !== this.#generation) return;
			this.pageInfo = page.pageInfo;
			this.#extraPages += 1;
			this.#setSessions(this.#mergeById(page.sessions), {
				forks: page.forks,
				authoritative: true,
				startedAt,
			});
		} catch (error) {
			if (generation !== this.#generation) return;
			console.warn("[chats] Failed to load more", error);
		} finally {
			if (generation === this.#generation) this.loadingMore = false;
		}
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

	async #activate() {
		const activation = ++this.#activation;
		const userKey = await getCacheUserKeyAsync();
		if (activation !== this.#activation) return;
		if (userKey !== this.#userKey) {
			this.#userKey = userKey;
			this.filter = readChatsFilter(userKey);
			this.#memo.clear();
			this.sessions = [];
			this.forks = [];
			this.pageInfo = emptyUserSessionListPageInfo();
			this.#firstPageInfo = emptyUserSessionListPageInfo();
			this.#extraPages = 0;
			this.recentSpaces = [];
		}
		this.#stopUserEvents = sdk.onUserEvent((event) =>
			this.#handleRealtimeEvent(event),
		);
		this.#watchSpace();
		void this.#loadRecentSpaces();
		await this.#hydrate();
		if (activation === this.#activation) await this.refresh();
	}

	#deactivate() {
		this.#activation += 1;
		this.#stopUserEvents?.();
		this.#stopUserEvents = null;
		this.#stopSpaceEvents?.();
		this.#stopSpaceEvents = null;
		if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
		this.#refreshTimer = null;
		this.#chipsFrozen = false;
	}

	#applyFilter(next: ChatsFilter) {
		if (sameChatsFilter(next, this.filter)) return;
		this.filter = next;
		this.#generation += 1;
		this.#refreshSeq += 1;
		const memo = this.#memo.get(chatsFilterScope(next));
		this.sessions = memo?.sessions ?? [];
		this.forks = memo?.forks ?? [];
		this.pageInfo = memo?.pageInfo ?? emptyUserSessionListPageInfo();
		this.#firstPageInfo = this.pageInfo;
		this.#extraPages = 0;
		this.loading = !memo?.sessions.length;
		this.loadingMore = false;
		this.refreshing = false;
		this.error = null;
		if (this.#userKey) writeChatsFilter(this.#userKey, next);
		this.#watchSpace();
		void this.#hydrate().then(() => this.refresh());
	}

	async #hydrate() {
		const generation = this.#generation;
		const cached = await this.#readCachedPage(this.filter).catch(() => null);
		if (generation !== this.#generation || !cached) return;
		if (this.sessions.length > 0) return;
		this.pageInfo = cached.pageInfo;
		this.#firstPageInfo = cached.pageInfo;
		this.#setSessions(cached.sessions, { forks: cached.forks });
		if (cached.sessions.length > 0) this.loading = false;
	}

	#mergeById(incoming: UserSessionListItem[]) {
		const byId = new Map(this.sessions.map((session) => [session.id, session]));
		for (const session of incoming)
			byId.set(
				session.id,
				mergeSessionRecord(
					byId.get(session.id),
					session,
				) as UserSessionListItem,
			);
		return [...byId.values()];
	}

	#setSessions(
		sessions: UserSessionListItem[],
		options?: {
			forks?: SessionListForkRecord[];
			authoritative?: boolean;
			startedAt?: number;
		},
	) {
		this.sessions = sortSessionsByRecentActivity(
			sessions,
		) as UserSessionListItem[];
		if (options?.forks) this.forks = mergeForks(this.forks, options.forks);
		this.#remember(chatsFilterScope(this.filter), {
			sessions: this.sessions.slice(0, PAGE_SIZE),
			forks: this.forks,
			pageInfo: this.#firstPageInfo,
		});
		reconcileGenerationStateFromSessionList(this.sessions, {
			authoritative: options?.authoritative,
			requestStartedAt: options?.startedAt,
		});
	}

	#remember(scope: string, page: Page) {
		this.#memo.delete(scope);
		this.#memo.set(scope, page);
		if (this.#memo.size > MEMO_LIMIT)
			this.#memo.delete(this.#memo.keys().next().value as string);
	}

	async #readCachedPage(filter: ChatsFilter): Promise<Page | null> {
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

	async #fetchPage(filter: ChatsFilter, cursor: string | null): Promise<Page> {
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

	async #persistFirstPage(filter = this.filter, userKey?: string | null) {
		if (filter.space) return;
		await setCachedUserSessionList(
			chatsFilterScope(filter),
			this.sessions.slice(0, PAGE_SIZE),
			this.#firstPageInfo,
			{ expectedUserKey: userKey ?? this.#userKey, forks: this.forks },
		);
	}

	#scheduleRefresh() {
		if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
		this.#refreshTimer = setTimeout(() => {
			this.#refreshTimer = null;
			void this.refresh();
		}, REALTIME_REFRESH_DEBOUNCE_MS);
	}

	#watchSpace() {
		this.#stopSpaceEvents?.();
		this.#stopSpaceEvents = null;
		const spaceId = this.filter.space?.id;
		if (!spaceId || this.#retainCount === 0) return;
		this.#stopSpaceEvents = subscribeSpaceChannel(spaceId, (event) => {
			if (
				event.type === "session.created" ||
				event.type === "session.turn.finalized"
			)
				this.#scheduleRefresh();
			else if (event.type === "session.updated")
				this.#handleRealtimeEvent(event);
		});
	}

	#handleRealtimeEvent(event: ChannelEnvelope) {
		const scopedSpaceId = this.filter.space?.id ?? null;
		const update = activeTurnFromEvent(event);
		if (update) {
			if (scopedSpaceId && update.spaceId !== scopedSpaceId) return;
			const existing = this.findById(update.sessionId);
			if (existing) {
				this.upsertSession({
					...existing,
					activeTurn: update.activeTurn,
					activeTurnSequence: update.activeTurnSequence,
				});
				return;
			}
			this.#scheduleRefresh();
			return;
		}
		if (event.type !== "session.turn.notify") return;
		const payload = event.payload as TurnNotifyPayload;
		if (
			typeof payload.sessionId !== "string" ||
			typeof payload.spaceId !== "string"
		)
			return;
		if (scopedSpaceId && payload.spaceId !== scopedSpaceId) return;
		const existing = this.findById(payload.sessionId);
		if (existing) {
			const completedAt =
				typeof payload.completedAt === "string"
					? payload.completedAt
					: new Date().toISOString();
			this.upsertSession({
				...existing,
				latestMessageText:
					typeof payload.userPreview === "string"
						? payload.userPreview
						: existing.latestMessageText,
				lastMessageAt: completedAt,
				updatedAt: completedAt,
			});
		}
		this.#scheduleRefresh();
	}

	async #loadRecentSpaces() {
		const cached = await getCachedSpacePage("recent", "").catch(() => null);
		if (cached) this.#setRecentSpaces(cached.items);
		if (cached && Date.now() - cached.updatedAt < SPACE_CHIPS_TTL_MS) return;
		try {
			const userUuid = authStore.userUuid ?? "";
			const page = await sdk.spaces.list({
				limit: SPACE_PAGE_SIZE,
				filter: "recent",
				query: "",
				recentSpaces: getRecentSpaces(userUuid).map((entry) => ({
					id: entry.spaceId,
					timestamp: entry.timestamp,
				})),
			});
			void setCachedSpacePage("recent", "", page).catch(() => undefined);
			this.#setRecentSpaces(page.items);
		} catch {}
	}

	#setRecentSpaces(spaces: SpaceRecord[]) {
		if (this.#retainCount === 0) return;
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
