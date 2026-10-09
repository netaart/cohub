import {
	type BoardViewport,
	clampZoom,
	normalizeViewport,
} from "@neta-art/cohub/board";


const STORAGE_PREFIX = "cohub:board:view";
const MAX_ENTRIES = 200;

type BoardSurfaceSize = { width: number; height: number };

export type BoardViewPreference = {
	centerX: number;
	centerY: number;
	zoom: number;
	updatedAt: number;
};

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

function validSurface(surface: BoardSurfaceSize) {
	return (
		Number.isFinite(surface.width) &&
		Number.isFinite(surface.height) &&
		surface.width > 0 &&
		surface.height > 0
	);
}

function parsePreference(value: unknown): BoardViewPreference | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Partial<BoardViewPreference>;
	if (
		!Number.isFinite(record.centerX) ||
		!Number.isFinite(record.centerY) ||
		!Number.isFinite(record.zoom)
	) {
		return null;
	}
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

function readAll(userKey: string, storage: Storage): Record<string, BoardViewPreference> {
	const entries: Record<string, BoardViewPreference> = {};
	try {
		const raw = storage.getItem(storageKey(userKey));
		const parsed = raw ? JSON.parse(raw) : null;
		if (!parsed || typeof parsed !== "object") return entries;
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			const entry = parsePreference(value);
			if (entry) entries[key] = entry;
		}
	} catch {
		return {};
	}
	return entries;
}

function entryKey(spaceId: string, boardId: string) {
	return `${spaceId}:${boardId}`;
}

export function boardViewPreferenceFromCamera(
	camera: BoardViewport,
	surface: BoardSurfaceSize,
	updatedAt = Date.now(),
): BoardViewPreference | null {
	if (!validSurface(surface)) return null;
	const viewport = normalizeViewport(camera);
	return {
		centerX: (surface.width / 2 - viewport.x) / viewport.zoom,
		centerY: (surface.height / 2 - viewport.y) / viewport.zoom,
		zoom: viewport.zoom,
		updatedAt,
	};
}

export function cameraFromBoardViewPreference(
	preference: BoardViewPreference,
	surface: BoardSurfaceSize,
): BoardViewport | null {
	if (!validSurface(surface)) return null;
	const parsed = parsePreference(preference);
	if (!parsed) return null;
	return normalizeViewport({
		x: surface.width / 2 - parsed.centerX * parsed.zoom,
		y: surface.height / 2 - parsed.centerY * parsed.zoom,
		zoom: parsed.zoom,
	});
}

export function readBoardViewPreference(
	userKey: string,
	spaceId: string,
	boardId: string,
	storage = browserStorage(),
): BoardViewPreference | null {
	if (!storage) return null;
	return readAll(userKey, storage)[entryKey(spaceId, boardId)] ?? null;
}

export function writeBoardViewPreference(
	userKey: string,
	spaceId: string,
	boardId: string,
	preference: BoardViewPreference,
	storage = browserStorage(),
) {
	if (!storage) return;
	const parsed = parsePreference(preference);
	if (!parsed) return;
	try {
		const entries = readAll(userKey, storage);
		entries[entryKey(spaceId, boardId)] = parsed;
		const trimmed = Object.entries(entries)
			.sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
			.slice(0, MAX_ENTRIES);
		storage.setItem(storageKey(userKey), JSON.stringify(Object.fromEntries(trimmed)));
	} catch {
	}
}
