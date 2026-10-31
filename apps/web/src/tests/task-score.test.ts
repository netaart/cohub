import assert from "node:assert/strict";
import { test } from "node:test";
import { generationOutput } from "@cohub/protocol";
import {
	buildGenerationRequestMessage,
	buildGenerationResultMessage,
} from "@cohub/protocol/generation";
import {
	generationTurnScoreItem,
	isTaskScoreBlock,
	taskScoreItem,
	taskScorePlacement,
} from "../lib/score-editor/task-score.ts";
import {
	AUDIO,
	requestedScore,
	returnedScore,
	scoreRun,
} from "./fixtures/generation-score-run.ts";

test("the item replaces the output block that holds the score", () => {
	const run = scoreRun({
		requestScore: requestedScore,
		returnScore: returnedScore,
		output: [
			AUDIO,
			{ type: "text", text: "a revised prompt" },
			{ type: "text", text: returnedScore, meta: { role: "abc" } },
		],
	});
	assert.equal(generationOutput(run)[2].text, returnedScore);
	assert.deepEqual(taskScoreItem(run), {
		taskRunId: "run-score",
		score: returnedScore,
		outputBlock: 2,
	});
});

test("a score only in the request gets an item that replaces no output block", () => {
	assert.deepEqual(taskScoreItem(scoreRun({ requestScore: requestedScore })), {
		taskRunId: "run-score",
		score: requestedScore,
		outputBlock: null,
	});
});

test("the item does not wait for the generation to finish", () => {
	for (const status of ["pending", "running", "failed"] as const) {
		assert.deepEqual(
			taskScoreItem(scoreRun({ status, requestScore: requestedScore })),
			{
				taskRunId: "run-score",
				score: requestedScore,
				outputBlock: null,
			},
			status,
		);
	}
	assert.equal(
		taskScoreItem({
			...scoreRun({ returnScore: returnedScore }),
			taskType: "run_command",
		}),
		null,
	);
});

type Turn = Parameters<typeof generationTurnScoreItem>[0];

function scoreTurn(
	options: {
		requestScore?: string;
		returnScore?: string;
		status?: "queued" | "running" | "completed" | "failed";
	} = {},
): Turn {
	const content = [
		...(options.requestScore === undefined
			? []
			: [
					{
						type: "text" as const,
						text: options.requestScore,
						meta: { role: "abc" },
					},
				]),
	];
	const output = [
		AUDIO,
		...(options.returnScore === undefined
			? []
			: [
					{
						type: "text" as const,
						text: options.returnScore,
						meta: { role: "abc" },
					},
				]),
	];
	return {
		executionKind: "direct_generation",
		status: options.status ?? "completed",
		model: "song2",
		meta: { executionKind: "direct_generation", generationTaskId: "run-score" },
		userContent: buildGenerationRequestMessage({
			taskId: "run-score",
			model: "song2",
			content,
		}).content,
		assistantContent: buildGenerationResultMessage({
			taskId: "run-score",
			model: "song2",
			status: options.status ?? "completed",
			result: output,
		}).content,
	};
}

test("a create-mode result bubble whose result carries a score gets the task", () => {
	assert.deepEqual(
		generationTurnScoreItem(
			scoreTurn({ requestScore: requestedScore, returnScore: returnedScore }),
		),
		{ taskRunId: "run-score", score: returnedScore },
	);
});

test("a create-mode bubble keeps the input score while the turn runs", () => {
	assert.equal(generationTurnScoreItem(scoreTurn()), null);
	assert.deepEqual(
		generationTurnScoreItem(scoreTurn({ requestScore: requestedScore })),
		{ taskRunId: "run-score", score: requestedScore },
	);
	for (const status of ["queued", "running", "failed"] as const) {
		assert.deepEqual(
			generationTurnScoreItem(
				scoreTurn({ status, requestScore: requestedScore }),
			),
			{ taskRunId: "run-score", score: requestedScore },
			status,
		);
	}
});

test("every abc text block of an output is a score block, blank or not", () => {
	assert.equal(
		isTaskScoreBlock({
			type: "text",
			text: returnedScore,
			meta: { role: "abc" },
		}),
		true,
	);
	assert.equal(
		isTaskScoreBlock({ type: "text", text: "  \n", meta: { role: "abc" } }),
		true,
	);
	assert.equal(
		isTaskScoreBlock({ type: "text", text: "la", meta: { role: "lyrics" } }),
		false,
	);
	assert.equal(isTaskScoreBlock({ type: "audio" }), false);
});

test("the score is paired with the generation's last audio output", () => {
	const run = scoreRun({
		returnScore: returnedScore,
		output: [
			{ type: "audio", source: { type: "url", url: "https://a.test/1.mp3" } },
			{ type: "audio", source: { type: "url", url: "https://a.test/2.mp3" } },
			{ type: "text", text: returnedScore, meta: { role: "abc" } },
		],
	});
	assert.deepEqual(taskScorePlacement(run), {
		score: { taskRunId: "run-score", score: returnedScore, outputBlock: 2 },
		audio: { index: 1, src: "https://a.test/2.mp3" },
	});
});

test("an audio block without a playable source is not the score's audio", () => {
	const run = scoreRun({
		returnScore: returnedScore,
		output: [
			{ type: "audio" },
			{ type: "audio", source: { type: "url", url: "  " } },
			{ type: "text", text: returnedScore, meta: { role: "abc" } },
		],
	});
	assert.deepEqual(taskScorePlacement(run)?.audio, null);
});

test("a score with no audio still gets a placement, without a cursor", () => {
	assert.deepEqual(
		taskScorePlacement(
			scoreRun({
				output: [
					{ type: "text", text: returnedScore, meta: { role: "abc" } },
				],
			}),
		),
		{
			score: { taskRunId: "run-score", score: returnedScore, outputBlock: 0 },
			audio: null,
		},
	);
	assert.equal(taskScorePlacement(scoreRun()), null);
});
