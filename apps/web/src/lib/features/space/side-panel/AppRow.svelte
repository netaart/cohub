<script lang="ts">
import type { AppRecord } from "@neta-art/cohub";
import { ExternalLink, Settings2 } from "lucide-svelte";
import { appDisplayTitle, appIconUrl } from "#lib/app-page-meta.ts";
import { boardAppCover } from "#lib/board/board-app.ts";
import AppIcon from "#lib/components/app/AppIcon.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import { buildSpaceAppRoute } from "#lib/space-routes.ts";
import type { WorkspaceAppLaunch } from "../modules/workspace-app-open.ts";
import SidePanelRow from "./SidePanelRow.svelte";
import SidePanelRowAction from "./SidePanelRowAction.svelte";

type Props = {
	spaceId: string;
	app: AppRecord;
	active?: boolean;
	draggable?: boolean;
	touchDraggable?: boolean;
	publicHref?: string | null;
	onOpen: (app: WorkspaceAppLaunch) => void;
	onManage: () => void;
};

const {
	spaceId,
	app,
	active = false,
	draggable = false,
	touchDraggable = false,
	publicHref = null,
	onOpen,
	onManage,
}: Props = $props();

const locale = $derived(getLocale());
const published = $derived(app.status === "published");
const title = $derived(appDisplayTitle(app.meta, app.slug));
const drag = $derived.by(() => {
	if (!draggable && !touchDraggable) return null;
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
});
</script>

<SidePanelRow {title} subtitle={app.slug} {active} dimmed={!published} {drag} onOpen={published ? () => onOpen({ appId: app.id, name: title, meta: app.meta }) : onManage}>
	{#snippet leading()}
		<AppIcon meta={app.meta} slug={app.slug} seed={app.id} size="sm" />
	{/snippet}
	{#snippet trailing()}
		{#if publicHref}
			<SidePanelRowAction icon={ExternalLink} label={m.window_open_in_new_tab({}, { locale })} itemName={title} href={publicHref} />
		{/if}
		<SidePanelRowAction icon={Settings2} label={m.apps_panel_manage({}, { locale })} itemName={title} onclick={onManage} />
	{/snippet}
</SidePanelRow>
