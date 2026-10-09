import assert from "node:assert/strict";
import { test } from "node:test";

const state = <T>(value: T) => value;
(
	globalThis as unknown as { $state: typeof state & { raw: typeof state } }
).$state = Object.assign(state, { raw: state });

const { dropTypesOf, pointerDragResources, readTransferResources } =
	await import("../lib/features/app/host-resource-drag.svelte.ts");

const transfer = (data: Record<string, string>) =>
	({
		getData: (type: string) => data[type] ?? "",
		types: Object.keys(data),
	}) as unknown as DataTransfer;

test("a resource drag hands over its resources, without Space resources", () => {
	const resources = readTransferResources(
		transfer({
			"application/x-cohub-resource": JSON.stringify({
				version: 1,
				resources: [
					{
						type: "file",
						ref: "a.png",
						path: "a.png",
						mimeType: null,
						size: 3,
					},
					{
						type: "task",
						ref: "t1",
						taskRunId: "t1",
						snapshot: { status: "done" },
					},
				],
			}),
		}),
	);
	assert.deepEqual(resources, [
		{ type: "file", ref: "a.png", path: "a.png", size: 3 },
		{ type: "task", ref: "t1", taskRunId: "t1", snapshot: { status: "done" } },
	]);
	assert.deepEqual(dropTypesOf(resources ?? []), ["file", "task"]);
});

test("a folder drag carries only a path and offers nothing", () => {
	assert.equal(
		readTransferResources(transfer({ "text/cohub-path": "docs/" })),
		null,
	);
	assert.equal(
		readTransferResources(transfer({ "text/plain": "hello" })),
		null,
	);
	assert.equal(readTransferResources(null), null);
});

test("a touch drag maps files and Apps and skips folders", () => {
	assert.deepEqual(
		pointerDragResources({
			origin: "space-file-tree",
			items: [
				{
					type: "file",
					path: "a.png",
					name: "a.png",
					mimeType: "image/png",
					size: 3,
				},
				{ type: "dir", path: "assets", name: "assets" },
				{
					type: "app",
					path: "",
					name: "Notes",
					appId: "app-1",
					appRef: "alice/studio/notes",
					appUrl: "https://x",
				},
			],
		}),
		[
			{
				type: "file",
				ref: "a.png",
				path: "a.png",
				title: "a.png",
				mimeType: "image/png",
				size: 3,
			},
			{
				type: "app",
				ref: "alice/studio/notes",
				title: "Notes",
				appId: "app-1",
				href: "https://x",
			},
		],
	);
});
