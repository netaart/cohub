<script lang="ts">
import type { AppRecord } from "@neta-art/cohub";
import { appDisplayTitle } from "$lib/app-page-meta";
import AppIcon from "$lib/components/app/AppIcon.svelte";
import {
	type PointerDragPayload,
	pointerDragSource,
} from "$lib/drag/pointer-drag.svelte";

const {
	app,
	href,
	active = false,
	isMobile = false,
	getPayload,
	onDragStart,
	onNavigate,
}: {
	app: AppRecord;
	href: string;
	active?: boolean;
	isMobile?: boolean;
	getPayload: () => PointerDragPayload | null;
	onDragStart?: (event: DragEvent, app: AppRecord) => void;
	onNavigate: (appId: string) => void;
} = $props();

const title = $derived(appDisplayTitle(app.meta, app.slug));
</script>

<a
	{href}
	draggable={!isMobile}
	use:pointerDragSource={{ enabled: isMobile, getPayload }}
	ondragstart={(event) => onDragStart?.(event, app)}
	class="sidebar-flyout-item flex min-w-0 items-center gap-2 rounded-[var(--sidebar-item-radius)] px-1.5 py-1.5 text-[13px] transition-colors duration-100 {active ? 'bg-[var(--sidebar-item-active-bg)] font-medium text-[var(--sidebar-item-active-fg)]' : 'text-text-tertiary hover:bg-[var(--sidebar-item-hover-bg)] hover:text-text-secondary'}"
	onclick={(event) => {
		event.preventDefault();
		onNavigate(app.id);
	}}
	title={title}
>
	<!-- The icon spans both text lines: 16px title + 12px slug = 28px (`md`). -->
	<AppIcon meta={app.meta} slug={app.slug} size="md" />
	<span class="min-w-0 flex-1">
		<span class="block truncate leading-4">{title}</span>
		<span class="block truncate font-mono text-[10px] font-normal leading-3 text-text-placeholder">{app.slug}</span>
	</span>
</a>
