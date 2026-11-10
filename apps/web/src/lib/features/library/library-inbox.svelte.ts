import type {
	ChannelEnvelope,
	UserAppFilter,
	UserAppListItem,
	UserCronJobFilter,
	UserCronJobListItem,
	UserListPage,
	UserSessionSpaceSummary,
} from "@neta-art/cohub";
import { idbGet, idbPut, type LibraryListCacheRecord } from "$lib/cache/db";
import { canUseUserScopedCache, getCacheUserKeyAsync } from "$lib/cache/keys";
import { APPS_CHANGED_EVENT } from "$lib/features/app/app-realtime";
import { CRONJOBS_UPDATED_EVENT } from "$lib/features/space/resources/space-cronjobs-feed.svelte";
import type { LibraryItemEntity } from "$lib/library-routes";
import { LiveList, type LivePage } from "$lib/lists/live-list.svelte";
import { sdk } from "$lib/sdk";

const PAGE_SIZE = 50;

export type LibraryItem = UserAppListItem | UserCronJobListItem;

type Kind = "apps" | "cronjobs";

const byTimeDesc =
	<T extends { id: string }>(at: (item: T) => string | null) =>
	(a: T, b: T) =>
		(Date.parse(at(b) ?? "") || 0) - (Date.parse(at(a) ?? "") || 0) ||
		(a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

async function cacheKey(kind: Kind, filter: string) {
	const userKey = await getCacheUserKeyAsync();
	return canUseUserScopedCache(userKey)
		? { userKey, key: `${encodeURIComponent(userKey)}:${kind}:${filter}` }
		: null;
}

function libraryList<F extends string, T extends { id: string }>(
	kind: Kind,
	options: {
		load: (filter: F, cursor: string | null) => Promise<UserListPage<T>>;
		sortAt: (item: T) => string | null;
		views: number;
	},
) {
	const compare = byTimeDesc(options.sortAt);
	return new LiveList<F, T, null>({
		name: `library-${kind}`,
		pageSize: PAGE_SIZE,
		memoLimit: options.views,
		key: (filter) => filter,
		id: (item) => item.id,
		compare: () => compare,
		emptyExtra: () => null,
		mergeExtra: () => null,
		fetch: async (filter, cursor) => {
			const page = await options.load(filter, cursor);
			return {
				items: page.items,
				hasMore: page.pageInfo.hasMore,
				cursor: page.pageInfo.nextCursor,
				extra: null,
			};
		},
		read: async (filter): Promise<LivePage<T, null> | null> => {
			const scope = await cacheKey(kind, filter);
			if (!scope) return null;
			const record = await idbGet<LibraryListCacheRecord>(
				"library_lists",
				scope.key,
			);
			if (record?.userKey !== scope.userKey) return null;
			return {
				items: record.items as T[],
				hasMore: record.hasMore,
				cursor: null,
				extra: null,
			};
		},
		write: async (filter, snapshot) => {
			const scope = await cacheKey(kind, filter);
			if (!scope) return;
			await idbPut<LibraryListCacheRecord>("library_lists", {
				key: scope.key,
				userKey: scope.userKey,
				items: snapshot.items,
				hasMore: snapshot.hasMore,
				updatedAt: Date.now(),
			});
		},
	});
}

class LibraryInbox {
	readonly apps = libraryList<UserAppFilter, UserAppListItem>("apps", {
		load: (filter, cursor) =>
			sdk.user.listApps({ filter, cursor, limit: PAGE_SIZE }),
		sortAt: (app) => app.updatedAt,
		views: 3,
	});

	readonly cronJobs = libraryList<UserCronJobFilter, UserCronJobListItem>(
		"cronjobs",
		{
			load: (filter, cursor) =>
				sdk.user.listCronJobs({ filter, cursor, limit: PAGE_SIZE }),
			sortAt: (job) => job.createdAt,
			views: 4,
		},
	);

	filters = $state<{
		apps: UserAppFilter;
		scheduled: UserCronJobFilter;
	}>({ apps: "mine", scheduled: "mine" });

	#stop: (() => void) | null = null;

	start(): () => void {
		if (this.#stop) return this.#stop;
		this.apps.start();
		this.cronJobs.start();
		const stopEvents = sdk.onUserEvent((event) => this.#handleEvent(event));
		const onApps = () => this.apps.invalidate();
		const onCronJobs = () => this.cronJobs.invalidate();
		window.addEventListener(APPS_CHANGED_EVENT, onApps);
		window.addEventListener(CRONJOBS_UPDATED_EVENT, onCronJobs);
		this.#stop = () => {
			stopEvents();
			window.removeEventListener(APPS_CHANGED_EVENT, onApps);
			window.removeEventListener(CRONJOBS_UPDATED_EVENT, onCronJobs);
			this.apps.stop();
			this.cronJobs.stop();
			this.#stop = null;
		};
		return this.#stop;
	}

	#list(entity: LibraryItemEntity) {
		return (entity === "apps"
			? this.apps
			: this.cronJobs) as unknown as LiveList<string, LibraryItem, null>;
	}

	view(entity: LibraryItemEntity) {
		return this.#list(entity).view(this.filters[entity]);
	}

	watch(entity: LibraryItemEntity) {
		return this.#list(entity).watch(this.filters[entity]);
	}

	loadMore(entity: LibraryItemEntity) {
		return this.#list(entity).loadMore(this.filters[entity]);
	}

	sync(entity: LibraryItemEntity) {
		return this.#list(entity).sync(this.filters[entity]);
	}

	setCronJobEnabled(id: string, enabled: boolean) {
		this.cronJobs.apply({
			id,
			fit: (filter) =>
				filter === "paused" ? (enabled ? "out" : "unknown") : "keep",
			merge: (job) => ({
				...job,
				enabled,
				nextRunAt: enabled ? job.nextRunAt : null,
			}),
		});
	}

	removeCronJob(id: string) {
		this.cronJobs.remove(id);
	}

	spaceSummary(spaceId: string): UserSessionSpaceSummary | null {
		const owns = (item: { space: UserSessionSpaceSummary | null }) =>
			item.space?.id === spaceId;
		return (
			this.apps.findBy(owns)?.space ?? this.cronJobs.findBy(owns)?.space ?? null
		);
	}

	#handleEvent(event: ChannelEnvelope) {
		if (event.type === "space.list.changed") {
			this.apps.invalidate();
			this.cronJobs.invalidate();
			return;
		}
		if (event.type === "app.list.changed") this.apps.invalidate();
		else if (event.type === "cronjob.list.changed") this.cronJobs.invalidate();
	}
}

export const libraryInbox = new LibraryInbox();
