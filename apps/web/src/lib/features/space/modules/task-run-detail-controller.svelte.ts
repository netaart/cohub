import type { ChannelEnvelope } from "@cohub/protocol/realtime";
import type { TaskRunBoard, TaskRunRecord } from "@neta-art/cohub";
import { untrack } from "svelte";
import {
	readTaskRunDetail,
	writeTaskRunDetail,
} from "#lib/cache/repositories/task-runs-repo.ts";
import {
	displaySafeJson,
	mergeTaskRunRecord,
} from "#lib/resource-kit/task-run.ts";
import { sdk } from "#lib/sdk.ts";
import { createKeyedRouteRequestGuard } from "./route-request-guard.ts";

export type TaskRealtimeEvent = {
	spaceId: string;
	payload: ChannelEnvelope;
	seq: number;
};

export function isActiveTaskRun(run: TaskRunRecord | null | undefined) {
	return run?.status === "pending" || run?.status === "running";
}

export function createTaskRunDetailController(options: {
	getSpaceId: () => string;
	getTaskId: () => string | null;
	onDetailLoaded?: (run: TaskRunRecord | null) => void;
}) {
	let detail = $state<TaskRunRecord | null>(null);
	let loading = $state(false);
	let error = $state("");
	let progress = $state<unknown>(null);
	let boards = $state.raw<TaskRunBoard[]>([]);
	let copiedField = $state<"id" | "payload" | "result" | null>(null);
	let routeStateKey = "";
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let copiedTimer: ReturnType<typeof setTimeout> | null = null;
	let refreshInFlight: Promise<void> | null = null;
	let refreshInFlightTaskId: string | null = null;

	function notify(run: TaskRunRecord | null) {
		options.onDetailLoaded?.(run);
	}

	function clearPoll() {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = null;
	}

	function ensurePoll(targetTaskId: string, intervalMs = 5000) {
		if (pollTimer) return;
		pollTimer = setInterval(() => void refresh(targetTaskId), intervalMs);
	}

	async function refresh(targetTaskId: string, showLoading = false) {
		if (refreshInFlight && refreshInFlightTaskId === targetTaskId) {
			return refreshInFlight;
		}
		const requestSpaceId = options.getSpaceId();
		const guard = createKeyedRouteRequestGuard({
			captureKey: () => `${options.getSpaceId()}:${options.getTaskId() ?? ""}`,
		});
		refreshInFlightTaskId = targetTaskId;
		let request: Promise<void> = Promise.resolve();
		request = (async () => {
			if (showLoading) loading = true;
			error = "";
			try {
				const {
					run,
					progress: nextProgress,
					boards: nextBoards = [],
				} = await sdk.tasks.get(targetTaskId, { include: ["boards"] });
				if (!guard.isCurrent()) return;
				detail = run;
				notify(run);
				progress = nextProgress;
				boards = nextBoards;
				void writeTaskRunDetail(requestSpaceId, run, nextProgress).catch(
					() => undefined,
				);
				if (isActiveTaskRun(run)) ensurePoll(targetTaskId);
				else clearPoll();
			} catch (cause) {
				if (!guard.isCurrent()) return;
				detail = null;
				boards = [];
				notify(null);
				error = cause instanceof Error ? cause.message : "Failed to load task";
				clearPoll();
			} finally {
				if (guard.isCurrent()) loading = false;
				if (refreshInFlight === request) {
					refreshInFlight = null;
					refreshInFlightTaskId = null;
				}
			}
		})();
		refreshInFlight = request;
		return request;
	}

	async function load(targetTaskId: string) {
		clearPoll();
		progress = null;
		boards = [];
		const requestSpaceId = options.getSpaceId();
		const cached = await readTaskRunDetail(requestSpaceId, targetTaskId).catch(
			() => null,
		);
		if (
			options.getSpaceId() === requestSpaceId &&
			options.getTaskId() === targetTaskId &&
			cached
		) {
			detail = cached.run;
			progress = cached.progress;
			notify(cached.run);
		}
		await refresh(targetTaskId, !cached);
	}

	function applyRealtime(payload: ChannelEnvelope) {
		const eventPayload = payload.payload as {
			task?: Partial<TaskRunRecord> & {
				id?: string;
				type?: string;
				userId?: string | null;
			};
			progress?: unknown;
		};
		const task = eventPayload.task;
		if (!task?.id || task.id !== options.getTaskId()) return;
		const wasActive = isActiveTaskRun(detail);
		detail = mergeTaskRunRecord(
			detail,
			{
				...(task as Partial<TaskRunRecord>),
				id: task.id,
				type: task.type,
				userId: task.userId,
			},
			options.getSpaceId(),
		);
		notify(detail);
		if ("progress" in eventPayload) progress = eventPayload.progress;
		void writeTaskRunDetail(options.getSpaceId(), detail, progress).catch(
			() => undefined,
		);
		if (isActiveTaskRun(detail)) {
			ensurePoll(task.id);
			return;
		}
		clearPoll();
		if (wasActive || !detail.result) void refresh(task.id);
	}

	async function copyField(field: "id" | "payload" | "result", value: unknown) {
		try {
			const text = typeof value === "string" ? value : displaySafeJson(value);
			await navigator.clipboard.writeText(text);
			copiedField = field;
			if (copiedTimer) clearTimeout(copiedTimer);
			copiedTimer = setTimeout(() => {
				copiedField = null;
			}, 1600);
		} catch {
			// Clipboard API can fail in non-secure contexts or due to permissions
		}
	}

	function syncRoute() {
		const taskId = options.getTaskId();
		const stateKey = `${options.getSpaceId()}:${taskId ?? ""}`;
		if (routeStateKey === stateKey) return;
		routeStateKey = stateKey;
		clearPoll();
		detail = null;
		notify(null);
		progress = null;
		if (!taskId) return;
		void load(taskId);
	}

	function applyRealtimeEvent(event: TaskRealtimeEvent | null | undefined) {
		if (!event || event.spaceId !== options.getSpaceId()) return;
		untrack(() => applyRealtime(event.payload));
	}

	function dispose() {
		clearPoll();
		if (copiedTimer) clearTimeout(copiedTimer);
		copiedTimer = null;
	}

	return {
		get detail() {
			return detail;
		},
		get loading() {
			return loading;
		},
		get error() {
			return error;
		},
		get progress() {
			return progress;
		},
		get boards() {
			return boards;
		},
		get copiedField() {
			return copiedField;
		},
		refresh,
		load,
		applyRealtimeEvent,
		copyField,
		syncRoute,
		dispose,
	};
}
