import { sdk } from "$lib/sdk";
import {
	GapTracker,
	PhaseDisplay,
	resolveSyncPhase,
	type SocketState,
	SYNC_TIMING,
	type SyncPhase,
	type SyncSignals,
} from "$lib/sync/sync-status-core";

class SyncStatus {
	phase = $state<SyncPhase>("idle");
	epoch = 1;
	#epochStartedAt = Date.now();
	#signals: SyncSignals = {
		online: true,
		socket: "idle",
		socketDownSince: null,
		willReconnect: false,
		catchUps: 0,
	};
	#gaps = new GapTracker();
	#display = new PhaseDisplay((phase) => {
		this.phase = phase;
	});
	#gapListeners = new Set<() => void>();
	#graceTimer: ReturnType<typeof setTimeout> | null = null;
	#stop: (() => void) | null = null;

	get recovering() {
		return Date.now() - this.#epochStartedAt < SYNC_TIMING.recoveryWindowMs;
	}

	start(): () => void {
		if (this.#stop) return this.#stop;
		if (typeof window === "undefined") return () => undefined;
		this.#signals.online = navigator.onLine !== false;
		this.#setSocket(sdk.connectionState as SocketState, false);
		const stopConnection = sdk.onConnection((snapshot) => {
			const state =
				snapshot.state === "error"
					? (sdk.connectionState as SocketState)
					: snapshot.state;
			this.#setSocket(state, snapshot.willReconnect);
		});
		const onNetwork = () => {
			this.#signals.online = navigator.onLine !== false;
			this.#refresh();
		};
		const onVisibility = () => {
			const visible = document.visibilityState === "visible";
			if (this.#gaps.visibility(visible, Date.now())) this.#gap();
		};
		window.addEventListener("online", onNetwork);
		window.addEventListener("offline", onNetwork);
		document.addEventListener("visibilitychange", onVisibility);
		this.#stop = () => {
			stopConnection();
			window.removeEventListener("online", onNetwork);
			window.removeEventListener("offline", onNetwork);
			document.removeEventListener("visibilitychange", onVisibility);
			if (this.#graceTimer) clearTimeout(this.#graceTimer);
			this.#graceTimer = null;
			this.#display.dispose();
			this.#stop = null;
		};
		return this.#stop;
	}

	onGap(listener: () => void): () => void {
		this.#gapListeners.add(listener);
		return () => this.#gapListeners.delete(listener);
	}

	track<T>(work: Promise<T>): Promise<T> {
		this.#signals.catchUps += 1;
		this.#refresh();
		return work.finally(() => {
			this.#signals.catchUps -= 1;
			this.#refresh();
		});
	}

	#setSocket(state: SocketState, willReconnect: boolean) {
		const signals = this.#signals;
		if (state === "open") signals.socketDownSince = null;
		else if (signals.socketDownSince === null)
			signals.socketDownSince = Date.now();
		signals.socket = state;
		signals.willReconnect = willReconnect;
		if (this.#gaps.socket(state)) this.#gap();
		this.#refresh();
		if (this.#graceTimer) clearTimeout(this.#graceTimer);
		this.#graceTimer =
			state === "open"
				? null
				: setTimeout(() => {
						this.#graceTimer = null;
						this.#refresh();
					}, SYNC_TIMING.connectingGraceMs);
	}

	#gap() {
		this.epoch += 1;
		this.#epochStartedAt = Date.now();
		for (const listener of [...this.#gapListeners]) {
			try {
				listener();
			} catch (error) {
				console.error("[sync] gap listener failed", error);
			}
		}
	}

	#refresh() {
		this.#display.set(resolveSyncPhase(this.#signals, Date.now()));
	}
}

export const syncStatus = new SyncStatus();
