import assert from "node:assert/strict";
import { test } from "node:test";
import type { GlobalSearchResult } from "@neta-art/cohub";
import { withLocalCommands } from "../lib/command-palette/commands";
import { mergeCommandResults } from "../lib/command-palette/merge-results";
import { getViewerTurnActivityBySpace } from "../lib/command-palette/personal-activity";
import { sortCommandItems } from "../lib/command-palette/score";
import type {
	CommandPaletteItem,
	CommandPaletteViewerRelation,
} from "../lib/command-palette/types";

let nextId = 0;

function makeItem(input: {
	type: CommandPaletteItem["type"];
	title: string;
	score: number;
	textScore?: number;
	viewerRelation?: CommandPaletteViewerRelation | null;
	viewerTier?: number;
	updatedAt?: string;
}): CommandPaletteItem {
	nextId += 1;
	return {
		type: input.type,
		id: `item-${nextId}`,
		spaceId: `space-${nextId}`,
		sessionId: input.type === "chat" ? `session-${nextId}` : null,
		title: input.title,
		excerpt: null,
		spaceName: null,
		matchedField: "title",
		href: "#",
		score: input.score,
		textScore: input.textScore ?? 0.5,
		recencyScore: 0.5,
		typePriorityScore: 0.5,
		membershipPriorityScore: 1,
		updatedAt: input.updatedAt ?? null,
		source: "local",
		...(input.viewerRelation !== undefined
			? { viewerRelation: input.viewerRelation }
			: {}),
		...(input.viewerTier !== undefined ? { viewerTier: input.viewerTier } : {}),
	};
}

test("personal results outrank foreign results even with lower scores", () => {
	const mine = makeItem({
		type: "chat",
		title: "我需要你帮我写介绍视频文案",
		score: 0.5,
		viewerRelation: "creator",
		viewerTier: 0,
	});
	const foreign = makeItem({
		type: "chat",
		title: "视频",
		score: 0.95,
		viewerRelation: "unrelated",
		viewerTier: 2,
	});
	const sorted = sortCommandItems([foreign, mine]);
	assert.equal(sorted[0]?.title, mine.title);
	assert.equal(sorted[1]?.title, foreign.title);
});

test("creator and participant share tier 0; unknown defaults to tier 1", () => {
	const creator = makeItem({
		type: "chat",
		title: "creator",
		score: 0.4,
		viewerRelation: "creator",
		viewerTier: 0,
	});
	const participant = makeItem({
		type: "chat",
		title: "participant",
		score: 0.41,
		viewerRelation: "participant",
		viewerTier: 0,
	});
	const unknown = makeItem({
		type: "chat",
		title: "unknown",
		score: 0.42,
	});
	const sorted = sortCommandItems([unknown, participant, creator]);
	// Tier 0 items first (score order within tier), unknown tier 1 last.
	assert.equal(sorted[0]?.title, "participant");
	assert.equal(sorted[1]?.title, "creator");
	assert.equal(sorted[2]?.title, "unknown");
});

test("long queries let strong exact matches bypass the tier", () => {
	const mineWeak = makeItem({
		type: "chat",
		title: "mine weak match",
		score: 0.5,
		textScore: 0.5,
		viewerRelation: "creator",
		viewerTier: 0,
	});
	const foreignExact = makeItem({
		type: "chat",
		title: "exact foreign title",
		score: 0.6,
		textScore: 0.95,
		viewerRelation: "unrelated",
		viewerTier: 2,
	});
	// Short query: personal tier wins.
	const shortSorted = sortCommandItems([foreignExact, mineWeak]);
	assert.equal(shortSorted[0]?.title, mineWeak.title);
	// Long query: strong text match surfaces to tier 0 and outscores mine.
	const longSorted = sortCommandItems([mineWeak, foreignExact], true);
	assert.equal(longSorted[0]?.title, foreignExact.title);
});

