import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { appWindowKey } from "../lib/features/space/modules/app-window-key.ts";
import { createWindowManager } from "../lib/features/space/modules/window-manager.svelte.ts";

(globalThis as unknown as { $state: <T>(value: T) => T }).$state = <T>(
	value: T,
) => value;

const WORK_ID = "123e4567-e89b-42d3-a456-426614174000";
const APP_A = "11111111-1111-4111-8111-111111111111";
const APP_B = "22222222-2222-4222-8222-222222222222";
const APP_C = "33333333-3333-4333-8333-333333333333";
const APP_D = "44444444-4444-4444-8444-444444444444";

type Ref = { kind: "file" | "board" | "port" | "app"; key: string };

/**
 * A harness with all four domains mounted, so cross-domain fallback and
 * out-of-band closes can be exercised the way the page wires them.
 */
function createHarness(
	options: { appKeepAliveLimit?: number; weightLimit?: number } = {},
) {
	let filePaths: string[] = [];
	let activeFilePath: string | null = null;
	let boardPaths: string[] = [];
	let activeBoardPath: string | null = null;
	let ports: string[] = [];
	let activePort: string | null = null;
	let appKeys: string[] = [];
	let activeAppKey: string | null = null;
	const dirtyApps = new Set<string>();
	let boardOpenCount = 0;
	const urls: Array<Ref | null> = [];
	const appInvocations: Array<unknown> = [];

	const drop = (list: string[], key: string) =>
		list.filter((item) => item !== key);

	const controller = createWindowManager({
		getFileTabs: () =>
			filePaths.map((path) => ({ path, response: null, draft: "" })),
		getActiveFilePath: () => activeFilePath,
		getBoardTabs: () => boardPaths.map((path) => ({ path, saving: false })),
		getActiveBoardPath: () => activeBoardPath,
		getPortTabs: () => ports.map((port) => ({ port, url: "http://x" })),
		getActivePort: () => activePort,
		getAppTabs: () =>
			appKeys.map((key) => ({
				key,
				loading: false,
				windowState: { dirty: dirtyApps.has(key) },
			})),
		getActiveAppKey: () => activeAppKey,
		openFile: async (path) => {
			if (!filePaths.includes(path)) filePaths = [...filePaths, path];
			activeFilePath = path;
		},
		activateFile: (path) => {
			activeFilePath = path;
		},
		closeFile: (path) => {
			if (!path) return;
			filePaths = drop(filePaths, path);
			if (activeFilePath === path) activeFilePath = filePaths.at(-1) ?? null;
		},
		goBackFile: async () => null,
		openBoard: async (path) => {
			boardOpenCount += 1;
			if (!boardPaths.includes(path)) boardPaths = [...boardPaths, path];
			activeBoardPath = path;
		},
		activateBoard: (path) => {
			activeBoardPath = path;
		},
		closeBoard: (path) => {
			if (!path) return;
			boardPaths = drop(boardPaths, path);
			if (activeBoardPath === path) activeBoardPath = boardPaths.at(-1) ?? null;
		},
		openPort: (port) => {
			if (!ports.includes(port)) ports = [...ports, port];
			activePort = port;
		},
		activatePort: (port) => {
			activePort = port;
		},
		closePort: (port) => {
			if (!port) return;
			ports = drop(ports, port);
			if (activePort === port) activePort = ports.at(-1) ?? null;
		},
		openApp: (input) => {
			const key = appWindowKey(input.appId, input.openContext.file?.path);
			if (!appKeys.includes(key)) appKeys = [...appKeys, key];
			appInvocations.push(input.openContext);
			activeAppKey = key;
		},
		activateApp: (key) => {
			activeAppKey = key;
		},
		closeApp: (key) => {
			if (!key) return;
			appKeys = drop(appKeys, key);
			if (activeAppKey === key) activeAppKey = appKeys.at(-1) ?? null;
		},
		getPortEndpointUrl: () => "http://x",
		syncUrl: (ref) => {
			urls.push(ref);
		},
		weightLimit: options.weightLimit ?? 100,
		appKeepAliveLimit: options.appKeepAliveLimit,
	});

	return {
		controller,
		urls,
		appInvocations,
		counts: () => ({
			files: filePaths.length,
			boards: boardPaths.length,
			ports: ports.length,
			apps: appKeys.length,
		}),
		boardOpenCount: () => boardOpenCount,
		/** An App reporting unsaved work, as its window state would. */
		markDirty: (appId: string) => dirtyApps.add(appId),
		/** An App window rekeyed by its domain after its file moved. */
		renameApp: (from: string, to: string) => {
			appKeys = appKeys.map((key) => (key === from ? to : key));
			if (activeAppKey === from) activeAppKey = to;
		},
		/** Simulate a domain closing a tab on its own schedule. */
		closeFileOutOfBand: (path: string) => {
			filePaths = drop(filePaths, path);
			if (activeFilePath === path) activeFilePath = filePaths.at(-1) ?? null;
		},
	};
}

