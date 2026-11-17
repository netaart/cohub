<script lang="ts">
import type { SpacePortStatus } from "@cohub/protocol/ports";
import PortPreview from "#lib/components/PortPreview.svelte";
import type { PreviewChrome } from "./preview-header.ts";
import type { Window } from "./windows.ts";

type Props = {
	windows: Window[];
	port: string;
	url: string;
	status: SpacePortStatus | "unknown";
	observedAt?: number;
	chrome: PreviewChrome;
	isMobile: boolean;
	onPublish: () => void;
	onActivateWindow: (kind: Window["kind"], key: string) => void;
	onCloseWindow: (kind: Window["kind"], key: string) => void;
};

let {
	windows,
	port,
	url,
	status,
	observedAt,
	chrome,
	isMobile,
	onPublish,
	onActivateWindow,
	onCloseWindow,
}: Props = $props();
</script>

<div class="flex h-full min-w-0 flex-col bg-bg-content">
	<PortPreview
		{port}
		{url}
		{status}
		{observedAt}
		{windows}
		{chrome}
		{isMobile}
		onActivateWindow={onActivateWindow}
		onCloseWindow={onCloseWindow}
		{onPublish}
	/>
</div>
