import assert from "node:assert/strict";
import { test } from "node:test";
import type { SpaceInstalledApps } from "@cohub/protocol";
import type { AppDetailResponse, AppRecord } from "@neta-art/cohub";
import {
	canOpenFileWith,
	createFileHandlerResolver,
	saveDefaultFileHandler,
} from "../lib/features/app/file-handlers.ts";

type Record = Pick<AppRecord, "id" | "slug" | "status" | "meta">;

const BOARD = "00000000-0000-4000-8000-00000000b0a1";
const NOTES = "00000000-0000-4000-8000-00000000a0e5";
const OWN = "00000000-0000-4000-8000-0000000000aa";

const app = (
	id: string,
	fileHandlers: string[] | undefined,
	status: Record["status"] = "published",
): Record => ({
	id,
	slug: id.slice(-4),
	status,
	meta: fileHandlers ? { fileHandlers } : null,
});

const installed = (id: string, fields: object = {}) => ({
	id,
	ref: `alice/studio/${id.slice(-4)}`,
	url: "https://apps.example.test/app",
	enabled: true,
	source: { type: "url" as const, url: "https://apps.example.test/app" },
	snapshot: { name: id },
	installedAt: "2026-09-24T00:00:00.000Z",
	...fields,
});

const apps = (...entries: SpaceInstalledApps["apps"]): SpaceInstalledApps => ({
	format: "cohub.space-apps",
	version: 1,
	apps: entries,
});

function detail(record: Record | undefined) {
	if (!record) throw Object.assign(new Error("not found"), { status: 404 });
	return {
		app: record,
		space: { id: "space-1", slug: "studio", name: null, userUuid: "u" },
		owner: { userUuid: "u", username: "alice", displayName: "Alice" },
		publicUrl: `https://cohub.test/alice/studio/w/${record.slug}`,
	} as unknown as AppDetailResponse;
}

function createHarness(input: {
	records: Record[];
	document: SpaceInstalledApps;
	own?: Record[];
}) {
	const lookups: string[] = [];
	const byId = new Map(input.records.map((record) => [record.id, record]));
	const resolver = createFileHandlerResolver({
		loader: {
			get: async (id) => {
				lookups.push(id);
				return detail(byId.get(id));
			},
			getPublicById: async (id) => detail(byId.get(id)),
		},
		listSpaceApps: async () => input.own ?? [],
		readInstalled: async () => input.document,
	});
	return { resolver, lookups, byId };
}

test("only a published App that declares the extension can open a file", () => {
	assert.equal(canOpenFileWith(app(BOARD, [".board"]), "x/y.board"), true);
	assert.equal(canOpenFileWith(app(BOARD, [".board"]), "x/y.md"), false);
	assert.equal(
		canOpenFileWith(app(BOARD, [".board"], "disabled"), "x/y.board"),
		false,
	);
	assert.equal(canOpenFileWith(app(BOARD, undefined), "x/y.board"), false);
});

test("the default is the installed App registered for the extension, validated once", async () => {
	const { resolver, lookups } = createHarness({
		records: [app(BOARD, [".board"]), app(NOTES, [".md"])],
		document: apps(
			installed(BOARD, { opens: [".board"] }),
			installed(NOTES, { opens: [".txt"] }),
		),
	});
	assert.equal(
		(await resolver.resolveDefault("space-1", "plans/a.board"))?.app?.appId,
		BOARD,
	);
	await resolver.resolveDefault("space-1", "plans/b.board");
	assert.deepEqual(lookups, [BOARD], "a repeat open is served from cache");

	assert.deepEqual(await resolver.resolveDefault("space-1", "notes.txt"), {
		ref: `alice/studio/${NOTES.slice(-4)}`,
		app: null,
	});
	assert.equal(await resolver.resolveDefault("space-1", "readme.md"), null);
});

test("a known App answers at once, refreshes after a while, and survives a failed refresh", async () => {
	let reachable = true;
	let lookups = 0;
	const load = async (id: string) => {
		lookups += 1;
		if (!reachable) throw Object.assign(new Error("offline"), { status: 503 });
		return detail(app(id, [".board"]));
	};
	const resolver = createFileHandlerResolver({
		loader: { get: load, getPublicById: load },
		listSpaceApps: async () => [],
		readInstalled: async () => apps(installed(BOARD, { opens: [".board"] })),
	});
	const realNow = Date.now;
	let now = realNow();
	Date.now = () => now;
	try {
		await resolver.resolveDefault("space-1", "a.board");
		now += 6 * 60 * 1_000;
		reachable = false;
		const stale = await resolver.resolveDefault("space-1", "b.board");
		assert.equal(stale?.app?.appId, BOARD, "the known App opens the file");
		assert.equal(lookups, 2, "while it refreshes in the background");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const kept = await resolver.resolveDefault("space-1", "c.board");
		assert.equal(kept?.app?.appId, BOARD, "a failed refresh keeps it");
	} finally {
		Date.now = realNow;
	}
});

