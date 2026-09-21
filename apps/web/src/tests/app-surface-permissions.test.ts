import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
	new URL("../lib/components/app/AppSurface.svelte", import.meta.url),
	"utf8",
);
const previewSource = readFileSync(
	new URL("../lib/features/space/modules/AppWindow.svelte", import.meta.url),
	"utf8",
);
const appControllerSource = readFileSync(
	new URL(
		"../lib/features/space/modules/app-window-controller.svelte.ts",
		import.meta.url,
	),
	"utf8",
);
const backgroundSource = readFileSync(
	new URL("../lib/components/NewChatBackground.svelte", import.meta.url),
	"utf8",
);
const workBackgroundSource = readFileSync(
	new URL("../lib/components/NewChatAppBackground.svelte", import.meta.url),
	"utf8",
);
const sessionPanelSource = readFileSync(
	new URL(
		"../lib/features/session-chat/SessionChatPanel.svelte",
		import.meta.url,
	),
	"utf8",
);
const workspaceSource = readFileSync(
	new URL("../lib/features/space/SpaceWorkspacePage.svelte", import.meta.url),
	"utf8",
);

test("composer context alone enables the App Surface message host", () => {
	assert.match(
		source,
		/onSurfaceHost \|\| onComposerChip\s*\? createAppSurfaceHost/,
	);
});

test("runtime context waits for the embedded document handshake", () => {
	assert.match(source, /let runtimeReady = \$state\(false\)/);
	assert.match(
		source,
		/if \(!runtimeReady\) return;\s+postFrameMessage\(payload\)/,
	);
	assert.match(source, /parseAppRuntimeReady\(event\.data\)/);
	assert.match(
		source,
		/runtimeReady = false;\s+surfaceHost\?\.reset\(\);\s+reportReady\(\);/,
	);
});

test("frame messages require a resolved embedded origin", () => {
	assert.match(
		source,
		/function postFrameMessage[\s\S]*?if \(!frameOrigin\) return/,
	);
});

test("all App frames delegate low-risk user-activated capabilities", () => {
	assert.match(
		source,
		/const framePermissions\s*=\s*"clipboard-read; clipboard-write; fullscreen; web-share"/,
	);
	assert.match(source, /<iframe[\s\S]*?allow=\{framePermissions\}/);
});

test("background App frames still exclude pointer lock", () => {
	assert.match(
		source,
		/allow-modals\$\{isBackground \? "" : " allow-pointer-lock"\}/,
	);
});

