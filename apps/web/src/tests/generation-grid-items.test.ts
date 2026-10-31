import assert from "node:assert/strict";
import { test } from "node:test";
import type { GenerationTaskOutput, GenerationTaskView } from "@neta-art/cohub";
import {
	generationGridItems,
	type GenerationGridItem,
	generationGridScoreResolver,
} from "../lib/features/space/side-panel/side-panel-data.ts";
import { taskScoreItem } from "../lib/score-editor/task-score.ts";
import {
	AUDIO,
	requestedScore,
	returnedScore,
	scoreRun,
} from "./fixtures/generation-score-run.ts";

function view(run: ReturnType<typeof scoreRun>): GenerationTaskView {
	const output = (
		(run.result as { output?: Record<string, unknown>[] }).output ?? []
	).flatMap((block, index): GenerationTaskOutput[] => {
		const type = block.type;
		if (type !== "image" && type !== "video" && type !== "audio") return [];
		return [
			{
				index,
				type,
				url: "https://media.example.test/song.mp3",
				previewUrl: null,
				title: null,
				mimeType: "audio/mpeg",
				width: null,
				height: null,
				durationMs: null,
				deferred: false,
			},
		];
	});
	return {
		id: run.id,
		status: run.status,
		spaceId: run.spaceId,
		sessionId: run.sessionId,
		turnId: run.turnId,
		model: "song2",
		prompt: null,
		errorMessage: null,
		outputs: output,
		createdAt: run.createdAt,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		updatedAt: run.updatedAt,
	};
}

function gridFor(
	run: ReturnType<typeof scoreRun>,
	filter: "all" | "audio" | "image" | "video",
) {
	return generationGridItems([view(run)], filter, () => taskScoreItem(run));
}

const keysOf = (items: GenerationGridItem[]) => items.map((item) => item.key);

test("a finished song with a score gets a score item after its audio", () => {
	const items = gridFor(
		scoreRun({
			returnScore: returnedScore,
			output: [
				AUDIO,
				{ type: "text", text: returnedScore, meta: { role: "abc" } },
			],
		}),
		"all",
	);
	assert.deepEqual(keysOf(items), ["run-score:0", "run-score:score"]);
	const score = items[1];
	if (score.kind !== "score") throw new Error("expected a score item");
	assert.deepEqual(score.entry, {
		taskRunId: "run-score",
		score: returnedScore,
	});
});

test("the score item follows the audio filter and not the image or video filter", () => {
	const run = scoreRun({ returnScore: returnedScore });
	assert.deepEqual(keysOf(gridFor(run, "audio")), [
		"run-score:0",
		"run-score:score",
	]);
	for (const filter of ["image", "video"] as const) {
		assert.deepEqual(keysOf(gridFor(run, filter)), []);
	}
});

test("a request-only score also gets the item", () => {
	const run = scoreRun({ requestScore: requestedScore });
	assert.deepEqual(keysOf(gridFor(run, "all")), [
		"run-score:0",
		"run-score:score",
	]);
});

test("a task without a score keeps only its outputs", () => {
	assert.deepEqual(keysOf(gridFor(scoreRun(), "all")), ["run-score:0"]);
});

test("a running task's input score gets a tile under all, and no filter", () => {
	const run = scoreRun({ status: "running", requestScore: requestedScore });
	assert.deepEqual(keysOf(gridFor(run, "all")), [
		"run-score",
		"run-score:score",
	]);
	assert.deepEqual(keysOf(gridFor(run, "audio")), []);
});

test("the score tile sits right after the last audio, not after every output", () => {
	const run = scoreRun({
		returnScore: returnedScore,
		output: [
			AUDIO,
			{ type: "image", source: { type: "url", url: "https://x.test/a.png" } },
			{ type: "text", text: returnedScore, meta: { role: "abc" } },
		],
	});
	assert.deepEqual(keysOf(gridFor(run, "all")), [
		"run-score:0",
		"run-score:score",
		"run-score:1",
	]);
});

test("the media section counts every tile the grid draws", () => {
	const run = scoreRun({ returnScore: returnedScore });
	const tasks = [view(run)];
	const tiles = generationGridItems(
		tasks,
		"all",
		generationGridScoreResolver((id) =>
			id === run.id ? run : undefined,
		),
	);
	assert.equal(tiles.length, 2);
	assert.equal(tiles.filter((item) => item.kind === "score").length, 1);
});

test("under all, a score with no outputs is the only tile", () => {
	const run = scoreRun({
		returnScore: returnedScore,
		output: [{ type: "text", text: returnedScore, meta: { role: "abc" } }],
	});
	assert.deepEqual(keysOf(gridFor(run, "all")), ["run-score:score"]);
});

test("under a non-audio filter, a request score is not appended", () => {
	const run = scoreRun({
		requestScore: requestedScore,
		output: [
			{ type: "image", source: { type: "url", url: "https://x.test/a.png" } },
		],
	});
	assert.deepEqual(keysOf(gridFor(run, "image")), ["run-score:0"]);
});

test("under all, a request score follows non-audio outputs", () => {
	const run = scoreRun({
		requestScore: requestedScore,
		output: [
			{ type: "image", source: { type: "url", url: "https://x.test/a.png" } },
		],
	});
	assert.deepEqual(keysOf(gridFor(run, "all")), [
		"run-score:0",
		"run-score:score",
	]);
});

test("under audio, a score without audio has no tile", () => {
	const run = scoreRun({
		requestScore: requestedScore,
		output: [
			{ type: "image", source: { type: "url", url: "https://x.test/a.png" } },
		],
	});
	assert.deepEqual(keysOf(gridFor(run, "audio")), []);
});
