<script lang="ts">
import type { InstalledApp } from "@cohub/protocol";
import type { AppRecord } from "@neta-art/cohub";
import { appDisplayTitle, appIconUrl } from "$lib/app-page-meta";
import { boardAppCover } from "$lib/board/board-app";
import AppIcon from "$lib/components/app/AppIcon.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { buildSpaceAppRoute } from "$lib/space-routes";
import type { SpaceAppsFeed } from "../resources/space-apps-feed.svelte";
import InstalledAppsList from "./InstalledAppsList.svelte";
import LoadError from "./LoadError.svelte";
import SidePanelRow from "./SidePanelRow.svelte";
import SidePanelSection from "./SidePanelSection.svelte";
import { createSectionState } from "./side-panel-sections.svelte";

type Props = {
	spaceId: string;
	feed: SpaceAppsFeed | null;
	activeAppId: string | null;
	canWrite: boolean;
	draggable: boolean;
	touchDraggable: boolean;
	onOpenApp: (appId: string) => void;
	onOpenMarketplace: () => void;
	onOpenInstalled: (app: InstalledApp) => void;
};

const {
	spaceId,
	feed,
	activeAppId,
	canWrite,
	draggable,
	touchDraggable,
	onOpenApp,
	onOpenMarketplace,
	onOpenInstalled,
}: Props = $props();

const locale = $derived(getLocale());
const sections = createSectionState("cohub:side-panel:apps-sections:v1", [
	"published",
	"installed",
]);
const apps = $derived(feed?.items ?? []);

function drag(app: AppRecord) {
	if (!draggable && !touchDraggable) return null;
	const title = appDisplayTitle(app.meta, app.slug);
	const href = buildSpaceAppRoute(spaceId, app.id);
	const icon = appIconUrl(app.meta);
	const visual = { ...(icon ? { icon } : {}), ...boardAppCover(app.meta) };
	return {
		resource: {
			type: "app" as const,
			ref: app.slug,
			appId: app.id,
			title,
			href,
			...visual,
		},
		item: {
			type: "app" as const,
			path: "",
			name: title,
			appId: app.id,
			appRef: app.slug,
			appUrl: href,
			...visual,
		},
		touch: touchDraggable,
	};
}
</script>

<div class="h-full min-h-0 overflow-y-auto px-1.5 pb-3 pt-1" data-pointer-drag-autoscroll>
	<SidePanelSection
		title={m.apps_panel_published({}, { locale })}
		count={apps.length}
		collapsed={sections.collapsed.published}
		onToggle={() => sections.toggle("published")}
	>
		{#if feed && !feed.ready}
			<div class="space-y-1 px-1.5 py-1" aria-hidden="true">
				{#each [1, 2] as item (item)}
					<div class="flex h-9 items-center gap-2">
						<div class="h-7 w-7 animate-pulse rounded-[8px] bg-bg-elevated"></div>
						<div class="h-2.5 w-1/2 animate-pulse rounded bg-bg-elevated"></div>
					</div>
				{/each}
			</div>
		{:else if feed?.failed && apps.length === 0}
			<div class="px-1.5 pb-1">
				<LoadError message={m.apps_panel_load_failed({}, { locale })} onRetry={() => void feed.refresh()} />
			</div>
		{:else if apps.length === 0}
			<p class="px-1.5 py-1.5 text-[12px] leading-[18px] text-text-tertiary">{m.apps_panel_published_empty({}, { locale })}</p>
		{:else}
			<div role="list">
				{#each apps as app (app.id)}
					<SidePanelRow
						title={appDisplayTitle(app.meta, app.slug)}
						subtitle={app.slug}
						active={app.id === activeAppId}
						drag={drag(app)}
						onOpen={() => onOpenApp(app.id)}
					>
						{#snippet leading()}
							<AppIcon meta={app.meta} slug={app.slug} seed={app.id} size="sm" />
						{/snippet}
					</SidePanelRow>
				{/each}
			</div>
		{/if}
	</SidePanelSection>

	<div class="mt-2">
		<InstalledAppsList
			{spaceId}
			{canWrite}
			{draggable}
			{touchDraggable}
			collapsed={sections.collapsed.installed}
			onToggle={() => sections.toggle("installed")}
			{onOpenMarketplace}
			{onOpenInstalled}
		/>
	</div>
</div>
