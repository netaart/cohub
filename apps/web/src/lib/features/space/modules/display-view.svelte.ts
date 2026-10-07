import {
	type DisplayConnection,
	type DisplayConnectionStats,
	type DisplayInfo,
	HttpError,
} from "@neta-art/cohub";
import { sdk } from "$lib/sdk";

export type DisplayProblem =
	| "unavailable"
	| "offline"
	| "outdated"
	| "busy"
	| "failed";

export type DisplayPhase =
	| { kind: "idle" }
	| { kind: "connecting" }
	| { kind: "live" }
	| { kind: "problem"; problem: DisplayProblem };

const TRANSIENT_CLOSES = new Set(["failed", "connect_timeout", "idle"]);
const RETRY_DELAYS_MS = [500, 2_000, 5_000];
const STATS_INTERVAL_MS = 2_000;

export function problemFromError(error: unknown): DisplayProblem {
	if (!(error instanceof HttpError)) return "failed";
	if (error.code === "sandbox_offline") return "offline";
	if (error.code === "display_unsupported") return "outdated";
	if (error.code === "display_busy") return "busy";
	if (
		error.code === "display_unavailable" ||
		error.code === "display_not_found"
	)
		return "unavailable";
	return "failed";
}

export function createDisplayView(
	spaceId: () => string,
	displayId: () => string,
) {
	let phase = $state<DisplayPhase>({ kind: "idle" });
	let connection = $state<DisplayConnection | null>(null);
	let display = $state<DisplayInfo | null>(null);
	let stats = $state<DisplayConnectionStats | null>(null);
	let inputError = $state(0);
	let wanted = false;
	let attempt = 0;
	let generation = 0;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let statsTimer: ReturnType<typeof setInterval> | null = null;

	function unavailable(current: number) {
		phase = { kind: "problem", problem: "unavailable" };
		void sdk
			.space(spaceId())
			.displays.list()
			.then(({ displays }) => {
				if (current === generation)
					display = displays.find((item) => item.id === displayId()) ?? null;
			})
			.catch(() => undefined);
	}

	function clearTimers() {
		if (retryTimer) clearTimeout(retryTimer);
		if (statsTimer) clearInterval(statsTimer);
		retryTimer = null;
		statsTimer = null;
	}

	async function open() {
		const current = ++generation;
		phase = { kind: "connecting" };
		try {
			const next = await sdk.space(spaceId()).displays.connect(displayId());
			if (current !== generation || !wanted) {
				next.close();
				return;
			}
			connection = next;
			display = next.display;
			next.on("display", (info) => {
				display = info;
			});
			next.on("error", () => {
				inputError += 1;
			});
			next.on("state", (state) => {
				if (current !== generation) return;
				if (state === "connected") {
					attempt = 0;
					phase = { kind: "live" };
					statsTimer ??= setInterval(() => {
						void next.stats().then((value) => {
							if (current === generation) stats = value;
						});
					}, STATS_INTERVAL_MS);
				} else if (state === "closed") {
					closed(next.closeReason);
				}
			});
		} catch (error) {
			if (current !== generation) return;
			const problem = problemFromError(error);
			if (problem === "failed" && retry()) return;
			if (problem === "unavailable") unavailable(current);
			else phase = { kind: "problem", problem };
		}
	}

	function closed(reason: string | null) {
		clearTimers();
		connection = null;
		stats = null;
		if (!wanted) {
			phase = { kind: "idle" };
			return;
		}
		if (reason === "display_ended") {
			unavailable(generation);
			return;
		}
		if (reason && TRANSIENT_CLOSES.has(reason) && retry()) return;
		phase = {
			kind: "problem",
			problem: reason === "closed" ? "unavailable" : "failed",
		};
	}

	function retry(): boolean {
		const delay = RETRY_DELAYS_MS[attempt];
		if (delay === undefined) return false;
		attempt += 1;
		phase = { kind: "connecting" };
		retryTimer = setTimeout(() => {
			retryTimer = null;
			if (wanted) void open();
		}, delay);
		return true;
	}

	function stop() {
		generation += 1;
		clearTimers();
		const current = connection;
		connection = null;
		stats = null;
		current?.close();
		phase = { kind: "idle" };
	}

	return {
		get phase() {
			return phase;
		},
		get connection() {
			return connection;
		},
		get display() {
			return display;
		},
		get stats() {
			return stats;
		},
		get inputError() {
			return inputError;
		},
		setWanted(next: boolean) {
			if (next === wanted) return;
			wanted = next;
			if (next) {
				attempt = 0;
				void open();
			} else stop();
		},
		reconnect() {
			stop();
			if (!wanted) return;
			attempt = 0;
			void open();
		},
		dispose() {
			wanted = false;
			stop();
		},
	};
}
