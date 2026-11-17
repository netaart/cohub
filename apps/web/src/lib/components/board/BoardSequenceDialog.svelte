<script lang="ts">
import type { BoardChapter } from "@neta-art/cohub/board";
import type { BoardEditor } from "#lib/board/editor.svelte.ts";
import Dialog from "#lib/components/Dialog.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

const { editor, onClose }: { editor: BoardEditor; onClose: () => void } =
	$props();
const locale = $derived(getLocale());
let chapters = $state<BoardChapter[]>([]);
let failure = $state(false);
const ids = $derived(
	Object.keys(editor.animations).filter(
		(id) => editor.animations[id]?.play === "manual",
	),
);
const frames = $derived(
	Object.entries(editor.document.items).filter(
		([, item]) => item.type === "frame",
	),
);
function add(id: string) {
	if (!id || chapters.some((chapter) => chapter.animation === id)) return;
	chapters = [...chapters, { animation: id, pause: true }];
}
function move(index: number, delta: number) {
	const copy = [...chapters];
	const other = index + delta;
	if (other < 0 || other >= copy.length) return;
	const current = copy[index];
	const adjacent = copy[other];
	if (!current || !adjacent) return;
	[copy[index], copy[other]] = [adjacent, current];
	chapters = copy;
}
function create() {
	try {
		editor.createSequence(m.board_sequence_name({}, { locale }), chapters);
		onClose();
	} catch {
		failure = true;
	}
}
</script>
<Dialog open onClose={onClose} title={m.board_sequence_create({}, { locale })} maxWidth="440px">
	<div class="flex flex-col gap-3 p-4">
		<p class="text-xs text-text-secondary">{m.board_sequence_hint({}, { locale })}</p>
		<select class="rounded bg-bg-input p-2 text-sm text-text-primary" aria-label={m.board_export_animation({}, { locale })} value="" onchange={(event) => { add(event.currentTarget.value); event.currentTarget.value = ""; }}>
			<option value="" disabled>{m.board_export_animation({}, { locale })}</option>
			{#each ids.filter((id) => !chapters.some((chapter) => chapter.animation === id)) as id (id)}<option value={id}>{editor.animations[id]?.name || id}</option>{/each}
		</select>
		<ol class="max-h-80 overflow-y-auto">
			{#each chapters as chapter, index (chapter.animation)}
				<li class="flex flex-col gap-2 border-b border-border-subtle py-3">
					<div class="flex items-center gap-2"><span class="min-w-0 flex-1 truncate text-sm">{index + 1}. {editor.animations[chapter.animation]?.name || chapter.animation}</span>
						<button type="button" class="h-9 w-9 rounded hover:bg-bg-hover disabled:opacity-30" aria-label={m.board_chapter_up({}, { locale })} disabled={index === 0} onclick={() => move(index, -1)}>↑</button>
						<button type="button" class="h-9 w-9 rounded hover:bg-bg-hover disabled:opacity-30" aria-label={m.board_chapter_down({}, { locale })} disabled={index === chapters.length - 1} onclick={() => move(index, 1)}>↓</button>
						<button type="button" class="h-9 w-9 rounded hover:bg-bg-hover" aria-label={m.board_chapter_remove({}, { locale })} onclick={() => { chapters = chapters.filter((_, i) => i !== index); }}>×</button>
					</div>
					<label class="flex items-center gap-2 text-xs text-text-secondary">{m.board_frame({}, { locale })}<select class="min-w-0 flex-1 rounded bg-bg-input p-2" value={chapter.frame ?? ""} onchange={(event) => { chapter.frame = event.currentTarget.value || undefined; }}><option value="">—</option>{#each frames as [id, item] (id)}<option value={id}>{item.type === "frame" ? item.props.label || id : id}</option>{/each}</select></label>
					<label class="flex items-center gap-2 text-xs text-text-secondary"><input type="checkbox" bind:checked={chapter.pause} />{m.board_chapter_pause({}, { locale })}</label>
				</li>
			{/each}
		</ol>
		{#if failure}<p class="text-sm text-error-soft" role="alert">{m.board_sequence_failed({}, { locale })}</p>{/if}
		<button type="button" class="primary-key self-end px-3 py-2 text-sm" disabled={chapters.length < 2} onclick={create}>{m.board_sequence_create({}, { locale })}</button>
	</div>
</Dialog>
