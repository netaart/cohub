import type { TaskRunRecord } from "@neta-art/cohub";
import {
	idbDelete,
	idbDeleteWhere,
	idbGet,
	idbGetAllByIndex,
	idbPut,
	type TaskRunDetailCacheRecord,
	type TaskRunSummaryCacheRecord,
} from "$lib/cache/db";
import {
	canUseUserScopedCache,
	getCacheUserKeyAsync,
	taskRunKey,
} from "$lib/cache/keys";

const SUMMARY_LIMIT_PER_SPACE = 500;
const DETAIL_LIMIT_PER_SPACE = 100;
const SUMMARY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DETAIL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function now() {
	return Date.now();
}

function sortRecords<T extends { updatedAt: number }>(records: T[]) {
	return [...records].sort((a, b) => b.updatedAt - a.updatedAt);
}

async function resolveUserKey() {
	const userKey = await getCacheUserKeyAsync();
	return canUseUserScopedCache(userKey) ? userKey : null;
}

function toSummaryRecord(
	userKey: string,
	spaceId: string,
	run: TaskRunRecord,
): TaskRunSummaryCacheRecord {
	const timestamp = now();
	return {
		key: taskRunKey(userKey, spaceId, run.id),
		userKey,
		spaceId,
		sessionId: run.sessionId,
		turnId: run.turnId,
		taskRunId: run.id,
		taskType: run.taskType,
		status: run.status,
		run,
		updatedAt: Date.parse(run.updatedAt ?? "") || timestamp,
		lastAccessedAt: timestamp,
	};
}

function toDetailRecord(
	userKey: string,
	spaceId: string,
	run: TaskRunRecord,
	progress: unknown = null,
): TaskRunDetailCacheRecord {
	const timestamp = now();
	return {
		key: taskRunKey(userKey, spaceId, run.id),
		userKey,
		spaceId,
		sessionId: run.sessionId,
		turnId: run.turnId,
		taskRunId: run.id,
		taskType: run.taskType,
		run,
		progress,
		updatedAt: Date.parse(run.updatedAt ?? "") || timestamp,
		lastAccessedAt: timestamp,
	};
}

async function pruneStore<
	T extends {
		key: string;
		userKey: string;
		spaceId: string;
		updatedAt: number;
	},
>(
	store: "task_run_summaries" | "task_run_details",
	userKey: string,
	spaceId: string,
	limit: number,
	ttlMs: number,
) {
	const records = await idbGetAllByIndex<T>(
		store,
		"by_user_space",
		IDBKeyRange.only([userKey, spaceId]),
	);
	const cutoff = now() - ttlMs;
	const keep = new Set(
		sortRecords(records.filter((record) => record.updatedAt >= cutoff))
			.slice(0, limit)
			.map((record) => record.key),
	);
	await idbDeleteWhere<T>(
		store,
		(record) =>
			record.userKey === userKey &&
			record.spaceId === spaceId &&
			!keep.has(record.key),
	);
}

export async function readTaskRunSummaries(
	spaceId: string,
	sessionId?: string | null,
) {
	const userKey = await resolveUserKey();
	if (!userKey) return [];
	const records = sessionId
		? await idbGetAllByIndex<TaskRunSummaryCacheRecord>(
				"task_run_summaries",
				"by_user_space_session",
				IDBKeyRange.only([userKey, spaceId, sessionId]),
			)
		: await idbGetAllByIndex<TaskRunSummaryCacheRecord>(
				"task_run_summaries",
				"by_user_space",
				IDBKeyRange.only([userKey, spaceId]),
			);
	const cutoff = now() - SUMMARY_TTL_MS;
	return sortRecords(
		records.filter((record) => record.updatedAt >= cutoff),
	).map((record) => record.run);
}

export async function readTaskRunDetail(spaceId: string, taskRunId: string) {
	const userKey = await resolveUserKey();
	if (!userKey) return null;
	const record = await idbGet<TaskRunDetailCacheRecord>(
		"task_run_details",
		taskRunKey(userKey, spaceId, taskRunId),
	);
	if (!record || now() - record.updatedAt > DETAIL_TTL_MS) return null;
	return { run: record.run, progress: record.progress };
}

export async function writeTaskRunSummary(spaceId: string, run: TaskRunRecord) {
	const userKey = await resolveUserKey();
	if (!userKey) return;
	await idbPut("task_run_summaries", toSummaryRecord(userKey, spaceId, run));
	void pruneStore<TaskRunSummaryCacheRecord>(
		"task_run_summaries",
		userKey,
		spaceId,
		SUMMARY_LIMIT_PER_SPACE,
		SUMMARY_TTL_MS,
	).catch(() => undefined);
}

export async function writeTaskRunSummaries(
	spaceId: string,
	runs: TaskRunRecord[],
) {
	const userKey = await resolveUserKey();
	if (!userKey) return;
	await Promise.all(
		runs.map((run) =>
			idbPut("task_run_summaries", toSummaryRecord(userKey, spaceId, run)),
		),
	);
	void pruneStore<TaskRunSummaryCacheRecord>(
		"task_run_summaries",
		userKey,
		spaceId,
		SUMMARY_LIMIT_PER_SPACE,
		SUMMARY_TTL_MS,
	).catch(() => undefined);
}

export async function deleteTaskRunSummaries(
	spaceId: string,
	taskRunIds: readonly string[],
) {
	const userKey = await resolveUserKey();
	if (!userKey) return;
	await Promise.all(
		taskRunIds.map((taskRunId) =>
			idbDelete("task_run_summaries", taskRunKey(userKey, spaceId, taskRunId)),
		),
	);
}

export async function writeTaskRunDetail(
	spaceId: string,
	run: TaskRunRecord,
	progress: unknown = null,
) {
	const userKey = await resolveUserKey();
	if (!userKey) return;
	await Promise.all([
		idbPut("task_run_summaries", toSummaryRecord(userKey, spaceId, run)),
		idbPut("task_run_details", toDetailRecord(userKey, spaceId, run, progress)),
	]);
	void pruneStore<TaskRunSummaryCacheRecord>(
		"task_run_summaries",
		userKey,
		spaceId,
		SUMMARY_LIMIT_PER_SPACE,
		SUMMARY_TTL_MS,
	).catch(() => undefined);
	void pruneStore<TaskRunDetailCacheRecord>(
		"task_run_details",
		userKey,
		spaceId,
		DETAIL_LIMIT_PER_SPACE,
		DETAIL_TTL_MS,
	).catch(() => undefined);
}
