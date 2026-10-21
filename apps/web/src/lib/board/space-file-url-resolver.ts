import type { SpaceFsFileResponse } from "@neta-art/cohub";
import { MemoryLru } from "$lib/cache/memory-lru";
import { createLimiter, type SpaceFileRead } from "./space-file-batch";

export type SpaceFileUrlPurpose = "preview" | "playback";

export type SpaceFileUrlRecord = { url: string; verifiedAt: number };

export type SpaceFileUrlStore = {
	read(
		scope: string,
		spaceId: string,
		paths: readonly string[],
	): Promise<ReadonlyMap<string, SpaceFileUrlRecord>>;
	write(
		scope: string,
		spaceId: string,
		changes: {
			put: ReadonlyMap<string, SpaceFileUrlRecord>;
			remove: readonly string[];
		},
	): Promise<void>;
};

export type SpaceFileUrlRemote = {
	read(
		spaceId: string,
		path: string,
		options?: { background?: boolean },
	): Promise<SpaceFileRead>;
	invalidate(spaceId: string, paths: Iterable<string>): void;
	resolveUrl(spaceId: string, path: string): Promise<string | null>;
};

export type SpaceFileUrlChange = { spaceId: string; path: string };

type Entry = { url: string; inline: boolean; epoch: number };

type Request = {
	key: string;
	scope: string;
	spaceId: string;
	path: string;
	promise: Promise<Entry | null>;
	resolve: (entry: Entry | null) => void;
};

type PendingWrite = {
	scope: string;
	spaceId: string;
	put: Map<string, SpaceFileUrlRecord>;
	remove: Set<string>;
};

const MEMORY_LIMIT = 4096;
const INLINE_MEMORY_MAX_CHARS = 256 * 1024;
const PREPARING_CONCURRENCY = 4;
const STORED_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function fileUrl(file: SpaceFsFileResponse) {
	if (file.delivery === "url" && file.url) return file.url;
	const mimeType = file.mimeType ?? "application/octet-stream";
	return file.encoding === "base64"
		? `data:${mimeType};base64,${file.content}`
		: `data:${mimeType};charset=utf-8,${encodeURIComponent(file.content)}`;
}

