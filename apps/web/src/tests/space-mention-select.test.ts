import assert from "node:assert/strict";
import test from "node:test";
import { textMatchScore } from "$lib/command-palette/score";
import type { SpaceMentionSuggestion } from "$lib/mentions/space";
import { mergeSpaceMentionSuggestions } from "$lib/mentions/space-mention-select";

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

test("empty @ query keeps Recent default order and drops the current space", () => {
	assert.deepEqual(
		mergeSpaceMentionSuggestions({
			local: [
				suggestion("current", "Current"),
				suggestion("gamma", "Gamma"),
				suggestion("alpha", "Alpha Studio"),
			],
			remote: [],
			query: "",
			currentSpaceId: "current",
		}).map((item) => item.spaceId),
		["gamma", "alpha"],
	);
});

test("tt matches test as a subsequence, like Recent space search", () => {
	assert.ok(textMatchScore("test", "tt") > 0);
	assert.ok(textMatchScore("test-feishu", "tt") > 0);
	assert.ok(textMatchScore("sandbox test", "tt") > 0);
	assert.ok(textMatchScore("world_01KSFNYTZ9H8BFPJVRM7HSETTG", "tt") > 0);
});

test("typed @ query ranks owned spaces above public substring hits", () => {
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
		}).map((item) => item.spaceId),
		["mine", "public"],
	);
});

test("typed @ query keeps subsequence matches instead of requiring a substring", () => {
	assert.deepEqual(
		mergeSpaceMentionSuggestions({
			local: [suggestion("mine", "test", { textScore: 0.5, score: 0.55 })],
			remote: [],
			query: "tt",
			currentSpaceId: "current",
		}).map((item) => item.spaceId),
		["mine"],
	);
});
