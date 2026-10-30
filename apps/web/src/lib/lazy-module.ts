const DEFAULT_RETRY_DELAYS_MS = [250, 750] as const;

function wait(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRetryDelays(
	retryDelaysMs: number | readonly number[],
): number[] {
	if (typeof retryDelaysMs === "number") {
		return retryDelaysMs <= 0 ? [] : [retryDelaysMs];
	}
	return [...retryDelaysMs].filter((ms) => ms >= 0);
}

/** Use as `import.meta.env.SSR ? pending() : import("…")` at the call site to keep client-only modules out of the Worker. */
export function pending(): Promise<never> {
	return new Promise(() => {});
}

/**
 * Cache a dynamic import. Transient failures retry with backoff, then clear
 * the cached promise so the next call can recover.
 */
export function createLazyModuleLoader<T>(
	load: () => Promise<T>,
	retryDelaysMs: number | readonly number[] = DEFAULT_RETRY_DELAYS_MS,
) {
	const delays = normalizeRetryDelays(retryDelaysMs);
	let modulePromise: Promise<T> | null = null;

	async function loadWithRetry() {
		let lastError: unknown;
		const attempts = delays.length + 1;
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			try {
				return await load();
			} catch (error) {
				lastError = error;
				const delayMs = delays[attempt];
				if (delayMs === undefined) break;
				await wait(delayMs);
			}
		}
		throw lastError;
	}

	return () => {
		if (!modulePromise) {
			let nextPromise: Promise<T>;
			nextPromise = loadWithRetry().catch((error) => {
				if (modulePromise === nextPromise) modulePromise = null;
				throw error;
			});
			modulePromise = nextPromise;
		}
		return modulePromise;
	};
}
