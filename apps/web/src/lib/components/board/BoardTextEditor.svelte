<script lang="ts">
import { boardEditableText } from "@neta-art/cohub/board";
import { boardTextEditLayout } from "@neta-art/cohub/board/render";
import type { BoardStage } from "@neta-art/cohub/board/stage";
import { tick, untrack } from "svelte";
import type { BoardEditor } from "$lib/board/editor.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const { editor, stage }: { editor: BoardEditor; stage: BoardStage | null } =
	$props();

const locale = $derived(getLocale());

let textarea: HTMLTextAreaElement | null = $state(null);
let draft = $state("");

const editingItem = $derived.by(() => {
	const id = editor.editingId;
	const item = id ? editor.itemById(id) : null;
	return item && boardEditableText(item) !== null ? item : null;
});

const layout = $derived(
	editingItem &&
		boardTextEditLayout(editingItem, {
			viewport: editor.camera,
			scene: editor.scene,
			style: stage?.theme.style,
			draft,
		}),
);

$effect(() => {
	const id = editor.editingId;
	if (!id) return;
	const item = untrack(() => editor.itemById(id));
	const text = item ? boardEditableText(item) : null;
	if (text === null) return;
	draft = text;
	void tick().then(() => {
		if (editor.editingId !== id || !textarea) return;
		textarea.focus({ preventScroll: true });
		const end = textarea.value.length;
		if (matchMedia("(pointer: coarse)").matches)
			textarea.setSelectionRange(end, end);
		else textarea.select();
	});
});

function commit() {
	const item = editingItem;
	if (!item) return;
	editor.commitTextEdit(item.id, draft);
}

function handleInput(event: Event & { currentTarget: HTMLTextAreaElement }) {
	const item = editingItem;
	if (item?.type !== "text") return;
	editor.previewTextLayout(item.id, event.currentTarget.value);
}

function handleKeydown(event: KeyboardEvent) {
	event.stopPropagation();
	if (
		event.key === "Escape" ||
		(event.key === "Enter" && (event.metaKey || event.ctrlKey))
	) {
		event.preventDefault();
		commit();
	}
}
</script>

{#if editingItem && layout}
	<textarea
		bind:this={textarea}
		bind:value={draft}
		class="board-text-editor"
		style:left="{layout.left}px"
		style:top="{layout.top}px"
		style:width="{layout.width}px"
		style:height="{layout.height}px"
		style:transform="rotate({layout.rotation}deg) scale({layout.scale})"
		style:--board-text-editor-scale={layout.scale}
		style:font-family={layout.font.fontFamily}
		style:font-size="{layout.font.fontSize}px"
		style:font-weight={layout.font.fontWeight}
		style:line-height="{layout.lineHeight}px"
		style:text-align={layout.textAlign}
		style:padding="{layout.padding.y}px {layout.padding.x}px"
		style:white-space={layout.whiteSpace}
		class:board-text-editor--plain={layout.live}
		oninput={handleInput}
		onblur={commit}
		onkeydown={handleKeydown}
		aria-label={m.board_edit_text({}, { locale })}
	></textarea>
{/if}

<style>
	.board-text-editor {
		--board-text-editor-scale: 1;
		position: absolute;
		z-index: 30;
		box-sizing: content-box;
		margin: 0;
		transform-origin: center center;
		resize: none;
		overflow: hidden;
		border: 0;
		border-radius: calc(10px / var(--board-text-editor-scale));
		outline: calc(1px / var(--board-text-editor-scale)) solid var(--brand-border);
		background: color-mix(in srgb, var(--bg-surface) 96%, transparent);
		color: var(--text-primary);
		font-family: var(--font-sans);
		box-shadow: 0 0 0 calc(2px / var(--board-text-editor-scale)) color-mix(in srgb, var(--brand) 18%, transparent);
		overflow-wrap: break-word;
		word-break: normal;
		letter-spacing: 0;
		word-spacing: 0;
		font-kerning: auto;
		font-feature-settings: normal;
		font-variant: normal;
		text-rendering: auto;
		tab-size: 1;
	}

	.board-text-editor--plain {
		border-radius: 0;
		outline: none;
		background: transparent;
		box-shadow: none;
		caret-color: var(--brand);
	}
</style>
