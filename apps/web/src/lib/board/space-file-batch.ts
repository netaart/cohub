import type {
	SpaceFsFileResponse,
	SpaceFsPreparingFile,
	SpaceFsReadFilesResponse,
} from "@neta-art/cohub";

export type SpaceFileRead =
	| { kind: "file"; file: SpaceFsFileResponse }
	| { kind: "preparing"; file: SpaceFsPreparingFile }
	| { kind: "error"; status?: number };

export type SpaceFileBatchSource = {
	readMany(spaceId: string, paths: string[]): Promise<SpaceFsReadFilesResponse>;
	readOne(
		spaceId: string,
		path: string,
	): Promise<SpaceFsFileResponse | SpaceFsPreparingFile>;
};

type Pending = {
	key: string;
	spaceId: string;
	path: string;
	promise: Promise<SpaceFileRead>;
	resolve: (read: SpaceFileRead) => void;
};

const BATCH_SIZE = 32;
const BATCH_CONCURRENCY = 2;
const SINGLE_CONCURRENCY = 4;
const BACKGROUND_DELAY_MS = 1500;

export function createLimiter(limit: number) {
	let active = 0;
	const lanes: [Array<() => void>, Array<() => void>] = [[], []];
	function pump() {
		while (active < limit) {
			const job = lanes[0].shift() ?? lanes[1].shift();
			if (!job) return;
			active += 1;
			job();
		}
	}
	return <T>(run: () => Promise<T>, background = false) =>
		new Promise<T>((resolve, reject) => {
			lanes[background ? 1 : 0].push(() => {
				run()
					.then(resolve, reject)
					.finally(() => {
						active -= 1;
						pump();
					});
			});
			pump();
		});
}

function statusOf(error: unknown) {
	const status = (error as { status?: unknown } | null)?.status;
	return typeof status === "number" ? status : undefined;
}

export function createSpaceFileBatchReader(
	source: SpaceFileBatchSource,
	options: { backgroundDelayMs?: number } = {},
) {
	const backgroundDelayMs = options.backgroundDelayMs ?? BACKGROUND_DELAY_MS;
	const queues = [
		new Map<string, Pending>(),
		new Map<string, Pending>(),
	] as const;
	const timers: [
		ReturnType<typeof setTimeout> | null,
		ReturnType<typeof setTimeout> | null,
	] = [null, null];
	const inFlight = new Map<string, Pending>();
	const batches = createLimiter(BATCH_CONCURRENCY);
	const singles = createLimiter(SINGLE_CONCURRENCY);

	function schedule(lane: 0 | 1) {
		timers[lane] ??= setTimeout(
			() => {
				timers[lane] = null;
				flush(lane);
			},
			lane ? backgroundDelayMs : 0,
		);
	}

	function flush(lane: 0 | 1) {
		const bySpace = new Map<string, Pending[]>();
		for (const pending of queues[lane].values()) {
			inFlight.set(pending.key, pending);
			const group = bySpace.get(pending.spaceId);
			if (group) group.push(pending);
			else bySpace.set(pending.spaceId, [pending]);
		}
		queues[lane].clear();
		for (const [spaceId, group] of bySpace)
			for (let index = 0; index < group.length; index += BATCH_SIZE) {
				const chunk = group.slice(index, index + BATCH_SIZE);
				void batches(() => readBatch(spaceId, chunk), lane === 1);
			}
	}

	function settle(pending: Pending, read: SpaceFileRead) {
		if (inFlight.get(pending.key) === pending) inFlight.delete(pending.key);
		pending.resolve(read);
	}

	async function readBatch(spaceId: string, chunk: Pending[]) {
		let response: SpaceFsReadFilesResponse;
		try {
			response = await source.readMany(
				spaceId,
				chunk.map((pending) => pending.path),
			);
		} catch {
			await Promise.all(chunk.map(readSingle));
			return;
		}
		const byPath = new Map(chunk.map((pending) => [pending.path, pending]));
		const take = (path: string) => {
			const pending = byPath.get(path);
			byPath.delete(path);
			return pending;
		};
		for (const file of response.files) {
			const pending = take(file.path);
			if (pending) settle(pending, { kind: "file", file });
		}
		for (const file of response.preparing ?? []) {
			const pending = take(file.path);
			if (pending) settle(pending, { kind: "preparing", file });
		}
		for (const error of response.errors) {
			const pending = take(error.path);
			if (pending) settle(pending, { kind: "error", status: error.status });
		}
		for (const pending of byPath.values()) settle(pending, { kind: "error" });
	}

	async function readSingle(pending: Pending) {
		try {
			const file = await singles(() =>
				source.readOne(pending.spaceId, pending.path),
			);
			settle(
				pending,
				"content" in file
					? { kind: "file", file }
					: { kind: "preparing", file },
			);
		} catch (error) {
			settle(pending, { kind: "error", status: statusOf(error) });
		}
	}

	return {
		invalidate(spaceId: string, paths: Iterable<string>) {
			for (const path of paths) inFlight.delete(`${spaceId}\u0000${path}`);
		},
		read(
			spaceId: string,
			path: string,
			input: { background?: boolean } = {},
		): Promise<SpaceFileRead> {
			const key = `${spaceId}\u0000${path}`;
			const known = inFlight.get(key) ?? queues[0].get(key);
			if (known) return known.promise;
			const deferred = queues[1].get(key);
			if (deferred) {
				if (!input.background) {
					queues[1].delete(key);
					if (queues[1].size === 0 && timers[1]) {
						clearTimeout(timers[1]);
						timers[1] = null;
					}
					queues[0].set(key, deferred);
					schedule(0);
				}
				return deferred.promise;
			}
			let resolve!: (read: SpaceFileRead) => void;
			const promise = new Promise<SpaceFileRead>((done) => {
				resolve = done;
			});
			const lane = input.background ? 1 : 0;
			queues[lane].set(key, { key, spaceId, path, promise, resolve });
			schedule(lane);
			return promise;
		},
	};
}

export type SpaceFileBatchReader = ReturnType<
	typeof createSpaceFileBatchReader
>;