test("a reopened App preview remounts its surface lifecycle", () => {
	assert.match(previewSource, /\{#key preview\.mountKey\}/);
});

test("App authorization receives the mounted surface mode", () => {
	assert.match(source, /authorizationContext: \{ surface: mode \}/);
});

test("Workspace App tabs require a complete invocation context", () => {
	assert.match(appControllerSource, /openContext: WorkspaceAppOpenContext/);
	assert.match(
		appControllerSource,
		/createWorkspaceAppInvocation\(\s*options\.getSpaceId\(\),\s*input\.openContext/,
	);
	assert.match(previewSource, /invocation=\{preview\.invocation\}/);
	assert.match(
		workspaceSource,
		/onPreviewApp=\{\(app\) =>[\s\S]*?openContext: \{ source: "user" \}/,
	);
});

test("user-initiated App opens go through the published-app dispatcher", () => {
	assert.match(workspaceSource, /function openWorkspaceApp\(/);
	assert.match(
		workspaceSource,
		/onPreviewApp=\{\(app\) =>[\s\S]*?openWorkspaceApp\(/,
	);
	assert.match(
		workspaceSource,
		/onOpenMarketplace: \(\) =>[\s\S]*?openWorkspaceApp\(/,
	);
	assert.match(
		workspaceSource,
		/onOpenInstalledApp: \(app\) =>[\s\S]*?openWorkspaceApp\(/,
	);
	assert.match(
		workspaceSource,
		/surface: command\.target\.surface === "overlay" \? "overlay" : "window"/,
	);
});

test("App previews pass invocation context through the runtime bridge", () => {
	assert.match(previewSource, /invocation=\{preview\.invocation\}/);
	assert.match(source, /createAppBridgeHost\(\{[\s\S]*?invocation,/);
	assert.match(
		workspaceSource,
		/openContext: WorkspaceAppOpenContext[\s\S]*?sessionId: context\.source\.sessionId/,
	);
});

test("New Chat App receives the hosting Space invocation and shell context", () => {
	assert.match(workBackgroundSource, /currentSpaceId\?: string \| null/);
	assert.match(
		workBackgroundSource,
		/invocation: \{[\s\S]*?surface: "background" as const,[\s\S]*?source: "route" as const,[\s\S]*?spaceId: currentSpaceId/,
	);
	assert.match(
		workBackgroundSource,
		/shell: \{[\s\S]*?surface: "background" as const,[\s\S]*?space: \{ id: currentSpaceId \},[\s\S]*?session: null,[\s\S]*?turn: null/,
	);
	assert.match(
		workBackgroundSource,
		/invocation=\{hostContext\?\.invocation\}/,
	);
	assert.match(workBackgroundSource, /shell=\{hostContext\?\.shell\}/);
	assert.match(backgroundSource, /currentSpaceId=\{spaceId\}/);
});

test("New Chat App composer context reaches the workspace coordinator", () => {
	assert.match(workBackgroundSource, /onComposerChip=\{\(chip\) =>/);
	assert.match(backgroundSource, /onComposerChip=\{onAppComposerChip\}/);
	assert.match(
		sessionPanelSource,
		/onAppComposerChip=\{onNewChatBackgroundComposerChip\}/,
	);
	assert.match(
		workspaceSource,
		/onNewChatBackgroundComposerChip=\{handleNewChatBackgroundComposerChip\}/,
	);
});

test("active previews take priority over background App context", () => {
	assert.match(
		workspaceSource,
		/if \(activeWindowKind\) \{[\s\S]{0,160}?reportActiveSource\(null\);[\s\S]{0,100}?if \(newChatBackgroundAppContext\)/,
	);
	assert.match(
		workspaceSource,
		/if \(!shouldShowNewChatBackground\) newChatBackgroundAppContext = null/,
	);
});

test("unregistering an App surface never reads the preview it is leaving", () => {
	// The surface reports `null` from its unmount cleanup, which runs while the
	// panel is being destroyed and `preview` is already gone. Reading the prop in
	// that callback faults and aborts the teardown, so the next open finds a
	// half-destroyed tree and paints an empty stage.
	assert.match(previewSource, /onSurfaceHost=\{handleSurfaceHost\}/);
	assert.match(previewSource, /onComposerChip=\{handleComposerChip\}/);
	assert.doesNotMatch(previewSource, /onSurfaceHost=\{\(host\) =>/);
	assert.doesNotMatch(previewSource, /onComposerChip=\{\(chip\) =>/);
	assert.match(previewSource, /let surfaceAppId: string | null = null/);
	assert.match(
		previewSource,
		/function handleSurfaceHost\([\s\S]{0,240}?if \(surfaceAppId\) onRegisterSurface\(surfaceAppId, host\)/,
	);
});

test("a surface releases its bridge even if the consumer's unregister throws", () => {
	// Otherwise one faulty listener leaks the frame's message bridge.
	assert.match(
		source,
		/try \{\s*onSurfaceHost\?\.\(null\);\s*\} finally \{\s*surfaceHost\?\.dispose\(\);\s*\}/,
	);
});

test("overlay surfaces render with their own mode class and forward configure requests", () => {
	assert.match(source, /<div class="app-surface \{mode\}">/);
	assert.match(source, /parseAppRuntimeConfigureRequest\(event\.data\)/);
	assert.match(source, /onConfigureRequest\?\.\(configure\)/);
	const layerHostSource = readFileSync(
		new URL(
			"../lib/features/space/modules/DesktopLayerHost.svelte",
			import.meta.url,
		),
		"utf8",
	);
	assert.match(layerHostSource, /mode="overlay"/);
	assert.match(
		layerHostSource,
		/onConfigureRequest=\{\(request\) => manager\.configure\(overlay\.appId, request\)\}/,
	);
});
