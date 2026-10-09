import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AppMarketplaceCatalogSchema,
	InstalledAppSourceSchema,
	installedFileHandler,
	marketplaceEntryToInstalledApp,
	parseCanonicalAppRef,
	SpaceInstalledAppsSchema,
	setInstalledAppEnabled,
	setInstalledFileHandler,
	unclaimedFileHandlers,
} from "./src/app-catalog.js";

test("canonical app refs use username/space/app without the public route marker", () => {
	assert.equal(parseCanonicalAppRef("Alice/studio/notes"), "alice/studio/notes");
	assert.equal(parseCanonicalAppRef("alice/studio/w/notes"), null);
	assert.equal(parseCanonicalAppRef("alice/studio"), null);
});

test("marketplace entries omit optional metadata when it was not declared", () => {
	const catalog = AppMarketplaceCatalogSchema.parse({
		format: "cohub.app-marketplace",
		version: 1,
		apps: [{
			id: "00000000-0000-4000-8000-000000000001",
			ref: "alice/studio/notes",
			name: "Notes",
			url: "https://apps.example.test/notes",
		}],
	});
	const [entry] = catalog.apps;
	assert.ok(entry);
	const installed = marketplaceEntryToInstalledApp(entry);
	assert.equal(installed.id, "00000000-0000-4000-8000-000000000001");
	assert.equal(installed.ref, "alice/studio/notes");
	assert.deepEqual(installed.snapshot, { name: "Notes" });
	assert.deepEqual(installed.source, {
		type: "marketplace",
		catalog: "cohub",
		appId: "00000000-0000-4000-8000-000000000001",
	});
});

test("custom catalogs can be retained as a source without changing the app id", () => {
	assert.deepEqual(
		InstalledAppSourceSchema.parse({
			type: "marketplace",
			catalog: "https://example.test/apps.json",
			appId: "custom-notes",
		}),
		{
			type: "marketplace",
			catalog: "https://example.test/apps.json",
			appId: "custom-notes",
		},
	);
});

const installedApp = (id: string, fields: Record<string, unknown> = {}) => ({
	id,
	ref: `alice/studio/${id.slice(-4)}`,
	url: "https://apps.example.test/app",
	enabled: true,
	source: { type: "url", url: "https://apps.example.test/app" },
	snapshot: { name: id },
	installedAt: "2026-09-24T00:00:00.000Z",
	...fields,
});
const BOARD = "00000000-0000-4000-8000-00000000b0a1";
const NOTES = "00000000-0000-4000-8000-00000000a0e5";

test("installed Apps keep fields this version does not know, and normalize opens", () => {
	const parsed = SpaceInstalledAppsSchema.parse({
		format: "cohub.space-apps",
		version: 1,
		future: { kept: true },
		apps: [installedApp(BOARD, { opens: ["Board", "nope!", 7, ...Array.from({ length: 40 }, (_, i) => `.x${i}`)], pinned: true, snapshot: { name: "Board", banner: "x" } })],
	});
	assert.deepEqual((parsed as Record<string, unknown>).future, { kept: true });
	const [app] = parsed.apps;
	assert.ok(app);
	assert.equal(app.opens?.[0], ".board");
	assert.equal(app.opens?.length, 32);
	const odd = SpaceInstalledAppsSchema.parse({
		format: "cohub.space-apps",
		version: 1,
		apps: [installedApp(BOARD, { opens: ".board" }), installedApp(NOTES, { opens: { x: 1 } })],
	});
	assert.deepEqual(odd.apps.map((entry) => entry.opens), [[".board"], []]);
	assert.equal((app as Record<string, unknown>).pinned, true);
	assert.equal((app.snapshot as Record<string, unknown>).banner, "x");
});

test("each extension opens with at most one installed App", () => {
	const document = SpaceInstalledAppsSchema.parse({
		format: "cohub.space-apps",
		version: 1,
		apps: [installedApp(BOARD, { opens: [".board", ".md"] }), installedApp(NOTES)],
	});
	assert.equal(installedFileHandler(document, "plans/a.board")?.id, BOARD);
	assert.equal(installedFileHandler(document, "plans/a.txt"), null);

	const moved = setInstalledFileHandler(document, ".md", NOTES);
	assert.deepEqual(moved.apps.map((app) => app.opens), [[".board"], [".md"]]);
	const builtIn = setInstalledFileHandler(moved, ".board", null);
	assert.equal("opens" in (builtIn.apps[0] ?? {}), false, "an App left with nothing drops the field");
	assert.equal(installedFileHandler(builtIn, "a.board"), null);
});

test("a disabled App keeps its record but neither opens nor holds an extension", () => {
	const document = SpaceInstalledAppsSchema.parse({
		format: "cohub.space-apps",
		version: 1,
		apps: [installedApp(BOARD, { opens: [".board"], enabled: false })],
	});
	assert.equal(installedFileHandler(document, "a.board"), null);
	assert.deepEqual(unclaimedFileHandlers(document, [".board", ".md"]), [".board", ".md"]);
	assert.deepEqual(document.apps[0]?.opens, [".board"], "the record keeps it");
});

test("re-enabling an App never takes back an extension another App took over", () => {
	const document = SpaceInstalledAppsSchema.parse({
		format: "cohub.space-apps",
		version: 1,
		apps: [
			installedApp(BOARD, { opens: [".board", ".md"], enabled: false }),
			installedApp(NOTES, { opens: [".md"] }),
		],
	});
	const enabled = setInstalledAppEnabled(document, BOARD, true);
	assert.deepEqual(enabled.apps.map((app) => [app.enabled, app.opens]), [
		[true, [".board"]],
		[true, [".md"]],
	]);
	assert.equal(installedFileHandler(enabled, "a.md")?.id, NOTES);
	const disabled = setInstalledAppEnabled(enabled, NOTES, false);
	assert.deepEqual(disabled.apps[1]?.opens, [".md"], "disabling keeps the record");
});
