import type { ContentBlock } from "@cohub/protocol/core";
import { APP_ACTION_EXECUTION_SOURCE } from "@cohub/protocol/task";
import type { TaskRunRecord } from "@neta-art/cohub";
import { toIntlTag } from "$lib/i18n/format";
import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";
import { asRecord } from "../space-utils";

export function taskTypeLabel(taskType: string, locale?: Locale) {
	if (taskType === "run_command")
		return m.task_type_run_command({}, { locale });
	if (taskType === "save_checkpoint")
		return m.task_type_save_checkpoint({}, { locale });
	return taskType;
}

export type TaskRunRealtimePatch = Partial<TaskRunRecord> & {
	id: string;
	type?: string;
	userId?: string | null;
};

const taskRunSortTime = (run: Pick<TaskRunRecord, "updatedAt" | "createdAt">) =>
	Date.parse(run.updatedAt ?? run.createdAt ?? "") || 0;

export function mergeTaskRunRecord(
	current: TaskRunRecord | null,
	patch: TaskRunRealtimePatch,
	spaceId?: string,
): TaskRunRecord {
	const now = new Date().toISOString();
	return {
		id: patch.id,
		jobId: patch.jobId ?? current?.jobId ?? patch.id,
		cronJobId: patch.cronJobId ?? current?.cronJobId ?? null,
		taskType: patch.taskType ?? patch.type ?? current?.taskType ?? "unknown",
		status: patch.status ?? current?.status ?? "pending",
		payload: patch.payload ?? current?.payload ?? null,
		result: patch.result ?? current?.result ?? null,
		errorMessage: patch.errorMessage ?? current?.errorMessage ?? null,
		attemptCount: patch.attemptCount ?? current?.attemptCount ?? 0,
		spaceId: patch.spaceId ?? current?.spaceId ?? spaceId ?? "",
		sessionId: patch.sessionId ?? current?.sessionId ?? null,
		turnId: patch.turnId ?? current?.turnId ?? null,
		userUuid: patch.userUuid ?? patch.userId ?? current?.userUuid ?? null,
		userProfile: patch.userProfile ?? current?.userProfile,
		scheduledAt: patch.scheduledAt ?? current?.scheduledAt ?? null,
		startedAt: patch.startedAt ?? current?.startedAt ?? null,
		finishedAt: patch.finishedAt ?? current?.finishedAt ?? null,
		createdAt: patch.createdAt ?? current?.createdAt ?? now,
		updatedAt: patch.updatedAt ?? current?.updatedAt ?? now,
	};
}

export function mergeTaskRunList(
	runs: TaskRunRecord[],
	patch: TaskRunRealtimePatch,
	spaceId?: string,
) {
	const existing = runs.find((run) => run.id === patch.id) ?? null;
	const nextRun = mergeTaskRunRecord(existing, patch, spaceId);
	const nextRuns = existing
		? runs.map((run) => (run.id === patch.id ? nextRun : run))
		: [nextRun, ...runs];
	return [...nextRuns].sort((a, b) => taskRunSortTime(b) - taskRunSortTime(a));
}

export function taskHasResult(run: TaskRunRecord): boolean {
	return run.result !== null && run.result !== undefined;
}

export function taskAttemptsLabel(run: TaskRunRecord, locale?: Locale): string {
	return run.attemptCount === 1
		? m.task_attempts_one({ count: run.attemptCount }, { locale })
		: m.task_attempts_many({ count: run.attemptCount }, { locale });
}

export type DisplaySafeJsonOptions = {
	maxStringLength?: number;
	maxArrayItems?: number;
	maxObjectKeys?: number;
	maxDepth?: number;
	/** User-visible truncation counts follow this locale; defaults to base (`en`). */
	locale?: Locale;
};

type DisplaySafeJsonResolvedOptions = Required<
	Omit<DisplaySafeJsonOptions, "locale">
> & {
	locale?: Locale;
};

const DEFAULT_DISPLAY_SAFE_JSON_OPTIONS: DisplaySafeJsonResolvedOptions = {
	maxStringLength: 24_000,
	maxArrayItems: 200,
	maxObjectKeys: 200,
	maxDepth: 10,
};

