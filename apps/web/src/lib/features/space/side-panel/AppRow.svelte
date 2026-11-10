<script lang="ts">
import type { AppRecord } from "@neta-art/cohub";
import { appDisplayTitle, appIconUrl } from "$lib/app-page-meta";
import { boardAppCover } from "$lib/board/board-app";
import AppIcon from "$lib/components/app/AppIcon.svelte";
import { buildSpaceAppRoute } from "$lib/space-routes";
import SidePanelRow from "./SidePanelRow.svelte";

type Props = {
	spaceId: string;
	app: AppRecord;
	active?: boolean;
	draggable?: boolean;
	touchDraggable?: boolean;
	onOpen: () => void;
};

const {
	spaceId,
	app,
	active = false,
	draggable = false,
	touchDraggable = false,
	onOpen,
}: Props = $props();

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

<SidePanelRow {title} subtitle={app.slug} {active} {drag} {onOpen}>
	{#snippet leading()}
		<AppIcon meta={app.meta} slug={app.slug} seed={app.id} size="sm" />
	{/snippet}
</SidePanelRow>