test("merge keeps remote viewer tier over local derivation", () => {
	const localItem = makeItem({
		type: "chat",
		title: "视频",
		score: 0.6,
	});
	const remote: GlobalSearchResult = {
		type: "chat",
		id: localItem.id,
		spaceId: localItem.spaceId,
		sessionId: localItem.sessionId,
		title: localItem.title,
		matchedField: "title",
		href: "#",
		viewerRelation: "creator",
		effectiveTier: 0,
		score: 0.6,
		textScore: 0.6,
		recencyScore: 0.5,
		typePriorityScore: 0.74,
		updatedAt: null,
		source: "remote",
	};
	const merged = mergeCommandResults({ local: [localItem], remote: [remote] });
	assert.equal(merged.length, 1);
	assert.equal(merged[0]?.viewerRelation, "creator");
	assert.equal(merged[0]?.viewerTier, 0);
});

test("merged personal chat beats unrelated chat with higher score", () => {
	const mine: GlobalSearchResult = {
		type: "chat",
		id: "mine",
		spaceId: "s1",
		sessionId: "mine",
		title: "我的视频文案会话",
		matchedField: "title",
		href: "#",
		score: 0.5,
		textScore: 0.74,
		recencyScore: 0.5,
		typePriorityScore: 0.74,
		viewerRelation: "participant",
		effectiveTier: 0,
		updatedAt: "2026-08-24T00:00:00.000Z",
		source: "remote",
	};
	const foreign: GlobalSearchResult = {
		type: "chat",
		id: "foreign",
		spaceId: "s2",
		sessionId: "foreign",
		title: "视频",
		matchedField: "title",
		href: "#",
		score: 0.95,
		textScore: 1,
		recencyScore: 0.9,
		typePriorityScore: 0.74,
		viewerRelation: "unrelated",
		effectiveTier: 2,
		updatedAt: "2026-08-25T00:00:00.000Z",
		source: "remote",
	};
	const merged = mergeCommandResults({
		local: [],
		remote: [foreign, mine],
	});
	assert.equal(merged[0]?.id, "mine");
	assert.equal(merged[1]?.id, "foreign");
});

test("local Recent activity ignores turns authored by other participants", () => {
	const activity = getViewerTurnActivityBySpace(
		[
			{
				spaceId: "space-a",
				turns: [
					{
						userUuid: "other",
						createdAt: "2026-08-27T12:00:00.000Z",
						updatedAt: "2026-08-27T12:05:00.000Z",
					},
				],
			},
			{
				spaceId: "space-b",
				turns: [
					{
						userUuid: "viewer",
						createdAt: "2026-08-27T11:00:00.000Z",
						updatedAt: "2026-08-27T11:01:00.000Z",
					},
				],
			},
		],
		"viewer",
	);
	assert.equal(activity.has("space-a"), false);
	assert.equal(activity.get("space-b"), "2026-08-27T11:01:00.000Z");
});

test("local Recent activity ignores invalid viewer timestamps", () => {
	const activity = getViewerTurnActivityBySpace(
		[
			{
				spaceId: "space-a",
				turns: [
					{
						userUuid: "viewer",
						createdAt: "invalid",
						updatedAt: "invalid",
					},
				],
			},
		],
		"viewer",
	);
	assert.equal(activity.has("space-a"), false);
});

test("withLocalCommands preserves tier ordering for search results", () => {
	const mine = makeItem({
		type: "chat",
		title: "mine",
		score: 0.5,
		viewerRelation: "creator",
		viewerTier: 0,
	});
	const foreign = makeItem({
		type: "chat",
		title: "foreign chat",
		score: 0.9,
		viewerRelation: "unrelated",
		viewerTier: 2,
	});
	const result = withLocalCommands([foreign, mine], [], 30);
	assert.equal(result[0]?.title, "mine");
	assert.equal(result[1]?.title, "foreign chat");
});
