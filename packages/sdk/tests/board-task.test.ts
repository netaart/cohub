import assert from "node:assert/strict";
import test from "node:test";
import {
	BOARD_TASK_ARTIFACT_LIMIT,
	normalizeBoardRemoteUrl,
} from "@cohub/protocol/board-document";
import type { TaskRunRecord } from "../src/types.js";
import {
	featuredTaskArtifact,
	taskArtifacts,
	taskRunToBoardTaskSnapshot,
} from "../src/board/task.js";

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
				content: [{ type: "text", text: "  A precise product sketch  " }],
			},
		},
		result: null,
		errorMessage: null,
		attemptCount: 1,
		spaceId: "space_1",
		sessionId: null,
		turnId: null,
		userUuid: null,
		scheduledAt: null,
		startedAt: null,
		finishedAt: "2026-08-14T10:00:02.000Z",
		createdAt: "2026-08-14T10:00:00.000Z",
		updatedAt: "2026-08-14T10:00:02.000Z",
		...overrides,
	};
}

test("projects generation tasks to concise remote-media snapshots", () => {
	const snapshot = taskRunToBoardTaskSnapshot(
		taskRun({
			result: {
				output: [
					{ type: "image", source: { data: "large-base64" } },
					{
						type: "image",
						source: {
							url: "https://cdn.example.com/output.png",
							mediaType: "image/png",
							width: 1024,
							height: 1536,
						},
					},
				],
			},
		}),
	);

	assert.equal(snapshot.title, "A precise product sketch");
	assert.equal(snapshot.model, "image-model");
	assert.equal(snapshot.artifactCount, 1);
	assert.deepEqual(snapshot.artifacts, [
		{
			id: "output-2",
			type: "image",
			url: "https://cdn.example.com/output.png",
			mimeType: "image/png",
			naturalWidth: 1024,
			naturalHeight: 1536,
		},
	]);
	assert.equal(JSON.stringify(snapshot).includes("large-base64"), false);
});

test("pairs music covers and features the strongest playable result", () => {
	const snapshot = taskRunToBoardTaskSnapshot(
		taskRun({
			result: {
				output: [
					{
						type: "audio",
						source: { url: "https://cdn.example.com/short.mp3" },
						meta: { id: "track-1", title: "Fun", duration: 16.24 },
					},
					{
						type: "image",
						source: { url: "https://cdn.example.com/short.jpg" },
						meta: { id: "track-1" },
					},
					{
						type: "audio",
						source: { url: "https://cdn.example.com/full.mp3" },
						meta: { id: "track-2", title: "Fun", duration: 101.48 },
					},
					{
						type: "image",
						source: { url: "https://cdn.example.com/full.jpg" },
						meta: { id: "track-2" },
					},
				],
			},
		}),
	);

	assert.equal(snapshot.artifactCount, 2);
	assert.deepEqual(snapshot.artifacts, [
		{
			id: "track-2",
			type: "audio",
			title: "Fun",
			url: "https://cdn.example.com/full.mp3",
			previewUrl: "https://cdn.example.com/full.jpg",
			durationMs: 101_480,
		},
		{
			id: "track-1",
			type: "audio",
			title: "Fun",
			url: "https://cdn.example.com/short.mp3",
			previewUrl: "https://cdn.example.com/short.jpg",
			durationMs: 16_240,
		},
	]);
	assert.equal(featuredTaskArtifact(snapshot.artifacts)?.id, "track-2");
});

test("keeps unpaired multimodal results and prioritizes video", () => {
	const artifacts = taskArtifacts([
		{
			type: "image",
			source: { url: "https://cdn.example.com/image.png" },
		},
		{
			type: "text",
			text: "Generated notes",
		},
		{
			type: "video",
			source: { url: "https://cdn.example.com/video.mp4" },
			poster: "https://cdn.example.com/poster.jpg",
		},
	]);

	assert.deepEqual(
		artifacts.map((artifact) => artifact.type),
		["image", "text", "video"],
	);
	assert.equal(featuredTaskArtifact(artifacts)?.type, "video");
});

