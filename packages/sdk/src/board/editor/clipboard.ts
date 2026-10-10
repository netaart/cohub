
import { BOARD_CLIPBOARD_KIND, BOARD_CLIPBOARD_MIME } from "@cohub/protocol";
import {
	arrowBindings,
	type BoardItem,
	createBoardItemId,
	isArrowBinding,
	parseBoardItem,
} from "../model/index.js";

/** How far a duplicate or repeated paste lands from its source. */
export const DUPLICATE_OFFSET = 24;

export { BOARD_CLIPBOARD_MIME };
export const BOARD_CLIPBOARD_VERSION = 3 as const;

export const MAX_CLIPBOARD_ITEMS = 2000;
export const MAX_CLIPBOARD_CHARS = 4 * 1024 * 1024;

export type BoardClipboardPayload = {
	kind: typeof BOARD_CLIPBOARD_KIND;
	version: typeof BOARD_CLIPBOARD_VERSION;
	items: Record<string, BoardItem>;
	origin: { x: number; y: number };
};

export function encodeClipboard(items: Record<string, BoardItem>, origin: { x: number; y: number }): BoardClipboardPayload | null {
	const ids = Object.keys(items);
	if (ids.length === 0 || ids.length > MAX_CLIPBOARD_ITEMS) return null;
	return {
		kind: BOARD_CLIPBOARD_KIND,
		version: BOARD_CLIPBOARD_VERSION,
		items: Object.fromEntries(ids.map((id) => {
			const item = items[id] as BoardItem;
			return [id, item.parent && items[item.parent] ? item : shiftItem(item, -origin.x, -origin.y)];
		})),
		origin,
	};
}

export function parseClipboard(raw: unknown): BoardClipboardPayload | null {
	if (raw == null) return null;
	if (typeof raw === "string") {
		if (raw.length > MAX_CLIPBOARD_CHARS) return null;
		try {
			raw = JSON.parse(raw);
		} catch {
			return null;
		}
	}
	if (!raw || typeof raw !== "object") return null;
	const record = raw as Record<string, unknown>;
	if (record.kind !== BOARD_CLIPBOARD_KIND || record.version !== BOARD_CLIPBOARD_VERSION) return null;
	const origin = record.origin as { x?: unknown; y?: unknown } | undefined;
	if (typeof origin?.x !== "number" || typeof origin.y !== "number" || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return null;
	if (!record.items || typeof record.items !== "object" || Array.isArray(record.items)) return null;
	const entries = Object.entries(record.items as Record<string, unknown>);
	if (entries.length === 0 || entries.length > MAX_CLIPBOARD_ITEMS) return null;
	const items: Record<string, BoardItem> = {};
	for (const [id, value] of entries) {
		const parsed = parseBoardItem(value);
		if (!parsed.ok) return null;
		items[id] = parsed.item;
	}
	return { kind: BOARD_CLIPBOARD_KIND, version: BOARD_CLIPBOARD_VERSION, items, origin: { x: origin.x, y: origin.y } };
}

export function materializeClipboard(
	payload: BoardClipboardPayload,
	at: { x: number; y: number },
	resolveEnd: (id: string, which: "start" | "end") => { x: number; y: number } | null = () => null,
): Record<string, BoardItem> {
	const idMap = new Map(Object.keys(payload.items).map((id) => [id, createBoardItemId()]));
	return remapItems(payload.items, idMap, (item) => (item.parent && idMap.has(item.parent) ? item : shiftItem(item, at.x, at.y)), resolveEnd);
}

export function remapItems(
	items: Record<string, BoardItem>,
	idMap: ReadonlyMap<string, string>,
	place: (item: BoardItem) => BoardItem = (item) => item,
	resolveEnd: (id: string, which: "start" | "end") => { x: number; y: number } | null = () => null,
): Record<string, BoardItem> {
	const result: Record<string, BoardItem> = {};
	for (const [id, source] of Object.entries(items)) {
		let item = place(source);
		const { locked: _locked, ...unlocked } = item;
		item = unlocked as BoardItem;
		if (item.parent) {
			const parent = idMap.get(item.parent);
			if (parent) item = { ...item, parent };
			else {
				const { parent: _parent, ...root } = item;
				item = root as BoardItem;
			}
		}
		if (item.type === "arrow" && arrowBindings(item).length) {
			const end = (which: "start" | "end") => {
				const value = item.type === "arrow" ? item.props[which] : null;
				if (!value || !isArrowBinding(value)) return value;
				const mapped = idMap.get(value.item);
				if (mapped) return { ...value, item: mapped };
				return resolveEnd(id, which) ?? { x: 0, y: 0 };
			};
			item = { ...item, props: { ...item.props, start: end("start"), end: end("end") } } as BoardItem;
		}
		result[idMap.get(id) ?? createBoardItemId()] = item;
	}
	return result;
}

export function defaultPasteOffset(count = 1) {
	return { x: DUPLICATE_OFFSET * count, y: DUPLICATE_OFFSET * count };
}

function shiftItem(item: BoardItem, dx: number, dy: number): BoardItem {
	return { ...item, position: { x: item.position.x + dx, y: item.position.y + dy } };
}
