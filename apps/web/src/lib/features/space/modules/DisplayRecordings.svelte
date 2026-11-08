<script lang="ts">
import type { DisplayRecordingMeta } from "@neta-art/cohub";
import { DISPLAY_RECORDINGS_DIR } from "@neta-art/cohub";
import { FolderInput, Play, Trash2 } from "lucide-svelte";
import { onDestroy } from "svelte";
import { formatBytes } from "$lib/format-bytes";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { formatClock, loadRecordings } from "./display-replay";

const {
	spaceId,
	canEdit,
	refreshKey = "",
	onPlay,
}: {
	spaceId: string;
	canEdit: boolean;
	refreshKey?: string;
	onPlay: (recording: DisplayRecordingMeta) => void;
} = $props();

const SAVED_DIR = "recordings";
const CONFIRM_MS = 3_000;

const locale = $derived(getLocale());
let recordings = $state<DisplayRecordingMeta[] | null>(null);
let failed = $state(false);
let busy = $state<string | null>(null);
let confirming = $state<string | null>(null);
let saved = $state<Record<string, string>>({});
let confirmTimer: ReturnType<typeof setTimeout> | null = null;

$effect(() => {
	void refreshKey;
	failed = false;
	void loadRecordings(spaceId, (list) => {
		recordings = list;
	}).catch(() => {
		failed = true;
	});
});

onDestroy(() => {
	if (confirmTimer) clearTimeout(confirmTimer);
});

