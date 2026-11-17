import type { TaskRunRecord } from "@neta-art/cohub";
import {
	getCachedTaskRuns,
	onTaskRunsCacheUpdated,
	restoreCachedTaskRuns,
} from "#lib/stores/task-runs-cache.ts";

export type BoardLiveTask = {
	status: TaskRunRecord["status"];
	startedAt?: string;
};

export function createBoardLiveTasks(input: {
	spaceId: string;
	onChange: (taskRunIds: ReadonlySet<string>) => void;
}) {
	const runs = new Map<string, BoardLiveTask>();

	function adopt(list: readonly TaskRunRecord[]) {
		const changed = new Set<string>();
		for (const run of list) {
			const previous = runs.get(run.id);
			const startedAt = run.startedAt ?? undefined;
			if (previous?.status === run.status && previous.startedAt === startedAt)
				continue;
			runs.set(run.id, {
				status: run.status,
				...(startedAt ? { startedAt } : {}),
			});
			changed.add(run.id);
		}
		if (changed.size) input.onChange(changed);
	}

	adopt(getCachedTaskRuns(input.spaceId));
	void restoreCachedTaskRuns(input.spaceId)
		.then(adopt)
		.catch(() => undefined);
	const unsubscribe = onTaskRunsCacheUpdated((event) => {
		if (event.spaceId === input.spaceId) adopt(event.runs);
	});

	return {
		get: (taskRunId: string) => runs.get(taskRunId) ?? null,
		destroy: unsubscribe,
	};
}
