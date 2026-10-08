export type RefreshOptions = {
	ensureFresh?: boolean;
};

export function createRefreshCoordinator<T>(options: {
	keyOf?: (target: T) => string;
	isCurrent: (target: T) => boolean;
	refresh: (target: T) => Promise<void>;
}) {
	const keyOf = options.keyOf ?? String;
	const inFlightByKey = new Map<string, Promise<void>>();

	async function refresh(
		target: T,
		refreshOptions: RefreshOptions = {},
	): Promise<void> {
		const key = keyOf(target);
		const activeRefresh = inFlightByKey.get(key);
		if (activeRefresh) {
			await activeRefresh;
			if (refreshOptions.ensureFresh && options.isCurrent(target))
				await refresh(target);
			return;
		}

		const trackedRun = options.refresh(target).finally(() => {
			if (inFlightByKey.get(key) === trackedRun) inFlightByKey.delete(key);
		});
		inFlightByKey.set(key, trackedRun);
		await trackedRun;
	}

	return { refresh };
}
