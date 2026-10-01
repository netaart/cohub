<script lang="ts">
import { type BoardSceneItem, layoutBoardText, resolveSceneArrow } from "@neta-art/cohub/board";
import { tick, untrack } from "svelte";
import type { BoardEditor } from "$lib/board/editor.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const { editor }: { editor: BoardEditor } = $props();

const locale = $derived(getLocale());

let textarea: HTMLTextAreaElement | null = $state(null);
let draft = $state("");

type TextProps = { text?: string; label?: string; fontSize: number; fontWeight: number; font: string; lineHeight: number; width?: number; align?: "left" | "center" | "right" };

function editableText(item: BoardSceneItem): string | null {
	const props = item.props as { text?: string; label?: string };
	if (item.type === "text" || item.type === "shape") return props.text ?? "";
	if (item.type === "arrow" || item.type === "frame") return props.label ?? "";
	return null;
}

const editingItem = $derived.by(() => {
	const id = editor.editingId;
	const item = id ? editor.itemById(id) : null;
	return item && editableText(item) !== null ? item : null;
});

const layout = $derived.by(() => {
	const item = editingItem;
	if (!item) return null;
	const { x, y, zoom } = editor.camera;
	const left = (worldX: number) => worldX * zoom + x;
	const top = (worldY: number) => worldY * zoom + y;
	const rotation = item.frame.rotation || 0;
	const plain = item.type === "text";
	const props = item.props as TextProps;
	const fontSize = item.type === "text" || item.type === "shape" ? props.fontSize : 14;
	if (item.type === "frame" || item.type === "arrow") {
		const height = 20;
		const width = Math.max(fontSize * 4, (props.label?.length ?? 0) * fontSize * 0.62 + 16);
		const anchor =
			item.type === "frame"
				? { x: item.frame.x + 2, y: item.frame.y - 10 }
				: resolveSceneArrow(item, editor.scene).mid;
		return {
			left: left(anchor.x) - width / 2,
			top: top(anchor.y) - height / 2,
			width,
			height,
			rotation,
			fontSize: fontSize * zoom,
			lineHeight: height * zoom,
			fontWeight: 500,
			textAlign: "center",
			padding: 0,
			plain: false,
		};
	}
	const scale = plain ? item.frame.height / Math.max(1, layoutBoardText({ ...props, text: props.text ?? "" }).height) : 1;
	const lineHeight = fontSize * scale * (plain ? props.lineHeight : 1.4);
	const width = item.frame.width * zoom;
	const height = item.frame.height * zoom;
	return {
		left: left(item.frame.x),
		top: top(item.frame.y),
		width: Math.max(width, plain ? 24 * zoom : width),
		height: Math.max(height, plain ? lineHeight * zoom : height),
		rotation,
		fontSize: fontSize * scale * zoom,
		lineHeight: lineHeight * zoom,
		fontWeight: plain ? props.fontWeight : 500,
		textAlign: plain ? ((item.props as { align?: string }).align ?? "left") : "center",
		padding: plain ? 0 : 12 * zoom,
		plain,
	};
});

$effect(() => {
	const id = editor.editingId;
	if (!id) return;
	const item = untrack(() => editor.itemById(id));
	const text = item ? editableText(item) : null;
	if (text === null) return;
	draft = text;
	void tick().then(() => {
		if (editor.editingId !== id) return;
		textarea?.focus({ preventScroll: true });
		textarea?.select();
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
		style:transform="rotate({layout.rotation}deg)"
		style:font-size="{layout.fontSize}px"
		style:line-height="{layout.lineHeight}px"
		style:font-weight={layout.fontWeight}
		style:text-align={layout.textAlign}
		style:padding="{layout.padding}px"
		class:board-text-editor--plain={layout.plain}
		oninput={handleInput}
		onblur={commit}
		onkeydown={handleKeydown}
		aria-label={m.board_edit_text({}, { locale })}
	></textarea>
{/if}

<style>
	.board-text-editor {
		position: absolute;
		z-index: 30;
		transform-origin: center center;
		resize: none;
		overflow: hidden;
		border: 1px solid var(--brand-border);
		border-radius: 10px;
		background: color-mix(in srgb, var(--bg-surface) 96%, transparent);
		color: var(--text-primary);
		font-family: var(--font-sans);
		line-height: 1.35;
		outline: none;
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand) 18%, transparent);
	}

	.board-text-editor--plain {
		border: 0;
		border-radius: 0;
		background: transparent;
		box-shadow: none;
		caret-color: var(--brand);
		font-family: "Geist", system-ui, -apple-system, "Noto Sans CJK SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
	}
</style>
