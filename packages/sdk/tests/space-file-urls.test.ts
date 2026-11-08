import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";
import { createSpaceFileReads } from "../src/apis/space-file-reads.js";
import { createSpaceFileUrls } from "../src/apis/space-file-urls.js";
import type { HttpTransport } from "../src/transport.js";
import type { SpaceFsFileResponse } from "../src/types.js";

const file = (path: string, url = `https://cdn.test/${path}`): SpaceFsFileResponse => ({
	path,
	name: path,
	size: 1,
	mimeType: "image/png",
	mtimeMs: 1,
	kind: "binary",
	encoding: "base64",
	content: "",
	delivery: "url",
	url,
	media: { width: 4, height: 3 },
});

type Sent = { paths: string[]; token: string | null | undefined };

function setup(urlOf: (path: string) => string = (path) => `https://cdn.test/${path}`, cache = true) {
	const singles: string[] = [];
	const batches: string[][] = [];
	const sent: Sent[] = [];
	const caller = new AsyncLocalStorage<string | null>();
	const transport = {
		async credential() {
			const token = caller.getStore();
			return token === undefined ? "a" : token;
		},
		async requestRevalidated(url: string, init: { accessToken?: string | null } = {}) {
			const path = new URL(url, "http://x").searchParams.get("path") as string;
			singles.push(path);
			sent.push({ paths: [path], token: init.accessToken });
			return file(path, urlOf(path));
		},
		async request(_url: string, init: { body: string; accessToken?: string | null }) {
			const { paths } = JSON.parse(init.body) as { paths: string[] };
			batches.push(paths);
			sent.push({ paths, token: init.accessToken });
			return { files: paths.map((path) => file(path, urlOf(path))), errors: [] };
		},
	} as unknown as HttpTransport;
	const reads = createSpaceFileReads(transport);
	const urls = createSpaceFileUrls({
		reads,
		credential: () => transport.credential(),
		scope: async () => "user:u",
		watched: () => true,
		cache,
	});
	return { reads, urls, singles, batches, sent, caller, transport };
}

const as = <T>(caller: AsyncLocalStorage<string | null>, token: string | null, read: () => Promise<T>) =>
	caller.run(token, read);

test("a lone read keeps its plain request, reads of one task share batches", async () => {
	const { reads, singles, batches } = setup();
	await reads.read("s", "a.png");
	const paths = Array.from({ length: 40 }, (_, index) => `${index}.png`);
	await Promise.all([...paths, "0.png"].map((path) => reads.read("s", path)));
	assert.deepEqual(singles, ["a.png"]);
	assert.deepEqual(batches.map((batch) => batch.length), [32, 8]);
});

test("file changes drop remembered URLs and tell listeners", async () => {
	let version = 1;
	const { urls, singles } = setup((path) => `https://cdn.test/${path}?v=${version}`);
	const changed: string[] = [];
	urls.subscribe((_spaceId, path) => changed.push(path));
	await urls.resolve("s", "a.png");
	assert.deepEqual(await urls.resolve("s", "a.png"), { url: "https://cdn.test/a.png?v=1", media: { width: 4, height: 3 } });
	version = 2;
	urls.applyFsChange("s", { changes: [{ path: "a.png", kind: "modify" }] });
	assert.equal((await urls.resolve("s", "a.png"))?.url, "https://cdn.test/a.png?v=2");
	assert.deepEqual(changed, ["a.png"]);
	assert.deepEqual(singles, ["a.png", "a.png"]);
});

test("reads share a request only when they carry the same credential", async () => {
	const { reads, sent, caller } = setup();
	await Promise.all([
		as(caller, "owner", () => reads.read("s", "secret.md")),
		as(caller, "guest", () => reads.read("s", "secret.md")),
		as(caller, "owner", () => reads.read("s", "notes.md")),
		as(caller, null, () => reads.read("s", "notes.md")),
	]);
	const byToken = new Map(sent.map(({ token, paths }) => [token, paths]));
	assert.equal(sent.length, 3);
	assert.deepEqual(byToken.get("owner"), ["secret.md", "notes.md"]);
	assert.deepEqual(byToken.get("guest"), ["secret.md"]);
	assert.deepEqual(byToken.get(null), ["notes.md"]);
});

test("a batched symlink falls back to a single read that describes it", async () => {
	const link = { kind: "symlink", path: "AGENTS.md", name: "AGENTS.md", size: 9, mtimeMs: 1, target: "CLAUDE.md", targetPath: "CLAUDE.md" };
	const singles: string[] = [];
	const transport = {
		credential: async () => "a",
		async requestRevalidated(url: string) {
			singles.push(new URL(url, "http://x").searchParams.get("path") as string);
			return link;
		},
		request: async () => ({
			files: [file("a.png")],
			errors: [{ path: "AGENTS.md", code: "symlink_not_supported", message: "Symlink preview is not supported.", status: 400 }],
		}),
	} as unknown as HttpTransport;
	const reads = createSpaceFileReads(transport);
	const [symlink] = await Promise.all([reads.read("s", "AGENTS.md"), reads.read("s", "a.png")]);
	assert.deepEqual(symlink, link);
	assert.deepEqual(singles, ["AGENTS.md"]);
});
