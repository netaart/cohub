import { COMMAND_PALETTE_LENSES, type CommandPaletteLens } from "./lens";

export type RecentQuery = { lens: CommandPaletteLens; query: string };

const STORAGE_PREFIX = "cohub:command-palette:queries";
export const MAX_RECENT_QUERIES = 8;

function storageKey(userKey: string) {
	return `${STORAGE_PREFIX}:${encodeURIComponent(userKey)}`;
}

const keyOf = (entry: RecentQuery) =>
	`${entry.lens}:${entry.query.toLowerCase()}`;

export function pushRecentQuery(
	entries: readonly RecentQuery[],
	entry: RecentQuery,
	max = MAX_RECENT_QUERIES,
) {
	const query = entry.query.replace(/\s+/g, " ").trim();
	if (!query) return [...entries];
	const next = { lens: entry.lens, query };
	const key = keyOf(next);
	return [next, ...entries.filter((item) => keyOf(item) !== key)].slice(0, max);
}

function isRecentQuery(value: unknown): value is RecentQuery {
	const entry = value as RecentQuery | null;
	return (
		COMMAND_PALETTE_LENSES.some((lens) => lens === entry?.lens) &&
		typeof entry?.query === "string"
	);
}

export function getRecentQueries(userKey: string): RecentQuery[] {
	if (typeof localStorage === "undefined") return [];
	try {
		const parsed: unknown = JSON.parse(
			localStorage.getItem(storageKey(userKey)) ?? "[]",
		);
		return Array.isArray(parsed)
			? parsed.filter(isRecentQuery).slice(0, MAX_RECENT_QUERIES)
			: [];
	} catch {
		return [];
	}
}

export function rememberRecentQuery(userKey: string, entry: RecentQuery) {
	const next = pushRecentQuery(getRecentQueries(userKey), entry);
	try {
		localStorage.setItem(storageKey(userKey), JSON.stringify(next));
	} catch {}
	return next;
}

export function clearRecentQueries(userKey: string) {
	try {
		localStorage.removeItem(storageKey(userKey));
	} catch {}
}
