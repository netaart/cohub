type TaskScheduler = {
	postTask(task: () => void, options: { priority: "background"; delay: number; signal: AbortSignal }): Promise<unknown>;
};

export function scheduleBoardIdle(task: () => void, delay: number): () => void {
	const scheduler = (globalThis as { scheduler?: TaskScheduler }).scheduler;
	if (scheduler?.postTask) {
		const controller = new AbortController();
		scheduler.postTask(task, { priority: "background", delay, signal: controller.signal }).catch((error: unknown) => {
			if (!controller.signal.aborted) throw error;
		});
		return () => controller.abort();
	}
	let idle = 0;
	const timer = setTimeout(() => {
		if (typeof requestIdleCallback === "function") idle = requestIdleCallback(task, { timeout: 1_000 });
		else task();
	}, delay);
	return () => {
		clearTimeout(timer);
		if (idle) cancelIdleCallback(idle);
	};
}
