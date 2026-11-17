<script lang="ts">
import { untrack } from "svelte";
import { useSpaceTheme } from "#lib/custom-theme/page-space.svelte.ts";
import SpaceWorkspacePage from "#lib/features/space/SpaceWorkspacePage.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { useCompactShell } from "#lib/layout/compact-shell.svelte.ts";
import {
	type LibraryItemEntity,
	libraryEntityAt,
	librarySpaceAt,
} from "#lib/library-routes.ts";
import { m } from "#lib/paraglide/messages.js";
import { uiState } from "#lib/stores/ui.svelte.ts";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import LibraryList from "./LibraryList.svelte";
import { libraryEntityLabel } from "./library-copy.ts";
import { libraryWorkspaceScope } from "./library-workspace-scope.ts";

const locale = $derived(getLocale());
const isDesktop = $derived(!useCompactShell());
const entity = $derived(
	(libraryEntityAt(page.url.pathname) ?? "apps") as LibraryItemEntity,
);
// `space` survives the workspace's own window changes, unlike `resource`.
const spaceId = $derived(librarySpaceAt(page.url));
const workspaceData = $derived(
	isDesktop && spaceId
		? { spaceId, view: "session" as const, sessionId: "new" }
		: null,
);
useSpaceTheme(() => workspaceData?.spaceId ?? null);

$effect(() => {
	const target = !isDesktop ? spaceId : null;
	if (!target) return;
	untrack(() => {
		const search = new URLSearchParams(page.url.search);
		search.delete("space");
		void goto(`/spaces/${target}?${search}`, { replace: true });
	});
});
</script>

<svelte:head>
	{#if !workspaceData}<title>{libraryEntityLabel(entity, locale)} · Cohub</title>{/if}
</svelte:head>

{#if workspaceData}
	<SpaceWorkspacePage data={workspaceData} scope={libraryWorkspaceScope} />
{:else if !isDesktop || uiState.leftSidebarCollapsed}
	<div class="h-full min-h-0 w-full overflow-hidden bg-bg-primary">
		<LibraryList {entity} variant="page" />
	</div>
{:else}
	<div class="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-chat-bg px-6 text-center">
		<p class="text-[14px] text-text-secondary">
			{entity === "apps" ? m.library_select_app({}, { locale }) : m.library_select_cron({}, { locale })}
		</p>
		<p class="text-[12px] text-text-placeholder">{m.library_select_hint({}, { locale })}</p>
	</div>
{/if}
