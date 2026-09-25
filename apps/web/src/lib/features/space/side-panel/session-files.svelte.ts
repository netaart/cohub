import type { ContentBlock } from "@cohub/protocol/core";
import type { SessionFileRecord } from "@cohub/protocol/model";
import { getCacheUserKey } from "$lib/cache/keys";
import { MemoryLru } from "$lib/cache/memory-lru";
import {
	readSessionFiles,
	writeSessionFiles,
} from "$lib/cache/repositories/session-files-repo";
import { sdk } from "$lib/sdk";
import type {
	SessionGenerationState,
	StreamingIntermediateMessage,
} from "$lib/stores/session-generation.svelte";
import {
	extractLiveFileChanges,
	fileToolBlocks,
	type LiveFileChange,
	mergeSessionFiles,
	pruneCoveredLiveChanges,
	sameLiveFileChanges,
	withAncestorPaths,
} from "./side-panel-data";

const FILE_LIMIT = 200;
const INDEX_REFRESH_DELAY_MS = 1_500;
/** A finished change the index never reported is dropped after this. */
const INDEX_SETTLE_DELAY_MS = 6_000;
const STREAMING_STATUSES = new Set(["pending", "streaming"]);

type Snapshot = {
	server: SessionFileRecord[];
	live: Map<string, LiveFileChange>;
	settledTurns: Set<string>;
};

const snapshots = new MemoryLru<string, Snapshot>(24);
/** Archived rounds never change; filter their blocks once. */
const archivedBlocksByMessage = new WeakMap<
	StreamingIntermediateMessage,
	ContentBlock[]
>();

function archivedFileToolBlocks(message: StreamingIntermediateMessage) {
	let blocks = archivedBlocksByMessage.get(message);
	if (!blocks) {
		blocks = fileToolBlocks(message.content);
		archivedBlocksByMessage.set(message, blocks);
	}
	return blocks;
}

/** Server list of changed files, overlaid with the running turn's tool calls. */
export class SessionFilesFeed {
	readonly spaceId: string;
	readonly sessionId: string;
	readonly #key: string;
	#server = $state.raw<SessionFileRecord[]>([]);
	#live = $state.raw<Map<string, LiveFileChange>>(new Map());
	#started = false;
	#disposed = false;
	#version = 0;
	#timers = new Set<ReturnType<typeof setTimeout>>();
	#settledTurns = new Set<string>();

	ready = $state(false);
	refreshing = $state(false);
	failed = $state(false);

	readonly files = $derived(mergeSessionFiles(this.#server, this.#live));
	readonly activeCount = $derived(
		this.files.filter((file) => file.active).length,
	);
	readonly markedPaths = $derived(
		withAncestorPaths(this.files.map((file) => file.path)),
	);

	constructor(spaceId: string, sessionId: string) {
		this.spaceId = spaceId;
		this.sessionId = sessionId;
		this.#key = `${getCacheUserKey()}:${spaceId}:${sessionId}`;
		const snapshot = snapshots.get(this.#key);
		if (snapshot) {
			this.#server = snapshot.server;
			this.#live = snapshot.live;
			this.#settledTurns = snapshot.settledTurns;
			this.ready = true;
		}
	}

	start() {
		if (this.#started || this.#disposed) return;
		this.#started = true;
		void this.#restoreThenRefresh();
	}

	dispose() {
		this.#disposed = true;
		this.#version += 1;
		for (const timer of this.#timers) clearTimeout(timer);
		this.#timers.clear();
	}

	async refresh(): Promise<boolean> {
		if (this.#disposed || !this.#started) return false;
		const version = ++this.#version;
		this.refreshing = true;
		try {
			const { files } = await sdk
				.space(this.spaceId)
				.session(this.sessionId)
				.files({ limit: FILE_LIMIT });
			if (version !== this.#version) return false;
			this.#server = files;
			this.#setLive(pruneCoveredLiveChanges(this.#live, files));
			this.failed = false;
			void writeSessionFiles(this.spaceId, this.sessionId, files).catch(
				() => undefined,
			);
			return true;
		} catch (error) {
			if (version === this.#version) this.failed = true;
			console.warn("[side-panel] failed to refresh session files", error);
			return false;
		} finally {
			if (version === this.#version) {
				this.refreshing = false;
				this.ready = true;
				this.#remember();
			}
		}
	}

	observeStream(state: SessionGenerationState | null) {
		if (this.#disposed || !this.#started) return;
		const archivedBlocks: ContentBlock[] = [];
		for (const message of state?.intermediateMessages ?? []) {
			archivedBlocks.push(...archivedFileToolBlocks(message));
		}
		const next = extractLiveFileChanges({
			spaceId: this.spaceId,
			liveBlocks: fileToolBlocks(state?.contentBlocks ?? []),
			archivedBlocks,
			streaming: Boolean(state && STREAMING_STATUSES.has(state.status)),
			turnId: state?.turnId ?? null,
			previous: this.#live,
			now: Date.now(),
		});
		for (const [path, change] of next) {
			if (change.turnId && this.#settledTurns.has(change.turnId))
				next.delete(path);
		}
		this.#setLive(next);
	}

	onTurnFinalized(turnId: string | null) {
		if (!this.#started) return;
		this.#schedule(INDEX_REFRESH_DELAY_MS, () => void this.refresh());
		if (turnId)
			this.#schedule(INDEX_SETTLE_DELAY_MS, () => void this.#settle(turnId));
	}

	/** Drop a finalized turn's live changes the index never reported. */
	async #settle(turnId: string) {
		const settles = (change: LiveFileChange) =>
			!change.active && (change.turnId === turnId || change.turnId === null);
		if (![...this.#live.values()].some(settles)) return;
		if (!(await this.refresh())) return;
		this.#settledTurns.add(turnId);
		this.#setLive(
			new Map([...this.#live].filter(([, change]) => !settles(change))),
		);
	}

	#schedule(delay: number, run: () => void) {
		if (this.#disposed) return;
		const timer = setTimeout(() => {
			this.#timers.delete(timer);
			if (!this.#disposed) run();
		}, delay);
		this.#timers.add(timer);
	}

	#setLive(next: Map<string, LiveFileChange>) {
		if (sameLiveFileChanges(this.#live, next)) return;
		this.#live = next;
		this.#remember();
	}

	#remember() {
		snapshots.set(this.#key, {
			server: this.#server,
			live: this.#live,
			settledTurns: this.#settledTurns,
		});
	}

	async #restoreThenRefresh() {
		if (!this.ready) {
			const version = this.#version;
			const cached = await readSessionFiles(this.spaceId, this.sessionId).catch(
				() => null,
			);
			if (version === this.#version && !this.ready && cached) {
				this.#server = cached;
				this.ready = true;
				this.#remember();
			}
		}
		await this.refresh();
	}
}
