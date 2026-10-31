import { createLocalWorkspaces, type LocalWorkspaces } from "../local-workspace.js";
import { HttpError, type HttpTransport } from "../transport.js";
import type { SpaceFsFileResponse, SpaceFsPreparingFile, SpaceFsReadFilesResponse } from "../types.js";

export type SpaceFileRead = SpaceFsFileResponse | SpaceFsPreparingFile;

const BATCH_SIZE = 32;
const BATCH_CONCURRENCY = 2;
const SINGLE_CONCURRENCY = 4;
const BACKGROUND_DELAY_MS = 1500;
const READ_TIMEOUT_MS = 30_000;

type Pending = {
	key: string;
	token: string | null;
	spaceId: string;
	path: string;
	promise: Promise<SpaceFileRead>;
	resolve: (file: SpaceFileRead) => void;
	reject: (error: unknown) => void;
};

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

export const fileReadPath = (spaceId: string, path: string) =>
	`/api/spaces/${spaceId}/fs/file?${new URLSearchParams({ path })}`;

export function createSpaceFileReads(transport: HttpTransport, local: LocalWorkspaces = createLocalWorkspaces()) {
	const queues = [new Map<string, Pending>(), new Map<string, Pending>()] as const;
	const timers: [ReturnType<typeof setTimeout> | null, ReturnType<typeof setTimeout> | null] = [null, null];
	const inFlight = new Map<string, Pending>();
	const batches = createLimiter(BATCH_CONCURRENCY);
	const singles = createLimiter(SINGLE_CONCURRENCY);

	const readOne = (spaceId: string, path: string, init: { accessToken?: string | null } = {}) =>
		withTimeout((signal) => transport.requestRevalidated<SpaceFileRead>(fileReadPath(spaceId, path), { ...init, signal }));

	function schedule(lane: 0 | 1) {
		timers[lane] ??= setTimeout(() => {
			timers[lane] = null;
			flush(lane);
		}, lane ? BACKGROUND_DELAY_MS : 0);
	}

	function settle(pending: Pending, outcome: { file: SpaceFileRead } | { error: unknown }) {
		if (inFlight.get(pending.key) === pending) inFlight.delete(pending.key);
		if ("file" in outcome) pending.resolve(outcome.file);
		else pending.reject(outcome.error);
	}

	function flush(lane: 0 | 1) {
		const groups = new Map<string, Pending[]>();
		for (const pending of queues[lane].values()) {
			inFlight.set(pending.key, pending);
			const id = `${pending.token}\u0000${pending.spaceId}`;
			const group = groups.get(id);
			if (group) group.push(pending);
			else groups.set(id, [pending]);
		}
		queues[lane].clear();
		for (const group of groups.values()) {
			if (group.length === 1) {
				void readSingle(group[0] as Pending, lane === 1);
				continue;
			}
			for (let index = 0; index < group.length; index += BATCH_SIZE)
				void batches(() => readBatch(group.slice(index, index + BATCH_SIZE)), lane === 1);
		}
	}

	async function readSingle(pending: Pending, background = false) {
		const { spaceId, path, token } = pending;
		try {
			settle(pending, { file: await singles(() => readOne(spaceId, path, { accessToken: token }), background) });
		} catch (error) {
			settle(pending, { error });
		}
	}

	async function readBatch(chunk: Pending[]) {
		const { spaceId, token } = chunk[0] as Pending;
		let response: SpaceFsReadFilesResponse;
		try {
			response = await withTimeout((signal) =>
				transport.request<SpaceFsReadFilesResponse>(`/api/spaces/${spaceId}/fs/files`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ paths: chunk.map((pending) => pending.path) }),
					accessToken: token,
					signal,
				}),
			);
		} catch {
			await Promise.all(chunk.map((pending) => readSingle(pending)));
			return;
		}
		const byPath = new Map(chunk.map((pending) => [pending.path, pending]));
		const take = (path: string) => {
			const pending = byPath.get(path);
			byPath.delete(path);
			return pending;
		};
		for (const file of [...response.files, ...(response.preparing ?? [])]) {
			const pending = take(file.path);
			if (pending) settle(pending, { file });
		}
		for (const { path, status, code, message } of response.errors) {
			const pending = take(path);
			if (pending) settle(pending, { error: new HttpError(message, status, { code, message }) });
		}
		await Promise.all([...byPath.values()].map((pending) => readSingle(pending)));
	}

	function share(token: string | null, spaceId: string, path: string, background: boolean): Promise<SpaceFileRead> {
		const key = `${spaceId}\u0000${path}\u0000${token}`;
		let pending = inFlight.get(key) ?? queues[0].get(key);
		const deferred = queues[1].get(key);
		if (!pending && deferred && !background) {
			queues[1].delete(key);
			queues[0].set(key, deferred);
			schedule(0);
		}
		pending ??= deferred;
		if (!pending) {
			let resolve!: Pending["resolve"];
			let reject!: Pending["reject"];
			const promise = new Promise<SpaceFileRead>((done, fail) => {
				resolve = done;
				reject = fail;
			});
			const lane = background ? 1 : 0;
			pending = { key, token, spaceId, path, promise, resolve, reject };
			queues[lane].set(key, pending);
			schedule(lane);
		}
		return pending.promise;
	}

	return {
		async read(
			spaceId: string,
			path: string,
			options: { background?: boolean; signal?: AbortSignal; token?: string | null } = {},
		): Promise<SpaceFileRead> {
			return local.run(spaceId, "read", (workspace) => abortable(workspace.fs.read(path), options.signal), async () => {
				const own = options.token === undefined;
				const token = own ? await transport.credential() : (options.token ?? null);
				try {
					return await abortable(share(token, spaceId, path, options.background === true), options.signal);
				} catch (error) {
					if (!own || !isUnauthorized(error)) throw error;
					return abortable(readOne(spaceId, path), options.signal);
				}
			});
		},
		invalidate(spaceId: string, paths: Iterable<string>) {
			const stale = new Set([...paths].map((path) => `${spaceId}\u0000${path}`));
			for (const key of inFlight.keys()) if (stale.has(key.slice(0, key.lastIndexOf("\u0000")))) inFlight.delete(key);
		},
	};
}

export type SpaceFileReads = ReturnType<typeof createSpaceFileReads>;

export const isUnauthorized = (error: unknown) => error instanceof HttpError && error.status === 401;

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new DOMException("Space file read timed out", "TimeoutError")), READ_TIMEOUT_MS);
	try {
		return await run(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
