<script lang="ts">
import { untrack } from "svelte";
import ContextMenu from "#lib/components/context-menu/ContextMenu.svelte";
import {
	type ContextMenuRequest,
	contextMenu,
	readContextMenu,
} from "#lib/context-menu/context-menu.svelte.ts";
import { afterNavigate } from "$app/navigation";

const request = $derived(contextMenu.current);
const content = $derived(
	request ? readContextMenu(request.source, request.target) : null,
);

let last: {
	request: ContextMenuRequest;
	content: NonNullable<typeof content>;
} | null = null;
const shown = $derived.by(() => {
	if (request && content) last = { request, content };
	return last;
});

$effect(() => {
	if (request && !content) untrack(() => contextMenu.close());
});

afterNavigate(() => contextMenu.close());
</script>

<ContextMenu
	open={content !== null}
	anchor={shown?.request.target}
	point={shown?.request.point}
	sheet={shown?.request.sheet}
	title={shown?.content.title}
	items={shown?.content.items ?? []}
	onClose={() => contextMenu.close()}
/>
