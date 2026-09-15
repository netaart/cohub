import assert from "node:assert/strict";
import test from "node:test";
import type { SpaceMentionSuggestion } from "$lib/mentions/space";
import {
	mergeSpaceMentionSuggestions,
	selectSpaceMentionSuggestions,
} from "$lib/mentions/space-mention-select";

const VIEWER = "viewer";

function suggestion(
	id: string,
	name: string,
	source: SpaceMentionSuggestion["source"] = "local",
): SpaceMentionSuggestion {
	return {
		type: "space",
		id,
		spaceId: id,
		name,
		description: null,
		ownerProfile: null,
		spaceProfile: { avatarUrl: null },
		href: `/spaces/${id}`,
		uri: `cohub://spaces/${id}`,
		activityAt: null,
		source,
	};
}

function installRecentSpaces(entries: Array<{ spaceId: string; at: number }>) {
	const store: Record<string, string> = {
		[`cohub:recent-spaces:${VIEWER}:v1`]: JSON.stringify(
			entries.map((entry) => ({
				spaceId: entry.spaceId,
				sessionId: null,
				timestamp: entry.at,
			})),
		),
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
}

const now = Date.now();
const spaces = [
	suggestion("current", "Current"),
	suggestion("alpha", "Alpha Studio"),
	suggestion("beta", "Beta Lab"),
	suggestion("gamma", "Gamma"),
	suggestion("delta", "Delta Notes"),
];

test("empty @ query keeps recently visited spaces and drops the current one", () => {
	installRecentSpaces([
		{ spaceId: "current", at: now },
		{ spaceId: "gamma", at: now - 1 },
		{ spaceId: "alpha", at: now - 2 },
	]);
	assert.deepEqual(
		selectSpaceMentionSuggestions(spaces, {
			query: "",
			currentSpaceId: "current",
			viewerUserUuid: VIEWER,
		}).map((item) => item.spaceId),
		["gamma", "alpha"],
	);
});

test("empty @ query with no recents falls back to all other spaces by name", () => {
	installRecentSpaces([]);
	assert.deepEqual(
		selectSpaceMentionSuggestions(spaces, {
			query: "",
			currentSpaceId: "current",
			viewerUserUuid: VIEWER,
		}).map((item) => item.spaceId),
		["alpha", "beta", "delta", "gamma"],
	);
});

test("typed @ query substring-matches names and keeps recents first", () => {
	installRecentSpaces([
		{ spaceId: "delta", at: now },
		{ spaceId: "alpha", at: now - 1 },
	]);
	assert.deepEqual(
		selectSpaceMentionSuggestions(spaces, {
			query: "a",
			currentSpaceId: "current",
			viewerUserUuid: VIEWER,
		}).map((item) => item.spaceId),
		["delta", "alpha", "beta", "gamma"],
	);
});

test("typed @ query ignores recents whose names do not match", () => {
	installRecentSpaces([{ spaceId: "gamma", at: now }]);
	assert.deepEqual(
		selectSpaceMentionSuggestions(spaces, {
			query: "studio",
			currentSpaceId: "current",
			viewerUserUuid: VIEWER,
		}).map((item) => item.spaceId),
		["alpha"],
	);
});

test("merge drops remote fuzzy hits that do not substring-match the name", () => {
	installRecentSpaces([{ spaceId: "alpha", at: now }]);
	assert.deepEqual(
		mergeSpaceMentionSuggestions({
			local: [suggestion("alpha", "Alpha Studio")],
			remote: [
				suggestion("alpha", "Alpha Studio", "remote"),
				suggestion("zeta", "Something Else", "remote"),
			],
			query: "alpha",
			currentSpaceId: "current",
			viewerUserUuid: VIEWER,
		}).map((item) => item.spaceId),
		["alpha"],
	);
});
