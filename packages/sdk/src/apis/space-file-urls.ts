import type { SpaceFsChangedPayload } from "@cohub/protocol/fs";
import { getRealtimeSpaceRoom } from "@cohub/protocol/realtime/types";
import type { ResolvedFile, ResolveFileOptions } from "../media.js";
import { type Fetch, HttpError, type HttpTransport } from "../transport.js";
import type { SpaceFsFileResponse } from "../types.js";
import type { WebsocketClient } from "../websocket.js";
import type { LocalWorkspaces } from "../local-workspace.js";
import { createLimiter, createSpaceFileReads, isUnauthorized, type SpaceFileRead, type SpaceFileReads } from "./space-file-reads.js";
import { fileUrlStore, type StoredFileUrl } from "./space-file-url-store.js";

export type ResolveSpaceFileOptions = ResolveFileOptions & {
	/** Maximum time to wait while CDN delivery is being prepared. */
	timeoutMs?: number;
	signal?: AbortSignal;
	fetch?: Fetch;
};

type Resolved = ResolvedFile & { inline: boolean };
type Entry = Resolved & { scope: string | null; epoch: number; verifiedAt: number };

const MEMORY_LIMIT = 4096;
const INLINE_MEMORY_MAX_CHARS = 256 * 1024;
const PREPARING_CONCURRENCY = 4;
const PREPARING_TIMEOUT_MS = 15_000;
/** Well inside the fs CDN manifest's 6.5 days; CDN URLs carry the file version and are not signed. */
const STORED_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const UNWATCHED_TRUST_MS = 60_000;

export function inlineFileDataUrl(file: SpaceFsFileResponse) {
	const mimeType = file.mimeType ?? "application/octet-stream";
	return file.encoding === "base64"
		? `data:${mimeType};base64,${file.content}`
		: `data:${mimeType};charset=utf-8,${encodeURIComponent(file.content)}`;
}

function resolvedOf(file: SpaceFsFileResponse): Resolved {
	if (file.delivery === "url" && file.url) return { url: file.url, inline: false, ...(file.media ? { media: file.media } : {}) };
	return { url: inlineFileDataUrl(file), inline: true };
}

const isGone = (error: unknown) => error instanceof HttpError && (error.status === 404 || error.status === 410);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function remember<K, V>(map: Map<K, V>, key: K, value: V) {
	map.delete(key);
	map.set(key, value);
	if (map.size > MEMORY_LIMIT) map.delete(map.keys().next().value as K);
}

