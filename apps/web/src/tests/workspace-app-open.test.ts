import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppMeta } from "@neta-art/cohub";
import type { WorkspaceAppOpenContext } from "#lib/features/space/modules/workspace-app-context.ts";
import {
	openPublishedApp,
	type PublishedAppOpenPorts,
} from "#lib/features/space/modules/workspace-app-open.ts";

const OPEN = {
	appId: "app-1",
	label: "Mascot",
	openContext: { source: "user" } satisfies WorkspaceAppOpenContext,
};

function recordingPorts(options?: {
	overlay?: "opened" | "activated" | "limit";
	loadMeta?: PublishedAppOpenPorts["loadMeta"];
}): PublishedAppOpenPorts & {
	windows: unknown[];
	overlays: unknown[];
	loads: string[];
} {
	const windows: unknown[] = [];
	const overlays: unknown[] = [];
	const loads: string[] = [];
	const loadMeta = options?.loadMeta;
	return {
		windows,
		overlays,
		loads,
		spaceId: "space-1",
		loadMeta: loadMeta
			? async (appId) => {
					loads.push(appId);
					return loadMeta(appId);
				}
			: undefined,
		openWindow: (input) => {
			windows.push(input);
		},
		openOverlay: (input) => {
			overlays.push(input);
			return options?.overlay ?? "opened";
		},
	};
}

function overlayMeta(): AppMeta {
	return { presentation: { surface: "overlay" } };
}

test("an explicit overlay request opens an overlay and does not look up meta", async () => {
	const ports = recordingPorts({
		loadMeta: async () => overlayMeta(),
	});
	const result = await openPublishedApp({ ...OPEN, surface: "overlay" }, ports);
	assert.deepEqual(result, { ok: true, surface: "overlay" });
	assert.equal(ports.overlays.length, 1);
	assert.equal(ports.windows.length, 0);
	assert.deepEqual(ports.loads, []);
});

test("an explicit window request wins over a declared overlay", async () => {
	const ports = recordingPorts();
	const result = await openPublishedApp(
		{ ...OPEN, surface: "window", meta: overlayMeta() },
		ports,
	);
	assert.deepEqual(result, { ok: true, surface: "window" });
	assert.equal(ports.windows.length, 1);
	assert.equal(ports.overlays.length, 0);
});

test("a published overlay declaration opens as an overlay", async () => {
	const ports = recordingPorts();
	const result = await openPublishedApp(
		{ ...OPEN, meta: overlayMeta() },
		ports,
	);
	assert.deepEqual(result, { ok: true, surface: "overlay" });
	const overlay = ports.overlays[0] as {
		invocation: { surface: string; source: string; spaceId: string };
	};
	assert.equal(overlay.invocation.surface, "overlay");
	assert.equal(overlay.invocation.source, "user");
	assert.equal(overlay.invocation.spaceId, "space-1");
});

test("known window meta, or no declaration, opens as a tab without fetching", async () => {
	const ports = recordingPorts({
		loadMeta: async () => overlayMeta(),
	});
	assert.deepEqual(
		await openPublishedApp(
			{ ...OPEN, meta: { presentation: { surface: "window" } } },
			ports,
		),
		{ ok: true, surface: "window" },
	);
	assert.deepEqual(await openPublishedApp({ ...OPEN, meta: null }, ports), {
		ok: true,
		surface: "window",
	});
	assert.deepEqual(ports.loads, []);
	assert.equal(ports.overlays.length, 0);
	assert.equal(ports.windows.length, 2);
});

test("missing meta loads the published declaration before choosing a surface", async () => {
	const ports = recordingPorts({
		loadMeta: async () => overlayMeta(),
	});
	const result = await openPublishedApp(OPEN, ports);
	assert.deepEqual(result, { ok: true, surface: "overlay" });
	assert.deepEqual(ports.loads, ["app-1"]);
	assert.equal(ports.overlays.length, 1);
});

test("a failed meta lookup falls back to a window", async () => {
	const ports = recordingPorts({
		loadMeta: async () => {
			throw new Error("denied");
		},
	});
	const result = await openPublishedApp(OPEN, ports);
	assert.deepEqual(result, { ok: true, surface: "window" });
	assert.equal(ports.windows.length, 1);
	assert.equal(ports.overlays.length, 0);
});

test("hitting the overlay cap does not fall back to a window", async () => {
	const ports = recordingPorts({ overlay: "limit" });
	const result = await openPublishedApp(
		{ ...OPEN, meta: overlayMeta() },
		ports,
	);
	assert.deepEqual(result, { ok: false, reason: "overlay_limit" });
	assert.equal(ports.windows.length, 0);
});