test("an unreachable App is never reported as unable to open the file", async () => {
	const offline = async () => {
		throw Object.assign(new Error("offline"), { status: 503 });
	};
	const resolver = createFileHandlerResolver({
		loader: { get: offline, getPublicById: offline },
		listSpaceApps: async () => [],
		readInstalled: async () => apps(installed(BOARD, { opens: [".board"] })),
	});
	await assert.rejects(resolver.resolveDefault("space-1", "a.board"));
	assert.deepEqual(await resolver.listCandidates("space-1", "a.board"), []);
});

test("Open with lists the Space's own and enabled installed Apps that declare the extension", async () => {
	const { resolver } = createHarness({
		records: [
			app(BOARD, [".board", ".md"]),
			app(NOTES, [".board"]),
			app(OWN, [".board"]),
		],
		own: [
			app(OWN, [".board"]),
			app("00000000-0000-4000-8000-0000000000bb", [".board"], "disabled"),
		],
		document: apps(
			installed(BOARD),
			installed(OWN),
			installed(NOTES, { enabled: false }),
		),
	});
	const candidates = await resolver.listCandidates("space-1", "plans/a.board");
	assert.deepEqual(
		candidates.map((candidate) => candidate.appId),
		[OWN, BOARD],
	);
	assert.deepEqual(await resolver.listCandidates("space-1", "Makefile"), []);
});

test("saving a default moves the extension, and installs a Space's own App first", async () => {
	let written: SpaceInstalledApps | null = null;
	const deps = {
		read: async () => ({
			document: apps(installed(BOARD, { opens: [".board"] })),
			revision: { mtimeMs: 1, size: 2 },
		}),
		write: async (
			_spaceId: string,
			document: SpaceInstalledApps,
			revision: unknown,
		) => {
			assert.deepEqual(
				revision,
				{ mtimeMs: 1, size: 2 },
				"the write is conditional on what was read",
			);
			written = document;
			return { mtimeMs: 3, size: 4 };
		},
		loadApp: async () => detail(app(OWN, [".board"])),
	};

	const saved = await saveDefaultFileHandler(deps, {
		spaceId: "space-1",
		path: "a.board",
		appId: OWN,
	});
	assert.deepEqual(saved?.revision, { mtimeMs: 3, size: 4 });
	const document = written as SpaceInstalledApps | null;
	assert.deepEqual(
		document?.apps.map((entry) => [entry.id, entry.opens]),
		[
			[BOARD, undefined],
			[OWN, [".board"]],
		],
	);
	assert.equal(document?.apps[1]?.ref, `alice/studio/${OWN.slice(-4)}`);
	assert.deepEqual(document?.apps[1]?.source, {
		type: "url",
		url: `https://cohub.test/alice/studio/w/${OWN.slice(-4)}`,
	});

	await saveDefaultFileHandler(deps, {
		spaceId: "space-1",
		path: "a.board",
		appId: null,
	});
	assert.equal(
		(written as SpaceInstalledApps | null)?.apps[0]?.opens,
		undefined,
		"built-in holds no registration",
	);
	assert.equal(
		await saveDefaultFileHandler(deps, {
			spaceId: "space-1",
			path: "Makefile",
			appId: OWN,
		}),
		null,
	);
});

test("choosing a disabled App as the default enables it", async () => {
	let written: SpaceInstalledApps | null = null;
	await saveDefaultFileHandler(
		{
			read: async () => ({
				document: apps(installed(OWN, { enabled: false })),
				revision: null,
			}),
			write: async (_spaceId: string, document: SpaceInstalledApps) => {
				written = document;
				return null;
			},
			loadApp: async () => null,
		},
		{ spaceId: "space-1", path: "a.board", appId: OWN },
	);
	const [entry] = (written as SpaceInstalledApps | null)?.apps ?? [];
	assert.equal(entry?.enabled, true);
	assert.deepEqual(entry?.opens, [".board"]);
});