export function createSpaceFileUrls(options: {
	reads: SpaceFileReads;
	credential: () => Promise<string | null>;
	scope: () => Promise<string | null>;
	watched: (spaceId: string) => boolean;
	cache: boolean;
	now?: () => number;
}) {
	const { reads, cache } = options;
	const now = options.now ?? Date.now;
	const memory = new Map<string, Entry>();
	const invalidatedAt = new Map<string, number>();
	const epochs = new Map<string, number>();
	const serverReads = new Map<string, Promise<Entry | null>>();
	const localReads = new Map<string, Promise<Entry | null>>();
	const listeners = new Set<(spaceId: string, path: string) => void>();
	const preparing = createLimiter(PREPARING_CONCURRENCY);
	type LocalRead = { key: string; token: string | null; scope: string; spaceId: string; path: string; resolve: (read: Promise<Entry | null>) => void };
	let localBatch: LocalRead[] | null = null;
	let writes: Map<string, { put: Map<string, StoredFileUrl>; remove: Set<string> }> | null = null;
	let lastScope: string | null = null;

	const keyOf = (spaceId: string, path: string) => `${spaceId}\u0000${path}`;
	const epochOf = (spaceId: string) => epochs.get(spaceId) ?? 0;
	const persists = (scope: string | null): scope is string => cache && scope !== null && Boolean(globalThis.indexedDB);

	function persist(scope: string, spaceId: string, path: string, entry: Entry | null) {
		if (!writes) {
			const batch = new Map<string, { put: Map<string, StoredFileUrl>; remove: Set<string> }>();
			writes = batch;
			setTimeout(() => {
				writes = null;
				for (const [id, { put, remove }] of batch) {
					const [batchScope, batchSpace] = id.split("\u0000") as [string, string];
					void fileUrlStore.write(batchScope, batchSpace, { put, remove }).catch(() => undefined);
				}
			}, 0);
		}
		const id = `${scope}\u0000${spaceId}`;
		const pending = writes.get(id) ?? { put: new Map(), remove: new Set<string>() };
		writes.set(id, pending);
		if (entry) {
			pending.remove.delete(path);
			pending.put.set(path, { url: entry.url, verifiedAt: now(), ...(entry.media ? { media: entry.media } : {}) });
		} else {
			pending.put.delete(path);
			pending.remove.add(path);
		}
	}

	async function load(token: string | null, spaceId: string, path: string, background: boolean): Promise<Resolved | null> {
		const first = await reads.read(spaceId, path, { background, token });
		if ("content" in first) return resolvedOf(first);
		return preparing(async () => {
			const deadline = now() + PREPARING_TIMEOUT_MS;
			let file: SpaceFileRead = first;
			while (!("content" in file)) {
				const wait = Math.min(Math.max(250, Math.min(file.retryAfterMs, 2_000)), deadline - now());
				if (wait <= 0) return null;
				await sleep(wait);
				file = await reads.read(spaceId, path, { token });
			}
			return resolvedOf(file);
		}, background);
	}

	function server(token: string | null, scope: string | null, spaceId: string, path: string, background: boolean): Promise<Entry | null> {
		const key = keyOf(spaceId, path);
		const readKey = `${key}\u0000${token}`;
		const running = serverReads.get(readKey);
		if (running) {
			if (!background) void reads.read(spaceId, path, { token }).catch(() => undefined);
			return running;
		}
		const epoch = epochOf(spaceId);
		const read: Promise<Entry | null> = load(token, spaceId, path, background).then(
			(resolved) => {
				const current = serverReads.get(readKey) === read;
				if (current) serverReads.delete(readKey);
				if (!resolved) return null;
				const entry: Entry = { ...resolved, scope, epoch, verifiedAt: now() };
				if (current && cache) adopt(key, spaceId, path, entry);
				return entry;
			},
			(error: unknown) => {
				const current = serverReads.get(readKey) === read;
				if (current) serverReads.delete(readKey);
				if (current && cache && isGone(error)) {
					memory.delete(key);
					if (persists(scope)) persist(scope, spaceId, path, null);
				}
				throw error;
			},
		);
		serverReads.set(readKey, read);
		return read;
	}

	function adopt(key: string, spaceId: string, path: string, entry: Entry) {
		const previous = memory.get(key);
		if (!entry.inline || entry.url.length <= INLINE_MEMORY_MAX_CHARS) remember(memory, key, entry);
		if (!entry.inline && persists(entry.scope)) persist(entry.scope, spaceId, path, entry);
		if (previous && previous.url !== entry.url) emit(spaceId, path);
	}

	function revalidate(token: string | null, scope: string | null, spaceId: string, path: string) {
		void server(token, scope, spaceId, path, true).catch(() => undefined);
	}

	function readLocal(token: string | null, scope: string, spaceId: string, path: string): Promise<Entry | null> {
		const key = keyOf(spaceId, path);
		const running = localReads.get(key);
		if (running) return running;
		let resolve!: LocalRead["resolve"];
		const read = new Promise<Entry | null>((done) => {
			resolve = done;
		});
		const forget = () => {
			if (localReads.get(key) === read) localReads.delete(key);
		};
		read.then(forget, forget);
		localReads.set(key, read);
		if (!localBatch) {
			const batch: LocalRead[] = [];
			localBatch = batch;
			queueMicrotask(() => {
				localBatch = null;
				const groups = new Map<string, LocalRead[]>();
				for (const item of batch) {
					const id = `${item.scope}\u0000${item.spaceId}`;
					const group = groups.get(id);
					if (group) group.push(item);
					else groups.set(id, [item]);
				}
				for (const group of groups.values()) void readStored(group);
			});
		}
		localBatch.push({ key, token, scope, spaceId, path, resolve });
		return read;
	}

	async function readStored(group: LocalRead[]) {
		const { scope, spaceId } = group[0] as LocalRead;
		const records = await fileUrlStore.read(scope, spaceId, group.map((item) => item.path)).catch(() => new Map<string, StoredFileUrl>());
		for (const { key, token, path, resolve } of group) {
			const record = records.get(path);
			const usable =
				record && now() - record.verifiedAt <= STORED_MAX_AGE_MS && (invalidatedAt.get(key) ?? -1) < record.verifiedAt;
			if (!usable) {
				resolve(server(token, scope, spaceId, path, false));
				continue;
			}
			const entry: Entry = { url: record.url, inline: false, ...(record.media ? { media: record.media } : {}), scope, epoch: -1, verifiedAt: record.verifiedAt };
			if (!memory.has(key)) remember(memory, key, entry);
			revalidate(token, scope, spaceId, path);
			resolve(Promise.resolve(entry));
		}
	}

	function emit(spaceId: string, path: string) {
		for (const listener of listeners) listener(spaceId, path);
	}

	function invalidate(spaceId: string, paths: Iterable<string>) {
		const stale = [...new Set(paths)];
		if (stale.length === 0) return;
		reads.invalidate(spaceId, stale);
		const at = now();
		const buffered = lastScope === null ? undefined : writes?.get(`${lastScope}\u0000${spaceId}`);
		const keys = new Set<string>();
		for (const path of stale) {
			const key = keyOf(spaceId, path);
			keys.add(key);
			memory.delete(key);
			localReads.delete(key);
			remember(invalidatedAt, key, at);
			buffered?.put.delete(path);
		}
		for (const readKey of serverReads.keys())
			if (keys.has(readKey.slice(0, readKey.lastIndexOf("\u0000")))) serverReads.delete(readKey);
		if (persists(lastScope)) void fileUrlStore.write(lastScope, spaceId, { put: new Map(), remove: stale }).catch(() => undefined);
	}

	return {
		async resolve(spaceId: string, path: string, request: ResolveSpaceFileOptions = {}): Promise<ResolvedFile | null> {
			const purpose = request.purpose ?? "preview";
			const token = await options.credential();
			const scope = cache ? await options.scope().catch(() => null) : null;
			if (scope !== null) lastScope = scope;
			const key = keyOf(spaceId, path);
			const hit = cache && !request.fresh ? memory.get(key) : undefined;
			let entry: Entry | null;
			if (hit && hit.scope === scope) {
				remember(memory, key, hit);
				const unwatched = !options.watched(spaceId) && now() - hit.verifiedAt > UNWATCHED_TRUST_MS;
				if (hit.epoch !== epochOf(spaceId) || unwatched) revalidate(token, scope, spaceId, path);
				entry = hit;
			} else {
				const pending = persists(scope) && !request.fresh ? readLocal(token, scope, spaceId, path) : server(token, scope, spaceId, path, false);
				entry = await settle(pending.catch(async (error: unknown) => {
					if (!isUnauthorized(error)) throw error;
					await reads.read(spaceId, path, { signal: request.signal });
					request.signal?.throwIfAborted();
					return server(await options.credential(), scope, spaceId, path, false);
				}), request);
			}
			if (!entry || (purpose === "playback" && entry.inline)) return null;
			return entry.media ? { url: entry.url, media: entry.media } : { url: entry.url };
		},
		applyFsChange(spaceId: string, payload: Pick<SpaceFsChangedPayload, "changes" | "resync">) {
			if (payload.resync) epochs.set(spaceId, epochOf(spaceId) + 1);
			const paths = new Set<string>();
			for (const change of payload.changes ?? []) {
				if (change.path) paths.add(change.path);
				if (change.oldPath) paths.add(change.oldPath);
			}
			invalidate(spaceId, paths);
			for (const path of paths) emit(spaceId, path);
		},
		subscribe(listener: (spaceId: string, path: string) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

export type SpaceFileUrls = ReturnType<typeof createSpaceFileUrls>;

export type SpaceFileServices = { reads: SpaceFileReads; urls: SpaceFileUrls; local: LocalWorkspaces };

export function createSpaceFileServices(transport: HttpTransport, websocket: WebsocketClient | null, local: LocalWorkspaces): SpaceFileServices {
	const reads = createSpaceFileReads(transport, local);
	const urls = createSpaceFileUrls({
		reads,
		credential: () => transport.credential(),
		scope: () => transport.cacheScope(),
		watched: (spaceId) => websocket?.isRoomLive(getRealtimeSpaceRoom(spaceId)) ?? false,
		cache: websocket !== null && typeof window !== "undefined",
	});
	websocket?.on("event", (event) => {
		if (event.type === "space.fs.changed" && event.spaceId)
			urls.applyFsChange(event.spaceId, event.payload as SpaceFsChangedPayload);
	});
	return { reads, urls, local };
}

function settle<T>(read: Promise<T | null>, { timeoutMs = PREPARING_TIMEOUT_MS, signal }: ResolveSpaceFileOptions): Promise<T | null> {
	if (signal?.aborted) return Promise.reject(signal.reason);
	return new Promise<T | null>((resolve, reject) => {
		const timer = setTimeout(() => finish(() => resolve(null)), Math.max(0, timeoutMs));
		const abort = () => finish(() => reject(signal?.reason));
		signal?.addEventListener("abort", abort, { once: true });
		function finish(done: () => void) {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			done();
		}
		read.then(
			(value) => finish(() => resolve(value)),
			(error: unknown) => finish(() => reject(error)),
		);
	});
}
