// in: insert or move · out: remove · keep: update if shown · unknown: update if shown, else re-sync
export type LiveFit = "in" | "out" | "keep" | "unknown";

export type Compare<T> = (a: T, b: T) => number;

export function placeItem<T>(
	items: readonly T[],
	item: T,
	options: { id: (item: T) => string; compare: Compare<T>; hasMore: boolean },
): T[] {
	const id = options.id(item);
	const index = items.findIndex((current) => options.id(current) === id);
	const rest =
		index < 0
			? [...items]
			: [...items.slice(0, index), ...items.slice(index + 1)];
	let position = rest.findIndex(
		(current) => options.compare(item, current) < 0,
	);
	if (position < 0) position = rest.length;
	const wasLast = index >= 0 && index === items.length - 1;
	if (
		position === rest.length &&
		options.hasMore &&
		rest.length > 0 &&
		!wasLast
	)
		return rest;
	rest.splice(position, 0, item);
	return rest;
}

export function appendPage<T>(
	items: readonly T[],
	page: readonly T[],
	getId: (item: T) => string,
): T[] {
	const known = new Set(items.map(getId));
	return [...items, ...page.filter((item) => !known.has(getId(item)))];
}

export function mergeFirstPage<T>(
	items: readonly T[],
	page: readonly T[],
	options: {
		id: (item: T) => string;
		paged: boolean;
	},
): T[] {
	if (!options.paged || page.length === 0) return [...page];
	const pageIds = new Set(page.map(options.id));
	let boundary = -1;
	items.forEach((item, index) => {
		if (pageIds.has(options.id(item))) boundary = index;
	});
	if (boundary < 0) return [...page];
	const tail = items
		.slice(boundary + 1)
		.filter((item) => !pageIds.has(options.id(item)));
	return [...page, ...tail];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

export function sameData(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (Array.isArray(a)) {
		return (
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((item, index) => sameData(item, b[index]))
		);
	}
	if (!isPlainObject(a) || !isPlainObject(b)) return false;
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length &&
		keys.every((key) => Object.hasOwn(b, key) && sameData(a[key], b[key]))
	);
}

export function shareItems<T>(
	previous: T[],
	next: T[],
	getId: (item: T) => string,
): T[] {
	const known = new Map(previous.map((item) => [getId(item), item]));
	let unchanged = previous.length === next.length;
	const shared = next.map((item, index) => {
		const old = known.get(getId(item));
		const kept = old !== undefined && sameData(old, item) ? old : item;
		if (kept !== previous[index]) unchanged = false;
		return kept;
	});
	return unchanged ? previous : shared;
}
