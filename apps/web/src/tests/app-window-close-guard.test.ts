import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppDetailResponse } from "@neta-art/cohub";

(globalThis as unknown as { $state: <T>(value: T) => T }).$state = <T>(
	value: T,
) => value;

const { createAppPreviewController } = await import(
	"../lib/features/space/modules/app-window-controller.svelte.ts"
);
const { createAppSurfaceRegistry } = await import(
	"../lib/features/app/surface-registry.ts"
);

const APP_ID = "11111111-1111-4111-8111-111111111111";
const DIRTY = { title: "Roadmap", status: "idle" as const, dirty: true };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function detail(version = 1) {
	return {
		app: {
			id: APP_ID,
			slug: "board",
			status: "published",
			latestVersion: version,
			updatedAt: `2026-09-2${version}T00:00:00.000Z`,
			meta: null,
		},
		content: { kind: "web", url: "https://apps.test/board" },
	} as unknown as AppDetailResponse;
}

function createHarness(options: { flushed?: boolean; discard?: boolean } = {}) {
	const closed: string[] = [];
	const prepared: string[] = [];
	const confirmed: string[] = [];
	let version = 1;
	const controller = createAppPreviewController({
		getSpaceId: () => "space-1",
		surfaces: createAppSurfaceRegistry(),
		loadApp: async () => detail(version),
		onAppClosed: (appId) => closed.push(appId),
		prepareClose: async (appId) => {
			prepared.push(appId);
			return options.flushed ?? true;
		},
		confirmDiscard: (label) => {
			confirmed.push(label);
			return options.discard ?? false;
		},
	});
	controller.openApp({ appId: APP_ID, openContext: { source: "user" } });
	return {
		controller,
		closed,
		prepared,
		confirmed,
		publish: () => {
			version += 1;
		},
	};
}

test("a dirty App flushes before its tab closes", async () => {
	const { controller, closed, prepared, confirmed } = createHarness({
		flushed: true,
	});
	controller.setWindowState(APP_ID, DIRTY);
	controller.closeApp(APP_ID);
	assert.equal(controller.previews.length, 1, "the close waits for the flush");
	await settle();
	assert.deepEqual(prepared, [APP_ID]);
	assert.deepEqual(confirmed, []);
	assert.deepEqual(closed, [APP_ID]);
	assert.equal(controller.previews.length, 0);
});

test("a failed flush asks the viewer, and keeps the tab unless they discard", async () => {
	const kept = createHarness({ flushed: false, discard: false });
	kept.controller.setWindowState(APP_ID, DIRTY);
	kept.controller.closeApp(APP_ID);
	await settle();
	assert.deepEqual(kept.confirmed, ["Roadmap"]);
	assert.equal(kept.controller.previews.length, 1);

	const discarded = createHarness({ flushed: false, discard: true });
	discarded.controller.setWindowState(APP_ID, DIRTY);
	discarded.controller.closeApp(APP_ID);
	await settle();
	assert.equal(discarded.controller.previews.length, 0);
});

test("leaving flushes every dirty App and reports whether all are clean", async () => {
	const flushed = createHarness({ flushed: true });
	flushed.controller.setWindowState(APP_ID, DIRTY);
	assert.equal(await flushed.controller.flushAll(), true);
	assert.deepEqual(flushed.prepared, [APP_ID]);
	assert.deepEqual(flushed.confirmed, [], "the page asks, once, not each App");

	const stuck = createHarness({ flushed: false });
	stuck.controller.setWindowState(APP_ID, DIRTY);
	assert.equal(await stuck.controller.flushAll(), false);
	assert.equal(stuck.controller.hasDirty(), true);
});

test("a context teardown closes dirty Apps at once; leaving already settled them", () => {
	const { controller, closed, prepared, confirmed } = createHarness({
		flushed: false,
	});
	controller.setWindowState(APP_ID, DIRTY);
	controller.closeAll();
	assert.equal(controller.previews.length, 0);
	assert.deepEqual(closed, [APP_ID]);
	assert.deepEqual(prepared, []);
	assert.deepEqual(confirmed, []);
});

test("a new App version waits while work is unsaved", async () => {
	const { controller, publish } = createHarness();
	await settle();
	const mountKey = controller.previews[0]?.mountKey;
	controller.setWindowState(APP_ID, DIRTY);
	publish();
	controller.refreshIfOpen(APP_ID);
	await settle();
	assert.equal(
		controller.previews[0]?.mountKey,
		mountKey,
		"a background refresh must not reload a dirty App",
	);
	assert.equal(
		controller.previews[0]?.detail?.app.latestVersion,
		2,
		"the new version is ready for the next reload",
	);
});

test("reloading a dirty App flushes first, then starts the new document clean", async () => {
	const { controller, prepared, publish } = createHarness({ flushed: true });
	await settle();
	const mountKey = controller.previews[0]?.mountKey ?? 0;
	controller.setWindowState(APP_ID, DIRTY);
	publish();
	await controller.retry(APP_ID);
	await settle();
	assert.deepEqual(prepared, [APP_ID]);
	assert.ok((controller.previews[0]?.mountKey ?? 0) > mountKey);
	assert.equal(controller.previews[0]?.windowState.dirty, false);
});

