import assert from "node:assert/strict";
import { test } from "node:test";
import type { SpaceActivityResponse } from "@neta-art/cohub";
import { Command } from "commander";
import {
	InvalidSpaceActivityDaysError,
	parseActivityDays,
	printActivityReport,
	registerSpaceActivity,
	toAppRankingRows,
	toContributorRows,
} from "../src/commands/space-activity.js";

const response: SpaceActivityResponse = {
	days: 30,
	hourly: [],
	summary: {
		totalTokens: 12_400,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costInput: 0,
		costOutput: 0,
		costCacheRead: 0,
		costCacheWrite: 0,
		costTotal: 3.21,
		requestCount: 86,
		successCount: 84,
		errorCount: 2,
	},
	generation: {
		hourly: [],
		summary: { costTotal: 0, requestCount: 0, successCount: 0, errorCount: 0 },
	},
	totals: {
		totalTokens: 12_400,
		requestCount: 86,
		successCount: 84,
		errorCount: 2,
		costTotal: 3.21,
	},
	rankings: {
		llmModels: [
			{
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				totalTokens: 8200,
				requestCount: 40,
				costTotal: 2.1,
			},
		],
		generationModels: [],
		apps: [
			{
				appId: "app-1",
				slug: "portal",
				title: "Portal",
				status: "published",
				viewCount: 231,
			},
		],
	},
	contributors: {
		memberCount: 3,
		items: [
			{
				userUuid: "user-1",
				role: "host",
				tokens: 8200,
				requests: 40,
				costTotal: 2.1,
				sessionCount: 12,
				lastActiveAt: "2026-08-27T10:00:00.000Z",
				profile: {
					userUuid: "user-1",
					username: "ada",
					displayName: "Ada",
					avatarUrl: null,
				},
			},
		],
	},
};

test("activity days default to 30 and reject out-of-range values", () => {
	assert.equal(parseActivityDays(undefined), 30);
	assert.equal(parseActivityDays("7"), 7);
	assert.equal(parseActivityDays("365"), 365);
	assert.throws(() => parseActivityDays("0"), InvalidSpaceActivityDaysError);
	assert.throws(() => parseActivityDays("366"), InvalidSpaceActivityDaysError);
	assert.throws(() => parseActivityDays("week"), InvalidSpaceActivityDaysError);
});

test("contributor rows prefer display names and format metrics", () => {
	const rows = toContributorRows(response.contributors.items);
	assert.deepEqual(rows, [
		{
			name: "Ada",
			role: "host",
			tokens: "8,200",
			requests: "40",
			sessions: 12,
			cost: "$2.10",
			// Relative time depends on the wall clock; only its shape is asserted.
			lastActive: rows[0].lastActive,
		} satisfies Record<string, unknown>,
	]);
	assert.match(rows[0].lastActive, /^(just now|\d+[mhd] ago)$/);
	assert.equal(toContributorRows([{ ...response.contributors.items[0], lastActiveAt: null }])[0].lastActive, "");
});

test("app ranking rows keep the app id for follow-up commands", () => {
	assert.deepEqual(toAppRankingRows(response.rankings.apps), [
		{
			title: "Portal",
			status: "published",
			views: "231",
			id: "app-1",
		},
	]);
});

test("activity report renders summary, contributors, and rankings", () => {
	const logs: string[] = [];
	const originalLog = console.log;
	console.log = (...values: unknown[]) => {
		logs.push(values.join(" "));
	};
	try {
		printActivityReport(response);
	} finally {
		console.log = originalLog;
	}
	const output = logs.join("\n");
	assert.match(output, /Summary \(last 30 days\)/);
	assert.match(output, /Contributors \(3 members\)/);
	assert.match(output, /Top LLM models/);
	assert.match(output, /Most viewed apps/);
});

test("spaces activity forwards days and json flag to the selected space", async () => {
	const program = new Command("cohub")
		.option("-s, --space <id>", "Target space ID")
		.helpOption("-h, --help", "Show help");
	const spaces = program.command("spaces");
	let calledSpaceId = "";
	let calledDays = 0;
	registerSpaceActivity(spaces, {
		createClient: () => ({
			space: (spaceId) => ({
				activity: {
					get: async (days) => {
						calledSpaceId = spaceId;
						calledDays = days;
						return response;
					},
				},
			}),
		}),
	});

	await program.parseAsync(["node", "cohub", "-s", "7c9e6679-7425-40de-944b-e07fc1f90ae7", "spaces", "activity", "7"]);

	assert.equal(calledSpaceId, "7c9e6679-7425-40de-944b-e07fc1f90ae7");
	assert.equal(calledDays, 7);
	assert.match(spaces.commands.at(-1)?.helpInformation() ?? "", /usage, contributors, rankings/);
});
