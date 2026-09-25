import type { RealtimeTaskRecord } from "@cohub/protocol";
import {
	type GenerationTaskView,
	generationOutputSource,
	isActiveGenerationTask,
	type TaskRunRecord,
	toGenerationTaskView,
} from "@neta-art/cohub";
import { getCacheUserKey } from "$lib/cache/keys";
import { MemoryLru } from "$lib/cache/memory-lru";
import {
	deleteTaskRunSummaries,
	readTaskRunSummaries,
	writeTaskRunSummaries,
} from "$lib/cache/repositories/task-runs-repo";
import { sdk } from "$lib/sdk";
import {
	mergeTaskRunPage,
	patchTaskRun,
	sortTaskRuns,
	upsertTaskRuns,
} from "./side-panel-data";

const GENERATION_TASK_TYPE = "generation";
const PAGE_SIZE = 40;
const HYDRATE_DELAY_MS = 120;
const HYDRATE_BATCH = 100;

export type GenerationFeedScope = {
	spaceId: string;
	sessionId: string | null;
};

type PageInfo = { hasMore: boolean; nextCursor: string | null };
type Snapshot = { runs: TaskRunRecord[]; pageInfo: PageInfo };

const EMPTY_PAGE: PageInfo = { hasMore: false, nextCursor: null };
/** Last list per scope, so returning to a chat renders synchronously. */
const snapshots = new MemoryLru<string, Snapshot>(24);
const views = new WeakMap<TaskRunRecord, GenerationTaskView>();
const liveFeeds = new Set<GenerationFeed>();
const pendingHydration = new Map<string, Set<string>>();
const hydrationTimers = new Map<string, ReturnType<typeof setTimeout>>();
const resolvingResults = new Map<string, Promise<unknown>>();

function scopeKey(scope: GenerationFeedScope) {
	return `${getCacheUserKey()}:${scope.spaceId}:${scope.sessionId ?? "*"}`;
}

function viewOf(run: TaskRunRecord) {
	let view = views.get(run);
	if (!view) {
		view = toGenerationTaskView(run);
		views.set(run, view);
	}
	return view;
}

/** Generation tasks of a Space or chat: cache first, then server, then realtime. */
export class GenerationFeed {
	readonly scope: GenerationFeedScope;
	readonly key: string;
	#runs = $state.raw<TaskRunRecord[]>([]);
	#started = false;
	#disposed = false;
	#version = 0;
	#arrivedIds = new Set<string>();

	pageInfo = $state.raw<PageInfo>(EMPTY_PAGE);
	ready = $state(false);
	loadingMore = $state(false);
	refreshing = $state(false);
	failed = $state(false);
	loadMoreFailed = $state(false);

