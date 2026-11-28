import type {
	ChannelEnvelope,
	NotificationCategory,
	NotificationChangedEvent,
	NotificationReadTarget,
	NotificationRecord,
	NotificationSummary,
} from "@neta-art/cohub";
import { idbGet, idbPut, type NotificationCacheRecord } from "#lib/cache/db.ts";
import {
	canUseUserScopedCache,
	getCacheUserKeyAsync,
} from "#lib/cache/keys.ts";
import { LiveList, type LivePage } from "#lib/lists/live-list.svelte.ts";
import { sdk } from "#lib/sdk.ts";
import { syncStatus } from "#lib/sync/sync-status.svelte.ts";

export type InboxFilter = "all" | NotificationCategory;
export const INBOX_FILTERS: readonly InboxFilter[] = [
	"all",
	"mention",
	"activity",
];

const PAGE_SIZE = 30;
const STORE = "notification_lists";
const EMPTY_SUMMARY: NotificationSummary = {
	unread: 0,
	byCategory: { mention: 0, activity: 0, system: 0 },
};

type ChangedPayload = NotificationChangedEvent["payload"];
type Upserted = (records: NotificationRecord[]) => void;

const byRecent = (a: NotificationRecord, b: NotificationRecord) =>
	Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
	(a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

const fits = (filter: InboxFilter, record: NotificationRecord) =>
	filter === "all" || filter === record.category ? "in" : "out";

function matchesRead(
	record: NotificationRecord,
	target: NotificationReadTarget & { readAt?: string },
) {
	if (record.readAt) return false;
	if (target.readAt && Date.parse(record.updatedAt) > Date.parse(target.readAt))
		return false;
	if ("ids" in target) return target.ids.includes(record.id);
	if ("category" in target) return record.category === target.category;
	if ("sessionId" in target) return record.sessionId === target.sessionId;
	return true;
}

function optimisticSummary(
	summary: NotificationSummary,
	target: NotificationReadTarget,
	cleared: readonly NotificationRecord[],
): NotificationSummary {
	if ("all" in target) return EMPTY_SUMMARY;
	const byCategory = { ...summary.byCategory };
	if ("category" in target) byCategory[target.category] = 0;
	else
		for (const record of cleared)
			byCategory[record.category] = Math.max(
				0,
				byCategory[record.category] - 1,
			);
	return {
		unread: Object.values(byCategory).reduce((sum, count) => sum + count, 0),
		byCategory,
	};
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
		event.type === "notification.changed" &&
		typeof (event.payload as Partial<ChangedPayload>).summary?.unread ===
			"number"
	);
}

class Inbox {
	readonly list = new LiveList<InboxFilter, NotificationRecord, null>({
		name: "notifications",
		pageSize: PAGE_SIZE,
		memoLimit: INBOX_FILTERS.length,
		key: (filter) => filter,
		id: (record) => record.id,
		compare: () => byRecent,
		emptyExtra: () => null,
		mergeExtra: () => null,
		fetch: async (filter, cursor) => {
			const page = await sdk.notifications.list({
				category: filter === "all" ? null : filter,
				cursor,
				limit: PAGE_SIZE,
			});
			return {
				items: page.items,
				hasMore: page.pageInfo.hasMore,
				cursor: page.pageInfo.nextCursor,
				extra: null,
			};
		},
		read: async (
			filter,
		): Promise<LivePage<NotificationRecord, null> | null> => {
			const scope = await cacheKey(filter);
			if (!scope) return null;
			const record = await idbGet<NotificationCacheRecord>(STORE, scope.key);
			if (record?.userKey !== scope.userKey) return null;
			return {
				items: record.items as NotificationRecord[],
				hasMore: record.hasMore,
				cursor: null,
				extra: null,
			};
		},
		write: async (filter, snapshot) => {
			const scope = await cacheKey(filter);
			if (!scope) return;
			await idbPut<NotificationCacheRecord>(STORE, {
				key: scope.key,
				userKey: scope.userKey,
				items: snapshot.items,
				hasMore: snapshot.hasMore,
				updatedAt: Date.now(),
			});
		},
	});

	summary = $state<NotificationSummary>(EMPTY_SUMMARY);
	#listeners = new Set<Upserted>();
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

	onUpserted(listener: Upserted): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	hasUnreadFor(sessionId: string) {
		return Boolean(
			this.list.findBy(
				(record) => !record.readAt && record.sessionId === sessionId,
			),
		);
	}

	get unknownUnread() {
		const loaded = new Set<string>();
		for (const filter of INBOX_FILTERS)
			for (const record of this.list.view(filter).items)
				if (!record.readAt) loaded.add(record.id);
		return Math.max(0, this.summary.unread - loaded.size);
	}

	async refreshSummary() {
		const generation = ++this.#summaryGeneration;
		const summary = await sdk.notifications.summary().catch(() => null);
		if (summary && generation === this.#summaryGeneration)
			this.#setSummary(summary);
	}

	async markRead(target: NotificationReadTarget) {
		const cleared = this.#applyRead(target, new Date().toISOString());
		const known =
			"all" in target
				? this.summary.unread
				: "category" in target
					? this.summary.byCategory[target.category]
					: this.unknownUnread;
		if (cleared.length === 0 && known === 0) return;
		this.#setSummary(optimisticSummary(this.summary, target, cleared), {
			persist: false,
		});
		const generation = ++this.#summaryGeneration;
		try {
			const result = await sdk.notifications.markRead(target);
			if (generation === this.#summaryGeneration)
				this.#setSummary(result.summary);
		} catch (error) {
			console.warn("[notifications] mark read failed", error);
			this.list.invalidate();
			void this.refreshSummary();
		}
	}

	#apply(payload: ChangedPayload) {
		++this.#summaryGeneration;
		for (const record of payload.upserted ?? []) {
			this.list.apply({
				id: record.id,
				fit: (filter) => fits(filter, record),
				merge: (current) =>
					current.revision > record.revision ||
					(current.revision === record.revision && current.readAt)
						? current
						: record,
				create: () => record,
				settled: true,
			});
		}
		if (payload.read) this.#applyRead(payload.read, payload.read.readAt);
		this.#setSummary(payload.summary);
		if (payload.upserted?.length)
			for (const listener of this.#listeners) listener(payload.upserted);
	}

	#applyRead(
		target: NotificationReadTarget & { readAt?: string },
		readAt: string,
	) {
		const cleared = new Map<string, NotificationRecord>();
		for (const filter of INBOX_FILTERS)
			for (const record of this.list.view(filter).items)
				if (matchesRead(record, target)) cleared.set(record.id, record);
		for (const id of cleared.keys())
			this.list.apply({
				id,
				fit: () => "keep",
				merge: (record) => (record.readAt ? record : { ...record, readAt }),
			});
		return [...cleared.values()];
	}

	#setSummary(
		summary: NotificationSummary,
		options: { persist?: boolean } = {},
	) {
		this.summary = summary;
		if (options.persist !== false) void this.#persistSummary(summary);
	}

	async #hydrateSummary() {
		const scope = await cacheKey("summary");
		if (!scope) return;
		const record = await idbGet<NotificationCacheRecord>(
			STORE,
			scope.key,
		).catch(() => null);
		if (
			record?.userKey === scope.userKey &&
			record.summary &&
			this.summary === EMPTY_SUMMARY
		)
			this.summary = record.summary as NotificationSummary;
	}

	async #persistSummary(summary: NotificationSummary) {
		const scope = await cacheKey("summary");
		if (!scope) return;
		await idbPut<NotificationCacheRecord>(STORE, {
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
