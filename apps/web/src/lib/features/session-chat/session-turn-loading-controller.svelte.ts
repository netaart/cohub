import type { SessionTurnIndexItem } from "@cohub/protocol/model";
import { HttpError } from "@neta-art/cohub";
import { createRequestDedupe } from "#lib/features/space/modules/request-dedupe.ts";
import { sdk } from "#lib/sdk.ts";

export function createSessionTurnLoadingController(options: {
	getSpaceId: () => string;
	onIndexLoaded: (sessionId: string) => void;
}) {
	let turnIndexBySessionId = $state<Record<string, SessionTurnIndexItem[]>>({});
	let turnIndexLoadingBySessionId = $state<Record<string, boolean>>({});
	let turnIndexRetryAfterBySessionId = $state<Record<string, number>>({});
	let loadingTurnSequence = $state<number | null>(null);
	const turnWindowLoadDedupe = createRequestDedupe();

	async function loadTurnIndex(sessionId: string, force = false) {
		if (!force && Object.hasOwn(turnIndexBySessionId, sessionId)) return;
		if (turnIndexLoadingBySessionId[sessionId]) return;
		if (!force) {
			if (typeof navigator !== "undefined" && !navigator.onLine) return;
			const retryAfter = turnIndexRetryAfterBySessionId[sessionId] ?? 0;
			if (retryAfter > Date.now()) return;
		}
		return turnWindowLoadDedupe.run(`turn-index:${sessionId}`, async () => {
			const requestSpaceId = options.getSpaceId();
			turnIndexLoadingBySessionId = {
				...turnIndexLoadingBySessionId,
				[sessionId]: true,
			};
			try {
				let cursor: number | undefined;
				const collected: SessionTurnIndexItem[] = [];
				for (let page = 0; page < 20; page += 1) {
					const response = await sdk
						.space(requestSpaceId)
						.session(sessionId)
						.turns.index({
							cursor,
							limit: 500,
						});
					collected.push(...response.turns);
					if (!response.hasMore || response.nextCursor == null) break;
					cursor = response.nextCursor;
				}
				if (options.getSpaceId() !== requestSpaceId) return;
				// Dedupe by sequence first (authoritative rail order), then id.
				// Duplicate keys crash Svelte keyed each in TurnRail/TurnNavigatorPanel.
				const bySequence = new Map<number, (typeof collected)[number]>();
				for (const turn of collected) {
					bySequence.set(turn.sequence, turn);
				}
				const deduped = [...bySequence.values()].sort(
					(a, b) => a.sequence - b.sequence,
				);
				turnIndexBySessionId = {
					...turnIndexBySessionId,
					[sessionId]: deduped,
				};
				if (turnIndexRetryAfterBySessionId[sessionId]) {
					const nextRetryAfterBySessionId = {
						...turnIndexRetryAfterBySessionId,
					};
					delete nextRetryAfterBySessionId[sessionId];
					turnIndexRetryAfterBySessionId = nextRetryAfterBySessionId;
				}
				options.onIndexLoaded(sessionId);
			} catch (error) {
				if (options.getSpaceId() !== requestSpaceId) return;
				const retryDelayMs =
					error instanceof HttpError && error.status === 401 ? 60_000 : 15_000;
				turnIndexRetryAfterBySessionId = {
					...turnIndexRetryAfterBySessionId,
					[sessionId]: Date.now() + retryDelayMs,
				};
				console.warn("[loadTurnIndex] Failed to load turn index:", error);
			} finally {
				if (options.getSpaceId() === requestSpaceId) {
					turnIndexLoadingBySessionId = {
						...turnIndexLoadingBySessionId,
						[sessionId]: false,
					};
				}
			}
		});
	}

	function reset() {
		turnIndexBySessionId = {};
		turnIndexLoadingBySessionId = {};
		turnIndexRetryAfterBySessionId = {};
		loadingTurnSequence = null;
		turnWindowLoadDedupe.clear();
	}

	return {
		get turnIndexBySessionId() {
			return turnIndexBySessionId;
		},
		set turnIndexBySessionId(value: Record<string, SessionTurnIndexItem[]>) {
			turnIndexBySessionId = value;
		},
		get turnIndexLoadingBySessionId() {
			return turnIndexLoadingBySessionId;
		},
		set turnIndexLoadingBySessionId(value: Record<string, boolean>) {
			turnIndexLoadingBySessionId = value;
		},
		get turnIndexRetryAfterBySessionId() {
			return turnIndexRetryAfterBySessionId;
		},
		set turnIndexRetryAfterBySessionId(value: Record<string, number>) {
			turnIndexRetryAfterBySessionId = value;
		},
		get loadingTurnSequence() {
			return loadingTurnSequence;
		},
		set loadingTurnSequence(value: number | null) {
			loadingTurnSequence = value;
		},
		runTurnWindowLoad(key: string, task: () => Promise<void>) {
			return turnWindowLoadDedupe.run(`turn-window:${key}`, task);
		},
		loadTurnIndex,
		reset,
	};
}