test("closing the active preview falls back to the most recently used surface", async () => {
	const { controller } = createHarness();
	await controller.openFile("docs/a.md");
	controller.openPort("5173", "http://x");
	controller.openApp({
		appId: WORK_ID,
		openContext: { source: "user" },
	});

	controller.close("app", WORK_ID);

	// The remaining file and port tabs are both mounted; the port was used more
	// recently, so a fixed kind order must not send the user back to the file.
	assert.deepEqual(controller.currentRef(), { kind: "port", key: "5173" });
	assert.equal(controller.activeKind, "port");
});

test("re-activating an older tab makes it the fallback again", async () => {
	const { controller } = createHarness();
	await controller.openFile("docs/a.md");
	await controller.openBoard("plans/main.board");
	controller.activate("file", "docs/a.md");
	controller.openApp({
		appId: WORK_ID,
		openContext: { source: "user" },
	});

	controller.close("app", WORK_ID);

	assert.deepEqual(controller.currentRef(), { kind: "file", key: "docs/a.md" });
});

test("a deferred domain close re-derives the active ref and rewrites the URL", async () => {
	const { controller, urls, closeFileOutOfBand } = createHarness();
	await controller.openFile("docs/a.md");
	await controller.openFile("docs/b.md");
	const writesBefore = urls.length;

	// A file that flushed its autosave closes itself after the user's click has
	// already returned; without a report the URL keeps pointing at it.
	closeFileOutOfBand("docs/b.md");
	controller.tabClosed("file", "docs/b.md");

	assert.deepEqual(controller.currentRef(), { kind: "file", key: "docs/a.md" });
	assert.deepEqual(urls.at(-1), { kind: "file", key: "docs/a.md" });
	assert.ok(urls.length > writesBefore);
});

test("the last deferred close clears the preview URL", async () => {
	const { controller, urls, closeFileOutOfBand } = createHarness();
	await controller.openFile("docs/a.md");

	closeFileOutOfBand("docs/a.md");
	controller.tabClosed("file", "docs/a.md");

	assert.equal(controller.currentRef(), null);
	assert.equal(controller.activeKind, null);
	assert.equal(urls.at(-1), null);
});

test("a close driven by the coordinator is not reconciled twice", async () => {
	const { controller, urls } = createHarness();
	await controller.openFile("docs/a.md");
	await controller.openFile("docs/b.md");
	controller.close("file", "docs/b.md");
	const writesAfterClose = urls.length;

	// The domain also reports the close it was just asked to perform.
	controller.tabClosed("file", "docs/b.md");

	assert.equal(urls.length, writesAfterClose);
	assert.deepEqual(controller.currentRef(), { kind: "file", key: "docs/a.md" });
});

