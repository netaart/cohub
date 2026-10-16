import assert from "node:assert/strict";
import { test } from "node:test";
import { taskRunToBoardTaskSnapshot } from "@cohub/protocol";
import {
	boardItemOrigin,
	createTaskBoardItem,
	createTaskResultItems,
} from "../../src/board/model/items/create.js";
import { boardModelTarget } from "../../src/board/model/media.js";
import { boardAssetKey } from "../../src/board/stage/assets.js";
import { sceneItem } from "./fixtures.js";

const base = "https://router-files.neta.art/files/space/task";
const meta = (field: string, format?: string) => ({
	task_id: "task_meshy",
	task_type: "text-to-3d",
	field,
	...(format ? { format } : {}),
});

function snapshot(output: unknown[]) {
	return taskRunToBoardTaskSnapshot({
		taskType: "generation",
		status: "completed",
		updatedAt: "2026-10-16T12:00:00.000Z",
		payload: { data: { model: "meshy", content: [{ type: "text", text: "a robot" }] } },
		result: { output },
	});
}

const withStill = snapshot([
	{ type: "3d", source: { type: "url", url: `${base}/model.glb` }, meta: meta("model_urls.glb", "glb") },
	{ type: "3d", source: { type: "url", url: `${base}/model.fbx` }, meta: meta("model_urls.fbx", "fbx") },
	{ type: "image", source: { type: "url", url: `${base}/preview.png` }, meta: meta("thumbnail_url") },
]);
const fbxOnly = snapshot([
	{ type: "3d", source: { type: "url", url: `${base}/clip.fbx` }, meta: meta("result.animation_fbx_url", "fbx") },
]);

function taskItem(taskSnapshot: ReturnType<typeof snapshot>) {
	const entry = createTaskBoardItem("run_1", taskSnapshot, 0, 0, undefined, "task_1");
	return sceneItem(entry.id, entry.item as unknown as Record<string, unknown>);
}

test("a 3D task card opens its previewable model and shows its still", () => {
	const card = taskItem(withStill);
	assert.deepEqual(boardModelTarget(card), {
		key: `${base}/model.glb`,
		src: `${base}/model.glb`,
		format: "glb",
		title: "model",
	});
	assert.match(boardAssetKey(card) ?? "", /^url:.*preview\.png/);
	assert.equal(card.type === "task" && card.frame.width === card.frame.height, true);
});

test("a 3D task card without a viewer format opens nothing in place", () => {
	const card = taskItem(fbxOnly);
	assert.equal(boardModelTarget(card), null);
	assert.equal(boardAssetKey(card), null);
});

test("3D results land as file items that remember their task", () => {
	const entries = createTaskResultItems({
		taskRunId: "run_1",
		frame: { x: 0, y: 0, width: 300, height: 300 },
		artifacts: withStill.artifacts,
	});
	const [glb, fbx] = entries.map((entry) => sceneItem(entry.id, entry.item as unknown as Record<string, unknown>));
	assert.equal(glb?.type, "file");
	assert.equal(glb?.type === "file" && glb.props.snapshot?.mimeType, "model/gltf-binary");
	assert.equal(glb?.frame.width, glb?.frame.height);
	assert.deepEqual(boardItemOrigin(glb as NonNullable<typeof glb>), {
		taskRunId: "run_1",
		artifactId: withStill.artifacts[0]?.id,
	});
	assert.equal(boardModelTarget(glb)?.format, "glb");
	assert.equal(fbx?.type, "file");
	assert.equal(boardModelTarget(fbx), null);
	assert.notEqual(fbx?.frame.width, fbx?.frame.height);
});
