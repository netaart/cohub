import assert from "node:assert/strict";
import { test } from "node:test";
import type { SpaceFsFileResponse } from "@neta-art/cohub";
import {
	filePreviewModel,
	isScorePath,
} from "../lib/file-preview-model.ts";

function textFile(path: string): SpaceFsFileResponse {
	return {
		path,
		name: path.split("/").at(-1) ?? path,
		size: 18,
		mimeType: "text/plain",
		mtimeMs: 0,
		kind: "text",
		encoding: "utf-8",
		content: "X:1\nK:C\nc16|\n",
	};
}

test("an .abc file opens as a score preview", () => {
	const model = filePreviewModel(textFile("scores/song.abc"));
	assert.equal(model.kind, "score");
	assert.equal(model.isText, true);
	assert.equal(model.hasRenderedPreview, true);
});

test("only .abc paths are scores, on any case", () => {
	assert.equal(isScorePath("song.abc"), true);
	assert.equal(isScorePath("SONG.ABC"), true);
	assert.equal(isScorePath("song.abc.txt"), false);
	assert.equal(filePreviewModel(textFile("song.txt")).kind, "text");
});
