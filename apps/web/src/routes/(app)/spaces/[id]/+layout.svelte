<script lang="ts">
/**
 * Keep the Space workspace mounted across all main-panel routes.
 * Child pages provide route data; this shell owns long-lived preview runtimes.
 */
import { type Snippet, untrack } from "svelte";
import { goto, replaceState } from "$app/navigation";
import { page } from "$app/state";
import type { WindowKind } from "$lib/features/space/modules/window-route";
import SpaceWorkspacePage from "$lib/features/space/SpaceWorkspacePage.svelte";
import { canonicalSpaceLocation } from "$lib/stores/space-address";

type WorkspaceRouteData = {
	spaceId: string;
	view:
		| "space"
		| "session"
		| "checkpoint"
		| "checkpoint-new"
		| "cronjob"
		| "cronjob-new"
		| "app"
		| "task";
	sessionId: string | null;
	filePath: string | null;
	windowKind: WindowKind | null;
	windowKey: string | null;
	checkpointId: string | null;
	cronjobId: string | null;
	appId: string | null;
	taskId: string | null;
	turnSequence: string | null;
};

const WORKSPACE_VIEWS = new Set<WorkspaceRouteData["view"]>([
	"space",
	"session",
	"checkpoint",
	"checkpoint-new",
	"cronjob",
	"cronjob-new",
	"app",
	"task",
]);

let { children }: { children: Snippet } = $props();

const workspaceData = $derived.by(() => {
	const data = page.data as Partial<WorkspaceRouteData>;
	if (!data.view || !WORKSPACE_VIEWS.has(data.view)) return null;
	return {
		spaceId: data.spaceId as string,
		view: data.view,
		sessionId: data.sessionId ?? null,
		filePath: data.filePath ?? null,
		windowKind: data.windowKind ?? null,
		windowKey: data.windowKey ?? null,
		checkpointId: data.checkpointId ?? null,
		cronjobId: data.cronjobId ?? null,
		appId: data.appId ?? null,
		taskId: data.taskId ?? null,
		turnSequence: data.turnSequence ?? null,
	} satisfies WorkspaceRouteData;
});

// Show the Space's current friendly address. A shallow replace keeps `page.url`
// and history state on the route URL, so back/forward never re-resolve an address.
$effect(() => {
	const spaceId = page.params.id;
	void page.url;
	if (!spaceId) return;
	const next = canonicalSpaceLocation(window.location, spaceId);
	if (!next) return;
	if ("replace" in next)
		replaceState(
			next.replace,
			untrack(() => page.state),
		);
	else
		void goto(next.navigate, {
			replaceState: true,
			noScroll: true,
			keepFocus: true,
		});
});
</script>

{#if workspaceData}
	<SpaceWorkspacePage data={workspaceData} />
{/if}
{@render children()}