function toDisplaySafeJsonValue(
	value: unknown,
	options: DisplaySafeJsonResolvedOptions = DEFAULT_DISPLAY_SAFE_JSON_OPTIONS,
	depth = 0,
	seen = new WeakSet<object>(),
): unknown {
	const tag = toIntlTag(options.locale);
	if (typeof value === "string") {
		if (value.length <= options.maxStringLength) return value;
		const omitted = value.length - options.maxStringLength;
		return `${value.slice(0, options.maxStringLength)}\n… [truncated ${omitted.toLocaleString(tag)} chars]`;
	}
	if (
		value === null ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "undefined"
	) {
		return value;
	}
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "function") return "[function]";
	if (typeof value !== "object") return String(value);
	if (depth >= options.maxDepth) return "[max depth reached]";
	if (seen.has(value)) return "[circular]";
	seen.add(value);
	if (Array.isArray(value)) {
		const items = value
			.slice(0, options.maxArrayItems)
			.map((item) => toDisplaySafeJsonValue(item, options, depth + 1, seen));
		if (value.length > options.maxArrayItems) {
			items.push(
				`[truncated ${(value.length - options.maxArrayItems).toLocaleString(tag)} items]`,
			);
		}
		seen.delete(value);
		return items;
	}
	const entries = Object.entries(value as Record<string, unknown>);
	const safeEntries = entries
		.slice(0, options.maxObjectKeys)
		.map(([key, item]) => [
			key,
			toDisplaySafeJsonValue(item, options, depth + 1, seen),
		]);
	if (entries.length > options.maxObjectKeys) {
		safeEntries.push([
			"__truncated__",
			`truncated ${(entries.length - options.maxObjectKeys).toLocaleString(tag)} keys`,
		]);
	}
	seen.delete(value);
	return Object.fromEntries(safeEntries);
}

export function displaySafeJson(
	value: unknown,
	options?: DisplaySafeJsonOptions,
): string {
	const merged = { ...DEFAULT_DISPLAY_SAFE_JSON_OPTIONS, ...options };
	return JSON.stringify(toDisplaySafeJsonValue(value, merged), null, 2);
}

export function checkpointIdFromTaskRun(
	run: TaskRunRecord | null | undefined,
): string | null {
	const result = asRecord(run?.result);
	const checkpointId = result?.checkpointId;
	return typeof checkpointId === "string" && checkpointId.trim()
		? checkpointId
		: null;
}

export function saveCheckpointProgressLabel(
	progress: unknown,
	locale?: Locale,
): string | null {
	const stage = asRecord(progress)?.stage;
	if (typeof stage !== "string" || !stage.trim()) return null;
	const labels: Record<string, string> = {
		prepare: m.task_stage_preparing({}, { locale }),
		scan_workspace: m.task_stage_scanning({}, { locale }),
		upload_assets: m.task_stage_uploading({}, { locale }),
		bundle_git_repos: m.task_stage_bundling({}, { locale }),
		commit_checkpoint: m.task_stage_commit({}, { locale }),
		materialize_latest: m.task_stage_materialize({}, { locale }),
		write_checkpoint_record: m.task_stage_write({}, { locale }),
		mirror_repository: m.task_stage_mirror({}, { locale }),
		// Keep rendering progress emitted by older workers during rolling deploys.
		mirror_gitea: m.task_stage_mirror({}, { locale }),
		completed: m.task_stage_completed({}, { locale }),
	};
	return labels[stage] ?? stage.replaceAll("_", " ");
}

function isContentBlockArray(value: unknown): value is ContentBlock[] {
	return (
		Array.isArray(value) &&
		value.every((block) => {
			return (
				block &&
				typeof block === "object" &&
				typeof (block as { type?: unknown }).type === "string"
			);
		})
	);
}

function contentBlocksFrom(value: unknown): ContentBlock[] {
	if (!value || typeof value !== "object") return [];
	const record = value as { content?: unknown; output?: unknown };
	if (isContentBlockArray(record.content)) return record.content;
	if (isContentBlockArray(record.output)) return record.output;
	return [];
}

export function runCommandContent(
	run: TaskRunRecord,
	progress: unknown,
): ContentBlock[] {
	const resultRecord = asRecord(run.result);
	const progressRecord = asRecord(progress);
	const resultContent = contentBlocksFrom(run.result);
	const progressContent = contentBlocksFrom(progress);
	const content = resultContent.length > 0 ? resultContent : progressContent;
	if (content.length > 0) return content;

	const output = resultRecord?.output ?? progressRecord?.output;
	return typeof output === "string" && output
		? [{ type: "text", text: output }]
		: [];
}

export function taskOutputContent(
	run: TaskRunRecord,
	progress: unknown,
): ContentBlock[] {
	if (run.taskType === "generation") return [];
	if (run.taskType === "run_command") return runCommandContent(run, progress);
	const resultContent = contentBlocksFrom(run.result);
	if (resultContent.length > 0) return resultContent;
	return contentBlocksFrom(progress);
}

export function generationOutputBlocks(
	run: TaskRunRecord,
): Record<string, unknown>[] {
	if (run.taskType !== "generation") return [];
	const result = asRecord(run.result);
	const output = result?.output;
	return Array.isArray(output)
		? (output.filter((block) => !!asRecord(block)) as Record<string, unknown>[])
		: [];
}

export function generationBlockText(
	block: Record<string, unknown>,
): string | null {
	if (block.type !== "text") return null;
	const text = block.text ?? block.content ?? block.value;
	return typeof text === "string" ? text : null;
}

