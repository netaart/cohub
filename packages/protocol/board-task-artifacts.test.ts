import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BoardTaskSnapshotSchema,
	featuredTaskArtifact,
	generationCovers,
	taskArtifactModelFormat,
	taskRunArtifacts,
	taskRunToBoardTaskSnapshot,
} from "./src/index.js";

const base = "https://router-files.neta.art/files/space/task";
const meshyMeta = (field: string, extra: Record<string, unknown> = {}) => ({
	task_id: "task_meshy",
	task_type: "image-to-3d",
	field,
	...extra,
	task_expires_at: "2026-10-19T05:48:40.198Z",
});
const meshyOutput = [
	{ type: "3d", source: { type: "url", url: `${base}/model.glb` }, meta: meshyMeta("model_urls.glb", { format: "glb" }) },
	{ type: "3d", source: { type: "url", url: `${base}/model.fbx` }, meta: meshyMeta("model_urls.fbx", { format: "fbx" }) },
	{ type: "image", source: { type: "url", url: `${base}/preview.png` }, meta: meshyMeta("thumbnail_url") },
	{ type: "image", source: { type: "url", url: `${base}/base_color.png` }, meta: meshyMeta("texture_urls[0].base_color") },
	{ type: "video", source: { type: "url", url: `${base}/turntable.mp4` }, meta: meshyMeta("video_url") },
];

function run(output: unknown[]) {
	return {
		taskType: "generation",
		status: "completed" as const,
		updatedAt: "2026-10-16T12:00:00.000Z",
		payload: { data: { model: "meshy", content: [{ type: "image", source: { type: "url", url: "https://example.com/in.png" } }] } },
		result: { output },
	};
}

test("a 3D result takes the first image of its provider task as its still", () => {
	assert.deepEqual([...generationCovers(meshyOutput)], [
		[0, 2],
		[1, 2],
	]);
});

test("3D results become artifacts, the previewable model featured", () => {
	const artifacts = taskRunArtifacts(run(meshyOutput));
	assert.deepEqual(
		artifacts.map((artifact) => [artifact.type, artifact.type === "text" ? "" : artifact.url]),
		[
			["3d", `${base}/model.glb`],
			["3d", `${base}/model.fbx`],
			["video", `${base}/turntable.mp4`],
			["image", `${base}/base_color.png`],
		],
	);
	const featured = featuredTaskArtifact(artifacts);
	assert.equal(featured?.type, "3d");
	assert.equal(featured?.type === "3d" && featured.previewUrl, `${base}/preview.png`);
	assert.equal(featured?.type === "3d" && featured.format, "glb");
	assert.equal(taskArtifactModelFormat(featured), "glb");
	assert.equal(taskArtifactModelFormat(artifacts[1]), null);
});

test("the viewer format follows the URL when the provider declares none", () => {
	const [artifact] = taskRunArtifacts(run([{ type: "3d", source: { type: "url", url: "https://cdn.example.com/a/Scene.STL?sig=1" } }]));
	assert.equal(artifact?.type === "3d" && artifact.format, "stl");
	assert.equal(taskArtifactModelFormat(artifact), "stl");
});

test("a previewable model outranks an earlier format the viewer cannot read", () => {
	const [first, second] = meshyOutput;
	const featured = featuredTaskArtifact(taskRunArtifacts(run([second, first])));
	assert.equal(featured?.type === "3d" && featured.format, "glb");
});

test("Board task snapshots carry 3D artifacts", () => {
	const snapshot = taskRunToBoardTaskSnapshot(run(meshyOutput));
	assert.equal(BoardTaskSnapshotSchema.safeParse(snapshot).success, true);
	assert.equal(snapshot.artifactCount, 4);
	assert.equal(snapshot.model, "meshy");
});

test("playable media still pair with art sharing their provider id", () => {
	const output = [
		{ type: "audio", source: { type: "url", url: "https://cdn.example.com/a.mp3" }, meta: { clip_id: "clip-1", task_id: "task-1" } },
		{ type: "image", source: { type: "url", url: "https://cdn.example.com/a.png" }, meta: { clip_id: "clip-1", task_id: "task-1" } },
		{ type: "video", source: { type: "url", url: "https://cdn.example.com/b.mp4" }, meta: { task_id: "task-1" } },
	];
	assert.deepEqual([...generationCovers(output)], [[0, 1]]);
});