test("pairs a video with its first frame and keeps covers of inline media", () => {
	const artifacts = taskArtifacts([
		{ type: "video", source: { url: "https://cdn.example.com/clip.mp4" } },
		{
			type: "image",
			meta: { role: "first_frame" },
			source: { url: "https://cdn.example.com/clip.webp" },
		},
		{ type: "audio", meta: { id: "t1" }, source: { data: "AAAA" } },
		{
			type: "image",
			meta: { id: "t1" },
			source: { url: "https://cdn.example.com/t1.jpg" },
		},
	]);

	assert.deepEqual(
		artifacts.map((artifact) => [
			artifact.type,
			artifact.type === "video" ? artifact.previewUrl : artifact.url,
		]),
		[
			["video", "https://cdn.example.com/clip.webp"],
			["image", "https://cdn.example.com/t1.jpg"],
		],
	);
});

test("bounds snapshots while retaining the complete artifact count", () => {
	const output = Array.from({ length: BOARD_TASK_ARTIFACT_LIMIT + 4 }, (_, index) => ({
		type: "image",
		source: {
			url: `https://cdn.example.com/image-${index}.png`,
			width: 100 + index,
			height: 100 + index,
		},
	}));
	const snapshot = taskRunToBoardTaskSnapshot(taskRun({ result: { output } }));

	assert.equal(snapshot.artifactCount, output.length);
	assert.equal(snapshot.artifacts.length, BOARD_TASK_ARTIFACT_LIMIT);
	assert.equal(snapshot.artifacts[0]?.id, `output-${output.length}`);
	assert.equal(
		snapshot.artifacts.at(-1)?.id,
		`output-${output.length - BOARD_TASK_ARTIFACT_LIMIT + 1}`,
	);
});

test("rejects local, inline, and credentialed task output URLs", () => {
	for (const url of [
		"data:video/mp4;base64,large",
		"blob:https://app.example.com/temporary",
		"file:///tmp/output.png",
		"https://user:secret@cdn.example.com/output.png",
		"http://localhost/output.png",
		"https://assets.local/output.png",
		"http://127.0.0.1/output.png",
		"http://2130706433/output.png",
		"http://10.0.0.8/output.png",
		"http://172.16.0.8/output.png",
		"http://192.168.0.8/output.png",
		"http://169.254.169.254/latest/meta-data",
		"http://[::1]/output.png",
		"http://[fc00::1]/output.png",
		"http://[fe80::1]/output.png",
		"http://[::ffff:127.0.0.1]/output.png",
		"http://[::127.0.0.1]/output.png",
		"http://[fec0::1]/output.png",
		"http://[2001:db8::1]/output.png",
	]) {
		assert.equal(normalizeBoardRemoteUrl(url), undefined);
	}
	assert.equal(
		normalizeBoardRemoteUrl("https://cdn.example.com/output.png"),
		"https://cdn.example.com/output.png",
	);
	assert.equal(
		normalizeBoardRemoteUrl("https://8.8.8.8/output.png"),
		"https://8.8.8.8/output.png",
	);
	assert.equal(
		normalizeBoardRemoteUrl("https://[2606:4700:4700::1111]/output.png"),
		"https://[2606:4700:4700::1111]/output.png",
	);
});

test("projects generic task facts without copying its payload", () => {
	const snapshot = taskRunToBoardTaskSnapshot(
		taskRun({
			taskType: "space_hook",
			status: "running",
			payload: { data: { command: "  Refresh the project index  ", secret: "private" } },
			result: { private: true },
		}),
	);

	assert.deepEqual(snapshot, {
		taskType: "space_hook",
		status: "running",
		title: "Refresh the project index",
		promptExcerpt: "Refresh the project index",
		artifactCount: 0,
		artifacts: [],
		updatedAt: "2026-08-14T10:00:02.000Z",
	});
	assert.equal(JSON.stringify(snapshot).includes("private"), false);
});