export function generationBlockSource(
	block: Record<string, unknown>,
): string | null {
	const source = asRecord(block.source);
	const directUrl = source?.url ?? source?.src ?? block.url ?? block.src;
	if (typeof directUrl === "string" && directUrl.trim()) {
		return directUrl.trim();
	}
	const data =
		source?.data ??
		source?.base64 ??
		source?.contentBase64 ??
		block.data ??
		block.base64 ??
		block.contentBase64;
	if (typeof data !== "string" || !data.trim()) return null;
	const mediaType =
		source?.mediaType ??
		source?.media_type ??
		source?.mimeType ??
		block.mediaType ??
		block.media_type ??
		block.mimeType;
	const fallbackType =
		block.type === "audio"
			? "audio/mpeg"
			: block.type === "video"
				? "video/mp4"
				: "image/png";
	return `data:${typeof mediaType === "string" ? mediaType : fallbackType};base64,${data}`;
}

export function generationBlockLabel(
	block: Record<string, unknown>,
	index: number,
): string {
	const name = block.name ?? block.filename ?? block.alt;
	return typeof name === "string" && name.trim()
		? name.trim()
		: `Output ${index + 1}`;
}

export function generationBlockMeta(
	block: Record<string, unknown>,
): string | null {
	const source = asRecord(block.source);
	const mediaType =
		source?.mediaType ??
		source?.media_type ??
		source?.mimeType ??
		block.mediaType ??
		block.media_type ??
		block.mimeType;
	const parts = [
		typeof block.type === "string" ? block.type : null,
		typeof mediaType === "string" ? mediaType : null,
	].filter(Boolean);
	return parts.length > 0 ? parts.join(" · ") : null;
}

export function taskRawResult(run: TaskRunRecord): unknown {
	return run.result ?? null;
}

export function taskContextLabel(run: TaskRunRecord, locale?: Locale): string {
	if (run.cronJobId) return m.task_from_cronjob({}, { locale });
	return m.task_one_time({}, { locale });
}

export function taskIsStreaming(run: TaskRunRecord): boolean {
	return run.status === "pending" || run.status === "running";
}

export function appActionName(
	run: Pick<TaskRunRecord, "payload">,
): string | null {
	const payload = asRecord(run.payload);
	const data = asRecord(payload?.data);
	const action = data?.action;
	return data?.source === APP_ACTION_EXECUTION_SOURCE &&
		typeof action === "string" &&
		action.trim()
		? action.trim()
		: null;
}

export function appActionInput(run: TaskRunRecord): unknown {
	const payload = asRecord(run.payload);
	const data = asRecord(payload?.data);
	return data?.source === APP_ACTION_EXECUTION_SOURCE &&
		Object.hasOwn(data, "actionInput")
		? data.actionInput
		: null;
}

export function runCommandPayload(run: TaskRunRecord) {
	const payload =
		run.payload && typeof run.payload === "object"
			? (run.payload as { data?: unknown })
			: null;
	const data =
		payload?.data && typeof payload.data === "object"
			? (payload.data as Record<string, unknown>)
			: null;
	return {
		command: typeof data?.command === "string" ? data.command : "",
		cwd: typeof data?.cwd === "string" ? data.cwd : "/workspace",
	};
}

export function runCommandResultMeta(run: TaskRunRecord) {
	const result =
		run.result && typeof run.result === "object"
			? (run.result as Record<string, unknown>)
			: null;
	return {
		exitCode: typeof result?.exitCode === "number" ? result.exitCode : null,
		durationMs:
			typeof result?.durationMs === "number" ? result.durationMs : null,
		truncated: Boolean(result?.truncated),
	};
}

export function formatDurationMs(ms: number | null, locale?: Locale) {
	if (ms === null) return "—";
	const zh = toIntlTag(locale) === "zh-CN";
	if (ms < 1000) return `${ms}${zh ? "毫秒" : "ms"}`;
	return `${(ms / 1000).toFixed(1)}${zh ? "秒" : "s"}`;
}

export function taskRunStatusBadge(run: TaskRunRecord, locale?: Locale) {
	switch (run.status) {
		case "completed":
			return {
				label: m.task_status_completed({}, { locale }),
				color: "text-status-running",
				dot: "bg-status-running",
			};
		case "failed":
			return {
				label: m.task_status_failed({}, { locale }),
				color: "text-status-error",
				dot: "bg-status-error",
			};
		case "running":
			return {
				label: m.task_status_running({}, { locale }),
				color: "text-info",
				dot: "bg-info",
			};
		case "pending":
			return {
				label: m.task_status_pending({}, { locale }),
				color: "text-warning",
				dot: "bg-warning",
			};
		default:
			return {
				label: run.status,
				color: "text-text-placeholder",
				dot: "bg-text-placeholder",
			};
	}
}

export function taskRunDuration(run: TaskRunRecord, locale?: Locale): string {
	if (!run.startedAt || !run.finishedAt) return "—";
	const ms = Math.max(
		0,
		new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime(),
	);
	return formatDurationMs(ms, locale);
}
