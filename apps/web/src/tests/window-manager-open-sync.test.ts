import assert from "node:assert/strict";
import { test } from "node:test";
import {
	activeWindowFilePath,
	workspaceFilePreviewKind,
} from "../lib/features/space/modules/windows.ts";

test("file-tree selection follows the active preview kind", () => {
	const filePath = "docs/readme.md";
	const boardPath = "boards/plan.board";

	assert.equal(activeWindowFilePath("file", filePath, boardPath), filePath);
	assert.equal(activeWindowFilePath("board", filePath, boardPath), boardPath);
	assert.equal(activeWindowFilePath("port", filePath, boardPath), "");
	assert.equal(activeWindowFilePath(null, filePath, boardPath), "");
});

test("workspace file links use the same Board routing as the file tree", () => {
	assert.equal(workspaceFilePreviewKind("docs/readme.md"), "file");
	assert.equal(workspaceFilePreviewKind("boards/plan.board"), "board");
	assert.equal(workspaceFilePreviewKind("boards/PLAN.BOARD"), "board");
});
