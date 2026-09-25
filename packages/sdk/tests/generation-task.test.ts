import assert from "node:assert/strict";
import test from "node:test";
import {
	generationOutputSource,
	toGenerationTaskView,
} from "../src/generation-task.js";
import type { TaskRunRecord } from "../src/types.js";

function taskRun(overrides: Partial<TaskRunRecord> = {}): TaskRunRecord {
	return {
		id: "task_1",
		jobId: "job_1",
		cronJobId: null,
		taskType: "generation",
		status: "completed",
		payload: {
			type: "generation",
			data: {
				model: "image-model",
				content: [{ type: "text", text: "  A calm   lake  " }],
			},
		},
		result: null,
		errorMessage: null,
		attemptCount: 1,
		spaceId: "space_1",
		sessionId: "session_1",
		turnId: "turn_1",
		userUuid: null,
		scheduledAt: null,
		startedAt: "2026-09-01T10:00:01.000Z",
		finishedAt: "2026-09-01T10:00:09.000Z",
		createdAt: "2026-09-01T10:00:00.000Z",
		updatedAt: "2026-09-01T10:00:09.000Z",
		...overrides,
	};
}

test("projects prompt, model, and outputs", () => {
	const view = toGenerationTaskView(
		taskRun({
			result: {
				model: "image-model",
				output: [
					{
						type: "image",
						source: { url: "https://cdn.example.com/a.png", width: 1600, height: 900 },
					},
					{ type: "image", source: { deferredBase64: true, mediaType: "image/png" } },
					{ type: "audio", source: { data: "AAAA", mediaType: "audio/mpeg" } },
					{ type: "text", meta: { role: "revised_prompt" }, text: "A calm lake at dawn" },
				],
			},
		}),
	);
	assert.equal(view.prompt, "A calm lake");
	assert.equal(view.model, "image-model");
	assert.deepEqual(
		view.outputs.map((output) => [output.index, output.type, output.url, output.deferred]),
		[
			[0, "image", "https://cdn.example.com/a.png", false],
			[1, "image", null, true],
			[2, "audio", null, false],
		],
	);
	assert.equal(view.outputs[0]?.width, 1600);
});

test("leaves text-only results without outputs", () => {
	const view = toGenerationTaskView(
		taskRun({ result: { output: [{ type: "text", text: "Could you try again?" }] } }),
	);
	assert.deepEqual(view.outputs, []);
});

test("folds a cover image into media sharing its provider id", () => {
	const view = toGenerationTaskView(
		taskRun({
			result: {
				output: [
					{ type: "image", meta: { clip_id: "c1" }, source: { url: "https://cdn.example.com/cover.png" } },
					{ type: "audio", meta: { clip_id: "c1", title: "Song" }, source: { url: "https://cdn.example.com/song.mp3", duration: 30 } },
					{ type: "image", source: { url: "https://cdn.example.com/extra.png" } },
				],
			},
		}),
	);
	assert.deepEqual(
		view.outputs.map((output) => [output.index, output.type, output.previewUrl]),
		[
			[1, "audio", "https://cdn.example.com/cover.png"],
			[2, "image", null],
		],
	);
	assert.equal(view.outputs[0]?.title, "Song");
	assert.equal(view.outputs[0]?.durationMs, 30_000);
});

test("folds cover-role frames into videos in order, keeping last frames", () => {
	const url = (name: string) => `https://cdn.example.com/${name}`;
	const view = toGenerationTaskView(
		taskRun({
			result: {
				output: [
					{ type: "video", source: { url: url("a.mp4") } },
					{ type: "video", source: { url: url("b.mp4") } },
					{ type: "image", meta: { role: "first_frame" }, source: { url: url("a.webp") } },
					{ type: "image", meta: { role: "first_frame" }, source: { url: url("b.webp") } },
					{ type: "image", meta: { role: "last_frame" }, source: { url: url("end.webp") } },
					{ type: "image", meta: { role: "cover" }, source: { data: "AAAA" } },
				],
			},
		}),
	);
	assert.deepEqual(
		view.outputs.map((output) => [output.index, output.type, output.previewUrl]),
		[
			[0, "video", url("a.webp")],
			[1, "video", url("b.webp")],
			[4, "image", null],
			[5, "image", null],
		],
	);
});

test("keeps a last frame that shares the video's provider id", () => {
	const url = (name: string) => `https://cdn.example.com/${name}`;
	const view = toGenerationTaskView(
		taskRun({
			result: {
				output: [
					{ type: "video", meta: { id: "t1" }, source: { url: url("clip.mp4") } },
					{ type: "image", meta: { id: "t1", role: "last_frame" }, source: { url: url("last.webp") } },
					{ type: "image", meta: { id: "t1", role: "first_frame" }, source: { url: url("first.webp") } },
				],
			},
		}),
	);
	assert.deepEqual(
		view.outputs.map((output) => [output.index, output.type, output.previewUrl]),
		[
			[0, "video", url("first.webp")],
			[1, "image", null],
		],
	);
});

test("never gives a video frame to audio listed before the video", () => {
	const frame = "https://cdn.example.com/first.webp";
	const view = toGenerationTaskView(
		taskRun({
			result: {
				output: [
					{ type: "audio", source: { url: "https://cdn.example.com/song.mp3" } },
					{ type: "video", source: { url: "https://cdn.example.com/clip.mp4" } },
					{ type: "image", meta: { role: "first_frame" }, source: { url: frame } },
				],
			},
		}),
	);
	assert.deepEqual(
		view.outputs.map((output) => [output.type, output.previewUrl]),
		[
			["audio", null],
			["video", frame],
		],
	);
});

test("resolves remote and inline output sources", () => {
	const result = {
		output: [
			{ type: "image", source: { url: "https://cdn.example.com/a.png" } },
			{ type: "video", source: { type: "base64", data: "AAAA" } },
		],
	};
	assert.equal(generationOutputSource(result, 0), "https://cdn.example.com/a.png");
	assert.equal(generationOutputSource(result, 1), "data:video/mp4;base64,AAAA");
	assert.equal(generationOutputSource(result, 2), null);
	assert.equal(
		generationOutputSource(
			{ output: [{ type: "audio", source: { data: "AAAA", mediaType: "audio/mpeg;x,y" } }] },
			0,
		),
		"data:audio/mpeg;base64,AAAA",
		"malformed media types fall back",
	);
	assert.equal(generationOutputSource(null, 0), null);
});
