import { type BoardCameraState, clampZoom } from "@neta-art/cohub/board";

const STORAGE_PREFIX = "cohub:board:view";
const MAX_ENTRIES = 200;

type StoredView = BoardCameraState & { updatedAt: number };

function storageKey(userKey: string) {
	return `${STORAGE_PREFIX}:${encodeURIComponent(userKey)}`;
}

function browserStorage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

function parseView(value: unknown): StoredView | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Partial<StoredView>;
	if (
		!Number.isFinite(record.centerX) ||
		!Number.isFinite(record.centerY) ||
		!Number.isFinite(record.zoom)
	)
		return null;
	return {
		centerX: record.centerX as number,
		centerY: record.centerY as number,
		zoom: clampZoom(record.zoom as number),
		updatedAt:
			typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
				? Math.max(0, record.updatedAt)
				: 0,
	};
}

function readAll(
	userKey: string,
	storage: Storage,
): Record<string, StoredView> {
	const entries: Record<string, StoredView> = {};
	try {
		const raw = storage.getItem(storageKey(userKey));
		const parsed = raw ? JSON.parse(raw) : null;
		if (!parsed || typeof parsed !== "object") return entries;
		for (const [key, value] of Object.entries(
			parsed as Record<string, unknown>,
		)) {
			const entry = parseView(value);
			if (entry) entries[key] = entry;
		}
	} catch {
		return {};
	}
	return entries;
}

export function boardViewKey(
	scope:
		| { kind: "space"; spaceId: string }
		| { kind: "checkpoint"; checkpointId: string }
		| { kind: "app"; appId: string },
	boardId: string,
) {
	if (scope.kind === "space") return `${scope.spaceId}:${boardId}`;
	if (scope.kind === "checkpoint")
		return `checkpoint:${scope.checkpointId}:${boardId}`;
	return `app:${scope.appId}`;
}

export function readBoardView(
	userKey: string,
	key: string,
	storage = browserStorage(),
): BoardCameraState | null {
	if (!storage) return null;
	const entry = readAll(userKey, storage)[key];
	return entry
		? { centerX: entry.centerX, centerY: entry.centerY, zoom: entry.zoom }
		: null;
}

export function writeBoardView(
	userKey: string,
	key: string,
	view: BoardCameraState,
	storage = browserStorage(),
) {
	if (!storage) return;
	const entry = parseView({ ...view, updatedAt: Date.now() });
	if (!entry) return;
	try {
		const entries = readAll(userKey, storage);
		entries[key] = entry;
		const trimmed = Object.entries(entries)
			.sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
			.slice(0, MAX_ENTRIES);
		storage.setItem(
			storageKey(userKey),
			JSON.stringify(Object.fromEntries(trimmed)),
		);
	} catch {}
}
