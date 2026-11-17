import type { TaskRunRecord } from "@neta-art/cohub";
import {
	canUseUserScopedCache,
	getCacheUserKey,
	getCacheUserKeyAsync,
} from "#lib/cache/keys.ts";
import {
	readTaskRunSummaries,
	writeTaskRunSummaries,
	writeTaskRunSummary,
} from "#lib/cache/repositories/task-runs-repo.ts";

type TaskRunPatch = Partial<TaskRunRecord> & {
	id: string;
	type?: string;
	userId?: string | null;
};

type TaskRunsCacheEvent = {
	spaceId: string;
	runs: TaskRunRecord[];
};

const MAX_CACHED_RUNS = 500;
const runsByUserSpace = new Map<string, TaskRunRecord[]>();
const restoredUserSpaces = new Set<string>();

const taskRunTime = (run: Pick<TaskRunRecord, "updatedAt" | "createdAt">) =>
	Date.parse(run.updatedAt ?? run.createdAt ?? "") || 0;

function memoryKey(userKey: string, spaceId: string) {
	return `${userKey}:${spaceId}`;
}

function sortRuns(runs: TaskRunRecord[]) {
	return [...runs].sort((a, b) => taskRunTime(b) - taskRunTime(a));
}

function normalizeTaskRunPatch(
	patch: TaskRunPatch,
	existing?: TaskRunRecord | null,
): TaskRunRecord {
	const now = new Date().toISOString();
	return {
		id: patch.id,
		jobId: patch.jobId ?? existing?.jobId ?? patch.id,
		cronJobId: patch.cronJobId ?? existing?.cronJobId ?? null,
		taskType: patch.taskType ?? patch.type ?? existing?.taskType ?? "unknown",
		status: patch.status ?? existing?.status ?? "pending",
		payload: patch.payload ?? existing?.payload ?? null,
		result: patch.result ?? existing?.result ?? null,
		errorMessage: patch.errorMessage ?? existing?.errorMessage ?? null,
		attemptCount: patch.attemptCount ?? existing?.attemptCount ?? 0,
		spaceId: patch.spaceId ?? existing?.spaceId ?? null,
		sessionId: patch.sessionId ?? existing?.sessionId ?? null,
		turnId: patch.turnId ?? existing?.turnId ?? null,
		userUuid: patch.userUuid ?? patch.userId ?? existing?.userUuid ?? null,
		scheduledAt: patch.scheduledAt ?? existing?.scheduledAt ?? null,
		startedAt: patch.startedAt ?? existing?.startedAt ?? null,
		finishedAt: patch.finishedAt ?? existing?.finishedAt ?? null,
		createdAt: patch.createdAt ?? existing?.createdAt ?? now,
		updatedAt: patch.updatedAt ?? existing?.updatedAt ?? now,
	};
}

function emit(spaceId: string, runs: TaskRunRecord[]) {
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent<TaskRunsCacheEvent>("cohub:task-runs-cache-updated", {
			detail: { spaceId, runs },
		}),
	);
}

function currentMemoryUserKey() {
	const userKey = getCacheUserKey();
	return canUseUserScopedCache(userKey) ? userKey : null;
}

export function getCachedTaskRuns(spaceId: string) {
	const userKey = currentMemoryUserKey();
	if (!userKey) return [];
	return runsByUserSpace.get(memoryKey(userKey, spaceId)) ?? [];
}

export function clearTaskRunsMemoryCache() {
	runsByUserSpace.clear();
	restoredUserSpaces.clear();
}

export async function restoreCachedTaskRuns(
	spaceId: string,
	sessionId?: string | null,
) {
	const userKey = await getCacheUserKeyAsync();
	if (!canUseUserScopedCache(userKey)) return [];
	const key = memoryKey(userKey, spaceId);
	if (!sessionId && restoredUserSpaces.has(key)) {
		return runsByUserSpace.get(key) ?? [];
	}
	const restored = await readTaskRunSummaries(spaceId, sessionId);
	if (restored.length === 0) {
		if (!sessionId) restoredUserSpaces.add(key);
		return runsByUserSpace.get(key) ?? [];
	}
	const nextRuns = patchCachedTaskRuns(
		spaceId,
		(current) => {
			const byId = new Map(current.map((run) => [run.id, run]));
			for (const run of restored)
				byId.set(run.id, { ...(byId.get(run.id) ?? run), ...run });
			return Array.from(byId.values());
		},
		{ persist: false },
	);
	if (!sessionId) restoredUserSpaces.add(key);
	return nextRuns;
}

export function setCachedTaskRuns(spaceId: string, runs: TaskRunRecord[]) {
	const nextRuns = sortRuns(runs).slice(0, MAX_CACHED_RUNS);
	const userKey = currentMemoryUserKey();
	if (userKey) runsByUserSpace.set(memoryKey(userKey, spaceId), nextRuns);
	// Repo resolves identity before write; fire-and-forget is fine for persistence.
	void writeTaskRunSummaries(spaceId, nextRuns).catch(() => undefined);
	emit(spaceId, nextRuns);
	return nextRuns;
}

export function patchCachedTaskRuns(
	spaceId: string,
	updater: (runs: TaskRunRecord[]) => TaskRunRecord[],
	options?: { persist?: boolean },
) {
	const userKey = currentMemoryUserKey();
	const current = userKey
		? (runsByUserSpace.get(memoryKey(userKey, spaceId)) ?? [])
		: [];
	const nextRuns = sortRuns(updater(current)).slice(0, MAX_CACHED_RUNS);
	if (userKey) runsByUserSpace.set(memoryKey(userKey, spaceId), nextRuns);
	if (options?.persist !== false)
		void writeTaskRunSummaries(spaceId, nextRuns).catch(() => undefined);
	emit(spaceId, nextRuns);
	return nextRuns;
}

export function mergeCachedTaskRun(spaceId: string, patch: TaskRunPatch) {
	let merged: TaskRunRecord | null = null;
	const runs = patchCachedTaskRuns(
		spaceId,
		(currentRuns) => {
			const existing = currentRuns.find((run) => run.id === patch.id) ?? null;
			merged = normalizeTaskRunPatch(patch, existing);
			if (!existing) return [merged, ...currentRuns];
			return currentRuns.map((run) =>
				run.id === patch.id ? (merged as TaskRunRecord) : run,
			);
		},
		{ persist: false },
	);
	if (merged)
		void writeTaskRunSummary(spaceId, merged as TaskRunRecord).catch(
			() => undefined,
		);
	return runs;
}

export function mergeCachedCronJobTaskRuns(
	spaceId: string,
	cronJobId: string,
	runs: TaskRunRecord[],
) {
	return patchCachedTaskRuns(spaceId, (currentRuns) => {
		const incomingIds = new Set(runs.map((run) => run.id));
		return [
			...runs,
			...currentRuns.filter(
				(run) => run.cronJobId !== cronJobId || !incomingIds.has(run.id),
			),
		];
	});
}

export function onTaskRunsCacheUpdated(
	handler: (event: TaskRunsCacheEvent) => void,
) {
	const listener = (event: Event) => {
		const custom = event as CustomEvent<TaskRunsCacheEvent>;
		if (!custom.detail?.spaceId) return;
		handler(custom.detail);
	};
	if (typeof window !== "undefined") {
		window.addEventListener("cohub:task-runs-cache-updated", listener);
	}
	return () => {
		if (typeof window !== "undefined") {
			window.removeEventListener("cohub:task-runs-cache-updated", listener);
		}
	};
}
