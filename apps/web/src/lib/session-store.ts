import type { SessionRecord, SessionTurnRecord } from "@neta-art/cohub";
import { SvelteMap } from "svelte/reactivity";
import { sameData } from "$lib/lists/live-list-core";
import {
	mergeSessionRecord,
	type SessionRecordInput,
} from "$lib/session-record-merge";
import { mergeSessionTurnState } from "$lib/session-turn-state";

export type SessionStorePersistence = {
	save(records: SessionRecord[]): Promise<unknown>;
	find(sessionId: string): Promise<SessionRecord | null>;
	findMany(spaceId: string, sessionIds: string[]): Promise<SessionRecord[]>;
};

/** The single client copy of each Session: lists hold ids, rows read here. */
export class SessionStore {
	readonly #records = new SvelteMap<string, SessionRecord>();
	readonly #persistence: SessionStorePersistence;
	readonly #persistDelayMs: number;
	readonly #pending = new Set<string>();
	readonly #loading = new Map<string, Promise<void>>();
	#generation = 0;
	#timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		persistence: SessionStorePersistence,
		options: { persistDelayMs?: number } = {},
	) {
		this.#persistence = persistence;
		this.#persistDelayMs = options.persistDelayMs ?? 300;
	}

	get(id: string): SessionRecord | undefined {
		return this.#records.get(id);
	}

	merge(incoming: SessionRecordInput) {
		return this.#put(incoming, true);
	}

	mergeAll(records: readonly SessionRecordInput[]) {
		return records.map((record) => this.merge(record));
	}

	seed(cached: SessionRecord) {
		return this.#records.get(cached.id) ?? this.#put(cached, false);
	}

	seedAll(records: readonly SessionRecord[]) {
		return records.map((record) => this.seed(record));
	}

	mergeRemote(record: SessionRecord) {
		if (this.#records.has(record.id)) this.#put(record, false);
	}

	applyRecord(incoming: SessionRecordInput): Promise<void> {
		return this.#whenLoaded(incoming.id, () => this.merge(incoming));
	}

	applyTurn(turn: Partial<SessionTurnRecord>) {
		const id = turn.sessionId;
		if (!id) return;
		void this.#whenLoaded(id, () => {
			const session = this.#records.get(id);
			if (!session) return;
			const next = mergeSessionTurnState(session, turn);
			if (next === session) return;
			this.#records.set(id, next);
			this.#schedulePersist(id);
		});
	}

	async hydrate(spaceId: string, ids: readonly string[]) {
		const generation = this.#generation;
		const missing = [...new Set(ids)].filter((id) => !this.#records.has(id));
		if (missing.length === 0) return;
		const cached = await this.#persistence
			.findMany(spaceId, missing)
			.catch(() => []);
		if (generation === this.#generation) this.seedAll(cached);
	}

	forget(id: string) {
		this.#pending.delete(id);
		this.#records.delete(id);
	}

	async flush() {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		const records = [...this.#pending].flatMap((id) => {
			const record = this.#records.get(id);
			return record ? [record] : [];
		});
		this.#pending.clear();
		if (records.length === 0) return;
		await this.#persistence.save(records).catch((error: unknown) => {
			console.warn("[session-store] persist failed", error);
		});
	}

	reset() {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		this.#generation += 1;
		this.#pending.clear();
		this.#loading.clear();
		this.#records.clear();
	}

	#whenLoaded(id: string, apply: () => void): Promise<void> {
		const pending = this.#loading.get(id);
		if (!pending && this.#records.has(id)) {
			apply();
			return Promise.resolve();
		}
		const generation = this.#generation;
		const current = () => generation === this.#generation;
		const base =
			pending ??
			this.#persistence
				.find(id)
				.catch(() => null)
				.then((cached) => {
					if (cached && current()) this.seed(cached);
				});
		const run: Promise<void> = base
			.then(() => {
				if (current()) apply();
			})
			.catch((error: unknown) => {
				console.warn("[session-store] realtime apply failed", error);
			})
			.finally(() => {
				if (this.#loading.get(id) === run) this.#loading.delete(id);
			});
		this.#loading.set(id, run);
		return run;
	}

	#put(incoming: SessionRecordInput, persist: boolean) {
		const existing = this.#records.get(incoming.id);
		const merged = mergeSessionRecord(existing, incoming);
		if (existing && sameData(existing, merged)) return existing;
		this.#records.set(merged.id, merged);
		if (persist) this.#schedulePersist(merged.id);
		return merged;
	}

	#schedulePersist(id: string) {
		this.#pending.add(id);
		this.#timer ??= setTimeout(() => void this.flush(), this.#persistDelayMs);
	}
}
