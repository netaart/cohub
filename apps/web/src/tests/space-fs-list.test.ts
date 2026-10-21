import assert from "node:assert/strict";
import { test } from "node:test";
import type { SpaceFsEntry } from "@neta-art/cohub";
import { register } from "tsx/esm/api";

register();
const { HttpError } = await import("@neta-art/cohub");
const { readDirectoryPages } = await import("../lib/space-fs-list.ts");

const entry = (name: string): SpaceFsEntry => ({
	name,
	path: name,
	type: "file",
	size: 0,
	mimeType: null,
	mtimeMs: 0,
});

test("directory conflicts restart without mixing pages or repeating the preview", async () => {
	const cursors: (string | undefined)[] = [];
	const previews: SpaceFsEntry[][] = [];
	const result = await readDirectoryPages(
		async (cursor) => {
			cursors.push(cursor);
			if (cursors.length === 2)
				throw new HttpError("Directory changed.", 409, {
					code: "directory_changed",
				});
			return {
				path: "",
				entries: [
					entry(cursors.length === 1 ? "deleted" : cursor ? "last" : "first"),
				],
				nextCursor: cursor ? null : "next",
				truncated: cursors.length === 1,
			};
		},
		(entries) => previews.push(entries),
	);
	assert.deepEqual(cursors, [undefined, "next", undefined, "next"]);
	assert.deepEqual(result, {
		entries: [entry("first"), entry("last")],
		truncated: false,
	});
	assert.deepEqual(previews, [[entry("deleted")]]);
});