test("a reopened tab does not inherit its previous access order", async () => {
	const { controller } = createHarness();
	await controller.openFile("docs/a.md");
	controller.openPort("5173", "http://x");
	controller.close("port", "5173");

	// Reopening the port must rank it as newest, not restore the stale ordering
	// left behind by the closed tab.
	controller.openPort("5173", "http://x");
	controller.openApp({
		appId: WORK_ID,
		openContext: { source: "user" },
	});
	controller.close("app", WORK_ID);

	assert.deepEqual(controller.currentRef(), { kind: "port", key: "5173" });
});

test("compact session navigation suspends tabs without disposing runtimes", async () => {
	const { controller, counts, boardOpenCount } = createHarness();
	await controller.openFile("docs/a.md");
	await controller.openBoard("plans/main.board");
	controller.openPort("5173", "http://x");
	controller.openApp({
		appId: WORK_ID,
		openContext: { source: "user" },
	});
	const opensBeforeSuspend = boardOpenCount();

	assert.equal(controller.suspendForRoute(), true);
	assert.equal(controller.suspended, true);
	assert.equal(controller.currentRef(), null);
	assert.equal(controller.activeKind, null);
	assert.deepEqual(counts(), { files: 1, boards: 1, ports: 1, apps: 1 });

	controller.applyRoute({ kind: "board", key: "plans/main.board" });
	assert.equal(controller.suspended, false);
	assert.deepEqual(controller.currentRef(), {
		kind: "board",
		key: "plans/main.board",
	});
	assert.equal(
		boardOpenCount(),
		opensBeforeSuspend,
		"restoring a mounted Board must reuse its editor runtime",
	);
});

test("only the most recently used Apps stay mounted in the background", () => {
	const { controller } = createHarness();
	const open = (appId: string) =>
		controller.openApp({ appId, openContext: { source: "user" } });

	open(APP_A);
	open(APP_B);
	open(APP_C);
	assert.deepEqual(
		[...controller.retainedAppKeys()].sort(),
		[APP_A, APP_B, APP_C].sort(),
		"every App fits while there is room",
	);

	open(APP_D);
	assert.deepEqual(
		[...controller.retainedAppKeys()].sort(),
		[APP_B, APP_C, APP_D].sort(),
		"the least recently used App falls out of the mounted set",
	);

	// Re-activating the dropped App makes it newest again and evicts the LRU.
	controller.activate("app", APP_A);
	assert.deepEqual(
		[...controller.retainedAppKeys()].sort(),
		[APP_A, APP_C, APP_D].sort(),
	);
});

test("the active App is always retained, even with a keep-alive window of 1", () => {
	const { controller } = createHarness({ appKeepAliveLimit: 1 });
	controller.openApp({ appId: APP_A, openContext: { source: "user" } });
	controller.openApp({ appId: APP_B, openContext: { source: "user" } });
	assert.deepEqual([...controller.retainedAppKeys()], [APP_B]);

	controller.activate("app", APP_A);
	assert.deepEqual(
		[...controller.retainedAppKeys()],
		[APP_A],
		"activating an App must keep its surface mounted",
	);
});

test("Apps with unsaved work stay mounted beyond the keep-alive window", () => {
	const { controller, markDirty } = createHarness({ appKeepAliveLimit: 1 });
	controller.openApp({ appId: APP_A, openContext: { source: "user" } });
	markDirty(APP_A);
	controller.openApp({ appId: APP_B, openContext: { source: "user" } });
	assert.deepEqual(
		[...controller.retainedAppKeys()].sort(),
		[APP_A, APP_B].sort(),
		"unmounting a dirty App would discard its work",
	);
});

test("the tab budget never closes an App with unsaved work", () => {
	const { controller, counts, markDirty } = createHarness({ weightLimit: 6 });
	controller.openApp({ appId: APP_A, openContext: { source: "user" } });
	markDirty(APP_A);
	controller.openApp({ appId: APP_B, openContext: { source: "user" } });
	controller.openApp({ appId: APP_C, openContext: { source: "user" } });
	assert.equal(counts().apps, 2, "the budget closes a clean App instead");
	assert.deepEqual([...controller.retainedAppKeys()].includes(APP_A), true);
});

