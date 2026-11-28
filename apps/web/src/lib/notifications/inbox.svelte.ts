import {
	type ChannelEnvelope,
	type InboxChangedEvent,
	type InboxItem,
	type InboxReadTarget,
	type InboxSummary,
	isNotificationKind,
} from "@neta-art/cohub";
import { type InboxCacheRecord, idbGet, idbPut } from "#lib/cache/db.ts";
import {
	canUseUserScopedCache,
	getCacheUserKeyAsync,
} from "#lib/cache/keys.ts";
import { LiveList, type LivePage } from "#lib/lists/live-list.svelte.ts";
import { sdk } from "#lib/sdk.ts";
import { syncStatus } from "#lib/sync/sync-status.svelte.ts";

export type InboxFilter = "all" | "unread";
export const INBOX_FILTERS: readonly InboxFilter[] = ["all", "unread"];

const PAGE_SIZE = 30;
const STORE = "inbox_lists";
const EMPTY_SUMMARY: InboxSummary = { unread: 0 };

type ChangedPayload = InboxChangedEvent["payload"];

const byRecent = (a: InboxItem, b: InboxItem) =>
	Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
	(a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

const known = (items: readonly InboxItem[]) =>
	items.filter((item) => isNotificationKind(item.kind));

function matchesRead(
	item: InboxItem,
	target: InboxReadTarget & { readAt?: string },
) {
	if (item.readAt) return false;
	if (target.readAt && Date.parse(item.updatedAt) > Date.parse(target.readAt))
		return false;
	if ("ids" in target) return target.ids.includes(item.id);
	if ("sessionId" in target) return item.sessionId === target.sessionId;
	return true;
}

async function cacheKey(name: string) {
	const userKey = await getCacheUserKeyAsync();
	return canUseUserScopedCache(userKey)
		? { userKey, key: `${encodeURIComponent(userKey)}:${name}` }
		: null;
}

function isChanged(
	event: ChannelEnvelope,
): event is ChannelEnvelope & { payload: ChangedPayload } {
	return (
		event.type === "inbox.changed" &&
		typeof (event.payload as Partial<ChangedPayload>).summary?.unread ===
			"number"
	);
}

class Inbox {
	readonly list = new LiveList<InboxFilter, InboxItem, null>({
		name: "inbox",
		pageSize: PAGE_SIZE,
		memoLimit: INBOX_FILTERS.length,
		key: (filter) => filter,
		id: (item) => item.id,
		compare: () => byRecent,
		emptyExtra: () => null,
		mergeExtra: () => null,
		fetch: async (filter, cursor) => {
			const page = await sdk.inbox.list({
				unread: filter === "unread",
				cursor,
				limit: PAGE_SIZE,
			});
			return {
				items: known(page.items),
				hasMore: page.pageInfo.hasMore,
				cursor: page.pageInfo.nextCursor,
				extra: null,
			};
		},
		read: async (filter): Promise<LivePage<InboxItem, null> | null> => {
			const scope = await cacheKey(filter);
			if (!scope) return null;
			const record = await idbGet<InboxCacheRecord>(STORE, scope.key);
			if (record?.userKey !== scope.userKey) return null;
			return {
				items: known(record.items as InboxItem[]),
				hasMore: record.hasMore,
				cursor: null,
				extra: null,
			};
		},
		write: async (filter, snapshot) => {
			const scope = await cacheKey(filter);
			if (!scope) return;
			await idbPut<InboxCacheRecord>(STORE, {
				key: scope.key,
				userKey: scope.userKey,
				items: snapshot.items,
				hasMore: snapshot.hasMore,
				updatedAt: Date.now(),
			});
		},
	});

	summary = $state<InboxSummary>(EMPTY_SUMMARY);
	#summaryGeneration = 0;
	#stop: (() => void) | null = null;

	start(): () => void {
		if (this.#stop) return this.#stop;
		this.list.start();
		void this.#hydrateSummary().then(() => this.refreshSummary());
		const stopEvents = sdk.onUserEvent((event) => {
			if (isChanged(event)) this.#apply(event.payload);
		});
		const stopGap = syncStatus.onGap(() => void this.refreshSummary());
		this.#stop = () => {
			stopEvents();
			stopGap();
			this.list.stop();
			this.#stop = null;
		};
		return this.#stop;
	}

	hasUnreadFor(sessionId: string) {
		return Boolean(
			this.list.findBy((item) => !item.readAt && item.sessionId === sessionId),
		);
	}

	get unknownUnread() {
		const loaded = new Set<string>();
		for (const filter of INBOX_FILTERS)
			for (const item of this.list.view(filter).items)
				if (!item.readAt) loaded.add(item.id);
		return Math.max(0, this.summary.unread - loaded.size);
	}

	async refreshSummary() {
		const generation = ++this.#summaryGeneration;
		const summary = await sdk.inbox.summary().catch(() => null);
		if (summary && generation === this.#summaryGeneration)
			this.#setSummary(summary);
	}

	async markRead(target: InboxReadTarget) {
		const cleared = this.#applyRead(target, new Date().toISOString());
		const elsewhere =
			"ids" in target
				? target.ids.length
				: "all" in target
					? this.summary.unread
					: this.unknownUnread;
		if (cleared.length === 0 && elsewhere === 0) return;
		this.#setSummary(
			{
				unread:
					"all" in target
						? 0
						: Math.max(0, this.summary.unread - cleared.length),
			},
			{ persist: false },
		);
		const generation = ++this.#summaryGeneration;
		try {
			const result = await sdk.inbox.markRead(target);
			if (generation === this.#summaryGeneration)
				this.#setSummary(result.summary);
		} catch (error) {
			console.warn("[inbox] mark read failed", error);
			this.list.invalidate();
			void this.refreshSummary();
		}
	}

	#apply(payload: ChangedPayload) {
		++this.#summaryGeneration;
		for (const item of known(payload.upserted ?? [])) {
			this.list.apply({
				id: item.id,
				fit: () => "in",
				merge: (current) =>
					current.revision > item.revision ||
					(current.revision === item.revision && current.readAt)
						? current
						: item,
				create: () => item,
				settled: true,
			});
		}
		if (payload.read) this.#applyRead(payload.read, payload.read.readAt);
		this.#setSummary(payload.summary);
	}

	#applyRead(target: InboxReadTarget & { readAt?: string }, readAt: string) {
		const cleared = new Map<string, InboxItem>();
		for (const filter of INBOX_FILTERS)
			for (const item of this.list.view(filter).items)
				if (matchesRead(item, target)) cleared.set(item.id, item);
		for (const id of cleared.keys())
			this.list.apply({
				id,
				fit: (filter) => (filter === "unread" ? "out" : "keep"),
				merge: (item) => (item.readAt ? item : { ...item, readAt }),
			});
		return [...cleared.values()];
	}

	#setSummary(summary: InboxSummary, options: { persist?: boolean } = {}) {
		this.summary = summary;
		if (options.persist !== false) void this.#persistSummary(summary);
	}

	async #hydrateSummary() {
		const scope = await cacheKey("summary");
		if (!scope) return;
		const record = await idbGet<InboxCacheRecord>(STORE, scope.key).catch(
			() => null,
		);
		if (
			record?.userKey === scope.userKey &&
			typeof (record.summary as Partial<InboxSummary> | undefined)?.unread ===
				"number" &&
			this.summary === EMPTY_SUMMARY
		)
			this.summary = { unread: (record.summary as InboxSummary).unread };
	}

	async #persistSummary(summary: InboxSummary) {
		const scope = await cacheKey("summary");
		if (!scope) return;
		await idbPut<InboxCacheRecord>(STORE, {
			key: scope.key,
			userKey: scope.userKey,
			items: [],
			hasMore: false,
			summary,
			updatedAt: Date.now(),
		}).catch(() => undefined);
	}
}

export const inbox = new Inbox();