const when = (at: number) =>
	new Intl.DateTimeFormat(locale, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(at);

function savedName(recording: DisplayRecordingMeta, index: number) {
	const stamp = new Date(recording.since)
		.toISOString()
		.slice(0, 16)
		.replace("T", " ")
		.replace(":", ".");
	const name = (recording.name || recording.display)
		.replace(/[\\/:*?"<>|]+/g, " ")
		.trim();
	return `${SAVED_DIR}/${stamp} ${name}${index ? ` ${index + 1}` : ""}.mp4`;
}

async function save(recording: DisplayRecordingMeta) {
	busy = recording.id;
	try {
		const files = sdk.space(spaceId).files;
		let first = "";
		for (const [index, file] of recording.files.entries()) {
			const destination = savedName(recording, index);
			const copy = await files.copy({
				sources: [
					{
						spaceId,
						path: `${DISPLAY_RECORDINGS_DIR}/${recording.id}/${file.name}`,
					},
				],
				destination,
				noClobber: true,
			});
			await files.waitForCopy(copy);
			first ||= destination;
		}
		saved = { ...saved, [recording.id]: first };
	} catch {
		failed = true;
	} finally {
		busy = null;
	}
}

async function remove(recording: DisplayRecordingMeta) {
	if (confirming !== recording.id) {
		confirming = recording.id;
		if (confirmTimer) clearTimeout(confirmTimer);
		confirmTimer = setTimeout(() => (confirming = null), CONFIRM_MS);
		return;
	}
	confirming = null;
	busy = recording.id;
	try {
		await sdk
			.space(spaceId)
			.files.delete(`${DISPLAY_RECORDINGS_DIR}/${recording.id}`, true);
		recordings = (recordings ?? []).filter((item) => item.id !== recording.id);
	} catch {
		failed = true;
	} finally {
		busy = null;
	}
}
</script>

<div class="recordings">
	<div class="recordings-head">{m.display_recordings({}, { locale })}</div>
	{#if recordings === null && !failed}
		<div class="recordings-note">{m.display_recordings_loading({}, { locale })}</div>
	{:else if failed && !recordings?.length}
		<div class="recordings-note">{m.display_recordings_failed({}, { locale })}</div>
	{:else if !recordings?.length}
		<div class="recordings-note">{m.display_recordings_empty({}, { locale })}</div>
	{:else}
		<ul>
			{#each recordings as recording (recording.id)}
				<li class="recording">
					<button type="button" class="recording-play" onclick={() => onPlay(recording)} aria-label={m.display_replay_play({}, { locale })}>
						<Play class="h-3.5 w-3.5 shrink-0" />
						<span class="recording-main">
							<span class="recording-title">{when(recording.since)}</span>
							<span class="recording-meta">
								{recording.endedAt ? formatClock(recording.endedAt - recording.since) : m.display_recording_live({}, { locale })}
								· {formatBytes(recording.bytes)}
								{#if recording.auto}· {m.display_recording_auto_tag({}, { locale })}{/if}
								{#if saved[recording.id]}· {m.display_recording_saved_to({ path: saved[recording.id] }, { locale })}{/if}
							</span>
						</span>
					</button>
					{#if canEdit && recording.endedAt}
						<button type="button" class="recording-action" disabled={busy === recording.id || Boolean(saved[recording.id])} title={m.display_recording_save({}, { locale })} aria-label={m.display_recording_save({}, { locale })} onclick={() => void save(recording)}><FolderInput class="h-3.5 w-3.5" /></button>
						<button type="button" class="recording-action" class:is-confirming={confirming === recording.id} disabled={busy === recording.id} title={confirming === recording.id ? m.display_recording_delete_confirm({}, { locale }) : m.display_recording_delete({}, { locale })} aria-label={m.display_recording_delete({}, { locale })} onclick={() => void remove(recording)}>
							{#if confirming === recording.id}<span>{m.display_recording_delete_confirm({}, { locale })}</span>{:else}<Trash2 class="h-3.5 w-3.5" />{/if}
						</button>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
	<p class="recordings-foot">{m.display_recordings_hint({ path: DISPLAY_RECORDINGS_DIR }, { locale })}</p>
</div>

<style>
	.recordings {
		display: flex;
		max-height: 100%;
		flex-direction: column;
		overflow: hidden;
		border: 1px solid var(--border-subtle);
		border-radius: 8px;
		background: var(--bg-elevated);
		box-shadow: var(--menu-shadow);
	}
	.recordings-head {
		padding: 8px 12px 4px;
		color: var(--text-tertiary);
		font-size: 10px;
		font-weight: 500;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.recordings-note,
	.recordings-foot {
		margin: 0;
		padding: 6px 12px 10px;
		color: var(--text-tertiary);
		font-size: 12px;
		line-height: 1.45;
	}
	.recordings-foot {
		border-top: 1px solid var(--border-subtle);
		padding-top: 8px;
		font-size: 11px;
	}
	ul {
		min-height: 0;
		margin: 0;
		padding: 2px 4px 4px;
		overflow-y: auto;
		list-style: none;
	}
	.recording {
		display: flex;
		align-items: center;
		gap: 2px;
	}
	.recording-play {
		display: flex;
		min-width: 0;
		min-height: 40px;
		flex: 1;
		align-items: center;
		gap: 8px;
		padding: 4px 8px;
		border: 0;
		border-radius: 6px;
		background: none;
		color: var(--text-secondary);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.recording-play:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}
	.recording-main {
		display: flex;
		min-width: 0;
		flex-direction: column;
	}
	.recording-title {
		font-size: 12px;
		color: var(--text-primary);
	}
	.recording-meta {
		overflow: hidden;
		color: var(--text-tertiary);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.recording-action {
		display: inline-flex;
		min-width: 32px;
		height: 32px;
		flex: none;
		align-items: center;
		justify-content: center;
		padding: 0 6px;
		border: 0;
		border-radius: 6px;
		background: none;
		color: var(--text-tertiary);
		font: inherit;
		font-size: 11px;
		cursor: pointer;
	}
	.recording-action:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-primary);
	}
	.recording-action:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.recording-action.is-confirming {
		color: var(--error-700);
	}
	.recording-play:focus-visible,
	.recording-action:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 1px;
	}
	@media (max-width: 640px) {
		.recording-action {
			min-width: 44px;
			height: 44px;
		}
	}
</style>