export function createSpaceFileUrlResolver(options: {
	remote: SpaceFileUrlRemote;
	store: SpaceFileUrlStore;
	scope: () => string;
	now?: () => number;
}) {
	const { remote, store } = options;
	const now = options.now ?? Date.now;
	const memory = new MemoryLru<string, Entry>(MEMORY_LIMIT);
	const invalidatedAt = new MemoryLru<string, number>(MEMORY_LIMIT);
	const epochs = new Map<string, number>();
	const localReads = new Map<string, Promise<Entry | null>>();
	const serverReads = new Map<string, Request>();
	const listeners = new Set<(change: SpaceFileUrlChange) => void>();
	const preparing = createLimiter(PREPARING_CONCURRENCY);
	let localBatch: Request[] | null = null;
	let writes: Map<string, PendingWrite> | null = null;

	const spaceKey = (scope: string, spaceId: string) =>
		`${scope}\u0000${spaceId}`;
	const keyOf = (scope: string, spaceId: string, path: string) =>
		`${spaceKey(scope, spaceId)}\u0000${path}`;
	const epochOf = (scope: string, spaceId: string) =>
		epochs.get(spaceKey(scope, spaceId)) ?? 0;
	const stale = (key: string, since: number) =>
		(invalidatedAt.get(key) ?? -1) >= since;

	function request(scope: string, spaceId: string, path: string): Request {
		let resolve!: (entry: Entry | null) => void;
		const promise = new Promise<Entry | null>((done) => {
			resolve = done;
		});
		return {
			key: keyOf(scope, spaceId, path),
			scope,
			spaceId,
			path,
			promise,
			resolve,
		};
	}

	function pick(entry: Entry | null, purpose: SpaceFileUrlPurpose) {
		if (!entry || (purpose === "playback" && entry.inline)) return null;
		return entry.url;
	}

	function persist(next: Request, url: string | null) {
		if (!writes) {
			const batch = new Map<string, PendingWrite>();
			writes = batch;
			setTimeout(() => {
				writes = null;
				for (const { scope, spaceId, put, remove } of batch.values())
					void store
						.write(scope, spaceId, { put, remove: [...remove] })
						.catch(() => undefined);
			}, 0);
		}
		const id = spaceKey(next.scope, next.spaceId);
		const pending = writes.get(id) ?? {
			scope: next.scope,
			spaceId: next.spaceId,
			put: new Map(),
			remove: new Set<string>(),
		};
		writes.set(id, pending);
		if (url) {
			pending.remove.delete(next.path);
			pending.put.set(next.path, { url, verifiedAt: now() });
		} else {
			pending.put.delete(next.path);
			pending.remove.add(next.path);
		}
	}

	function server(
		scope: string,
		spaceId: string,
		path: string,
		background: boolean,
	) {
		const key = keyOf(scope, spaceId, path);
		const running = serverReads.get(key);
		if (running) {
			if (!background) void remote.read(spaceId, path);
			return running.promise;
		}
		const next = request(scope, spaceId, path);
		serverReads.set(key, next);
		void remote
			.read(spaceId, path, { background })
			.then((read) => answer(next, read));
		return next.promise;
	}

	async function answer(next: Request, read: SpaceFileRead) {
		if (read.kind === "file") {
			const url = fileUrl(read.file);
			const entry: Entry = {
				url,
				inline: url.startsWith("data:"),
				epoch: epochOf(next.scope, next.spaceId),
			};
			if (settle(next, entry, true) && !entry.inline) persist(next, url);
			return;
		}
		if (read.kind === "error") {
			// Only a definitive absence forgets a stored URL.
			const gone = read.status === 404 || read.status === 410;
			if (settle(next, null, gone) && gone) persist(next, null);
			return;
		}
		const url = await preparing(() =>
			remote.resolveUrl(next.spaceId, next.path),
		).catch(() => null);
		const entry: Entry | null = url
			? {
					url,
					inline: url.startsWith("data:"),
					epoch: epochOf(next.scope, next.spaceId),
				}
			: null;
		if (settle(next, entry, Boolean(entry)) && entry && !entry.inline)
			persist(next, entry.url);
	}

	function settle(next: Request, entry: Entry | null, authoritative: boolean) {
		const current = serverReads.get(next.key) === next;
		if (current) serverReads.delete(next.key);
		next.resolve(entry);
		if (!authoritative || !current) return false;
		const previous = memory.get(next.key);
		if (!entry) memory.delete(next.key);
		else if (!entry.inline || entry.url.length <= INLINE_MEMORY_MAX_CHARS)
			memory.set(next.key, entry);
		if (previous && previous.url !== entry?.url)
			for (const listener of listeners)
				listener({ spaceId: next.spaceId, path: next.path });
		return true;
	}

	function readLocal(scope: string, spaceId: string, path: string) {
		const key = keyOf(scope, spaceId, path);
		const running = localReads.get(key);
		if (running) return running;
		const next = request(scope, spaceId, path);
		localReads.set(key, next.promise);
		if (!localBatch) {
			const batch: Request[] = [];
			localBatch = batch;
			queueMicrotask(() => {
				localBatch = null;
				const groups = new Map<string, Request[]>();
				for (const item of batch) {
					const id = spaceKey(item.scope, item.spaceId);
					const group = groups.get(id);
					if (group) group.push(item);
					else groups.set(id, [item]);
				}
				for (const group of groups.values()) void readStored(group);
			});
		}
		localBatch.push(next);
		return next.promise;
	}

	async function readStored(group: Request[]) {
		const { scope, spaceId } = group[0] as Request;
		const records = await store
			.read(
				scope,
				spaceId,
				group.map((next) => next.path),
			)
			.catch(() => new Map<string, SpaceFileUrlRecord>());
		for (const next of group) {
			const current = localReads.get(next.key) === next.promise;
			if (current) localReads.delete(next.key);
			const record = records.get(next.path);
			if (
				!record ||
				!current ||
				now() - record.verifiedAt > STORED_MAX_AGE_MS ||
				stale(next.key, record.verifiedAt)
			) {
				void server(scope, spaceId, next.path, false).then(next.resolve);
				continue;
			}
			const entry: Entry = { url: record.url, inline: false, epoch: -1 };
			if (!memory.get(next.key)) memory.set(next.key, entry);
			void server(scope, spaceId, next.path, true);
			next.resolve(entry);
		}
	}

	return {
		async resolve(
			spaceId: string,
			path: string,
			input: { purpose?: SpaceFileUrlPurpose; fresh?: boolean } = {},
		): Promise<string | null> {
			const purpose = input.purpose ?? "preview";
			const scope = options.scope();
			if (input.fresh)
				return pick(await server(scope, spaceId, path, false), purpose);
			const hit = memory.get(keyOf(scope, spaceId, path));
			if (!hit) return pick(await readLocal(scope, spaceId, path), purpose);
			if (hit.epoch !== epochOf(scope, spaceId))
				void server(scope, spaceId, path, true);
			return pick(hit, purpose);
		},
		invalidate(spaceId: string, paths: Iterable<string>) {
			const scope = options.scope();
			const remove = [...new Set(paths)];
			if (remove.length === 0) return;
			remote.invalidate(spaceId, remove);
			const at = now();
			const buffered = writes?.get(spaceKey(scope, spaceId));
			for (const path of remove) {
				const key = keyOf(scope, spaceId, path);
				memory.delete(key);
				localReads.delete(key);
				serverReads.delete(key);
				invalidatedAt.set(key, at);
				buffered?.put.delete(path);
			}
			void store
				.write(scope, spaceId, { put: new Map(), remove })
				.catch(() => undefined);
		},
		expire(spaceId: string) {
			const key = spaceKey(options.scope(), spaceId);
			epochs.set(key, (epochs.get(key) ?? 0) + 1);
		},
		subscribe(listener: (change: SpaceFileUrlChange) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

export type SpaceFileUrlResolver = ReturnType<
	typeof createSpaceFileUrlResolver
>;
