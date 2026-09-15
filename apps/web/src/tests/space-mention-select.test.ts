import assert from "node:assert/strict";
import test from "node:test";
import { textMatchScore } from "$lib/command-palette/score";
import type { SpaceMentionSuggestion } from "$lib/mentions/space";
import {
	mergeSpaceMentionSuggestions,
	selectSpaceMentionSuggestions,
} from "$lib/mentions/space-mention-select";

const VIEWER = "viewer";

function suggestion(
	id: string,
	name: string,
	extra: Partial<SpaceMentionSuggestion> = {},
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
		source: "local",
		score: 0,
		textScore: 0,
		recencyScore: 0,
		typePriorityScore: 0,
		...extra,
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

test("tt matches test as a subsequence, like command-palette space search", () => {
	assert.ok(textMatchScore("test", "tt") > 0);
	assert.ok(textMatchScore("test-feishu", "tt") > 0);
	assert.ok(textMatchScore("sandbox test", "tt") > 0);
	assert.equal(
		textMatchScore("world_01KSFNYTZ9H8BFPJVRM7HSETTG", "tt") > 0,
		true,
	);
});

test("typed @ query ranks owned spaces above public substring hits", () => {
	installRecentSpaces([]);
	assert.deepEqual(
		mergeSpaceMentionSuggestions({
			local: [
				suggestion("mine", "test", {
					viewerRelation: "creator",
					viewerTier: 0,
					textScore: 0.5,
					score: 0.55,
					typePriorityScore: 0.88,
				}),
			],
			remote: [
				suggestion("public", "world_01KSFNYTZ9H8BFPJVRM7HSETTG", {
					source: "remote",
					viewerRelation: "unrelated",
					viewerTier: 2,
					textScore: 0.74,
					score: 0.7,
					typePriorityScore: 1,
				}),
			],
			query: "tt",
			currentSpaceId: "current",
			viewerUserUuid: VIEWER,
		}).map((item) => item.spaceId),
		["mine", "public"],
	);
});

test("typed @ query keeps subsequence matches instead of requiring a substring", () => {
	installRecentSpaces([]);
	assert.deepEqual(
		mergeSpaceMentionSuggestions({
			local: [suggestion("mine", "test", { textScore: 0.5, score: 0.55 })],
			remote: [],
			query: "tt",
			currentSpaceId: "current",
			viewerUserUuid: VIEWER,
		}).map((item) => item.spaceId),
		["mine"],
	);
});
