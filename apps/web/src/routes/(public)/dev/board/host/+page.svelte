<script lang="ts">
import { createBoardEditor } from "@neta-art/cohub/board/editor";
import {
	boardRenderTheme,
	createBoardCardRendererResolver,
} from "@neta-art/cohub/board/render";
import {
	createBoardAssetManager,
	mountBoardStage,
} from "@neta-art/cohub/board/stage";
import { onMount } from "svelte";
import {
	DEV_CARD,
	devCardRenderer,
	devHostDocument,
	devItemAsset,
	devRegistry,
	LIKE,
} from "./dev-host";

let host: HTMLDivElement;
let log = $state<string[]>([]);
const note = (line: string) => {
	log = [line, ...log].slice(0, 6);
};

onMount(() => {
	const editor = createBoardEditor({
		document: devHostDocument(),
		registry: devRegistry,
		key: "dev-host",
		onCommit() {},
	});
	const source = { resolveFileUrl: async () => null };
	const assets = createBoardAssetManager({
		...source,
		itemAsset: devItemAsset,
	});
	const theme = { key: "neta-pixel", ...boardRenderTheme("neta-pixel") };
	let fitted = false;
	const title = (id: string) =>
		(editor.itemById(id)?.props as { title?: string } | undefined)?.title ?? id;
	const stage = mountBoardStage(host, {
		editor,
		assets,
		source,
		theme: () => theme,
		renderers: createBoardCardRendererResolver([devCardRenderer]),
		onActivate: (item, { pointerType, selected }) => {
			if (selected && pointerType === "mouse") return;
			note(`open ${title(item.id)} (${pointerType})`);
		},
		onLongPress: (item, { pointerType }) => {
			if (item.type !== DEV_CARD || !editor.pickUp()) return;
			note(`pick up ${title(item.id)} (${pointerType})`);
		},
		onHit: (item, action) => {
			if (action !== LIKE) return false;
			const liked = !(item.props as { liked?: boolean }).liked;
			editor.commitPatch({ items: { [item.id]: { props: { liked } } } });
			note(`${liked ? "like" : "unlike"} ${title(item.id)}`);
			return true;
		},
		onSurfaceChange: () => {
			if (fitted) return;
			fitted = true;
			editor.fitView({ animate: false, maxZoom: 1 });
		},
	});
	return () => {
		stage.destroy();
		assets.destroy();
		editor.destroy();
	};
});
</script>

<div class="dev-host" bind:this={host}></div>
{#if log.length}
	<ol class="dev-log" aria-live="polite">
		{#each log as line, index (index)}<li>{line}</li>{/each}
	</ol>
{/if}

<style>
	.dev-host {
		position: fixed;
		inset: 0;
		background: #f6f6f6;
		touch-action: none;
	}
	.dev-log {
		position: fixed;
		left: 12px;
		bottom: 12px;
		margin: 0;
		padding: 8px 12px;
		list-style: none;
		font: 12px/1.5 ui-monospace, monospace;
		background: rgb(255 255 255 / 0.9);
		border-radius: 6px;
		pointer-events: none;
	}
</style>
