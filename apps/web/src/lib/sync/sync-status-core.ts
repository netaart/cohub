export type SyncPhase = "idle" | "offline" | "connecting" | "updating";

export type SocketState =
	| "idle"
	| "connecting"
	| "reconnecting"
	| "open"
	| "closed"
	| "error";

export const SYNC_TIMING = {
	connectingGraceMs: 1_000,
	showDelayMs: 400,
	minVisibleMs: 600,
	resumeGapMs: 30_000,
	recoveryWindowMs: 5_000,
} as const;

export type SyncSignals = {
	online: boolean;
	socket: SocketState;
	socketDownSince: number | null;
	willReconnect: boolean;
	catchUps: number;
};

export function resolveSyncPhase(signals: SyncSignals, now: number): SyncPhase {
	if (!signals.online) return "offline";
	const reconnecting =
		signals.socket === "connecting" ||
		signals.socket === "reconnecting" ||
		((signals.socket === "closed" || signals.socket === "error") &&
			signals.willReconnect);
	if (
		reconnecting &&
		signals.socketDownSince !== null &&
		now - signals.socketDownSince >= SYNC_TIMING.connectingGraceMs
	)
		return "connecting";
	if (signals.catchUps > 0) return "updating";
	return "idle";
}

export class GapTracker {
	#everOpen = false;
	#dropped = false;
	#hiddenAt: number | null = null;

	socket(state: SocketState): boolean {
		if (state !== "open") {
			if (this.#everOpen) this.#dropped = true;
			return false;
		}
		const gap = this.#dropped;
		this.#everOpen = true;
		this.#dropped = false;
		return gap;
	}

	visibility(visible: boolean, now: number): boolean {
		if (!visible) {
			this.#hiddenAt ??= now;
			return false;
		}
		const hiddenAt = this.#hiddenAt;
		this.#hiddenAt = null;
		return hiddenAt !== null && now - hiddenAt >= SYNC_TIMING.resumeGapMs;
	}
}

type Timers = {
	now(): number;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
};

const defaultTimers: Timers = {
	now: () => Date.now(),
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (handle) =>
		clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class PhaseDisplay {
	#shown: SyncPhase = "idle";
	#shownAt = 0;
	#target: SyncPhase = "idle";
	#timer: unknown = null;
	readonly #timers: Timers;
	readonly #onChange: (phase: SyncPhase) => void;

	constructor(onChange: (phase: SyncPhase) => void, timers = defaultTimers) {
		this.#onChange = onChange;
		this.#timers = timers;
	}

	get shown() {
		return this.#shown;
	}

	set(target: SyncPhase) {
		if (target === this.#target) return;
		this.#target = target;
		this.#cancel();
		if (target === "idle") {
			if (this.#shown === "idle") return;
			const remaining =
				SYNC_TIMING.minVisibleMs - (this.#timers.now() - this.#shownAt);
			if (remaining <= 0) this.#show("idle");
			else this.#schedule(() => this.#show("idle"), remaining);
			return;
		}
		if (this.#shown !== "idle") {
			this.#show(target, false);
			return;
		}
		this.#schedule(() => this.#show(target), SYNC_TIMING.showDelayMs);
	}

	dispose() {
		this.#cancel();
	}

	#show(phase: SyncPhase, stamp = true) {
		this.#timer = null;
		if (phase === this.#shown) return;
		if (stamp) this.#shownAt = this.#timers.now();
		this.#shown = phase;
		this.#onChange(phase);
	}

	#schedule(callback: () => void, ms: number) {
		this.#timer = this.#timers.setTimeout(callback, ms);
	}

	#cancel() {
		if (this.#timer === null) return;
		this.#timers.clearTimeout(this.#timer);
		this.#timer = null;
	}
}