test("closeAll drops every domain tab and the active ref", async () => {
	const { controller, counts } = createHarness();
	await controller.openFile("docs/a.md");
	await controller.openBoard("plans/main.board");
	controller.openPort("5173", "http://x");
	controller.openApp({
		appId: WORK_ID,
		openContext: { source: "user" },
	});

	controller.closeAll();

	assert.deepEqual(counts(), { files: 0, boards: 0, ports: 0, apps: 0 });
	assert.equal(controller.currentRef(), null);
});

test("route hydration adopts each preview kind without writing the URL back", async () => {
	for (const ref of [
		{ kind: "file", key: "docs/a.md" },
		{ kind: "board", key: "plans/main.board" },
		{ kind: "port", key: "5173" },
		{ kind: "app", key: WORK_ID },
	] as const) {
		const { controller, urls, appInvocations } = createHarness();
		const result = controller.applyRoute(ref);
		// File and Board open asynchronously; let their domain tab land.
		await Promise.resolve();

		assert.equal(result.ok, true);
		assert.deepEqual(controller.currentRef(), ref);
		assert.equal(urls.length, 0);
		if (ref.kind === "app") {
			assert.deepEqual(appInvocations, [{ source: "route" }]);
		}
	}
});

test("a context teardown never writes the URL of the route it is leaving for", async () => {
	const { controller, urls } = createHarness();
	await controller.openFile("docs/a.md");
	controller.openPort("5173", "http://x");
	controller.openApp({
		appId: WORK_ID,
		openContext: { source: "user" },
	});
	const writesBefore = urls.length;

	// Leaving a Space/FS context: the new route is already in the address bar, so
	// closing the outgoing previews must not sync a URL of its own.
	controller.resetForContext(() => {
		controller.tabClosed("app", WORK_ID);
		controller.tabClosed("port", "5173");
		controller.tabClosed("file", "docs/a.md");
	});

	assert.equal(urls.length, writesBefore, "teardown must not sync any URL");
});

test("the route that follows a context teardown survives", async () => {
	const { controller, urls } = createHarness();
	controller.openApp({
		appId: WORK_ID,
		openContext: { source: "user" },
	});
	const writesBefore = urls.length;

	// Full sequence of a Space switch: tear the old context down, then hydrate the
	// preview the new URL asked for.
	controller.resetForContext(() => {
		controller.tabClosed("app", WORK_ID);
	});
	const result = controller.applyRoute({ kind: "file", key: "README.md" });
	await Promise.resolve();

	assert.equal(result.ok, true);
	assert.deepEqual(controller.currentRef(), { kind: "file", key: "README.md" });
	assert.deepEqual(
		urls.slice(writesBefore),
		[],
		"neither the discarded context nor route hydration may write the URL",
	);
});

