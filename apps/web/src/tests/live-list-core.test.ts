import assert from "node:assert/strict";
import test from "node:test";
import {
	appendPage,
	type Compare,
	mergeFirstPage,
	placeItem,
	shareItems,
} from "$lib/lists/live-list-core";

type Row = { id: string; at: number };
const id = (row: Row) => row.id;
const byRecent: Compare<Row> = (a, b) => b.at - a.at;
const rows = (...entries: [string, number][]) =>
	entries.map(([rowId, at]) => ({ id: rowId, at }));
const ids = (items: Row[]) => items.map(id).join(",");

test("placeItem moves an updated row to its sorted position", () => {
	const items = rows(["a", 30], ["b", 20], ["c", 10]);
	const options = { id, compare: byRecent, hasMore: false };
	assert.equal(ids(placeItem(items, { id: "c", at: 40 }, options)), "c,a,b");
	assert.equal(ids(placeItem(items, { id: "d", at: 25 }, options)), "a,d,b,c");
});

test("placeItem leaves rows past a partial window to pagination", () => {
	const items = rows(["a", 30], ["b", 20]);
	const options = { id, compare: byRecent, hasMore: true };
	assert.equal(ids(placeItem(items, { id: "z", at: 1 }, options)), "a,b");
	assert.equal(
		ids(placeItem(items, { id: "a", at: 1 }, options)),
		"b",
		"a row that sinks below the window leaves it",
	);
	assert.equal(
		ids(placeItem(items, { id: "b", at: 15 }, options)),
		"a,b",
		"the last row stays when it is the one updated",
	);
	assert.equal(
		ids(placeItem(items, { id: "z", at: 1 }, { ...options, hasMore: false })),
		"a,b,z",
	);
});

test("mergeFirstPage trusts the page for its range and keeps later pages", () => {
	const loaded = rows(["a", 50], ["gone", 40], ["b", 30], ["c", 20], ["d", 10]);
	const page = rows(["new", 60], ["a", 50], ["b", 30]);
	assert.equal(
		ids(mergeFirstPage(loaded, page, { id, paged: true })),
		"new,a,b,c,d",
		"a row removed inside the page range is dropped, later rows stay",
	);
	assert.equal(
		ids(mergeFirstPage(loaded, page, { id, paged: false })),
		"new,a,b",
	);
	assert.equal(ids(mergeFirstPage(loaded, [], { id, paged: true })), "");
});

test("appendPage skips rows that shifted into an earlier page", () => {
	const items = rows(["a", 3], ["b", 2]);
	assert.equal(ids(appendPage(items, rows(["b", 2], ["c", 1]), id)), "a,b,c");
});

test("shareItems keeps unchanged rows and the list itself", () => {
	const previous = rows(["a", 30], ["b", 20]);
	const same = shareItems(previous, rows(["a", 30], ["b", 20]), id);
	assert.equal(same, previous, "an identical refresh keeps the list");

	const next = shareItems(previous, rows(["c", 40], ["a", 30], ["b", 21]), id);
	assert.notEqual(next, previous);
	assert.equal(ids(next), "c,a,b");
	assert.equal(next[1], previous[0], "an unchanged row keeps its object");
	assert.deepEqual(next[2], { id: "b", at: 21 });

	const reordered = shareItems(previous, rows(["b", 20], ["a", 30]), id);
	assert.notEqual(reordered, previous, "a new order is a new list");
	assert.equal(reordered[0], previous[1]);
});
