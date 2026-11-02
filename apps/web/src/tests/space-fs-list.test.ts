import assert from "node:assert/strict";
import { mock, test } from "node:test";
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

const offline = () =>
	new HttpError("local sandbox is offline", 503, { code: "sandbox_offline" });
const page = {
	path: "",
	entries: [entry("a")],
	nextCursor: null,
	truncated: false,
};

async function runWithTimers<T>(promise: Promise<T>) {
	const settled = promise.then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	);
	for (let i = 0; i < 30; i += 1) {
		await new Promise((resolve) => setImmediate(resolve));
		mock.timers.tick(1_000);
	}
	return settled;
}

test("a cold sandbox connect is retried silently", async () => {
	mock.timers.enable({ apis: ["setTimeout", "Date"] });
	try {
		let calls = 0;
		const result = await runWithTimers(
			readDirectoryPages(async () => {
				calls += 1;
				if (calls <= 2) throw offline();
				return page;
			}),
		);
		assert.deepEqual(result, {
			value: { entries: [entry("a")], truncated: false },
		});
		assert.equal(calls, 3);
	} finally {
		mock.timers.reset();
	}
});

test("a sandbox that stays offline fails after the grace window", async () => {
	mock.timers.enable({ apis: ["setTimeout", "Date"] });
	try {
		let calls = 0;
		const result = await runWithTimers(
			readDirectoryPages(async () => {
				calls += 1;
				throw offline();
			}),
		);
		assert.ok("error" in result && isOffline(result.error));
		assert.ok(calls >= 5 && calls < 10);
	} finally {
		mock.timers.reset();
	}
});

function isOffline(error: unknown) {
	return error instanceof HttpError && error.code === "sandbox_offline";
}