test("context teardown runs through the coordinator, not the page", () => {
	const page = readFileSync(
		new URL("../lib/features/space/SpaceWorkspacePage.svelte", import.meta.url),
		"utf8",
	);

	// Both teardown paths (route context change, entering a Space) must close their
	// domains inside resetForContext, or a dying context writes over the new route.
	const teardowns = [...page.matchAll(/resetForContext\(\(\) => \{/g)];
	assert.equal(teardowns.length, 2);
	for (const match of teardowns) {
		const body = page.slice(match.index, match.index + 600);
		assert.match(body, /close(Board|Port|All)\(/);
	}
});

test("every domain reports closed tabs to the coordinator", () => {
	const features = new URL("../lib/features/space/", import.meta.url);
	const modules = new URL("modules/", features);
	const page = readFileSync(
		new URL("SpaceWorkspacePage.svelte", features),
		"utf8",
	);

	// A domain can close a tab without being asked — a file flushing its autosave
	// first, or a deleted path. Without a report the URL and panel keep pointing
	// at a surface that no longer exists.
	for (const [file, callback] of [
		["file-workspace-controller.svelte.ts", "onInlineFileClosed"],
		["board-window-controller.svelte.ts", "onBoardClosed"],
		["port-window-controller.svelte.ts", "onPortClosed"],
		["app-window-controller.svelte.ts", "onAppClosed"],
	] as const) {
		const source = readFileSync(new URL(file, modules), "utf8");
		assert.match(source, new RegExp(`options\\.${callback}\\?\\.\\(`));
		assert.match(page, new RegExp(`${callback}:[\\s\\S]{0,80}tabClosed\\(`));
	}
});

test("panels open only once their tab is the committed active surface", () => {
	const modules = new URL("../lib/features/space/modules/", import.meta.url);
	const board = readFileSync(
		new URL("board-window-controller.svelte.ts", modules),
		"utf8",
	);
	const port = readFileSync(
		new URL("port-window-controller.svelte.ts", modules),
		"utf8",
	);
	const app = readFileSync(
		new URL("app-window-controller.svelte.ts", modules),
		"utf8",
	);

	// Same failure mode for every domain: opening the panel before the tab and
	// the active key are committed paints a preview stage with nothing in it.
	for (const [source, activeAssignment] of [
		[board, "activeBoardPath = path"],
		[port, "activePort = port"],
		[app, "activeKey = key"],
	] as const) {
		const activeAt = source.indexOf(activeAssignment);
		const openPanelAt = source.indexOf("options.onOpenPanel?.()");
		assert.ok(activeAt > 0, `missing active assignment: ${activeAssignment}`);
		assert.ok(openPanelAt > 0, "missing onOpenPanel call");
		assert.ok(
			activeAt < openPanelAt,
			`onOpenPanel must follow ${activeAssignment}`,
		);
	}
});

test("workspace App tabs keep recent surfaces mounted while inactive", () => {
	const domain = readFileSync(
		new URL(
			"../lib/features/space/modules/SpaceFileDomain.svelte",
			import.meta.url,
		),
		"utf8",
	);
	const window = readFileSync(
		new URL("../lib/features/space/modules/AppWindow.svelte", import.meta.url),
		"utf8",
	);

	assert.match(domain, /\{#each retainedAppTabs as tab \(tab\.id\)\}/);
	assert.match(domain, /active=\{isActiveApp\}/);
	// Only the visible tab mounts the shared header; background tabs must not
	// render duplicate chrome.
	assert.match(window, /\{#if active\}\s*<PreviewHeader/);
	assert.equal(window.match(/<PreviewHeader/g)?.length, 1);
});

test("a file window deep link restores the App with its file", () => {
	const { controller, appInvocations } = createHarness();
	controller.applyRoute({ kind: "app", key: `${APP_A}:plans/a.board` });
	assert.deepEqual(appInvocations.at(-1), {
		source: "route",
		file: { path: "plans/a.board" },
	});
	assert.deepEqual(controller.currentRef(), {
		kind: "app",
		key: `${APP_A}:plans/a.board`,
	});
});

test("a renamed active file window stays active and rewrites the URL", async () => {
	const { controller, urls, renameApp } = createHarness();
	await controller.openFile("docs/a.md");
	controller.openApp({
		appId: APP_A,
		openContext: { source: "user", file: { path: "plans/a.board" } },
	});
	const from = `${APP_A}:plans/a.board`;
	const to = `${APP_A}:archive/a.board`;
	renameApp(from, to);
	controller.renameTab("app", from, to);
	assert.deepEqual(urls.at(-1), { kind: "app", key: to });
	assert.deepEqual(
		controller.currentRef(),
		{ kind: "app", key: to },
		"the older file tab must not take over",
	);
});
