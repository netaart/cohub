import assert from "node:assert/strict";
import test from "node:test";
import {
	filterSpacePickerItems,
	normalizeSpacePickerQuery,
	orderSpacePickerItems,
} from "#lib/space-picker-model.ts";

const spaces = [
	{ id: "a", name: "Alpha", ownerUserUuid: "viewer", isPinned: true },
	{ id: "b", name: "Beta", ownerUserUuid: "other", isPinned: false },
	{ id: "c", name: "Gamma", ownerUserUuid: "viewer", isPinned: false },
];

test("space picker normalizes queries and shares mine/pinned filters", () => {
	assert.equal(normalizeSpacePickerQuery("  AL pha  "), "al pha");
	assert.deepEqual(
		filterSpacePickerItems(spaces, "mine", "", "viewer").map(
			(space) => space.id,
		),
		["a", "c"],
	);
	assert.deepEqual(
		filterSpacePickerItems(spaces, "pinned", "", "viewer").map(
			(space) => space.id,
		),
		["a"],
	);
	assert.deepEqual(
		filterSpacePickerItems(spaces, "all", "ga", "viewer").map(
			(space) => space.id,
		),
		["c"],
	);
});

test("space picker orders known recent spaces first", () => {
	const store: Record<string, string> = {
		"cohub:recent-spaces:viewer:v1": JSON.stringify([
			{ spaceId: "c", sessionId: null, timestamp: Date.now() },
			{ spaceId: "a", sessionId: null, timestamp: Date.now() - 1 },
		]),
	};
	globalThis.window = {} as Window & typeof globalThis;
	globalThis.localStorage = {
		getItem: (key: string) => store[key] ?? null,
		setItem: (key: string, value: string) => {
			store[key] = value;
		},
		removeItem: (key: string) => {
			delete store[key];
		},
	} as Storage;
	assert.deepEqual(
		orderSpacePickerItems(spaces, "viewer").map((space) => space.id),
		["c", "a", "b"],
	);
});
