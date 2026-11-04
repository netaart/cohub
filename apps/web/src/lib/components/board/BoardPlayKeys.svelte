<script lang="ts">
import { defaultBoardTool } from "@neta-art/cohub/board/editor";
import { Gamepad2, PencilLine, RotateCcw } from "lucide-svelte";
import type { BoardEditor } from "$lib/board/editor.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	editor,
	playing,
	isMobile = false,
	onReset,
	onTogglePlay,
}: {
	editor: BoardEditor;
	playing: boolean;
	isMobile?: boolean;
	onReset?: () => void;
	onTogglePlay?: () => void;
} = $props();

const locale = $derived(getLocale());
const icon = $derived(isMobile ? "h-4 w-4" : "h-3.5 w-3.5");
const editing = $derived(playing && editor.tool !== "play");
const editLabel = $derived(
	editing
		? m.board_play_resume({}, { locale })
		: m.board_play_edit({}, { locale }),
);

function toggleEditing() {
	editor.tool = editing ? "play" : defaultBoardTool(isMobile);
}
</script>

{#if playing}
	<button type="button" class="tool-key" title={editLabel} aria-label={editLabel} aria-pressed={editing} onclick={toggleEditing}>
		{#if editing}<Gamepad2 class={icon} />{:else}<PencilLine class={icon} />{/if}
	</button>
	{#if onReset}
		<button type="button" class="tool-key" title={m.board_play_reset({}, { locale })} aria-label={m.board_play_reset({}, { locale })} onclick={onReset}>
			<RotateCcw class={icon} />
		</button>
	{/if}
{:else if onTogglePlay}
	<button type="button" class="tool-key" title={m.board_play_start({}, { locale })} aria-label={m.board_play_start({}, { locale })} onclick={onTogglePlay}>
		<Gamepad2 class={icon} />
	</button>
{/if}
