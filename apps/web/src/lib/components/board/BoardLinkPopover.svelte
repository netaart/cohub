<script lang="ts">
import {
	type BoardMediaItemKind,
	inferBoardMediaKind,
	normalizeBoardRemoteUrl,
} from "@neta-art/cohub/board";
import { Link, X } from "lucide-svelte";
import { onMount } from "svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

const {
	initialUrl = "",
	onAdd,
	onClose,
}: {
	initialUrl?: string;
	onAdd: (url: string, kind: BoardMediaItemKind) => void;
	onClose: () => void;
} = $props();
const locale = $derived(getLocale());
const errorId = $props.id();
let url = $state("");
let selectedKind = $state<BoardMediaItemKind | "">("");
let error = $state(false);
let input: HTMLInputElement;
const inferred = $derived(inferBoardMediaKind(url));
const kind = $derived(
	selectedKind || (inferred === "text" ? "file" : inferred),
);

onMount(() => {
	url = initialUrl;
	input.focus();
});

function submit(event: SubmitEvent) {
	event.preventDefault();
	const normalized = normalizeBoardRemoteUrl(url);
	if (!normalized) {
		error = true;
		input.focus();
		return;
	}
	onAdd(normalized, kind);
}
</script>

<div class="board-link-popover absolute bottom-16 left-3 right-3 z-30 mx-auto w-auto max-w-sm rounded-lg border border-border-primary bg-bg-primary p-3 shadow-lg sm:bottom-20" role="dialog" aria-label={m.board_add_link({}, { locale })}>
	<div class="mb-3 flex items-center justify-between gap-2">
		<div class="flex items-center gap-2 text-sm font-medium text-text-primary"><Link class="h-4 w-4" />{m.board_add_link({}, { locale })}</div>
		<button type="button" class="flex h-9 w-9 items-center justify-center rounded text-text-secondary hover:bg-bg-hover focus-visible:outline-brand" aria-label={m.board_close({}, { locale })} onclick={onClose}><X class="h-4 w-4" /></button>
	</div>
	<form onsubmit={submit} novalidate class="flex flex-col gap-3">
		<label class="flex flex-col gap-1 text-xs text-text-secondary">
			{m.board_media_url({}, { locale })}
			<input bind:this={input} bind:value={url} type="url" inputmode="url" required maxlength="4096" autocomplete="off" spellcheck="false" placeholder="https://…" aria-invalid={error} aria-describedby={error ? errorId : undefined} oninput={() => { error = false; }} class="h-10 w-full rounded border border-border-primary bg-bg-input px-3 text-sm text-text-primary outline-none focus:border-brand" />
		</label>
		{#if error}<p id={errorId} role="alert" class="text-xs text-error-soft">{m.board_media_url_invalid({}, { locale })}</p>{/if}
		<div class="flex items-end gap-3">
			<label class="flex flex-1 flex-col gap-1 text-xs text-text-secondary">
				{m.board_media_type({}, { locale })}
				<select value={kind} onchange={(event) => { selectedKind = event.currentTarget.value as BoardMediaItemKind; }} class="h-10 rounded border border-border-primary bg-bg-input px-2 text-sm text-text-primary outline-none focus:border-brand">
					<option value="image">{m.board_media_image({}, { locale })}</option>
					<option value="video">{m.board_media_video({}, { locale })}</option>
					<option value="audio">{m.board_media_audio({}, { locale })}</option>
					<option value="file">{m.board_media_file({}, { locale })}</option>
				</select>
			</label>
			<button type="submit" class="primary-key h-10 px-4 text-sm">{m.board_add({}, { locale })}</button>
		</div>
	</form>
</div>
