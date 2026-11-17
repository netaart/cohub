import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAppNavigationOpenMessage } from "@cohub/protocol/app-navigation";
import type { AppDetailResponse } from "@neta-art/cohub";

(globalThis as unknown as { $state: <T>(value: T) => T }).$state = <T>(
	value: T,
) => value;

const { createAppNavigator } = await import(
	"#lib/features/app/app-navigator.ts"
);
const { createAppSurfaceRegistry } = await import(
	"#lib/features/app/surface-registry.ts"
);
const { createAppPreviewController } = await import(
	"#lib/features/space/modules/app-window-controller.svelte.ts"
);

test("the same App launch reopens a closed tab and reuses an existing tab", async () => {
	const appId = "11111111-1111-4111-8111-111111111111";
	const detail = {
		app: { id: appId, slug: "example", status: "published", meta: null },
		content: { kind: "web", url: "https://apps.test/example" },
	} as unknown as AppDetailResponse;
	const message = () =>
		buildAppNavigationOpenMessage({
			requestId: crypto.randomUUID(),
			target: { kind: "app", ref: appId, launch: { hash: "#document=1" } },
		});
	const tabs = createAppPreviewController({
		getSpaceId: () => "space",
		surfaces: createAppSurfaceRegistry(),
		loadApp: async () => detail,
	});
	const navigator = createAppNavigator({
		getContext: () => "space",
		resolve: async (target) => ({ detail, launch: target.launch }),
		open: async ({ launch }) => {
			tabs.openApp({ appId, launch, openContext: { source: "user" } });
			return { handled: true };
		},
	});
	await navigator.open(message());
	const first = tabs.previews[0].id;
	await navigator.open(message());
	assert.equal(tabs.previews.length, 1);
	assert.equal(tabs.previews[0].id, first);
	tabs.closeApp(appId);
	assert.equal(tabs.previews.length, 0);
	await navigator.open(message());
	assert.equal(tabs.activeKey, appId);
	assert.notEqual(tabs.previews[0].id, first);
	assert.equal(tabs.previews[0].launch?.hash, "#document=1");
	tabs.dispose();
});
