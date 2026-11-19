import type { SpaceTurnListItem, SpaceTurnsResponse } from "@neta-art/cohub";

const STATE_VERSION = 1;
const RECENT_TURN_LIMIT = 256;
const LEASE_TTL_MS = 15_000;
const STATE_PREFIX = "cohub:space-danmaku-catchup:v1";

type CatchupState = {
	version: 1;
	afterCursor: string;
	recentTurnIds: string[];
	updatedAt: number;
};

export type DanmakuCatchupCandidate = {
	id: string;
	text: string;
	sessionId: string;
	sequence: number;
	userUuid: string;
	authorName: string;
	avatarUrl: string | null;
	createdAt: string;
	source: "catchup";
};

type CatchupOptions = {
	spaceId: string;
	userKey: string;
	getActiveSessionId: () => string | null;
	fetchLimit: number;
	playLimit: number;
	isCurrent: () => boolean;
	fetchTurns: (options: {
		author: "others";
		after?: string;
		limit: number;
	}) => Promise<SpaceTurnsResponse>;
	enqueue: (items: DanmakuCatchupCandidate[]) => string[];
};

function isBrowser() {
	return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

export function spaceDanmakuCatchupStateKey(userKey: string, spaceId: string) {
	return `${STATE_PREFIX}:state:${encodeURIComponent(userKey)}:${encodeURIComponent(spaceId)}`;
}

function lockKey(userKey: string, spaceId: string) {
	return `${STATE_PREFIX}:lock:${encodeURIComponent(userKey)}:${encodeURIComponent(spaceId)}`;
}

function readState(userKey: string, spaceId: string): CatchupState | null {
	if (!isBrowser()) return null;
	try {
		const parsed = JSON.parse(
			localStorage.getItem(spaceDanmakuCatchupStateKey(userKey, spaceId)) ??
				"null",
		) as Partial<CatchupState> | null;
		if (
			parsed?.version !== STATE_VERSION ||
			typeof parsed.afterCursor !== "string" ||
			!Array.isArray(parsed.recentTurnIds)
		) {
			return null;
		}
		return {
			version: STATE_VERSION,
			afterCursor: parsed.afterCursor,
			recentTurnIds: parsed.recentTurnIds
				.filter((id): id is string => typeof id === "string")
				.slice(-RECENT_TURN_LIMIT),
			updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
		};
	} catch {
		return null;
	}
}

function writeState(userKey: string, spaceId: string, state: CatchupState) {
	if (!isBrowser()) return;
	try {
		localStorage.setItem(
			spaceDanmakuCatchupStateKey(userKey, spaceId),
			JSON.stringify(state),
		);
	} catch {
		// Best-effort UI state must never block the workspace.
	}
}

export function mergeRecentTurnIds(current: string[], incoming: string[]) {
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const id of [...current, ...incoming]) {
		if (!id || seen.has(id)) continue;
		seen.add(id);
		merged.push(id);
	}
	return merged.slice(-RECENT_TURN_LIMIT);
}

function createToken() {
	return typeof crypto !== "undefined" && "randomUUID" in crypto
		? crypto.randomUUID()
		: `${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function readLease(key: string) {
	try {
		return JSON.parse(localStorage.getItem(key) ?? "null") as {
			token?: unknown;
			expiresAt?: unknown;
		} | null;
	} catch {
		return null;
	}
}

async function withFallbackLease<T>(
	userKey: string,
	spaceId: string,
	task: () => Promise<T>,
): Promise<T | null> {
	const key = lockKey(userKey, spaceId);
	const token = createToken();
	const now = Date.now();
	try {
		const current = readLease(key);
		if (typeof current?.expiresAt === "number" && current.expiresAt > now) {
			return null;
		}
		localStorage.setItem(
			key,
			JSON.stringify({ token, expiresAt: now + LEASE_TTL_MS }),
		);
		const claimed = readLease(key);
		if (claimed?.token !== token) return null;
		return await task();
	} finally {
		try {
			const current = readLease(key);
			if (current?.token === token) localStorage.removeItem(key);
		} catch {
			// Ignore malformed or unavailable lease storage.
		}
	}
}

async function withCatchupLock<T>(
	userKey: string,
	spaceId: string,
	task: () => Promise<T>,
): Promise<T | null> {
	if (!isBrowser()) return null;
	if (navigator.locks?.request) {
		return navigator.locks.request(
			lockKey(userKey, spaceId),
			{ ifAvailable: true, mode: "exclusive" },
			async (lock) => (lock ? task() : null),
		);
	}
	return withFallbackLease(userKey, spaceId, task);
}

function fallbackAuthorName(turn: SpaceTurnListItem) {
	return turn.authorProfile?.displayName?.trim() || turn.userUuid || "User";
}

export function selectSpaceDanmakuCatchupCandidates(input: {
	turns: SpaceTurnListItem[];
	recentTurnIds: string[];
	activeSessionId: string | null;
	limit?: number;
}) {
	const recent = new Set(input.recentTurnIds);
	const candidates = input.turns
		.filter(
			(turn) =>
				turn.initiator === "human" &&
				!recent.has(turn.id) &&
				turn.sessionId !== input.activeSessionId &&
				Boolean(turn.userUuid && turn.userPreview?.trim()),
		)
		.map(
			(turn): DanmakuCatchupCandidate => ({
				id: turn.id,
				text: turn.userPreview?.trim() ?? "",
				sessionId: turn.sessionId,
				sequence: turn.sequence,
				userUuid: turn.userUuid as string,
				authorName: fallbackAuthorName(turn),
				avatarUrl: turn.authorProfile?.avatarUrl ?? null,
				createdAt: turn.createdAt,
				source: "catchup",
			}),
		);
	return candidates.slice(0, input.limit).reverse();
}

export async function runSpaceDanmakuCatchup(options: CatchupOptions) {
	return withCatchupLock(options.userKey, options.spaceId, async () => {
		if (!options.isCurrent()) return null;
		const state = readState(options.userKey, options.spaceId);
		const response = await options.fetchTurns({
			author: "others",
			...(state?.afterCursor ? { after: state.afterCursor } : {}),
			limit: state ? options.fetchLimit : 1,
		});
		if (!options.isCurrent()) return null;

		if (!state) {
			writeState(options.userKey, options.spaceId, {
				version: STATE_VERSION,
				afterCursor: response.snapshotCursor,
				recentTurnIds: [],
				updatedAt: Date.now(),
			});
			return { initialized: true, enqueued: 0 };
		}

		const candidates = selectSpaceDanmakuCatchupCandidates({
			turns: response.turns,
			recentTurnIds: state.recentTurnIds,
			activeSessionId: options.getActiveSessionId(),
			limit: options.playLimit,
		});
		const acceptedIds = options.enqueue(candidates);
		const latestState = readState(options.userKey, options.spaceId) ?? state;

		writeState(options.userKey, options.spaceId, {
			version: STATE_VERSION,
			afterCursor: response.snapshotCursor,
			recentTurnIds: mergeRecentTurnIds(
				latestState.recentTurnIds,
				response.turns.map((turn) => turn.id),
			),
			updatedAt: Date.now(),
		});
		return {
			initialized: false,
			enqueued: acceptedIds.length,
			committed: true,
		};
	});
}

export function rememberSpaceDanmakuTurn(
	userKey: string,
	spaceId: string,
	turnId: string,
) {
	const state = readState(userKey, spaceId);
	if (!state) return;
	writeState(userKey, spaceId, {
		...state,
		recentTurnIds: mergeRecentTurnIds(state.recentTurnIds, [turnId]),
		updatedAt: Date.now(),
	});
}