test("each file opens its own window; opening it again reuses that window", async () => {
	const { controller } = createHarness();
	const openFile = (path: string) =>
		controller.openApp({
			appId: APP_ID,
			openContext: { source: "user", file: { path } },
		});
	openFile("plans/a.board");
	openFile("plans/b.board");
	openFile("plans/a.board");
	await settle();
	assert.deepEqual(
		controller.previews.map((item) => item.key),
		[APP_ID, `${APP_ID}:plans/a.board`, `${APP_ID}:plans/b.board`],
	);
	assert.equal(controller.activeKey, `${APP_ID}:plans/a.board`);
	assert.ok(
		controller.previews.every((item) => item.detail),
		"windows of one App share its detail",
	);
});

test("a renamed file keeps its window; a deleted one closes it", async () => {
	const { controller, closed } = createHarness();
	controller.openApp({
		appId: APP_ID,
		openContext: { source: "user", file: { path: "plans/a.board" } },
	});
	controller.openApp({
		appId: APP_ID,
		openContext: { source: "user", file: { path: "notes/b.board" } },
	});
	await settle();
	const before = controller.previews.find(
		(item) => item.invocation.file?.path === "plans/a.board",
	);
	controller.renamePath("plans", "archive/plans");
	const moved = controller.previews.find(
		(item) => item.invocation.file?.path === "archive/plans/a.board",
	);
	assert.equal(moved?.key, `${APP_ID}:archive/plans/a.board`);
	assert.equal(
		moved?.id,
		before?.id,
		"the window keeps its identity, so its frame stays mounted",
	);
	assert.equal(moved?.mountKey, before?.mountKey);
	assert.equal(
		controller.activeKey,
		`${APP_ID}:notes/b.board`,
		"an unrelated active window stays active",
	);

	controller.closeFilesAtPath("archive", true);
	assert.deepEqual(closed.slice(-1), [`${APP_ID}:archive/plans/a.board`]);

	controller.setWindowState(`${APP_ID}:notes/b.board`, DIRTY);
	controller.closeFilesAtPath("notes", true);
	assert.deepEqual(
		controller.previews.map((item) => item.key),
		[APP_ID, `${APP_ID}:notes/b.board`],
	);
});

test("a rename and its realtime echo move a window exactly once", async () => {
	const { controller, closed } = createHarness();
	controller.openApp({
		appId: APP_ID,
		openContext: { source: "user", file: { path: "a.board" } },
	});
	await settle();
	controller.renamePath("a.board", "b.board");
	assert.deepEqual(controller.renamePath("a.board", "b.board"), []);
	assert.deepEqual(
		controller.previews.map((item) => item.key),
		[APP_ID, `${APP_ID}:b.board`],
	);
	assert.deepEqual(closed, []);
});

test("a route sync shows a window without opening it again", async () => {
	const { controller } = createHarness();
	const key = `${APP_ID}:a.board`;
	const open = (source: "user" | "route") =>
		controller.openApp({
			appId: APP_ID,
			openContext: { source, file: { path: "a.board" } },
		});
	open("user");
	await settle();
	const opened = controller.previews.find((item) => item.key === key)
		?.invocation.id;
	controller.activateApp(APP_ID);
	open("route");
	assert.equal(controller.activeKey, key);
	assert.equal(
		controller.previews.find((item) => item.key === key)?.invocation.id,
		opened,
	);
	open("user");
	assert.notEqual(
		controller.previews.find((item) => item.key === key)?.invocation.id,
		opened,
		"opening it again is a new launch",
	);
});

test("a file moved while its window flushes still closes, under its new key", async () => {
	const { controller, closed } = createHarness({ flushed: true });
	const from = `${APP_ID}:plans/a.board`;
	const to = `${APP_ID}:archive/a.board`;
	controller.openApp({
		appId: APP_ID,
		openContext: { source: "user", file: { path: "plans/a.board" } },
	});
	await settle();
	controller.setWindowState(from, DIRTY);
	controller.closeApp(from);
	controller.renamePath("plans/a.board", "archive/a.board");
	await settle();
	assert.deepEqual(closed, [to]);
	assert.equal(
		controller.previews.some((item) => item.key === to),
		false,
	);

	controller.openApp({
		appId: APP_ID,
		openContext: { source: "user", file: { path: "archive/a.board" } },
	});
	await settle();
	controller.setWindowState(to, DIRTY);
	controller.closeApp(to);
	assert.equal(controller.previews.length, 2, "the close waits for a flush");
});

test("a move over another open file closes the window on the replaced file", async () => {
	const { controller } = createHarness();
	for (const path of ["plans/a.board", "plans/b.board"]) {
		controller.openApp({
			appId: APP_ID,
			openContext: { source: "user", file: { path } },
		});
	}
	await settle();
	const moving = controller.previews.find(
		(item) => item.invocation.file?.path === "plans/a.board",
	);
	controller.renamePath("plans/a.board", "plans/b.board");
	const keys = controller.previews.map((item) => item.key);
	assert.deepEqual(keys, [APP_ID, `${APP_ID}:plans/b.board`]);
	assert.equal(controller.previews[1]?.id, moving?.id);
});
