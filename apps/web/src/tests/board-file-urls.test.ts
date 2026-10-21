import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	SpaceFsFileResponse,
	SpaceFsReadFilesResponse,
} from "@neta-art/cohub";
import { createSpaceFileBatchReader } from "$lib/board/space-file-batch";
import {
	createSpaceFileUrlResolver,
	type SpaceFileUrlRecord,
} from "$lib/board/space-file-url-resolver";

const wait = () => new Promise((resolve) => setTimeout(resolve, 5));

const response = (url: string): SpaceFsReadFilesResponse => ({
	files: [
		{
			path: "a.png",
			name: "a.png",
			size: 1,
			mimeType: "image/png",
			mtimeMs: 1,
			kind: "binary",
			encoding: "base64",
			content: "",
			delivery: "url",
			url,
		} satisfies SpaceFsFileResponse,
	],
	errors: [],
});

for (const oldFirst of [true, false]) {
	test(`invalidation isolates in-flight reads (old answer ${oldFirst ? "first" : "last"})`, async () => {
		const gates: Array<PromiseWithResolvers<SpaceFsReadFilesResponse>> = [];
		const reader = createSpaceFileBatchReader({
			readMany: () => {
				const gate = Promise.withResolvers<SpaceFsReadFilesResponse>();
				gates.push(gate);
				return gate.promise;
			},
			readOne: () => Promise.reject(new Error("Unexpected fallback")),
		});
		const records = new Map<string, SpaceFileUrlRecord>();
		const resolver = createSpaceFileUrlResolver({
			scope: () => "user",
			remote: { ...reader, resolveUrl: async () => null },
			store: {
				read: async () => records,
				write: async (_scope, _spaceId, { put, remove }) => {
					for (const [path, record] of put) records.set(path, record);
					for (const path of remove) records.delete(path);
				},
			},
		});
		const old = resolver.resolve("s", "a.png", { fresh: true });
		await wait();
		resolver.invalidate("s", ["a.png"]);
		const fresh = resolver.resolve("s", "a.png", { fresh: true });
		await wait();
		assert.equal(gates.length, 2, "post-change reads start a new batch");
		const [before, after] = gates as [
			(typeof gates)[number],
			(typeof gates)[number],
		];
		if (oldFirst) before.resolve(response("https://cdn.test/old"));
		after.resolve(response("https://cdn.test/new"));
		if (!oldFirst) before.resolve(response("https://cdn.test/old"));
		assert.equal(await old, "https://cdn.test/old");
		assert.equal(await fresh, "https://cdn.test/new");
		await wait();
		assert.equal(await resolver.resolve("s", "a.png"), "https://cdn.test/new");
		assert.equal(records.get("a.png")?.url, "https://cdn.test/new");
	});
}