	readonly tasks = $derived(this.#runs.map(viewOf));
	readonly activeCount = $derived(
		this.tasks.filter((task) => isActiveGenerationTask(task)).length,
	);

	constructor(scope: GenerationFeedScope) {
		this.scope = scope;
		this.key = scopeKey(scope);
		const snapshot = snapshots.get(this.key);
		if (snapshot) {
			this.#runs = snapshot.runs;
			this.pageInfo = snapshot.pageInfo;
			this.ready = true;
		}
		liveFeeds.add(this);
	}

	start() {
		if (this.#started || this.#disposed) return;
		this.#started = true;
		void this.#restoreThenRefresh();
	}

	dispose() {
		this.#disposed = true;
		this.#version += 1;
		liveFeeds.delete(this);
	}

	async refresh() {
		if (this.#disposed || !this.#started) return;
		const version = ++this.#version;
		this.#arrivedIds.clear();
		this.refreshing = true;
		try {
			const response = await sdk.tasks.list(this.#filters());
			if (version !== this.#version) return;
			this.#applyPage(response, null);
			this.failed = false;
			this.loadMoreFailed = false;
		} catch (error) {
			if (version === this.#version) this.failed = true;
			console.warn("[side-panel] failed to refresh generations", error);
		} finally {
			if (version === this.#version) {
				this.refreshing = false;
				this.ready = true;
			}
		}
	}

	async loadMore() {
		const cursor = this.pageInfo.nextCursor;
		if (!cursor || this.loadingMore || this.#disposed) return;
		this.loadingMore = true;
		this.loadMoreFailed = false;
		const version = this.#version;
		try {
			const response = await sdk.tasks.list({ ...this.#filters(), cursor });
			if (version === this.#version) this.#applyPage(response, cursor);
		} catch {
			if (version === this.#version) this.loadMoreFailed = true;
		} finally {
			this.loadingMore = false;
		}
	}

	run(taskRunId: string) {
		return this.#runs.find((run) => run.id === taskRunId);
	}

	upsert(runs: readonly TaskRunRecord[]) {
		// Unstarted feeds must still restore from cache when first shown.
		if (!this.#started) return;
		const accepted = this.#accept(runs);
		if (accepted.length === 0) return;
		const byId = new Map(this.#runs.map((run) => [run.id, run]));
		upsertTaskRuns(byId, accepted);
		this.#setRuns(sortTaskRuns([...byId.values()]), this.pageInfo);
	}

	/** Returns whether the full row should be fetched. */
	applyRealtime(task: RealtimeTaskRecord, changed: readonly string[]) {
		if (!this.#started || !this.#matches(task)) return false;
		const existing = this.#runs.find((run) => run.id === task.id);
		// Unloaded older runs arrive with their page, not at the list's end.
		if (!existing && !this.#withinLoaded(task.createdAt)) return false;
		const byId = new Map(this.#runs.map((run) => [run.id, run]));
		upsertTaskRuns(byId, [patchTaskRun(existing, task)]);
		this.#arrivedIds.add(task.id);
		this.#setRuns(sortTaskRuns([...byId.values()]), this.pageInfo);
		return (
			!existing?.payload ||
			changed.includes("result") ||
			(existing.status !== task.status &&
				(task.status === "completed" || task.status === "failed"))
		);
	}

	#withinLoaded(createdAt: string) {
		const oldest = this.#runs.at(-1);
		return (
			!oldest ||
			!this.pageInfo.hasMore ||
			(Date.parse(createdAt) || 0) >= (Date.parse(oldest.createdAt) || 0)
		);
	}

	#filters() {
		return {
			spaceId: this.scope.spaceId,
			...(this.scope.sessionId ? { sessionId: this.scope.sessionId } : {}),
			taskType: GENERATION_TASK_TYPE,
			limit: PAGE_SIZE,
		};
	}

	#matches(run: {
		spaceId: string | null;
		sessionId: string | null;
		taskType?: string;
		type?: string;
	}) {
		const type = run.taskType ?? run.type;
		return (
			type === GENERATION_TASK_TYPE &&
			run.spaceId === this.scope.spaceId &&
			(!this.scope.sessionId || run.sessionId === this.scope.sessionId)
		);
	}

	#applyPage(
		response: { runs?: TaskRunRecord[]; pageInfo?: PageInfo },
		cursor: string | null,
	) {
		const page = this.#accept(response.runs ?? []);
		const pageInfo = response.pageInfo ?? EMPTY_PAGE;
		const { runs, removedIds } = mergeTaskRunPage(this.#runs, page, {
			cursor,
			complete: !pageInfo.hasMore,
			keepIds: cursor === null ? this.#arrivedIds : undefined,
		});
		this.#setRuns(runs, pageInfo);
		const { spaceId } = this.scope;
		void writeTaskRunSummaries(spaceId, page).catch(() => undefined);
		if (removedIds.length > 0)
			void deleteTaskRunSummaries(spaceId, removedIds).catch(() => undefined);
	}

	#accept(runs: readonly TaskRunRecord[]) {
		return runs.filter((run) => this.#matches(run));
	}

	#setRuns(runs: TaskRunRecord[], pageInfo: PageInfo) {
		this.#runs = runs;
		this.pageInfo = pageInfo;
		this.ready = true;
		snapshots.set(this.key, { runs, pageInfo });
	}

	async #restoreThenRefresh() {
		if (!this.ready) {
			const version = this.#version;
			const cached = await readTaskRunSummaries(
				this.scope.spaceId,
				this.scope.sessionId,
			).catch(() => []);
			const runs = this.#accept(cached);
			if (version === this.#version && !this.ready && runs.length > 0) {
				this.#setRuns(sortTaskRuns(runs), {
					hasMore: true,
					nextCursor: null,
				});
			}
		}
		await this.refresh();
	}
}

async function flushHydration(spaceId: string) {
	hydrationTimers.delete(spaceId);
	const ids = [...(pendingHydration.get(spaceId) ?? [])];
	pendingHydration.delete(spaceId);
	for (let index = 0; index < ids.length; index += HYDRATE_BATCH) {
		const batch = ids.slice(index, index + HYDRATE_BATCH);
		try {
			const { runs } = await sdk.tasks.getMany(batch, { spaceId });
			if (runs.length === 0) continue;
			for (const feed of liveFeeds) {
				if (feed.scope.spaceId === spaceId) feed.upsert(runs);
			}
			void writeTaskRunSummaries(spaceId, runs).catch(() => undefined);
		} catch (error) {
			console.warn("[side-panel] failed to load generation tasks", {
				spaceId,
				error,
			});
		}
	}
}

function requestHydration(spaceId: string, taskRunId: string) {
	const pending = pendingHydration.get(spaceId) ?? new Set<string>();
	pending.add(taskRunId);
	pendingHydration.set(spaceId, pending);
	if (hydrationTimers.has(spaceId)) return;
	hydrationTimers.set(
		spaceId,
		setTimeout(() => void flushHydration(spaceId), HYDRATE_DELAY_MS),
	);
}

export function ingestGenerationTaskEvent(
	task: RealtimeTaskRecord,
	changed: readonly string[] = [],
) {
	if (task.type !== GENERATION_TASK_TYPE || !task.spaceId) return;
	let hydrate = false;
	for (const feed of liveFeeds) {
		if (feed.applyRealtime(task, changed)) hydrate = true;
	}
	if (hydrate) requestHydration(task.spaceId, task.id);
}

/** Only in-flight requests are shared; data URLs are too large to keep. */
export async function resolveGenerationOutputSource(
	taskRunId: string,
	outputIndex: number,
) {
	// One detail request serves every output of the task (the viewer resolves
	// neighbours together); only the chosen payload outlives it.
	let result = resolvingResults.get(taskRunId);
	if (!result) {
		result = sdk.tasks
			.get(taskRunId)
			.then((detail) => detail.run.result)
			.finally(() => resolvingResults.delete(taskRunId));
		resolvingResults.set(taskRunId, result);
	}
	return generationOutputSource(await result, outputIndex);
}
