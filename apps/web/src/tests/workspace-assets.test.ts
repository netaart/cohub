import assert from "node:assert/strict";
import test from "node:test";
import type {
	SpaceFsFileResponse,
	SpaceFsPreparingFile,
} from "@neta-art/cohub";
import {
	createWorkspaceAssetLoader,
	resolveWorkspaceFileAsset,
} from "#lib/workspace-assets.ts";

const ready: SpaceFsFileResponse = {
	path: "images/cat.png",
	name: "cat.png",
	size: 3,
	mimeType: "image/png",
	mtimeMs: 0,
	kind: "binary",
	encoding: "base64",
	content: "AAA",
};

const preparing: SpaceFsPreparingFile = {
	path: ready.path,
	name: ready.name,
	size: ready.size,
	mimeType: ready.mimeType,
	mtimeMs: ready.mtimeMs,
	retryAfterMs: 1,
};

test("workspace assets deduplicate and recover from preparing", async () => {
	const controller = new AbortController();
	let reads = 0;
	const load = createWorkspaceAssetLoader(
		(path, options) =>
			resolveWorkspaceFileAsset(
				async () => (++reads === 1 ? preparing : ready),
				path,
				{ ...options, timeoutMs: 1_000 },
			),
		controller.signal,
	);

	const first = load(ready.path);
	assert.equal(first, load(ready.path));
	assert.equal((await first).src, "data:image/png;base64,AAA");
	assert.equal(reads, 2);
});

test("workspace asset retries are abortable", async () => {
	const controller = new AbortController();
	const pending = resolveWorkspaceFileAsset(async () => preparing, ready.path, {
		signal: controller.signal,
	});
	controller.abort();
	await assert.rejects(
		pending,
		(error: unknown) =>
			error instanceof DOMException && error.name === "AbortError",
	);
});
